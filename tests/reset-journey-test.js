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
    // How wide the tab actually is, tracked from every write rather than
    // fixed. authTab() reads this to decide whether a tab predates a column,
    // so a constant here would have made that decision untestable - and the
    // ACCOUNTS tab is one that already exists on the live sheet, with two
    // fewer columns than the code now asks for.
    width: (headers || []).length,
    getLastColumn: () => sheet.width,
    getMaxRows: () => sheet.rows.length + 200,
    getLastRow: () => sheet.rows.length + 1,
    setFrozenRows: () => sheet,
    appendRow: function (r) {
      sheet.rows.push(r.slice());
      sheet.width = Math.max(sheet.width, r.length);
      return sheet;
    },
    deleteRow: function (r) { sheet.rows.splice(r - 2, 1); return sheet; },
    deleteRows: function (r, n) { sheet.rows.splice(r - 2, n); return sheet; },
    // Reading does NOT widen a sheet - only writing does. A fake that grew on
    // every read would have made the header repair untestable: readAccounts
    // asks for the full width on its way in, so the tab would always look
    // wide enough by the time anything checked.
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
            sheet.width = Math.max(sheet.width, c - 1 + v.length);
            // Row 1 is the header. Kept rather than thrown away, so a test
            // can ask whether a tab made before a column was added had that
            // column's name written in.
            if (at < 0) { sheet.header = v.slice(); return; }
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

// ---------------------------------------------------------------------------
// the sign-in log does not grow forever
// ---------------------------------------------------------------------------
// It gains a row on every sign-in, password change and reset. Left alone that
// is a few thousand rows a year, all of which the Accounts screen loads to
// show the last twenty.
const prune = vm.runInContext('pruneAuthLog', sb);
const CONFIG = vm.runInContext('CONFIG', sb);
const logTab = vm.runInContext('authLogTab', sb)();
const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY);

logTab.rows = [];
[95, 60, 40, 31, 29, 10, 2, 0].forEach(function (d, i) {
  logTab.rows.push([ago(d), '2053672' + i, 'SIGNIN', 'MASTER', '']);
});
const before = logTab.rows.length;
const dropped = prune();

check('rows older than the window are dropped',
  dropped === 4, dropped + ' of ' + before + ' removed');
check('and everything inside it is kept, untouched',
  logTab.rows.length === 4 &&
  logTab.rows.every(function (r) {
    return (Date.now() - r[0].getTime()) < CONFIG.AUTH_LOG_DAYS * DAY;
  }),
  logTab.rows.length + ' left, newest to ' + CONFIG.AUTH_LOG_DAYS + ' days old');
check('running it again removes nothing',
  prune() === 0, 'it is not a sliding window that eats its own tail');

// THE ONE THAT WOULD HAVE BEEN WRONG. "Delete every row older than the cutoff"
// is the obvious rule and it is unsafe: the moment a sheet is not perfectly
// sorted - a clock skew, a row pasted in by hand - it reaches PAST fresh rows
// to get at an old one and takes the fresh ones with it. Stopping at the first
// row worth keeping cannot do that.
logTab.rows = [
  [ago(90), 'old-1', 'SIGNIN', 'MASTER', ''],
  [ago(88), 'old-2', 'SIGNIN', 'MASTER', ''],
  [ago(1),  'TODAY', 'SIGNIN', 'MASTER', ''],      // out of order, on purpose
  [ago(80), 'old-3', 'SIGNIN', 'MASTER', ''],
  [ago(2),  'fresh', 'SIGNIN', 'MASTER', '']
];
prune();
check('an out-of-order sheet never costs a row that is still inside the window',
  logTab.rows.some(function (r) { return r[1] === 'TODAY'; }) &&
  logTab.rows.some(function (r) { return r[1] === 'fresh'; }),
  logTab.rows.map(function (r) { return r[1]; }).join(', '));
check('and the expired block above it still goes',
  !logTab.rows.some(function (r) { return r[1] === 'old-1' || r[1] === 'old-2'; }),
  'it stops at TODAY and leaves old-3 - stale, harmless, gone next time');

