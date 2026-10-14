// Asking a question, answering it, and who may see what.
//
// The FAQ half is content. This is about the half that holds data somebody
// typed and hands it to other people:
//
//   - a question is attributed to the TOKEN, never to a field, so it cannot be
//     posted in somebody else's name;
//   - a person sees their own questions and nobody else's, decided on the
//     server, because an endpoint that returned everyone's and let the screen
//     hide the rest would hand the lot to anyone with a console open;
//   - answering needs ADMIN;
//   - AND THE EMAIL CANNOT LOSE A QUESTION. The row is written before the send
//     and the send is wrapped, so a throttled, unauthorised or misaddressed
//     mail costs a nudge and nothing else.
//
//   node tests/questions-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a spreadsheet, a cache and a post room
// ---------------------------------------------------------------------------
function makeSheet(name) {
  const sheet = {
    name: name,
    rows: [],                        // data rows only; row 1 is the header
    getLastRow: function () { return sheet.rows.length + 1; },
    setFrozenRows: function () { return sheet; },
    appendRow: function (row) { sheet.rows.push(row.slice()); return sheet; },
    getRange: function (r, c, n, w) {
      const height = n === undefined ? 1 : n;
      const width = w === undefined ? 1 : w;
      const api = {
        getValues: function () {
          const got = [];
          for (let i = 0; i < height; i++) {
            got.push((sheet.rows[r - 2 + i] || []).slice(c - 1, c - 1 + width));
          }
          return got;
        },
        setValues: function (values) {
          values.forEach(function (v, i) {
            const at = r - 2 + i;
            if (at < 0) return;                  // the header row
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
        setFontWeight: function () { return api; },
        setBackground: function () { return api; },
        setFontColor: function () { return api; },
        setNumberFormat: function () { return api; }
      };
      return api;
    }
  };
  return sheet;
}

const tabs = {};
const book = {
  getSheetByName: function (n) { return tabs[n] || null; },
  insertSheet: function (n) { tabs[n] = makeSheet(n); return tabs[n]; }
};

const sent = [];
let mailWorks = true;
const cache = {};
const props = { EAS_SPREADSHEET_ID: 'fake' };

const sb = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat, Set,
  Logger: { log: function () {} },
  SpreadsheetApp: { openById: function () { return book; } },
  PropertiesService: {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return k in props ? props[k] : null; },
        setProperty: function (k, v) { props[k] = v; },
        deleteProperty: function (k) { delete props[k]; }
      };
    }
  },
  CacheService: {
    getScriptCache: function () {
      return {
        get: function (k) { return k in cache ? cache[k] : null; },
        put: function (k, v) { cache[k] = v; },
        remove: function (k) { delete cache[k]; }
      };
    }
  },
  MailApp: {
    sendEmail: function (options) {
      // The real one throws when the daily quota is gone, when the script has
      // not been authorised for mail, and on a malformed address.
      if (!mailWorks) throw new Error('Service invoked too many times for one day: email.');
      sent.push(options);
    }
  },
  Utilities: {
    // The real one is unique per call, and that uniqueness is the only reason
    // the question IDs are unique, so a stub returning a constant would be
    // testing a different program. A seeded PRNG keeps every character varying
    // the way a real UUID does - a counter padded on the left would not, since
    // the caller keeps the FIRST few characters and throws the rest away.
    getUuid: (function () {
      let seed = 0x2f6e2b1;
      const hex = function () {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0).toString(16).padStart(8, '0').slice(0, 8);
      };
      return function () {
        const a = hex(), b = hex(), c = hex(), d = hex();
        return a + '-' + b.slice(0, 4) + '-' + b.slice(4) + '-' +
               c.slice(0, 4) + '-' + c.slice(4) + d;
      };
    })(),
    formatDate: function (d, tz, fmt) {
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      const at = new Date(d);
      return fmt
        .replace('yyyy', at.getUTCFullYear())
        .replace('MMM', 'Aug')
        .replace('MM', pad(at.getUTCMonth() + 1))
        .replace('dd', pad(at.getUTCDate()))
        .replace('d', at.getUTCDate())
        .replace('HHmmss', pad(at.getUTCHours()) + pad(at.getUTCMinutes()) +
                           pad(at.getUTCSeconds()))
        .replace('HH:mm', pad(at.getUTCHours()) + ':' + pad(at.getUTCMinutes()));
    }
  }
};
sb.globalThis = sb;
vm.createContext(sb);

vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), sb);
vm.runInContext('function getSpreadsheetId() { return "fake"; }', sb);
vm.runInContext('function CONFIG_TZ() { return "Asia/Dhaka"; }', sb);

// The guards are the point, so they are the real ones from Auth.gs wherever
// a real one can run here.
const AUTH = fs.readFileSync(path.join(SRC, 'Auth.gs'), 'utf8');
vm.runInContext(AUTH.match(/const ROLE_USER[\s\S]*?const ROLE_MASTER = 'MASTER';/)[0], sb);
vm.runInContext(AUTH.match(/const ROLE_RANK = \{[\s\S]*?\};/)[0], sb);
vm.runInContext(AUTH.match(/function rankOf[\s\S]*?\n}/)[0], sb);
vm.runInContext(AUTH.match(/function requireAdmin[\s\S]*?\n}/)[0], sb);
// Sessions: a token is 'ROLE:employeeId' here, and null is nobody.
vm.runInContext(
  'function currentSession(token) {' +
  '  if (!token) return null;' +
  '  var bits = String(token).split(":");' +
  '  return { u: bits[1], r: bits[0] };' +
  '}', sb);
vm.runInContext('function requireOwner() {}', sb);

vm.runInContext(fs.readFileSync(path.join(SRC, 'Questions.gs'), 'utf8'), sb);

const CONFIG = vm.runInContext('CONFIG', sb);
const ask = vm.runInContext('askQuestion', sb);
const mine = vm.runInContext('myQuestions', sb);
const all = vm.runInContext('listQuestions', sb);
const answer = vm.runInContext('answerQuestion', sb);
const waiting = vm.runInContext('unansweredQuestionCount', sb);

const USER = 'USER:20000001';
const OTHER = 'USER:20000002';
const ADMIN = 'ADMIN:20000099';
const threw = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message || e); } };

// ---------------------------------------------------------------------------
// asking
// ---------------------------------------------------------------------------
check('somebody who is not signed in cannot ask',
  ask(null, 'KPI 1', 'Why is this number what it is?').ok === false,
  ask(null, '', 'Why is this number what it is?').message);

const first = ask(USER, 'KPI 1', 'Why does August show 12 delayed for Sales?');
check('a signed-in person can', first.ok === true, first.message);

const stored = tabs[CONFIG.SHEETS.QUESTIONS].rows;
check('and the row records WHO from the token, not from the form',
  stored.length === 1 && stored[0][2] === '20000001',
  'From = ' + stored[0][2]);
check('with the question, the topic and a status of NEW',
  stored[0][4] === 'Why does August show 12 delayed for Sales?' &&
  stored[0][3] === 'KPI 1' && stored[0][5] === 'NEW',
  [stored[0][3], stored[0][5]].join(' / '));

check('an empty question is refused',
  ask(USER, '', '   ').ok === false, ask(USER, '', '  ').message);
check('and one longer than the limit',
  ask(USER, '', 'x'.repeat(CONFIG.QUESTION_MAX + 1)).ok === false,
  CONFIG.QUESTION_MAX + ' characters');
check('neither of which wrote a row',
  tabs[CONFIG.SHEETS.QUESTIONS].rows.length === 1,
  stored.length + ' row(s)');

// ---------------------------------------------------------------------------
// the email is a nudge, not the record
// ---------------------------------------------------------------------------
check('with nobody on the alert list, nothing is sent and the question still lands',
  sent.length === 0 && stored.length === 1,
  'setQuestionAlerts has not been run');

vm.runInContext('setQuestionAlerts', sb)('boss@example.com, lead@example.com');
const emailed = ask(USER, 'Logins', 'Can you reset my password please?');
check('with a list set, one email goes to all of them',
  emailed.ok === true && emailed.emailed === true && sent.length === 1 &&
  sent[0].to === 'boss@example.com,lead@example.com',
  sent[0].to);
check('and it carries the asker, the topic and the question itself',
  /20000001/.test(sent[0].body) && /Logins/.test(sent[0].body) &&
  /reset my password/.test(sent[0].body),
  sent[0].subject);
