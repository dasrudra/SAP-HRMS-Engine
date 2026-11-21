/**
 * kpi-equivalence-test.js - the KPI port must answer exactly what Kpi.gs does.
 * ===========================================================================
 *
 *     cd api
 *     node kpi-equivalence-test.js
 *
 * Needs nothing switched on - no server, no database. It is arithmetic.
 *
 * THE SAME IDEA AS equivalence-test.js, AND FOR THE SAME REASON. A port can
 * be self-consistent, well tested and still quietly disagree with the system
 * it replaces. So this file does not describe the expected answers at all:
 * it lifts the real functions out of src/Kpi.gs and src/Config.gs, runs them
 * beside the ported ones, and demands identical output.
 *
 * That approach has already earned its place once on this project. The
 * objectives equivalence test found a hard-coded five-day working week on
 * its first run, where Config.gs says six - an error no self-written test
 * could have caught, because those tests were written from the same wrong
 * assumption.
 *
 * WHAT IS COMPARED
 *
 *   isCompleted      20 cell shapes, including the whitespace-only dates
 *                    that cost the August figure a ticket
 *   toNumber         24 values - ints, floats, strings, junk, negatives
 *   bandFor          the two boundaries to four decimal places, both sides
 *   achievementFor   the same rates
 *   headroomFor      every completed/successful pair up to 40 x 40
 *   scoreRows        2,000 generated ticket sets
 *   monthsInScope    months, quarters, lists, ALL, junk
 *   quarterOf        48 months x 2 schemes
 *   monthsOfQuarter  16 quarters x 2 schemes
 *   quarterLabel     the same keys plus junk
 *   groupBy          generated tables, checking order as well as contents
 *
 * WHEN Kpi.gs CHANGES, THIS FAILS. That is the point: it means the port has
 * drifted and must be brought back, not that the test is wrong.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const port = require('./kpi');

/*
  TWO SCHEMES THAT DO NOT EXIST IN Config.gs, ADDED HERE BEFORE ANYTHING IS
  LIFTED - and this needs justifying rather than just doing.

  monthsOfQuarter carries real arithmetic for a company year that does not
  start in January:

      const y = year + Math.floor((n - 1) / 12);     // the quarter crosses
      if (rules.yearFrom === 'end' ...) year -= 1;   // the calendar year

  Config.gs sets both KPIs to startMonth 1 today, which makes every one of
  those branches unreachable - n never exceeds 12, yearFrom is never 'end'.
  A deliberate break of the first line SURVIVED the whole suite, because
  nothing could reach it.

  The branches are not dead code by mistake. Kpi.gs documents them:
  "a company year that starts in April is described in one place rather
  than assumed in several ... With startMonth 4, '2026-Q4' is January to
  March of 2027." They exist so that changing one line of Config.gs works.
  Untested, that line would be changed one day and the port would silently
  disagree with Kpi.gs about which months a quarter covers.

  So the schemes are added to the PORT's exported table and the sandbox's
  CONFIG is then built from it, which means both sides are asked the same
  question. Nothing in production asks for a scheme by these names, and
  quarterScheme falls back to RESOLUTION for anything it does not know -
  which is itself compared below, with 'NOT_A_SCHEME'.
*/
port.QUARTERS.TEST_APRIL_START = { startMonth: 4, yearFrom: 'start' };
port.QUARTERS.TEST_APRIL_END   = { startMonth: 4, yearFrom: 'end' };

const KPI_GS = path.join(__dirname, '..', 'src', 'Kpi.gs');
const CONFIG_GS = path.join(__dirname, '..', 'src', 'Config.gs');

const FROM_KPI = ['scoreRows', 'isCompleted', 'toNumber', 'groupBy',
                  'groupByKey', 'monthsInScope', 'quarterScheme',
                  'monthsOfQuarter', 'quarterOf', 'quarterLabel', 'round2'];

const FROM_CONFIG = ['bandFor', 'achievementFor', 'headroomFor'];