// THREE expired rows, not one. With a single row the function returns before
// it prunes anything, so a one-row fixture passed whether the guard below was
// there or not - it was asserting the early exit, not the rule.
logTab.rows = [
  [ago(400), 'ancient-1', 'SIGNIN', 'MASTER', ''],
  [ago(300), 'ancient-2', 'SIGNIN', 'MASTER', ''],
  [ago(200), 'ancient-3', 'SIGNIN', 'MASTER', '']
];
prune();
check('a log of nothing but expired rows keeps the last one rather than emptying',
  logTab.rows.length === 1 && logTab.rows[0][1] === 'ancient-3',
  'an empty tab reads as a broken feature; one stale row reads as a quiet ' +
  'month - ' + logTab.rows.length + ' left');

logTab.rows = [];
check('and an empty log is not something to trip over', prune() === 0);

// ---------------------------------------------------------------------------
// the name beside the ID, and the address the alerts go to
// ---------------------------------------------------------------------------
// Both are new columns on an ACCOUNTS tab that already exists with ten, so
// the first thing to establish is that the tab survives being widened at all:
// readAccounts() asks for the full width, and a range wider than the sheet
// throws, which would be every account on the dashboard unreadable at once.
const threwFrom = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message || e); } };
const setMyName = vm.runInContext('setMyName', sb);
const setDetails = vm.runInContext('masterSetDetails', sb);
const alertList = vm.runInContext('alertEmailList', sb);
const accountNameOf = vm.runInContext('accountNameOf', sb);
const COLUMNS = vm.runInContext('ACCOUNT_COLUMNS', sb);
const accountsTab = tabs['ACCOUNTS'];

check('the accounts tab carries a Name and an Email column',
  COLUMNS.indexOf('Name') === 10 && COLUMNS.indexOf('Email') === 11,
  COLUMNS.join(', '));
check('and they are on the END, where they shift nothing',
  COLUMNS.indexOf('Salt') === 2 && COLUMNS.indexOf('Hash') === 3,
  'a column inserted higher up would put the salt in the hash\'s place, for ' +
  'every account at once');

// A tab exactly as it was before these columns existed: ten wide, with a
// header row that has never heard of Name or Email.
accountsTab.width = 10;
accountsTab.header = COLUMNS.slice(0, 10);

const stillThere = Object.keys(readAccounts()).length;
check('a tab from before the new columns still reads',
  stillThere > 0, stillThere + ' accounts, none of them lost to a wider range');
check('and its header row is brought up to date',
  accountsTab.header.indexOf('Name') === 10 &&
  accountsTab.header.indexOf('Email') === 11,
  'now ' + accountsTab.header.length + ' wide: ' +
  accountsTab.header.slice(9).join(', '));
check('while the rows written before it read back blank, not broken',
  accountNameOf('20217473') === '',
  'which is what "this was written before we asked" should look like');

// ---- somebody setting their own ----
const BOSS = issueToken('20217473', 'ADMIN');
check('somebody signed out cannot set a name',
  setMyName(null, 'Nobody').ok === false, setMyName(null, 'X').message);
check('and an empty one is refused rather than stored',
  setMyName(BOSS, '   ').ok === false, setMyName(BOSS, '  ').message);

check('a signed-in person can set their own',
  setMyName(BOSS, '  Shahriar   Kabir ').ok === true);
check('tidied on the way in, so one person is stored one way',
  accountNameOf('20217473') === 'Shahriar Kabir',
  '"' + accountNameOf('20217473') + '"');

// The ID comes from the token. Without that, the name box on the panel would
// be a way to rename a colleague.
check('and it is THEIR account, whatever else is passed',
  accountNameOf('20536723') === '',
  'the employee ID is taken from the signed token, never from the call');

// ---- the master correcting one, and setting where alerts go ----
check('a name is not something an ordinary admin can change for somebody else',
  /master/i.test(threwFrom(() => setDetails(BOSS, '20536723', 'Imposter', ''))),
  threwFrom(() => setDetails(BOSS, '20536723', 'Imposter', '')));

setDetails(MASTER, '20217473', 'Shahriar K. Kabir', 'shahriar@youngone.com');
check('the master can correct a name',
  accountNameOf('20217473') === 'Shahriar K. Kabir',
  accountNameOf('20217473'));
check('and set the address that account is told at',
  readAccounts()['20217473'].email === 'shahriar@youngone.com',
  readAccounts()['20217473'].email);
