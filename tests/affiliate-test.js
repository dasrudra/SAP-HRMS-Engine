// The affiliate filter on the By individuals table - the SERVER half.
//
// WHY THIS SUITE EXISTS AT ALL
// tests/filter-ui-test.js drives this filter in a real browser, and it passes
// whatever the server does, because a browser cannot run a .gs file: the
// harness answers listAffiliates and getPeopleByAffiliate from a fixture of
// its own. So that suite proves the DROPDOWN is wired and the note appears;
// it says nothing about the figures. Two deliberate breakages of Kpi.gs -
// dropping the blank-affiliate rows, and reporting every affiliate's count as
// the row total - left it green from end to end.
//
// This one runs the real readAffiliateList() and readPeopleByAffiliate()
// against a sheet just real enough, so the arithmetic has somewhere to fail.
//
//   node tests/affiliate-test.js
//
// WHAT AN AFFILIATE IS, AND WHY IT IS NOT A SECTION
// A section is a fact about a PERSON - one desk, one team. Filtering by it
// narrows who is listed and leaves every figure alone.
// An affiliate is a fact about a TICKET. The same person raises work for KSL
// and for TVL, so filtering by it cannot just hide rows: the figures beside
// the names it keeps have to be re-added up from that affiliate's tickets.
// The fixture below is built so those two readings give DIFFERENT numbers.
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
// This one also keeps a log of what was asked for. readAffiliateList() exists
// because the dropdown needs two columns and not the other thirty-odd, and a
// claim like that is only true while something checks it.
function makeSheet(name, rows) {
  const sheet = {
    name: name,
    rows: rows,                       // data rows only; row 1 is the header
    reads: [],
    getLastRow: () => sheet.rows.length + 1,
    getRange: function (r, c, n, w) {
      // Real Apps Script refuses a range of no rows - "The number of rows in
      // the range must be at least 1" - and an empty TICKETS tab is exactly
      // how a month starts. A fake that quietly returned [] instead would let
      // the early-exit guards be deleted without a single test going red.
      if (!(n >= 1) || !(w >= 1)) {
        throw new Error('The number of rows in the range must be at least 1');
      }
      sheet.reads.push({ row: r, col: c, height: n, width: w });
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
// Ayesha spans two affiliates and her three possible rates all differ, so a
// filter that merely hid rows would be caught:
//
//   Ayesha Spanner   KSL  5 tickets, 1 delayed  ->  4/5  =  80.00%
//                    TVL  3 tickets, 0 delayed  ->  3/3  = 100.00%
//                    whole person: 8, 1 delayed ->  7/8  =  87.50%
//   Bilal Steady     KSL  2 tickets, 0 delayed  ->  2/2  = 100.00%
//   Carim Struggler  ''   2 tickets, 2 delayed  ->  0/2  =   0.00%
//   Dina Later       ZZZ  1 ticket, SEPTEMBER   ->  must not reach August
//
// August totals: KSL 7, TVL 3, (none given) 2 = 12 tickets.
//
// INVENTED NAMES, ON PURPOSE. This repository is public, and a fixture that
// attached a 0% month to a real colleague's name would read as a statement
// about that person's work. The affiliate codes are the two real ones because
// they are company names, not people.
const TICKETS = [];
function ticket(id, affiliate, who, delayDays, month) {
  TICKETS.push({ id: id, affiliate: affiliate, who: who,
                 delay: delayDays, month: month || '2026-08' });
}
for (let i = 1; i <= 5; i++) ticket('T-K' + i, 'KSL', 'Ayesha Spanner', i === 1 ? 3 : 0);
for (let i = 1; i <= 3; i++) ticket('T-T' + i, 'TVL', 'Ayesha Spanner', 0);
for (let i = 1; i <= 2; i++) ticket('T-B' + i, 'KSL', 'Bilal Steady', 0);
for (let i = 1; i <= 2; i++) ticket('T-C' + i, '',    'Carim Struggler', 2);
ticket('T-D1', 'ZZZ', 'Dina Later', 0, '2026-09');

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

// The guard is the point of the endpoint pair, so it is not stubbed away
// silently: this records that it ran, and one assertion below proves the
// endpoint goes through it.
sb.GUARDED = [];
vm.runInContext('function requireSignedIn(token) { GUARDED.push(token); }', sb);

const CONFIG = vm.runInContext('CONFIG', sb);
const COL = vm.runInContext('COL', sb);

check('the Affiliate column is one the ingest already maps',
  typeof COL.AFFILIATE === 'number' && COL.AFFILIATE >= 0,
  'column ' + (COL.AFFILIATE + 1) + ' of the TICKETS tab');

// Now that COL is known, lay the tickets out as real sheet rows.
const ticketRows = TICKETS.map(function (t) {
  const row = new Array(COL.WIDTH).fill('');
  row[COL.TICKET_ID]    = t.id;
  row[COL.SERVICE]      = 'SAP';
  row[COL.PART]         = 'PP Production';
  row[COL.AFFILIATE]    = t.affiliate;
  row[COL.REQUEST_DATE] = t.month + '-05';
  row[COL.COMPLETION]   = t.month + '-07';
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

const readAffiliateList     = vm.runInContext('readAffiliateList', sb);
const readPeopleByAffiliate = vm.runInContext('readPeopleByAffiliate', sb);
const listAffiliates        = vm.runInContext('listAffiliates', sb);

// ---------------------------------------------------------------------------
// what fills the dropdown
// ---------------------------------------------------------------------------
tabs[CONFIG.SHEETS.TICKETS].reads.length = 0;
const list = readAffiliateList('2026-08');
const byAffiliate = {};
list.forEach(function (a) { byAffiliate[a.name] = a.tickets; });

check('the dropdown is filled from the tickets themselves',
  list.length === 3,
  list.map(function (a) { return a.name + ':' + a.tickets; }).join(' | '));
check('with each affiliate counted once per ticket',
  byAffiliate.KSL === 7 && byAffiliate.TVL === 3,
  'KSL ' + byAffiliate.KSL + ', TVL ' + byAffiliate.TVL + '  (want 7 and 3)');
check('the rows carrying no affiliate are named, not dropped',
  byAffiliate['(none given)'] === 2,
  'a silent drop would make the filtered totals disagree with the unfiltered ' +
  'ones for no reason anybody could see');
check('busiest affiliate first, so the useful one is not last',
  list[0].name === 'KSL',
  list.map(function (a) { return a.name; }).join(' > '));
check('and another month is another list',
  !byAffiliate.ZZZ,
  'ZZZ is a September affiliate and this was the August dropdown');

// The claim that justifies a second function instead of reusing readKpi1():
// filling a dropdown should not drag the whole sheet across.
const reads = tabs[CONFIG.SHEETS.TICKETS].reads;
check('and it reads two narrow columns, not the whole sheet',
  reads.length > 0 && reads.every(function (r) { return r.width === 1; }),
  reads.map(function (r) { return r.height + 'x' + r.width; }).join(' + ') +
  ' of ' + COL.WIDTH + ' columns');

// ---------------------------------------------------------------------------
// what the filter does to the figures
// ---------------------------------------------------------------------------
const all = readPeopleByAffiliate('2026-08', '');
const ksl = readPeopleByAffiliate('2026-08', 'KSL');
const tvl = readPeopleByAffiliate('2026-08', 'TVL');
const none = readPeopleByAffiliate('2026-08', '(none given)');

const person = (data, name) => data.people.filter(
  function (p) { return p.name === name; })[0];

check('no affiliate chosen is the whole caseload',
  all.people.length === 3 && person(all, 'Ayesha Spanner').received === 8,
  all.people.map(function (p) { return p.name + ':' + p.received; }).join(' | '));

check('choosing one lists only the people who worked on it',
  ksl.people.length === 2 && !person(ksl, 'Carim Struggler'),
  ksl.people.map(function (p) { return p.name; }).join(' | '));

// THE ASSERTION THIS SUITE IS FOR. 5, not 8.
check('and re-adds their figures up from that affiliate alone',
  person(ksl, 'Ayesha Spanner').received === 5 &&
  person(ksl, 'Ayesha Spanner').delayed === 1 &&
  person(ksl, 'Ayesha Spanner').successful === 4,
  [person(ksl, 'Ayesha Spanner').received,
   person(ksl, 'Ayesha Spanner').delayed,
   person(ksl, 'Ayesha Spanner').successful].join(' / ') +
  '  (8 / 1 / 7 would mean the filter only hid rows)');

check('so the rate moves with the figures',
  Math.abs(person(ksl, 'Ayesha Spanner').rate - 80) < 0.01 &&
  Math.abs(person(tvl, 'Ayesha Spanner').rate - 100) < 0.01 &&
  Math.abs(person(all, 'Ayesha Spanner').rate - 87.5) < 0.01,
  'KSL ' + person(ksl, 'Ayesha Spanner').rate.toFixed(2) + '%, ' +
  'TVL ' + person(tvl, 'Ayesha Spanner').rate.toFixed(2) + '%, ' +
  'both ' + person(all, 'Ayesha Spanner').rate.toFixed(2) + '%');

check('the blank affiliate is a choice like any other',
  none.people.length === 1 &&
  person(none, 'Carim Struggler').received === 2 &&
  person(none, 'Carim Struggler').rate === 0,
  none.people.map(function (p) { return p.name + ':' + p.rate + '%'; }).join(' | '));

// Nothing is lost and nothing is double-counted: the parts add up to the whole.
const summed = ksl.people.concat(tvl.people, none.people)
  .reduce(function (n, p) { return n + p.received; }, 0);
const whole = all.people.reduce(function (n, p) { return n + p.received; }, 0);
check('every ticket lands under exactly one affiliate',
  summed === whole && whole === 12,
  summed + ' across the affiliates, ' + whole + ' in the month');

check('and the month still holds while an affiliate is chosen',
  !person(ksl, 'Dina Later') && !person(all, 'Dina Later'),
  'Dina raised the September ticket');

// ---------------------------------------------------------------------------
// the dropdown does not collapse once it is used
// ---------------------------------------------------------------------------
// The affiliate counts are taken BEFORE the chosen one is applied, which is
// what lets the page keep a full dropdown while filtered. Count them after and
// the list shrinks to the one option already selected - a filter you cannot
// change back without reloading.
check('a filtered answer still carries the whole list of affiliates',
  ksl.affiliates.length === 3 &&
  ksl.affiliates.some(function (a) { return a.name === 'TVL'; }),
  ksl.affiliates.map(function (a) { return a.name + ':' + a.tickets; }).join(' | '));
check('with the counts of the whole month, not of the filtered slice',
  ksl.affiliates.filter(function (a) { return a.name === 'KSL'; })[0].tickets === 7 &&
  ksl.affiliates.filter(function (a) { return a.name === 'TVL'; })[0].tickets === 3,
  'TVL still reads ' +
  ksl.affiliates.filter(function (a) { return a.name === 'TVL'; })[0].tickets +
  ' while KSL is the one showing');

check('and it says which affiliate it answered for',
  ksl.affiliate === 'KSL' && all.affiliate === '' && ksl.hasData === true,
  'the page checks this before it believes the figures');

// ---------------------------------------------------------------------------
// the endpoint in front of them
// ---------------------------------------------------------------------------
sb.GUARDED.length = 0;
listAffiliates('a-token', '2026-08');
check('the endpoint checks the session before reading anything',
  sb.GUARDED.length === 1 && sb.GUARDED[0] === 'a-token',
  'every global in an Apps Script project is reachable from a browser');

// ---------------------------------------------------------------------------
// an empty month, and an empty sheet
// ---------------------------------------------------------------------------
const quiet = readPeopleByAffiliate('2026-07', '');
check('a month with no tickets says so rather than throwing',
  quiet.hasData === false && quiet.people.length === 0 &&
  quiet.affiliates.length === 0,
  'July had nothing in it');

const saved = tabs[CONFIG.SHEETS.TICKETS].rows.splice(0);
check('and nor does a sheet with nothing on it but a header',
  readAffiliateList('2026-08').length === 0 &&
  readPeopleByAffiliate('2026-08', '').hasData === false,
  'the first run of a new month, before the upload');
tabs[CONFIG.SHEETS.TICKETS].rows.push.apply(
  tabs[CONFIG.SHEETS.TICKETS].rows, saved);

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
