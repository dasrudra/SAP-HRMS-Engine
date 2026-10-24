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

// What a call threw, as text - so a guard test can tell "refused because
// you are not a master" from "crashed on the way", which both look like
// a thrown exception and are not the same result at all.
const threwFrom = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message || e); } };

const RESET_PW = vm.runInContext('RESET_PASSWORD', sb);
const BOOTSTRAP = vm.runInContext('BOOTSTRAP_USER', sb);
const login = vm.runInContext('login', sb);
const register = vm.runInContext('registerAccount', sb);
const signUp = vm.runInContext('createAccount', sb);
const setAccount = vm.runInContext('setAccount', sb);
const readAccounts = vm.runInContext('readAccounts', sb);
const reset = vm.runInContext('masterResetPassword', sb);
const issueToken = vm.runInContext('issueToken', sb);
const setSignups = vm.runInContext('masterSetSignups', sb);
const signupsOpen = vm.runInContext('signupsOpen', sb);
const invite = vm.runInContext('masterGrantToEmployeeId', sb);

vm.runInContext('seedCredentials();', sb);
setAccount('20536723', 'rudrapass', 'MASTER');
const MASTER = issueToken('20536723', 'MASTER');

// ---------------------------------------------------------------------------
// the door everybody comes in by
// ---------------------------------------------------------------------------
check('a fresh install leaves the door open rather than shut',
  signupsOpen() === true,
  'a control defaulting to closed stops a rollout dead on the day it ships');

check('there is no shared starting login any more',
  login(BOOTSTRAP, RESET_PW).ok === false &&
  !readAccounts()[BOOTSTRAP],
  'seedCredentials used to create one; it creates nothing now');

// AND AN INSTALLATION THAT STILL HAS THE OLD ROW IS NO WORSE OFF.
// Every dashboard already running has a 'user' row on its ACCOUNTS tab with
// the published password on it. Deploying this must shut that door on the
// spot, without waiting for anybody to remember to delete the row - which is
// exactly the kind of step that does not get done.
setAccount(BOOTSTRAP, RESET_PW, 'USER');
check('and a leftover one is refused with its own password',
  Boolean(readAccounts()[BOOTSTRAP]) &&
  login(BOOTSTRAP, RESET_PW).ok === false,
  'the row is still there and it opens nothing');
check('refused with the same words as any employee ID nobody has used',
  login(BOOTSTRAP, RESET_PW).message === login('20999999', 'whatever').message,
  'or the difference between the two answers tells you the row exists');
check('and the master can delete it, which was once refused',
  (function () {
    vm.runInContext('masterRemoveAccount', sb)(MASTER, BOOTSTRAP);
    return !readAccounts()[BOOTSTRAP];
  })(),
  'it used to be undeletable, because without it nobody could sign up');

const made = signUp('20217473', '  Shahriar   Kabir ', 'shahriar@youngone.com',
                    'bosspass1');
check('somebody creates their own login in one step', made.ok === true, made.message);
check('and is signed in there and then, with no second card',
  Boolean(made.token) && made.setup === false && made.username === '20217473',
  'username = ' + made.username);
check('their username IS their employee ID, and cannot be anything else',
  Boolean(readAccounts()['20217473']) &&
  signUp('shahriar', 'Shahriar', '', 'bosspass1').ok === false,
  'digits only - the number on the ID card');

check('the name is kept against that ID, tidied',
  readAccounts()['20217473'].fullName === 'Shahriar Kabir',
  '"' + readAccounts()['20217473'].fullName + '"');
check('and so is the email, which was optional',
  readAccounts()['20217473'].email === 'shahriar@youngone.com');
check('a new login is a VIEWER, never an admin',
  readAccounts()['20217473'].role === 'USER',
  'admin is granted afterwards, never claimed on the way in');

// What is required, and what is not.
check('a name is required',
  signUp('20900101', '   ', '', 'goodpass1').ok === false,
  signUp('20900101', '', '', 'goodpass1').message);
check('an email is not',
  (function () {
    const r = signUp('20900101', 'No Address', '', 'goodpass1');
    return r.ok === true && readAccounts()['20900101'].email === '';
  })(),
  'optional means optional');
check('but a bad one is refused rather than stored',
  signUp('20900102', 'Typo Person', 'not-an-address', 'goodpass1').ok === false,
  signUp('20900103', 'Typo Person', 'not-an-address', 'goodpass1').message);
check('and a short password is refused',
  signUp('20900104', 'Short Pass', '', 'abc').ok === false);

// THE TAKEOVER THAT MUST NOT WORK.
const takeover = signUp('20217473', 'Not Shahriar', '', 'stealing123');
check('signing up with an employee ID that already has a login is refused',
  takeover.ok === false && /already a login/.test(takeover.message),
  takeover.message);
check('and the account it was aimed at is untouched',
  login('20217473', 'bosspass1').ok === true &&
  login('20217473', 'stealing123').ok === false,
  'the password typed at the wrong door did not take');

