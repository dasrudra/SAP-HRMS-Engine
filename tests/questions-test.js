// The published FAQ: what it shows, and what editing it in the sheet costs.
//
// The conversation half of this file moved to Messenger.gs when the messenger
// replaced one-question-one-answer, and its tests moved to messenger-test.js
// with it. What is left is the part that answers a question before anybody has
// to ask it, and the thing that matters about it is that it is edited in a
// SPREADSHEET and not in a deployment:
//
//   - a database with no FAQ tab still shows something;
//   - the seed never overwrites an answer somebody improved by hand, or nobody
//     would dare improve one;
//   - and a half-written entry is not published, because a question on screen
//     with nothing underneath it is worse than no question.
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
    width: 0,
    getLastRow: function () { return sheet.rows.length + 1; },
    // The real one reports how wide the sheet actually is, which is what
    // sheetWithHeaders uses to decide whether a tab predates a column. Tracked
    // from every write, so a fake tab is as narrow as what was put in it.
    getLastColumn: function () { return sheet.width; },
    setFrozenRows: function () { return sheet; },
    appendRow: function (row) {
      sheet.rows.push(row.slice());
      sheet.width = Math.max(sheet.width, row.length);
      return sheet;
    },
    getRange: function (r, c, n, w) {
      const height = n === undefined ? 1 : n;
      const width = w === undefined ? 1 : w;
      sheet.width = Math.max(sheet.width, c - 1 + width);
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

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