check('as plain text, so nothing somebody typed can be markup',
  sent[0].htmlBody === undefined && typeof sent[0].body === 'string');
check('and it says the asker will not be emailed back',
  /holds no address/.test(sent[0].body),
  'because an account here is an employee ID');

// THE ONE THAT MATTERS. A send that throws must not reach the caller: if it
// escapes, the screen shows a red error for a question that is sitting safely
// in the sheet, and the person types it again.
mailWorks = false;
let escaped = '';
let despite = { ok: false, emailed: null, message: '' };
try {
  despite = ask(USER, 'Reports', 'The download button gives me an empty file.');
} catch (e) {
  escaped = String(e.message || e);
}
mailWorks = true;
check('a question still lands when the email fails outright',
  !escaped && despite.ok === true &&
  tabs[CONFIG.SHEETS.QUESTIONS].rows.length === 3,
  escaped ? 'the send threw all the way out: ' + escaped
          : 'quota, authorisation and a bad address all throw the same way');
check('and it says so rather than claiming it was sent',
  despite.emailed === false && !/Sent\./.test(despite.message) &&
  /Sent\./.test(emailed.message),
  'failed: "' + despite.message + '" / sent: "' + emailed.message + '"');

// ---------------------------------------------------------------------------
// one person's questions are one person's
// ---------------------------------------------------------------------------
ask(OTHER, 'MM', 'Who do I ask about a purchase order?');

const theirs = mine(USER);
check('a person sees their own questions',
  theirs.length === 3, theirs.length + ' of 4');
check('and nobody else is in that list',
  !theirs.some(function (q) { return /purchase order/.test(q.question); }),
  'filtered on the server, not on the screen');
check('their own employee ID is not echoed back at them either',
  theirs.every(function (q) { return q.from === undefined; }),
  'they know who they are');
check('somebody signed out gets nothing rather than everything',
  mine(null).length === 0);

// ---------------------------------------------------------------------------
// answering
// ---------------------------------------------------------------------------
check('listing every question needs ADMIN',
  /admin login/i.test(threw(function () { all(USER); })),
  threw(function () { all(USER); }));
check('and an admin gets the lot, newest first',
  all(ADMIN).length === 4 && /purchase order/.test(all(ADMIN)[0].question),
  all(ADMIN).map(function (q) { return q.topic || '-'; }).join(' | '));

check('answering needs ADMIN too',
  /admin login/i.test(threw(function () { answer(USER, first.id, 'Because.'); })),
  'hiding the box is not what stops them');

const done = answer(ADMIN, first.id, 'Four of them were logged against the wrong section.');
check('an admin can answer', done.ok === true, done.message);
check('and the answer lands on the asker\'s own copy',
  mine(USER).filter(function (q) { return q.id === first.id; })[0].answer ===
    'Four of them were logged against the wrong section.',
  'one question, one answer, one place to look');
check('with who answered it recorded',
  all(ADMIN).filter(function (q) { return q.id === first.id; })[0].answeredBy === '20000099',
  'answered by 20000099');
check('answering again replaces it, for a reply sent too fast',
  answer(ADMIN, first.id, 'Corrected: three of them.').ok === true &&
  /three/.test(mine(USER).filter(function (q) { return q.id === first.id; })[0].answer),
  'not a second row');
check('an answer to a question that is gone says so',
  answer(ADMIN, 'Q-nope', 'Hello').ok === false,
  answer(ADMIN, 'Q-nope', 'Hello').message);
check('and an empty answer is refused',
  answer(ADMIN, first.id, '  ').ok === false);

check('the waiting count is what is still unanswered',
  waiting() === 3, waiting() + ' of 4');

// ---------------------------------------------------------------------------
// the rate limit protects the email quota
// ---------------------------------------------------------------------------
// A consumer Google account may send 100 recipients a day. One accidental
// double-click on a slow connection should not cost five of them.
const burst = [];
for (let i = 0; i < CONFIG.QUESTION_RATE_PER_HOUR + 3; i++) {
  burst.push(ask(OTHER, '', 'Question number ' + i + ' in a hurry.'));
}
const allowed = burst.filter(function (r) { return r.ok; }).length;
check('one person is capped per hour',
  allowed < burst.length && allowed <= CONFIG.QUESTION_RATE_PER_HOUR,
  allowed + ' of ' + burst.length + ' accepted, cap is ' +
  CONFIG.QUESTION_RATE_PER_HOUR);