// ---------------------------------------------------------------------------
// what the sign-in card says when there is no account
// ---------------------------------------------------------------------------
// Somebody who has never signed up types their employee ID and a password
// they have just invented. Telling them the two "do not match" sends them off
// to try it again; there was nothing on the screen to suggest they had no
// account at all.
const never = login('20900900', 'anything123');
check('an employee ID with no login is told exactly that',
  never.ok === false && /no login for that employee ID/i.test(never.message),
  never.message);
check('and pointed at the card that makes one',
  /create your login/i.test(never.message),
  'while the door is open, that is the whole answer');

// A WRONG PASSWORD ON AN ACCOUNT THAT EXISTS STILL SAYS ONLY THAT. The two
// are different answers to different questions, and the one thing that must
// not happen is "no such account" leaking for an account that does exist.
const badPass = login('20217473', 'notmypassword');
check('but a wrong password on a real account says only that',
  badPass.ok === false &&
  /do not match/i.test(badPass.message) &&
  !/no login/i.test(badPass.message),
  badPass.message);


// ---------------------------------------------------------------------------
// closing the door
// ---------------------------------------------------------------------------
const viewerTried = threwFrom(function () {
  setSignups(issueToken('20217473', 'USER'), false);
});
check('closing it is master-only',
  /master/i.test(viewerTried),
  viewerTried || '(it did not refuse at all)');

setSignups(MASTER, false);
check('once closed, nobody can create a login from nothing',
  signupsOpen() === false &&
  signUp('20900200', 'Too Late', '', 'goodpass1').ok === false,
  signUp('20900201', 'Too Late', '', 'goodpass1').message);
check('and the refusal says what to do instead',
  /ask the EAS team/i.test(signUp('20900202', 'Too Late', '', 'goodpass1').message),
  'a closed door that explains nothing is a support call');

// And the sign-in card stops offering a card nobody can use.
const afterClose = login('20900901', 'anything123');
check('the sign-in card stops pointing at a closed door',
  /no login for that employee ID/i.test(afterClose.message) &&
  !/create your login/i.test(afterClose.message) &&
  /ask the EAS team/i.test(afterClose.message),
  afterClose.message);

// ---------------------------------------------------------------------------
// the reset, which closing the door must not break
// ---------------------------------------------------------------------------
const done = reset(MASTER, '20217473');
check('a master can still reset a password with sign-ups closed',
  done.ok === true, done.message);
check('and is told the password it went back to',
  done.password === RESET_PW, done.password);
check('the old password stops working',
  login('20217473', 'bosspass1').ok === false,
  'otherwise a reset would not be one');
check('his role survived it',
  readAccounts()['20217473'].role === 'USER' &&
  readAccounts()['20217473'].mustChange === true);

const his = login('20217473', RESET_PW);
check('his employee ID opens with the reset password',
  his.ok === true, 'because that is what the reset put back');
check('and it does NOT sign him straight in',
  his.setup === true && !his.token,
  'a password somebody else chose gets you as far as choosing your own');
check('the card knows who he is',
  his.username === '20217473' && Boolean(his.setupToken));
check('and does not ask for a name it already has',
  his.needsName === false,
  'he gave one when he signed up; asking again is asking twice');

const wrongId = register(his.setupToken, '20536723', 'nicetry123');
check('a card bound to him cannot set anybody else\'s password',
  wrongId.ok === false && /password reset for employee ID 20217473/.test(wrongId.message),
  wrongId.message);

const set = register(his.setupToken, '20217473', 's4hana1929#');
check('but it does set his', set.ok === true, set.message);
check('and signs him in there and then', Boolean(set.token));
check('his name and email came through the reset untouched',
  readAccounts()['20217473'].fullName === 'Shahriar Kabir' &&
  readAccounts()['20217473'].email === 'shahriar@youngone.com',
  'the reset rewrites the row around them');
check('the flag is cleared, so next time is an ordinary sign-in',
  readAccounts()['20217473'].mustChange === false);
check('the new password works',
  login('20217473', 's4hana1929#').ok === true);
check('and the reset password no longer opens his account',
  login('20217473', RESET_PW).ok === false,
  'or every reset would leave a second way in forever');

// ---------------------------------------------------------------------------
// the one door left open when sign-ups are closed
// ---------------------------------------------------------------------------
// A new joiner. The master writes the employee ID down first; that IS the
// invitation, and it is the only way an account appears once the door is shut.
const joined = invite(MASTER, '20900300', 'USER');
check('the master can still admit one named person',
  joined.ok === true && joined.invited === true, joined.password);

const theirs = login('20900300', RESET_PW);
check('who signs in with the reset password and is sent to the card',
  theirs.ok === true && theirs.setup === true && !theirs.token);
check('and IS asked for a name, having never given one',
  theirs.needsName === true,
  'written down by somebody else, so nothing about them is filled in yet');