/*
  Pulls each function out of the .gs text and runs it in a sandbox with the
  handful of globals it reads.

  WHY LIFT RATHER THAN require(): Kpi.gs calls SpreadsheetApp and CacheService
  at load time and Config.gs is 2,700 lines of the same. None of that exists
  here and none of it is needed - the functions under test are pure.
*/
function lift(file, names, prelude) {
  const src = fs.readFileSync(file, 'utf8');
  let code = prelude || '';

  names.forEach(function (name) {
    const re = new RegExp('\\nfunction ' + name +
                          '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
    const found = src.match(re);
    if (!found) {
      console.error('');
      console.error('  Could not find function ' + name + ' in ' +
                    path.basename(file));
      console.error('  Either it was renamed, or this test needs updating.');
      process.exit(1);
    }
    code += found[0] + '\n';
  });

  code += 'module.exports = { ' + names.join(', ') + ' };';

  const sandbox = {
    module: { exports: {} },
    Date: Date, Math: Math, Number: Number, String: String,
    Object: Object, Array: Array, isNaN: isNaN, parseFloat: parseFloat
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}

/*
  The globals Kpi.gs reads. COL is built from CONFIG.TICKET_COLUMNS in
  Ingest.gs; only the two indexes scoreRows touches matter, and they are
  taken from the real column list rather than typed in, so that reordering
  the tab breaks this test instead of silently rescoring everything.
*/
const TICKET_COLUMNS = (function () {
  const src = fs.readFileSync(CONFIG_GS, 'utf8');
  const block = src.match(/TICKET_COLUMNS:\s*\[([\s\S]*?)\n  \],/);
  if (!block) {
    console.error('  Could not read TICKET_COLUMNS from Config.gs');
    process.exit(1);
  }
  const names = [];
  block[1].split('\n').forEach(function (line) {
    const hit = line.match(/^\s*'([^']+)'/);
    if (hit) names.push(hit[1]);
  });
  return names;
})();

const COL_COMPLETION = TICKET_COLUMNS.indexOf('Completion Date');
const COL_DELAY = TICKET_COLUMNS.indexOf('Delay Days');

const KPI_PRELUDE =
  'const ALL_MONTHS = ' + JSON.stringify(port.ALL_MONTHS) + ';\n' +
  'const CONFIG = { QUARTERS: ' + JSON.stringify(port.QUARTERS) + ' };\n' +
  'const COL = { COMPLETION: ' + COL_COMPLETION +
  ', DELAY_DAYS: ' + COL_DELAY + ' };\n';

const original = lift(KPI_GS, FROM_KPI, KPI_PRELUDE);
const originalConfig = lift(CONFIG_GS, FROM_CONFIG, '');

// scoreRows calls these three, which live in Config.gs, so they have to be
// in the same sandbox. Lifting them separately and then bolting them on
// would leave scoreRows calling undefined.
const originalAll = lift(
  KPI_GS, FROM_KPI,
  KPI_PRELUDE +
  FROM_CONFIG.map(function (name) {
    const src = fs.readFileSync(CONFIG_GS, 'utf8');
    const re = new RegExp('\\nfunction ' + name +
                          '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
    return src.match(re)[0];
  }).join('\n') + '\n');


let comparisons = 0, mismatches = 0;
const shown = [];

function same(what, a, b) {
  comparisons++;
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left === right) return;
  mismatches++;
  if (shown.length < 12) {
    shown.push('  ' + what + '\n      Kpi.gs: ' + left + '\n      port:   ' + right);
  }
}

/** Runs both and compares, treating a thrown error as an answer too. */
function compare(what, run, mine) {
  let a, b;
  try { a = { value: run() }; } catch (e) { a = { threw: e.message }; }
  try { b = { value: mine() }; } catch (e) { b = { threw: e.message }; }
  same(what, a, b);
}


// ---------------------------------------------------------------------------
console.log('');
console.log('  Lifted ' + FROM_KPI.length + ' functions from Kpi.gs and ' +
            FROM_CONFIG.length + ' from Config.gs');
console.log('  Completion Date is column ' + COL_COMPLETION +
            ', Delay Days is column ' + COL_DELAY + ', read from Config.gs');
console.log('');


// ---------------------------------------------------------------------------
// isCompleted - including the whitespace dates that cost a ticket
// ---------------------------------------------------------------------------
const CELLS = [
  null, undefined, '', ' ', '   ', '\t', '\n', ' \t\n ',
  '2026-08-01', '1/8/2026', 0, 1, false, true,
  new Date('2026-08-01T00:00:00Z'), new Date('invalid'),
  'not a date', '0', 'null', '-',
  /*
    THE LAST ONE IS CONTRIVED, AND IT IS HERE ON PURPOSE.

    `if (value instanceof Date) return true;` cannot be told from the
    String().trim() line underneath it by any value a spreadsheet produces -
    every real Date stringifies to something non-empty, so deleting that
    line changes no answer and a deliberate break of it SURVIVED the whole
    suite. This is the one value that separates them: it passes
    instanceof Date and throws when stringified.

    Nothing in a ticket export looks like this. The point is not that it
    could happen - it is that the branch now has to exist to pass, so it
    cannot quietly disappear in a later edit.
  */
  Object.create(Date.prototype)
];
CELLS.forEach(function (cell, i) {
  const row = [];
  row[COL_COMPLETION] = cell;
  // The label is built with a try, because one of these values is here
  // precisely BECAUSE stringifying it throws - and a test that crashes
  // while naming a case has not run the case.
  let label;
  try { label = JSON.stringify(String(cell)); }
  catch (e) { label = '<a value that cannot be stringified>'; }

  compare('isCompleted[' + i + '] ' + label,
          function () { return original.isCompleted(row); },
          function () { return port.isCompleted(cell); });
});


// ---------------------------------------------------------------------------
// toNumber
// ---------------------------------------------------------------------------
const NUMBERS = [
  null, undefined, '', ' ', 0, 1, -1, 0.0, 1.5, -2.25, 1e3,
  '0', '1', '-1', '0.0', '1.5', ' 2 ', '3abc', 'abc', 'NaN',
  'Infinity', true, false, []
];
NUMBERS.forEach(function (v, i) {
  compare('toNumber[' + i + '] ' + JSON.stringify(v),
          function () { return original.toNumber(v); },
          function () { return port.toNumber(v); });
});


// ---------------------------------------------------------------------------
// round2
// ---------------------------------------------------------------------------
[0, 1, 1.005, 1.004999, 2.675, -1.005, 99.994, 99.995, 1 / 3, 100 / 3,
 1e-9, -0, NaN, Infinity, null, undefined, '12.345', 'x'].forEach(function (v, i) {
  compare('round2[' + i + '] ' + JSON.stringify(v),
          function () { return original.round2(v); },
          function () { return port.round2(v); });
});


// ---------------------------------------------------------------------------
// The bands, pressed hard against both boundaries
// ---------------------------------------------------------------------------
/*
  >= OR > IS THE WHOLE OF A BAND BOUNDARY, and the difference only shows at
  the boundary itself. A rate of exactly 90.00 is GREEN and 89.9999 is not,
  so both are here, along with the floating-point neighbours either side of
  each - because 85.00 is not representable exactly and a port that wrote
  > where the original writes >= would pass every test that stayed a
  tenth of a point away from the line.
*/
const KPI = port.KPI_RESOLUTION;

/*
  MORE THAN ONE SET OF THRESHOLDS, because two guards in scoreRows cannot be
  seen with only this one.

  `achievement: completed ? achievementFor(rate, kpi) : 0` reads as careful
  and is invisible at target 90: an empty month has rate 0, and 0/90*100 is
  0 either way. Removing the guard SURVIVED. At target 0 it is 0/0, which is
  NaN, and the guard is suddenly the whole difference.

  THE OLD THRESHOLDS ARE IN THIS LIST FOR THEIR OWN SAKE. Config.gs records
  that KPI 1 was 99.50 / 89.55 before TVL-KPI-001 v1.0 took effect on 1
  October 2026, and that history is rescored against whatever is in force
  rather than frozen. If anybody ever puts the old numbers back, the port
  has to behave exactly as Kpi.gs would.
*/
const KPI_SHAPES = [
  KPI,
  { target: 99.50, yellowFloor: 89.55 },   // the pre-October 2026 policy
  { target: 100,   yellowFloor: 100 },     // no room at all
  { target: 0,     yellowFloor: 0 }        // divides by zero; see above
];

const EDGES = [];
[KPI.target, KPI.yellowFloor].forEach(function (edge) {
  [-1, -0.01, -0.0001, -1e-9, 0, 1e-9, 0.0001, 0.01, 1].forEach(function (d) {
    EDGES.push(edge + d);
  });
});
[0, 0.01, 50, 99.99, 100, 100.01, 150, -1, -100].forEach(function (r) {
  EDGES.push(r);
});

KPI_SHAPES.forEach(function (shape, s) {
  EDGES.forEach(function (rate, i) {
    compare('bandFor[kpi ' + s + '][' + i + '] ' + rate,
            function () { return originalConfig.bandFor(rate, shape); },
            function () { return port.bandFor(rate, shape); });
    compare('achievementFor[kpi ' + s + '][' + i + '] ' + rate,
            function () { return originalConfig.achievementFor(rate, shape); },
            function () { return port.achievementFor(rate, shape); });
  });
});


// ---------------------------------------------------------------------------
// headroom - every pair up to 40 x 40
// ---------------------------------------------------------------------------
/*
  THE NUMBER THE DASHBOARD LEADS WITH, and a ceil() that rounded the other
  way would be wrong by one on most inputs and right on the round ones. So
  every combination, not a sample.
*/
for (let completed = 0; completed <= 40; completed++) {
  for (let successful = 0; successful <= 40; successful++) {
    KPI_SHAPES.forEach(function (shape, s) {
      compare('headroomFor[kpi ' + s + '](' + completed + ',' + successful + ')',
              function () {
                return originalConfig.headroomFor(completed, successful, shape);
              },
              function () {
                return port.headroomFor(completed, successful, shape);
              });
    });
  }
}


// ---------------------------------------------------------------------------
// scoreRows - generated ticket sets
// ---------------------------------------------------------------------------
/*
  A SMALL LCG, AND ITS HIGH BITS, NOT ITS LOW ONES.

  The objectives fixture generator took `next() % 4` and got the low bits of
  a linear congruential generator, which cycle almost immediately - nearly
  every row came out the same and a whole suite ran against an empty log.
  `>>> 16` takes the high bits, which do not.
*/
let seed = 20260821;
function next() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; }
function pick(list) { return list[(next() >>> 16) % list.length]; }

