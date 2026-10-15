// What happens between "reset their password" and that person signing in.
//
// This is the path a real person got lost on, so it is worth writing down in
// full. A master resets somebody's password. That person is holding the only
// login they have ever been given - the shared starting one - so they use it,
// and land on the card that CREATES an account. Their account already exists,
// so the card refuses them, and whether they get in from there depends
// entirely on whether the refusal tells them what to do.
//
// The way through is that their own employee ID is now a username that the
// starting password opens. It leads to the same card, bound to them, where the
// ID is fixed and all they choose is a password.
//
//   node tests/reset-journey-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const crypto = require('crypto');

// Apps Script hands back SIGNED bytes; Node hands back unsigned. Code that
// base64s the result does not care, but code that compares them would.
const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
const toBuf = (v) => (typeof v === 'string'
  ? Buffer.from(v, 'utf8')
  : Buffer.from(Array.from(v).map((b) => b & 0xff)));
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a spreadsheet and a clock
// ---------------------------------------------------------------------------
function makeSheet(name, headers) {
  const sheet = {
    name: name, rows: [],
    getLastRow: () => sheet.rows.length + 1,
    getLastColumn: () => headers.length,
    setFrozenRows: () => sheet,
    appendRow: function (r) { sheet.rows.push(r.slice()); return sheet; },
    deleteRow: function (r) { sheet.rows.splice(r - 2, 1); return sheet; },
    getRange: function (r, c, n, w) {
      const h = n === undefined ? 1 : n, width = w === undefined ? 1 : w;
      const api = {
        getValues: function () {
          const got = [];
          for (let i = 0; i < h; i++) {
            got.push((sheet.rows[r - 2 + i] || []).slice(c - 1, c - 1 + width));
          }
          return got;
        },
        setValues: function (vals) {
          vals.forEach(function (v, i) {
            const at = r - 2 + i;
            if (at < 0) return;
            if (!sheet.rows[at]) sheet.rows[at] = [];
            v.forEach(function (cell, j) { sheet.rows[at][c - 1 + j] = cell; });
          });
          return api;
        },
        setValue: function (v) {
          const at = r - 2;
          if (at < 0) return api;
          if (!sheet.rows[at]) sheet.rows[at] = [];
          sheet.rows[at][c - 1] = v;
          return api;
        },
        setFontWeight: () => api, setBackground: () => api,
        setFontColor: () => api, setNumberFormat: () => api,
        clearContent: function () { sheet.rows = []; return api; }
      };
      return api;
    }
  };
  return sheet;
}

const tabs = {};
const book = {
  getSheetByName: (n) => tabs[n] || null,
  insertSheet: function (n) { tabs[n] = makeSheet(n, []); return tabs[n]; }
};

let cache = {};
const props = {};
let now = new Date('2026-10-15T06:00:00Z');