const nameless = register(theirs.setupToken, '20900300', 'theirpass1');
check('so the card refuses to finish without one',
  nameless.ok === false && /name/i.test(nameless.message), nameless.message);

const finished = register(theirs.setupToken, '20900300', 'theirpass1',
                          'Nadia Islam', 'nadia@youngone.com');
check('and finishes once it is given',
  finished.ok === true && Boolean(finished.token), finished.message);
check('with the name and email stored against that ID',
  readAccounts()['20900300'].fullName === 'Nadia Islam' &&
  readAccounts()['20900300'].email === 'nadia@youngone.com');

setSignups(MASTER, true);
check('and the door can be opened again',
  signupsOpen() === true && signUp('20900400', 'Later Joiner', '', 'goodpass1').ok === true);


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
setAccount('20217999', 'legacypass', 'ADMIN');     // no name, no email
check('while the rows written before it read back blank, not broken',
  accountNameOf('20217999') === '',
  'which is what "this was written before we asked" should look like');

// ---- somebody setting their own ----
const BOSS = issueToken('20217999', 'ADMIN');
check('somebody signed out cannot set a name',
  setMyName(null, 'Nobody').ok === false, setMyName(null, 'X').message);
check('and an empty one is refused rather than stored',
  setMyName(BOSS, '   ').ok === false, setMyName(BOSS, '  ').message);

check('a signed-in person can set their own',
  setMyName(BOSS, '  Imran   Hossain ').ok === true);
check('tidied on the way in, so one person is stored one way',
  accountNameOf('20217999') === 'Imran Hossain',
  '"' + accountNameOf('20217999') + '"');

// The ID comes from the token. Without that, the name box on the panel would
// be a way to rename a colleague.
check('and it is THEIR account, whatever else is passed',
  accountNameOf('20536723') === '',
  'the employee ID is taken from the signed token, never from the call');

// ---- the master correcting one, and setting where alerts go ----
check('a name is not something an ordinary admin can change for somebody else',
  /master/i.test(threwFrom(() => setDetails(BOSS, '20536723', 'Imposter', ''))),
  threwFrom(() => setDetails(BOSS, '20536723', 'Imposter', '')));

setDetails(MASTER, '20217999', 'Imran K. Hossain', 'imran@youngone.com');
check('the master can correct a name',
  accountNameOf('20217999') === 'Imran K. Hossain',
  accountNameOf('20217999'));
check('and set the address that account is told at',
  readAccounts()['20217999'].email === 'imran@youngone.com',
  readAccounts()['20217999'].email);
check('an address that is not one is refused, not stored',
  /email address/i.test(threwFrom(() => setDetails(MASTER, '20217999', undefined, 'imran.at.work'))) &&
  readAccounts()['20217999'].email === 'imran@youngone.com',
  'the one already there is left alone');

// undefined means "leave it", '' means "clear it". Without that difference,
// setting an email would blank a name and there would be no way to remove a
// wrong address.
setDetails(MASTER, '20217999', undefined, undefined);
check('leaving both out changes neither',
  accountNameOf('20217999') === 'Imran K. Hossain' &&
  readAccounts()['20217999'].email === 'imran@youngone.com',
  'undefined is "leave it alone"');

// ---- who gets the email ----
setDetails(MASTER, '20536723', 'Rudra Das', 'rudra@youngone.com');
let who = alertList();
check('every admin and master with an address is emailed',
  who.indexOf('rudra@youngone.com') !== -1 &&
  who.indexOf('imran@youngone.com') !== -1,
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
vm.runInContext('masterSetRole', sb)(MASTER, '20217999', 'USER');
check('and taking admin away stops the emails on its own',
  alertList().indexOf('imran@youngone.com') === -1,
  'the list that needed editing by hand was the list of whoever was an ' +
  'admin on the day it was last edited');
vm.runInContext('masterSetRole', sb)(MASTER, '20217999', 'ADMIN');

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
reset(MASTER, '20217999');
check('resetting a password does not erase the name or the address',
  accountNameOf('20217999') === 'Imran K. Hossain' &&
  readAccounts()['20217999'].email === 'imran@youngone.com',
  'the reset rewrites the row around them');

const afterReset = login('20217999', vm.runInContext('RESET_PASSWORD', sb));
register(afterReset.setupToken, '20217999', 'brandnew1');
check('and nor does choosing a new password with the name box left empty',
  accountNameOf('20217999') === 'Imran K. Hossain',
  'an empty box is "nothing to add", not "forget me"');

// ---- and a new person gives one on the way in ----
setSignups(MASTER, true);
signUp('20991234', ' Rumana  Akter ', '', 'firstpass1');
check('somebody signing up gives a name on the way in, and it is kept',
  accountNameOf('20991234') === 'Rumana Akter',
  accountNameOf('20991234'));
check('and the sign-up card will not finish without one',
  signUp('20991235', '  ', '', 'firstpass1').ok === false,
  'it is what every message they send is signed with');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
