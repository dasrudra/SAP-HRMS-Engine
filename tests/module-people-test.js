// The By individuals table, and what the rebuild writes for it.
//
// The table filters by SECTION. A section is a fact about a person - one desk,
// one team, already beside their name - so the filter needs no derivation and
// the figures beside each name never change when it is applied.
//
// It filtered by MODULE for two steps and could not be made unambiguous. A
// module is what a TICKET was about, and people and work do not line up one to
// one: in the fixture below Ayesha has 6 PP tickets and 2 MM, so neither "her
// figures are 8" nor "her figures are 6" is right under a module heading. The
// cross-tab that made the module filter possible is gone with it, and this
// suite checks it is gone - it was about a hundred rows a month that nothing
// read.
//
//   node tests/module-people-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a spreadsheet just real enough
// ---------------------------------------------------------------------------
function makeSheet(name, rows) {
  const sheet = {
    name: name,
    rows: rows,                       // data rows only; row 1 is the header
    getLastRow: () => sheet.rows.length + 1,
    getRange: function (r, c, n, w) {
      return {
        getValues: function () {
          const got = [];
          for (let i = 0; i < n; i++) {
            const row = sheet.rows[r - 2 + i] || [];
            got.push(row.slice(c - 1, c - 1 + w));
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
        clearContent: function () {
          for (let i = 0; i < n; i++) sheet.rows[r - 2 + i] = [];
          sheet.rows.length = 0;
          return this;
        },
        setNumberFormat: function () { return this; }
      };
    }
  };
  return sheet;
}

// ---------------------------------------------------------------------------
// the tickets
// ---------------------------------------------------------------------------
// Deliberately built so one person spans two modules and the two figures
// disagree. If they agreed, a filter that merely hid rows would pass this
// suite and the real screen would still be wrong.
//
//   Spanner   6 PP tickets, 1 delayed    -> PP  83.33%
//             2 MM tickets, 0 delayed    -> MM 100.00%
//             whole person: 8, 1 delayed -> 87.50%
//   Steady    3 MM tickets, 0 delayed    -> MM 100.00%
//   Struggler 2 PP tickets, 2 delayed    -> PP   0.00%
//
// The Part column carries the module, which is what makes Spanner span two.
//
// INVENTED NAMES, ON PURPOSE. This repository is public, and a fixture that
// attached a 0% RED month to a real colleague's name would read as a statement
// about that person's work. It also keeps the suite independent of the roster
// in Config.gs, which changes when people join and leave.
const TICKETS = [];
function ticket(id, part, who, delayDays) {
  TICKETS.push({ id: id, part: part, who: who, delay: delayDays });
}
for (let i = 1; i <= 6; i++) ticket('T-P' + i, 'PP Production', 'Ayesha Spanner', i === 1 ? 3 : 0);
for (let i = 1; i <= 2; i++) ticket('T-N' + i, 'MM Material', 'Ayesha Spanner', 0);
for (let i = 1; i <= 3; i++) ticket('T-S' + i, 'MM Material', 'Bilal Steady', 0);
for (let i = 1; i <= 2; i++) ticket('T-X' + i, 'PP Production', 'Carim Struggler', 2);

// ---------------------------------------------------------------------------
// the sandbox
// ---------------------------------------------------------------------------
const sb = {
  console, Object, String, Number, Array, Math, JSON, RegExp,
  isFinite, Boolean, Error, parseInt, parseFloat, Infinity, Set,
  Date: Date,
  Logger: { log: () => {} },
  Utilities: { getUuid: () => 'uuid', formatDate: (d) => String(d) }
};
sb.globalThis = sb;
vm.createContext(sb);

vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Ingest.gs'), 'utf8')
  .match(/const COL = \(function[\s\S]*?\}\)\(\);/)[0], sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Ingest.gs'), 'utf8')
  .match(/function truthy[\s\S]*?\n}/)[0], sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8')
  .match(/function monthKey[\s\S]*?\n}/)[0], sb);
vm.runInContext('function requireSignedIn() {}', sb);

const CONFIG = vm.runInContext('CONFIG', sb);
const COL = vm.runInContext('COL', sb);

