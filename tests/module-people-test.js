// The individuals table, sliced by module.
//
// WHAT THIS PROVES
// A person is not in exactly one module. moduleForTicket() takes the module
// off a ticket's own Part column first and only falls back to whose desk it
// landed on, so somebody whose role is PP handles MM tickets and those tickets
// ARE MM. That is why the By individuals table cannot filter by module just by
// hiding rows: it has to re-read each person's figures FOR THAT MODULE, or it
// shows a whole caseload under one module's name.
//
// So the round trip below is the point. Real tickets go through the real
// recomputeKpiCache(), the real getKpi1() reads them back, and the per-module
// figures are checked against hand-counted totals - not against the whole-
// person figures the same run produces.
//
// HOW TO RUN
//   node tests/module-people-test.js
// No dependencies. Everything it needs is in src/.
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

// ---- the cross-tab exists and is per person PER MODULE ----
const pairs = k.peopleByModule || [];
const key = (p) => p.module + ' / ' + p.name;
check('the rebuild writes one row per person-and-module pair, not per person',
  pairs.length === 4, pairs.length + ': ' + pairs.map(key).join(' | '));

const find = (mod, who) => pairs.filter((p) => p.module === mod && p.name === who)[0];

check('somebody who worked in two modules appears in both',
  Boolean(find('PP', 'Ayesha Spanner')) && Boolean(find('MM', 'Ayesha Spanner')),
  pairs.filter((p) => p.name === 'Ayesha Spanner').map((p) => p.module).join(' + '));

// ---- and the figures are the module's, not the person's ----
const nasirPP = find('PP', 'Ayesha Spanner');
const nasirMM = find('MM', 'Ayesha Spanner');
const nasirAll = k.people.filter((p) => p.name === 'Ayesha Spanner')[0];

check('their PP row counts their PP tickets only',
  nasirPP.received === 6 && nasirPP.delayed === 1 && nasirPP.successful === 5,
  [nasirPP.received, nasirPP.delayed, nasirPP.successful].join(' / '));
check('their MM row counts their MM tickets only',
  nasirMM.received === 2 && nasirMM.delayed === 0 && nasirMM.successful === 2,
  [nasirMM.received, nasirMM.delayed, nasirMM.successful].join(' / '));
check('and their whole-person row still counts everything',
  nasirAll.received === 8 && nasirAll.delayed === 1,
  nasirAll.received + ' / ' + nasirAll.delayed);

// The assertion the whole feature turns on. If these were equal, filtering by
// hiding rows would look correct and still be wrong.
check('the per-module rate DIFFERS from the whole-person rate',
  Math.abs(nasirPP.rate - nasirAll.rate) > 0.01,
  'PP ' + nasirPP.rate.toFixed(2) + '%  vs  all ' + nasirAll.rate.toFixed(2) + '%');
check('  and each is arithmetically right',
  Math.abs(nasirPP.rate - (5 / 6) * 100) < 0.01 &&
  Math.abs(nasirAll.rate - (7 / 8) * 100) < 0.01,
  nasirPP.rate.toFixed(2) + '% / ' + nasirAll.rate.toFixed(2) + '%');

// ---- bands are scored per module too ----
check('a module row is banded on its own rate',
  find('PP', 'Carim Struggler').rate === 0 &&
  find('PP', 'Carim Struggler').band === 'RED',
  find('PP', 'Carim Struggler').band);
check('and a clean one is GREEN',
  find('MM', 'Bilal Steady').rate === 100 && find('MM', 'Bilal Steady').band === 'GREEN',
  find('MM', 'Bilal Steady').band);

// ---- the section survives the extra key segment ----
// The scope value is 'Module :: Section :: Name'. Parsed wrongly, the section
// column would show the module, or the module would be swallowed.
// Nobody here is on the roster, so sectionFor() falls back to the ticket's own
// Department column - which is the path that matters here. What is being
// checked is that the extra key segment did not shift the parse: a section
// column showing 'PP' would mean the module had been read as the section.
check('each row still carries the person\'s section, not the module',
  pairs.every((p) => p.department === 'Manufacturing Applications') &&
  pairs.every((p) => p.department !== p.module),
  pairs.map((p) => p.department).filter((d, i, a) => a.indexOf(d) === i).join(' | '));
check('and the module is the module',
  pairs.every((p) => p.module === 'PP' || p.module === 'MM'),
  pairs.map((p) => p.module).filter((m, i, a) => a.indexOf(m) === i).join(' | '));

// ---- the totals must not have moved ----
// The cross-tab is extra rows on the same tab. If the reader double-counted
// them, every figure on the KPI 1 screen would be inflated.
check('the EAS total is unchanged by the extra rows',
  k.total.received === 13 && k.total.delayed === 3 && k.total.successful === 10,
  [k.total.received, k.total.delayed, k.total.successful].join(' / '));
check('and the whole-person list is still one row per person',
  k.people.length === 3, k.people.length + ': ' + k.people.map((p) => p.name).join(' | '));
check('and the module list is still one row per module',
  k.modules.length === 2 &&
  k.modules.filter((m) => m.name === 'PP')[0].received === 8,
  k.modules.map((m) => m.name + ':' + m.received).join(' | '));

// ---- an empty cross-tab must not break anything ----
// A database rebuilt before this scope existed has no PERSON_MODULE rows. The
// screen disables the filter and says why; nothing here may throw.
tabs[CONFIG.SHEETS.KPI_MONTH].rows =
  tabs[CONFIG.SHEETS.KPI_MONTH].rows.filter((r) => String(r[1]) !== 'PERSON_MODULE');
const stale = vm.runInContext('getKpi1', sb)('any-token', '2026-08');
check('a cache with no cross-tab still reads, with an empty list',
  Array.isArray(stale.peopleByModule) && stale.peopleByModule.length === 0 &&
  stale.people.length === 3,
  stale.peopleByModule.length + ' pairs, ' + stale.people.length + ' people');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