const sb = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Buffer,
  isFinite, Boolean, Error, parseInt, parseFloat, Set, Date,
  Logger: { log: function () {} },
  SpreadsheetApp: { openById: () => book },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (k) => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = v; },
      deleteProperty: (k) => { delete props[k]; }
    })
  },
  CacheService: {
    getScriptCache: () => ({
      get: (k) => (k in cache ? cache[k] : null),
      put: (k, v) => { cache[k] = v; },
      remove: (k) => { delete cache[k]; }
    })
  },
  Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.com' }),
             getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }) },
  Utilities: {
    getUuid: (function () {
      let n = 0;
      return () => 'uuid-' + (++n);
    })(),
    base64Encode: (v) => toBuf(v).toString('base64'),
    // Called with BYTE ARRAYS, not strings - once for the token payload and
    // once for its signature. Stringifying an array gave "116,101,..." and a
    // token that could never verify.
    base64EncodeWebSafe: (v) => toBuf(v).toString('base64')
                                  .replace(/\+/g, '-').replace(/\//g, '_'),
    base64DecodeWebSafe: (s) => Array.from(
      Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    newBlob: (v) => {
      const buf = toBuf(v);
      return {
        getBytes: () => Array.from(buf).map((b) => (b > 127 ? b - 256 : b)),
        getDataAsString: () => buf.toString('utf8')
      };
    },
    // Real SHA-256 and real HMAC, from Node. Stubbing them one at a time was
    // turning into a worse version of the thing being tested - and a hash that
    // is not a hash cannot show that a reset actually invalidates a password.
    computeDigest: (algo, value) => signed(
      crypto.createHash('sha256').update(
        typeof value === 'string' ? Buffer.from(value, 'utf8')
                                  : Buffer.from(value.map((b) => b & 0xff))).digest()),
    computeHmacSha256Signature: (value, key) => signed(
      crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest()),
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    MacAlgorithm: { HMAC_SHA_256: 'HMAC_SHA_256' },
    formatDate: (d, tz, fmt) => new Date(d).toISOString()
  }
};
sb.globalThis = sb;
vm.createContext(sb);

vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), sb);
vm.runInContext('function getSpreadsheetId() { return "fake"; }', sb);
vm.runInContext('function CONFIG_TZ() { return "Asia/Dhaka"; }', sb);
vm.runInContext('function sheetFor(name) {' +
  ' if (!tabsHas(name)) throw new Error("no tab " + name); return null; }' +
  'function tabsHas() { return false; }', sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Auth.gs'), 'utf8'), sb);

const STARTING = vm.runInContext('STARTING_PASSWORD', sb);
const BOOTSTRAP = vm.runInContext('BOOTSTRAP_USER', sb);
const login = vm.runInContext('login', sb);
const register = vm.runInContext('registerAccount', sb);
const setAccount = vm.runInContext('setAccount', sb);
const readAccounts = vm.runInContext('readAccounts', sb);
const reset = vm.runInContext('masterResetPassword', sb);
const issueToken = vm.runInContext('issueToken', sb);

// The cast: the shared starting login, a master, and the boss.
vm.runInContext('seedCredentials();', sb);
setAccount('20536723', 'rudrapass', 'MASTER');
setAccount('20217473', 'bosspass', 'ADMIN');
const MASTER = issueToken('20536723', 'MASTER');

check('the boss can sign in with the password he chose',
  login('20217473', 'bosspass').ok === true);

// ---------------------------------------------------------------------------
// the reset
// ---------------------------------------------------------------------------
const done = reset(MASTER, '20217473');
check('a master can reset it', done.ok === true);
check('and is told the password it went back to',
  done.password === STARTING, done.password);
check('the old password stops working',
  login('20217473', 'bosspass').ok === false,
  'otherwise a reset would not be one');
check('and the account is flagged as needing one chosen',
  readAccounts()['20217473'].mustChange === true,
  'which is the "Must set a password" the master screen shows');
check('his role survived the reset',
  readAccounts()['20217473'].role === 'ADMIN',
  'resetting a password is not demoting somebody');

// ---------------------------------------------------------------------------
// the wrong way round - the one a real person took
// ---------------------------------------------------------------------------
// He had been given the shared starting login once, months ago. It is the only
// thing he has, so it is what he tries.
const shared = login(BOOTSTRAP, STARTING);
check('the shared starting login still opens the sign-up card',
  shared.ok === true && shared.setup === true && Boolean(shared.setupToken));
check('and that card is bound to nobody, because it is for a new account',
  !shared.username, 'username = ' + JSON.stringify(shared.username));

const refused = register(shared.setupToken, '20217473', 's4hana1929#', 's4hana1929#');
check('putting an existing employee ID into it is refused',
  refused.ok === false, refused.message);

// THE POINT OF THIS SUITE.
check('and the refusal says to use the employee ID as the username',
  /username box/.test(refused.message) && /20217473/.test(refused.message),
  refused.message);
check('naming the shared login as the thing NOT to use',
  new RegExp('instead of "' + BOOTSTRAP + '"').test(refused.message),
  'he had just typed it, so "sign in with it" read as "do what you did"');
check('and it does not send him off to ask for another reset',
  !/ask for the password to be reset/.test(refused.message),
  'he had one - that sentence was a loop');
// The honest version of "it does not say whether a reset is pending": the
// answer for an account awaiting one and an account not awaiting one has to be
// the same text. Anything less and this box becomes a way to ask.
setAccount('20217450', 'theirownpass', 'USER');
const quiet = register(shared.setupToken, '20217450', 'another1234', 'another1234');
check('and an account with no reset pending is refused identically',
  quiet.ok === false &&
  quiet.message.replace(/20217450/g, 'ID') === refused.message.replace(/20217473/g, 'ID'),
  'otherwise the difference between the two answers IS the answer');

check('nothing was written while being refused',
  readAccounts()['20217473'].mustChange === true &&
  login('20217473', 's4hana1929#').ok === false,
  'the password he typed into the wrong card did not take');

// ---------------------------------------------------------------------------
// the way through
// ---------------------------------------------------------------------------
const his = login('20217473', STARTING);
check('his own employee ID opens with the starting password',
  his.ok === true, 'because that is what the reset put back');
check('and it does NOT sign him straight in',
  his.setup === true && !his.token,
  'a password somebody else chose gets you as far as choosing your own');
check('this time the card knows who he is',
  his.username === '20217473' && Boolean(his.setupToken),
  'username = ' + his.username);

const wrongId = register(his.setupToken, '20536723', 'nicetry123', 'nicetry123');
check('a card bound to him cannot set anybody else\'s password',
  wrongId.ok === false && /password reset for employee ID 20217473/.test(wrongId.message),
  wrongId.message);

const set = register(his.setupToken, '20217473', 's4hana1929#', 's4hana1929#');
check('but it does set his', set.ok === true, set.message);
check('and signs him in there and then, with no second trip',
  Boolean(set.token) && set.role === 'ADMIN', set.role);
check('his role is still ADMIN at the end of all that',
  readAccounts()['20217473'].role === 'ADMIN');
check('the flag is cleared, so next time is an ordinary sign-in',
  readAccounts()['20217473'].mustChange === false);

const after = login('20217473', 's4hana1929#');
check('the new password works on the next sign-in',
  after.ok === true && after.setup === false && Boolean(after.token));
check('and the starting password no longer opens his account',
  login('20217473', STARTING).ok === false,
  'or every reset would leave a second way in forever');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