check('and the refusal says when to come back rather than just failing',
  /limit/i.test(burst[burst.length - 1].message),
  burst[burst.length - 1].message);
check('somebody else is not caught by their neighbour\'s burst',
  ask(ADMIN, '', 'A different person asking a question.').ok === true,
  'the cap is per person');

// ---------------------------------------------------------------------------
// the FAQ
// ---------------------------------------------------------------------------
const faq = vm.runInContext('faqEntries', sb);
const seeded = faq();
check('a database with no FAQ tab still shows the seed',
  seeded.length === CONFIG.FAQ_SEED.length && Boolean(seeded[0].question),
  seeded.length + ' entries');

vm.runInContext('syncFaqSheet', sb)();
check('syncFaqSheet writes the seed onto the tab',
  tabs[CONFIG.SHEETS.FAQ].rows.length === CONFIG.FAQ_SEED.length,
  tabs[CONFIG.SHEETS.FAQ].rows.length + ' rows');

// An edited answer must survive the next run, or nobody would dare edit one.
tabs[CONFIG.SHEETS.FAQ].rows[0][2] = 'An answer somebody improved by hand.';
vm.runInContext('syncFaqSheet', sb)();
check('and running it again keeps an answer that was edited',
  tabs[CONFIG.SHEETS.FAQ].rows[0][2] === 'An answer somebody improved by hand.' &&
  tabs[CONFIG.SHEETS.FAQ].rows.length === CONFIG.FAQ_SEED.length,
  'edit in the sheet, not in a deployment');
check('and the screen reads the edited one, not the seed',
  faq().filter(function (e) {
    return e.answer === 'An answer somebody improved by hand.';
  }).length === 1);

// A row with half of it filled in is not an entry.
tabs[CONFIG.SHEETS.FAQ].rows.push([99, 'A question with no answer yet', '', '']);
check('a half-written entry is not published',
  !faq().some(function (e) { return /no answer yet/.test(e.question); }),
  'a question on screen with nothing under it is worse than no question');

// ---------------------------------------------------------------------------
// the reference has to be unique
// ---------------------------------------------------------------------------
// Two people asking in the same second must not be handed the same reference.
// They were. The suffix was three random digits, so nine questions inside one
// second collided about 4% of the time, answerQuestion found two matching rows
// and wrote the answer to the first - and somebody would open the Help screen
// and read a reply to a question a colleague had asked. It showed up here as a
// one-in-eighty flake in the three answering assertions, which is the only way
// a bug of this shape ever announces itself.
//
// Last, because proving it needs far more questions than one person may ask in
// an hour, and the cap has to come off to get them.
const CAP = CONFIG.QUESTION_RATE_PER_HOUR;
CONFIG.QUESTION_RATE_PER_HOUR = 500;
const ids = [];
for (let i = 0; i < 300; i++) {
  ids.push(ask('USER:20000050', 'Burst', 'Question ' + i + ' in the same second.').id);
}
CONFIG.QUESTION_RATE_PER_HOUR = CAP;
const got = ids.filter(Boolean);
check('questions asked in the same second get different references',
  got.length === 300 && new Set(got).size === 300,
  got.length + ' asked, ' + new Set(got).size + ' distinct');
check('and the reference still starts with the date, so a sheet sorts by it',
  /^Q\d{8}-\d{6}-[0-9A-F]{6}$/.test(got[0]), got[0]);

// If one ever does slip through - somebody pastes over the Id column, or sorts
// the tab badly - answering must refuse rather than pick a row.
const qTab = tabs[CONFIG.SHEETS.QUESTIONS];
qTab.rows[qTab.rows.length - 1][0] = qTab.rows[qTab.rows.length - 2][0];
const clashed = qTab.rows[qTab.rows.length - 1][0];
const refused = answer(ADMIN, clashed, 'An answer that must not be guessed at.');
check('and a duplicated reference is refused, not guessed at',
  refused.ok === false && /share that reference/.test(refused.message),
  refused.message);
check('leaving both rows untouched rather than answering one of them',
  qTab.rows.slice(-2).every(function (r) {
    return r[5] === 'NEW' && !r[8];
  }),
  'an answer on the wrong row cannot be taken back');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