// Now that COL is known, lay the tickets out as real sheet rows.
const ticketRows = TICKETS.map(function (t) {
  const row = new Array(COL.WIDTH).fill('');
  row[COL.TICKET_ID]    = t.id;
  row[COL.SERVICE]      = 'SAP';
  row[COL.PART]         = t.part;
  row[COL.REQUEST_DATE] = '2026-08-05';
  row[COL.COMPLETION]   = '2026-08-07';
  row[COL.DELAY_DAYS]   = t.delay;
  row[COL.IN_CHARGE]    = t.who;
  row[COL.DEPARTMENT]   = 'Manufacturing Applications';
  row[COL.IN_DEPT]      = true;
  row[COL.IN_OVERALL]   = true;
  return row;
});

const tabs = {};
tabs[CONFIG.SHEETS.TICKETS]   = makeSheet('TICKETS', ticketRows);
tabs[CONFIG.SHEETS.KPI_MONTH] = makeSheet('KPI_MONTHLY', []);
vm.runInContext('function sheetFor(name) { return TABS[name]; }', sb);
sb.TABS = tabs;

vm.runInContext(fs.readFileSync(path.join(SRC, 'Kpi.gs'), 'utf8'), sb);

// ---------------------------------------------------------------------------
// the round trip
// ---------------------------------------------------------------------------
vm.runInContext('recomputeKpiCache()', sb);
const k = vm.runInContext('getKpi1', sb)('any-token', '2026-08');

check('the month scored at all', k.hasData === true && k.total.received === 13,
  k.total ? k.total.received + ' tickets' : '(nothing)');

// ---- the counts are per person, once ----
const byName = {};
k.people.forEach(function (p) { byName[p.name] = p; });

check('one row per person, whatever their tickets touched',
  k.people.length === 3, k.people.map(function (p) { return p.name; }).join(' | '));
check('and the figures are their whole caseload',
  byName['Ayesha Spanner'].received === 8 &&
  byName['Ayesha Spanner'].delayed === 1 &&
  byName['Ayesha Spanner'].successful === 7,
  [byName['Ayesha Spanner'].received, byName['Ayesha Spanner'].delayed].join(' / ') +
  '  (6 PP + 2 MM)');
check('with the rate computed over all of it',
  Math.abs(byName['Ayesha Spanner'].rate - (7 / 8) * 100) < 0.01,
  byName['Ayesha Spanner'].rate.toFixed(2) + '%');

// ---- the section is what the table filters by ----
// A section is a fact about a person: one desk, one team. It is already beside
// every name, needs no derivation and cannot be two things at once, which is
// why the filter is built on it and not on the module.
check('every individual carries the section they sit in',
  k.people.every(function (p) { return p.department === 'Manufacturing Applications'; }),
  k.people.map(function (p) { return p.department; })
    .filter(function (d, i, a) { return a.indexOf(d) === i; }).join(' | '));
check('and nothing claims a single module for them',
  k.people.every(function (p) { return p.module === undefined; }),
  'a person who works across two modules has no one true module');

// ---- the per-module totals are unaffected ----
// Dropping the person-and-module cross-tab must not touch what the By module
// table reads. Those rows are still grouped straight from the tickets.
check('the module totals still add up',
  k.modules.length === 2 &&
  k.modules.filter(function (m) { return m.name === 'PP'; })[0].received === 8 &&
  k.modules.filter(function (m) { return m.name === 'MM'; })[0].received === 5,
  k.modules.map(function (m) { return m.name + ':' + m.received; }).join(' | '));
check('and the EAS total is unchanged',
  k.total.received === 13 && k.total.delayed === 3 && k.total.successful === 10,
  [k.total.received, k.total.delayed, k.total.successful].join(' / '));

// ---- and nothing writes the cross-tab any more ----
const cacheRows = tabs[CONFIG.SHEETS.KPI_MONTH].rows;
check('the rebuild writes no PERSON_MODULE rows',
  !cacheRows.some(function (r) { return String(r[1]) === 'PERSON_MODULE'; }),
  'about a hundred rows a month that nothing read');
check('while every scope the screens do read is still written',
  ['EAS', 'DEPARTMENT', 'PART', 'MODULE', 'PERSON'].every(function (scope) {
    return cacheRows.some(function (r) { return String(r[1]) === scope; });
  }),
  cacheRows.map(function (r) { return String(r[1]); })
    .filter(function (v, i, a) { return a.indexOf(v) === i; }).join(' '));

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
