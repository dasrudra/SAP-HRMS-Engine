// The functions you run by hand from the Apps Script editor.
//
// WHY THIS SUITE EXISTS
// listPersonModules() threw "Your session has ended. Reload the page and sign
// in again." the first time it was run - from the editor, where there is no
// page to reload and nobody signed in. It called getKpi1(null, month), and
// getKpi1 starts with requireSignedIn(token).
//
// runKpiSelfTest() had the identical bug and a comment asserting it did not
// ("run from the editor: the /dev shortcut covers it" - that shortcut is in
// doGet and does nothing here). Nobody had run it since the guard went in.
//
// Neither failure was reachable by any test that drove the browser, because in
// a browser there IS a token. So this suite calls them the way the editor does:
// no token, nothing.
//
//   node tests/editor-functions-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

const KPI = fs.readFileSync(path.join(SRC, 'Kpi.gs'), 'utf8');

// ---------------------------------------------------------------------------
// a spreadsheet, and an owner who is signed in to the editor
// ---------------------------------------------------------------------------
function makeSheet(rows) {
  const sheet = {
    rows: rows,
    getLastRow: () => sheet.rows.length + 1,
    getRange: function (r, c, n, w) {
      return {
        getValues: function () {
          const got = [];
          for (let i = 0; i < n; i++) {
            got.push((sheet.rows[r - 2 + i] || []).slice(c - 1, c - 1 + w));
          }
          return got;
        },
        setValues: function (values) {
          values.forEach(function (v, i) {
            const at = r - 2 + i;
            if (!sheet.rows[at]) sheet.rows[at] = [];
            v.forEach(function (cell, j) { sheet.rows[at][c - 1 + j] = cell; });
          });
          return this;
        },
        clearContent: function () { sheet.rows.length = 0; return this; },
        setNumberFormat: function () { return this; }
      };
    }
  };
  return sheet;
}

const logged = [];
const sb = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat, Set,
  Logger: { log: function () { logged.push(Array.prototype.slice.call(arguments)); } },
  Utilities: { getUuid: () => 'uuid', formatDate: (d) => String(d) },
  SpreadsheetApp: { flush: function () {} }
};
sb.globalThis = sb;
vm.createContext(sb);

vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), sb);
const INGEST = fs.readFileSync(path.join(SRC, 'Ingest.gs'), 'utf8');
vm.runInContext(INGEST.match(/const COL = \(function[\s\S]*?\}\)\(\);/)[0], sb);
vm.runInContext(INGEST.match(/function truthy[\s\S]*?\n}/)[0], sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8')
  .match(/function monthKey[\s\S]*?\n}/)[0], sb);

const CONFIG = vm.runInContext('CONFIG', sb);
const COL = vm.runInContext('COL', sb);

// Three tickets is enough: this suite is about whether the functions RUN.
const ticketRows = [
  ['Ayesha Spanner', 'PP Production', 0],
  ['Ayesha Spanner', 'MM Material', 0],
  ['Bilal Steady', 'MM Material', 2]
].map(function (t, i) {
  const row = new Array(COL.WIDTH).fill('');
  row[COL.TICKET_ID] = 'T-' + i;
  row[COL.SERVICE] = 'SAP';
  row[COL.PART] = t[1];
  row[COL.REQUEST_DATE] = '2026-08-05';
  row[COL.COMPLETION] = '2026-08-07';
  row[COL.DELAY_DAYS] = t[2];
  row[COL.IN_CHARGE] = t[0];
  row[COL.DEPARTMENT] = 'Manufacturing Applications';
  row[COL.IN_DEPT] = true;
  row[COL.IN_OVERALL] = true;
  return row;
});

const tabs = {};
tabs[CONFIG.SHEETS.TICKETS] = makeSheet(ticketRows);
tabs[CONFIG.SHEETS.KPI_MONTH] = makeSheet([]);
vm.runInContext('function sheetFor(name) { return TABS[name]; }', sb);
sb.TABS = tabs;

// requireSignedIn is what broke these. The real one, from Auth.gs, so this
// cannot pass against a stub that is kinder than production.
const AUTH = fs.readFileSync(path.join(SRC, 'Auth.gs'), 'utf8');
vm.runInContext(AUTH.match(/function requireSignedIn[\s\S]*?\n}/)[0], sb);
vm.runInContext('function currentSession(token) { return token ? { u: "x", r: "MASTER" } : null; }', sb);