const COMPLETIONS = [null, undefined, '', ' ', '  ', '2026-08-01',
                     new Date('2026-08-02T00:00:00Z'), '1/8/2026', '\t'];
const DELAYS = [0, 0.0, '0', '0.0', 1, 2, 7, -1, '', null, undefined,
                '3', '1.5', 'abc', ' 2 '];

for (let set = 0; set < 2000; set++) {
  const size = (next() >>> 16) % 25;
  const rows = [];
  for (let i = 0; i < size; i++) {
    const row = new Array(TICKET_COLUMNS.length).fill('');
    row[COL_COMPLETION] = pick(COMPLETIONS);
    row[COL_DELAY] = pick(DELAYS);
    rows.push(row);
  }
  // Every shape, including the one that divides by zero - that is what
  // makes the `completed ?` guards in scoreRows visible at all.
  KPI_SHAPES.forEach(function (shape, s) {
    compare('scoreRows[set ' + set + ', kpi ' + s + ', ' + size + ' rows]',
            function () { return originalAll.scoreRows(rows, shape); },
            function () {
              return port.scoreRows(rows, shape,
                { COMPLETION: COL_COMPLETION, DELAY_DAYS: COL_DELAY });
            });
  });
}


// ---------------------------------------------------------------------------
// Months, quarters and scopes
// ---------------------------------------------------------------------------
const MONTHS = [];
for (let y = 2025; y <= 2028; y++) {
  for (let m = 1; m <= 12; m++) {
    MONTHS.push(y + '-' + String(m).padStart(2, '0'));
  }
}
const SCHEMES = [undefined, 'RESOLUTION', 'FEEDBACK', 'NOT_A_SCHEME',
                 'TEST_APRIL_START', 'TEST_APRIL_END'];