check('an address that is not one is refused, not stored',
  /email address/i.test(threwFrom(() => setDetails(MASTER, '20217473', undefined, 'shahriar.at.work'))) &&
  readAccounts()['20217473'].email === 'shahriar@youngone.com',
  'the one already there is left alone');

// undefined means "leave it", '' means "clear it". Without that difference,
// setting an email would blank a name and there would be no way to remove a
// wrong address.
setDetails(MASTER, '20217473', undefined, undefined);
check('leaving both out changes neither',
  accountNameOf('20217473') === 'Shahriar K. Kabir' &&
  readAccounts()['20217473'].email === 'shahriar@youngone.com',
  'undefined is "leave it alone"');

// ---- who gets the email ----
setDetails(MASTER, '20536723', 'Rudra Das', 'rudra@youngone.com');
let who = alertList();
check('every admin and master with an address is emailed',
  who.indexOf('rudra@youngone.com') !== -1 &&
  who.indexOf('shahriar@youngone.com') !== -1,
  who.join(', '));
check('and the list maintains itself - that is the point of the column',
  who.length === 2, 'nothing was typed into the editor to get here');

// A viewer's address is stored and not written to. People who are not admins
// are not told when somebody asks a question.
setAccount('20000055', 'viewerpass', 'USER');
setDetails(MASTER, '20000055', 'A Viewer', 'viewer@youngone.com');
check('a viewer with an address is NOT emailed',
  alertList().indexOf('viewer@youngone.com') === -1,
  'only admins and above answer queries, so only they are told of one');

// Losing the role loses the alerts, with nothing else to remember.
vm.runInContext('masterSetRole', sb)(MASTER, '20217473', 'USER');
check('and taking admin away stops the emails on its own',
  alertList().indexOf('shahriar@youngone.com') === -1,
  'the list that needed editing by hand was the list of whoever was an ' +
  'admin on the day it was last edited');
vm.runInContext('masterSetRole', sb)(MASTER, '20217473', 'ADMIN');

// The extras are for addresses that have no account: a shared inbox, a
// manager who is not an admin.
// The property itself rather than setQuestionAlerts(), which lives in
// Questions.gs - this is the half being tested: that alertEmailList reads it
// and folds it in with the accounts.
vm.runInContext("PropertiesService.getScriptProperties()" +
  ".setProperty('EAS_QUESTION_ALERTS', 'desk@youngone.com,rudra@youngone.com');", sb);
who = alertList();
check('addresses with no account can still be added by hand',
  who.indexOf('desk@youngone.com') !== -1, who.join(', '));
check('and one that is both is emailed once, not twice',
  who.filter((a) => a === 'rudra@youngone.com').length === 1,
  who.join(', '));

// ---- a name survives everything that rewrites the row ----
// saveAccount writes the WHOLE row, so anything a caller rebuilds from
// scratch and forgets is erased. A password is reset far more often than a
// name changes.
reset(MASTER, '20217473');
check('resetting a password does not erase the name or the address',
  accountNameOf('20217473') === 'Shahriar K. Kabir' &&
  readAccounts()['20217473'].email === 'shahriar@youngone.com',
  'the reset rewrites the row around them');

const afterReset = login('20217473', vm.runInContext('RESET_PASSWORD', sb));
register(afterReset.setupToken, '20217473', 'brandnew1', 'brandnew1', '');
check('and nor does choosing a new password with the name box left empty',
  accountNameOf('20217473') === 'Shahriar K. Kabir',
  'an empty box is "nothing to add", not "forget me"');

// ---- and a new person gives one on the way in ----
const fresh = login(BOOTSTRAP, STARTING);
register(fresh.setupToken, '20991234', 'firstpass1', 'firstpass1', ' Nadia  Islam ');
check('somebody signing up for the first time is asked once, on that card',
  accountNameOf('20991234') === 'Nadia Islam',
  accountNameOf('20991234'));
check('and a blank one still creates the account',
  (function () {
    const other = login(BOOTSTRAP, STARTING);
    const made = register(other.setupToken, '20991235', 'firstpass1', 'firstpass1', '');
    return made.ok === true && accountNameOf('20991235') === '';
  })(),
  'a missing courtesy is no reason to refuse somebody an account');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