// requireOwner passes: the editor is the owner's editor.
let ownerChecks = 0;
vm.runInContext('function requireOwner() { OWNER_CHECKS++; }', sb);
sb.OWNER_CHECKS = 0;

vm.runInContext(fs.readFileSync(path.join(SRC, 'Kpi.gs'), 'utf8'), sb);

// ---------------------------------------------------------------------------
// the guard is still a guard
// ---------------------------------------------------------------------------
const threw = (fn) => {
  try { fn(); return ''; } catch (e) { return String(e.message || e); }
};

// Score the tickets first, or every check below would be reading an empty
// cache and passing for the wrong reason.
vm.runInContext('recomputeKpiCache()', sb);

check('getKpi1 still refuses a caller with no token',
  /session has ended/i.test(threw(function () {
    vm.runInContext('getKpi1', sb)(null, '2026-08');
  })),
  'the endpoint a browser calls is unchanged');
check('and still answers one that has a token',
  vm.runInContext('getKpi1', sb)('a-token', '2026-08').hasData === true);

// ---------------------------------------------------------------------------
// and the editor functions no longer go through it
// ---------------------------------------------------------------------------
check('readKpi1 needs no token, because the editor has none to give',
  vm.runInContext('readKpi1', sb)('2026-08').hasData === true,
  'same figures, no session check');

const listErr = threw(function () { vm.runInContext('listPersonModules', sb)('2026-08'); });
check('listPersonModules runs from the editor',
  listErr === '', listErr || 'no error');

const selfErr = threw(function () { vm.runInContext('runKpiSelfTest', sb)(); });
check('runKpiSelfTest runs from the editor',
  selfErr === '', selfErr || 'no error');

const explainErr = threw(function () { vm.runInContext('explainModule', sb)('PP', '2026-08'); });
check('explainModule runs from the editor',
  explainErr === '', explainErr || 'no error');

// ---------------------------------------------------------------------------
// they are owner-only, every one of them
// ---------------------------------------------------------------------------
// Every global in an Apps Script project is reachable from a browser. These
// three print names, Part values and whole-team figures, and one of them
// rebuilds the entire cache - so the check is not optional.
check('all three ask requireOwner before doing anything',
  vm.runInContext('OWNER_CHECKS', sb) === 3,
  vm.runInContext('OWNER_CHECKS', sb) + ' of 3 checked');

['listPersonModules', 'runKpiSelfTest', 'explainModule'].forEach(function (name) {
  const body = KPI.slice(KPI.indexOf('function ' + name + '('));
  const head = body.slice(0, body.indexOf('\n}'));
  check('  ' + name + ' checks before it reads',
    head.indexOf('requireOwner()') !== -1 &&
    head.indexOf('requireOwner()') < head.indexOf('sheetFor') + head.length,
    'requireOwner() is in the first lines');
});

// ---------------------------------------------------------------------------
// and no editor function reaches for a token it cannot have
// ---------------------------------------------------------------------------
// The bug in one sentence: getKpi1(null, ...) does not skip the check, it
// fails it. Nothing in this file may do that again.
check('nothing passes a null token to a guarded endpoint',
  !/getKpi1\(\s*null/.test(KPI.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')),
  'use readKpi1(month) from the editor');

// ---------------------------------------------------------------------------
// the output is worth reading
// ---------------------------------------------------------------------------
const text = logged.map(function (args) {
  return args.map(String).join(' ');
}).join('\n');
check('listPersonModules prints each person, where their work mostly falls, and the spread',
  /Ayesha Spanner/.test(text) && /MOSTLY/.test(text) && /THE SPREAD/.test(text),
  (text.match(/Ayesha Spanner.*/) || [''])[0].trim());
check('and counts the people no single module would describe',
  /less than 80/.test(text) && /module - those are the ones/.test(text),
  (text.match(/.*people\..*less than 80.*/) || [''])[0].trim());
check('and marks the ones PERSON_MODULES places, so counted is not read as set',
  /listed in PERSON_MODULES/.test(text) && /counted, not set/.test(text));

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