MONTHS.forEach(function (month) {
  SCHEMES.forEach(function (scheme) {
    compare('quarterOf(' + month + ',' + scheme + ')',
            function () { return original.quarterOf(month, scheme); },
            function () { return port.quarterOf(month, scheme); });
  });
});

['', ' ', 'rubbish', '2026', '2026-13', '2026-00', '202-01', null,
 undefined, '2026-8'].forEach(function (bad) {
  SCHEMES.forEach(function (scheme) {
    compare('quarterOf(bad ' + JSON.stringify(bad) + ')',
            function () { return original.quarterOf(bad, scheme); },
            function () { return port.quarterOf(bad, scheme); });
  });
});

const QUARTER_KEYS = [];
for (let y = 2025; y <= 2028; y++) {
  for (let q = 1; q <= 4; q++) QUARTER_KEYS.push(y + '-Q' + q);
}
QUARTER_KEYS.concat(['', '2026-Q0', '2026-Q5', '2026-QQ', 'rubbish', null])
  .forEach(function (key) {
    SCHEMES.forEach(function (scheme) {
      compare('monthsOfQuarter(' + key + ',' + scheme + ')',
              function () { return original.monthsOfQuarter(key, scheme); },
              function () { return port.monthsOfQuarter(key, scheme); });
    });
    compare('quarterLabel(' + key + ')',
            function () { return original.quarterLabel(key); },
            function () { return port.quarterLabel(key); });
  });

const SCOPES = ['ALL', '', ' ', 'all', 'All', '2026-08', '2026-Q3',
                '2026-01,2026-08', '2026-Q1,2026-Q3', '2026-08,ALL',
                'ALL,2026-08', '2026-08,', ',2026-08', ',', ',,',
                '2026-Q3,2026-08,2027-01', ' 2026-08 ', 'rubbish',
                '2026-08,rubbish', null, undefined];
SCOPES.forEach(function (scope) {
  SCHEMES.forEach(function (scheme) {
    compare('monthsInScope(' + JSON.stringify(scope) + ',' + scheme + ')',
            function () { return original.monthsInScope(scope, scheme); },
            function () { return port.monthsInScope(scope, scheme); });
  });
});

SCHEMES.concat(['', null]).forEach(function (scheme) {
  compare('quarterScheme(' + scheme + ')',
          function () { return original.quarterScheme(scheme); },
          function () { return port.quarterScheme(scheme); });
});


// ---------------------------------------------------------------------------
// Grouping - contents AND order
// ---------------------------------------------------------------------------
/*
  THE ORDER IS PART OF THE ANSWER: biggest bucket first is what puts the
  busiest service at the top of the table. JSON.stringify compares the array
  in order, so a port that returned the right groups in the wrong order
  fails here rather than looking fine until somebody reads the screen.
*/
const KEYS = ['SD', 'MM', 'PP', 'FI-CO', '', '  ', 'FI-CO', null, undefined,
              'SD ', ' SD'];
for (let round = 0; round < 300; round++) {
  const size = (next() >>> 16) % 30;
  const rows = [];
  for (let i = 0; i < size; i++) rows.push([pick(KEYS), i]);

  compare('groupBy[' + round + ']',
          function () { return original.groupBy(rows, 0); },
          function () { return port.groupBy(rows, 0); });
  compare('groupByKey[' + round + ']',
          function () {
            return original.groupByKey(rows, function (r) { return r[0]; });
          },
          function () {
            return port.groupByKey(rows, function (r) { return r[0]; });
          });
}


// ---------------------------------------------------------------------------
console.log('');
if (mismatches) {
  console.log('  ' + mismatches + ' MISMATCH(ES) out of ' + comparisons +
              ' comparisons:');
  console.log('');
  shown.forEach(function (line) { console.log(line); });
  console.log('');
  console.log('  The port disagrees with src/Kpi.gs. Fix the port, not this.');
  process.exit(1);
}

console.log('  ' + comparisons + ' comparisons, all identical to src/Kpi.gs');
console.log('');
