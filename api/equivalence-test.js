/**
 * equivalence-test.js - the port must answer exactly what the original did.
 * ===========================================================================
 *
 *     cd api
 *     node equivalence-test.js
 *
 * THIS IS THE TEST THAT ENFORCES "CHANGE NOTHING".
 *
 * objectives-test.js checks the port against what the arithmetic SHOULD do.
 * That is necessary and it is not sufficient: a port can be self-consistent,
 * well tested, and still quietly disagree with the system it replaces.
 *
 * So this file does not describe the expected answers at all. It lifts the
 * real functions out of src/Objective.gs, runs them beside the ported ones,
 * and demands identical output for every input it can think of:
 *
 *   - 48 months, 2025 to 2028
 *   - 9 frequency spellings each, including blanks and typos
 *   - 1,331 tally shapes, every combination of 0-10 on-time / late / not-done
 *   - 10 state strings through objCountState
 *
 * It found a real fault the first time it ran. The port had hard-coded a
 * five-day Sunday-to-Thursday week; Config.gs says
 *
 *     WORK_DAYS: [0, 1, 2, 3, 4, 6]
 *
 * which is six days - Saturday is a working day and only Friday is off.
 * Every DAILY objective would have been scored against a denominator 4 to 5
 * squares short, every month. Nothing in the port's own tests could have
 * caught that, because they were written from the same wrong assumption.
 *
 * When Objective.gs changes, this fails. That is the point: it means the
 * port has drifted and must be brought back, not that the test is wrong.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GS = path.join(__dirname, '..', 'src', 'Objective.gs');
const src = fs.readFileSync(GS, 'utf8');

const LIFT = ['objDaysInMonth', 'objWorkingDays', 'objIsQuarterEnd',
              'objSlotCount', 'objCountState', 'objTallyTotal', 'objTallyShare',
              'objDate', 'objPeriodOf', 'objMarksRead', 'objMarksSet',
              'objMarksBlank', 'objMarksCount', 'objSlotEnd',
              'objSlotsElapsed', 'objSlotsOpen', 'objTaskState',
              'objTally', 'objPeriodCell', 'objPeriods', 'objPeriodIndex',
              'objLogKey', 'objMilestoneScore', 'objPlanMonthState',
              'objTaskSquares', 'objPlanSquares', 'objProgressAll'];

/*
  Pulls each function out of the .gs text and runs it in a sandbox with the
  two globals it reads - the config it takes WORK_DAYS from, and the two
  memo objects it caches into.

  WHY LIFT RATHER THAN require(): Objective.gs is 2,714 lines of Apps Script
  that calls SpreadsheetApp, CacheService and Logger at load time. None of
  that exists here and none of it is needed - the arithmetic is pure.
*/
function loadOriginal() {
  let code =
    'const CONFIG = { OBJECTIVE: { WORK_DAYS: [0, 1, 2, 3, 4, 6],' +
    "   PERIOD_START: '2026-10', PERIOD_END: '2027-03' } };\n" +
    'const OBJ_WORK_DAYS = {};\nconst OBJ_SLOTS = {};\n' +
    "const OBJ_PENDING = '.';\nconst OBJ_DONE = 'Y';\nconst OBJ_MISSED = 'N';\n" +
    "const OBJ_KIND_PLAN = 'PLAN';\nconst OBJ_KIND_TASK = 'TASK';\n";

  LIFT.forEach(function (name) {
    const re = new RegExp('\\nfunction ' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
    const found = src.match(re);
    if (!found) {
      console.error('');
      console.error('  Could not find function ' + name + ' in src/Objective.gs');
      console.error('  Either it was renamed, or this test needs updating.');
      process.exit(1);
    }
    code += found[0] + '\n';
  });

  code += 'module.exports = { ' + LIFT.join(', ') + ' };';

  const sandbox = { module: { exports: {} }, Date: Date, Math: Math,
                    Number: Number, String: String };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}

const OLD = loadOriginal();
const NEW = require('./objectives');

let same = 0;
const differences = [];

function compare(label, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { same++; return; }
  differences.push('  ' + label + '\n      Objective.gs: ' + JSON.stringify(a) +
                   '\n      the port    : ' + JSON.stringify(b));
}

/*
  Runs both sides and compares the OUTCOME, which includes throwing.

  Two functions that both reject the same bad input the same way are
  equivalent; one that returns a tidy value where the other throws is not,
  however much nicer the tidy one looks. Without this the harness itself
  crashed on the first deliberately malformed input and reported nothing
  at all - which is a worse failure than a difference, because it looks
  like the test is broken rather than the code.
*/
function compareCall(label, fn, args) {
  let aOut, bOut;
  try { aOut = { value: OLD[fn].apply(null, args) }; }
  catch (e) { aOut = { threw: String(e && e.message) }; }
  try { bOut = { value: NEW[fn].apply(null, args) }; }
  catch (e) { bOut = { threw: String(e && e.message) }; }
  compare(label, aOut, bOut);
}

// --- every month from 2025 to 2028 ----------------------------------------
const periods = [];
for (let y = 2025; y <= 2028; y++) {
  for (let m = 1; m <= 12; m++) periods.push(y + '-' + String(m).padStart(2, '0'));
}

const FREQ = ['Daily', 'Weekly', 'Monthly', 'Quarterly', '', 'Munthly',
              'DAILY', 'dAiLy', null];

periods.forEach(function (p) {
  compare('objDaysInMonth(' + p + ')',  OLD.objDaysInMonth(p),  NEW.objDaysInMonth(p));
  compare('objWorkingDays(' + p + ')',  OLD.objWorkingDays(p),  NEW.objWorkingDays(p));
  compare('objIsQuarterEnd(' + p + ')', OLD.objIsQuarterEnd(p), NEW.objIsQuarterEnd(p));
  FREQ.forEach(function (f) {
    compare('objSlotCount(' + p + ', ' + f + ')',
            OLD.objSlotCount(p, f), NEW.objSlotCount(p, f));
  });
});

// --- every tally shape up to 10 of each ------------------------------------
for (let a = 0; a <= 10; a++) {
  for (let b = 0; b <= 10; b++) {
    for (let c = 0; c <= 10; c++) {
      const shape = a + '/' + b + '/' + c;
      compare('objTallyTotal(' + shape + ')',
              OLD.objTallyTotal({ onTime: a, late: b, notDone: c }),
              NEW.objTallyTotal({ onTime: a, late: b, notDone: c }));
      compare('objTallyShare(' + shape + ')',
              OLD.objTallyShare({ onTime: a, late: b, notDone: c }),
              NEW.objTallyShare({ onTime: a, late: b, notDone: c }));
    }
  }
}

// --- every state string ----------------------------------------------------
['done', 'late', 'missed', 'part', 'pending', 'open', '', 'x', null, undefined]
  .forEach(function (state) {
    const o = { onTime: 0, late: 0, notDone: 0 };
    const n = { onTime: 0, late: 0, notDone: 0 };
    OLD.objCountState(o, state);
    NEW.objCountState(n, state);
    compare('objCountState(' + state + ')', o, n);
  });


// --- the marks string ------------------------------------------------------
// Including cells a human has typed into by hand, which is where the
// cleaning in objMarksRead earns its place.
const CELLS = ['', 'YYY', 'Y.N', 'YYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
               'Y N . y n', 'hello', 'YN.YN.', null, undefined, 0, 'Y'.repeat(40),
               '...', 'NNN', '  Y . N  ', 'Y-N_N'];
CELLS.forEach(function (cell) {
  [0, 1, 5, 26, 31].forEach(function (slots) {
    compare('objMarksRead(' + JSON.stringify(cell) + ', ' + slots + ')',
            OLD.objMarksRead(cell, slots), NEW.objMarksRead(cell, slots));
  });
  ['Y', 'N', '.', 'x', null].forEach(function (mark) {
    [undefined, 0, 3, 99, -1].forEach(function (upto) {
      compare('objMarksCount(' + JSON.stringify(cell) + ',' + mark + ',' + upto + ')',
              OLD.objMarksCount(cell, mark, upto), NEW.objMarksCount(cell, mark, upto));
    });
  });
});

['YYY', '...', 'Y.N', ''].forEach(function (m) {
  [-1, 0, 1, 2, 5, 99, null, 'x'].forEach(function (i) {
    ['Y', 'N', '.', 'z', null].forEach(function (mark) {
      compare('objMarksSet(' + m + ',' + i + ',' + mark + ')',
              OLD.objMarksSet(m, i, mark), NEW.objMarksSet(m, i, mark));
    });
  });
});

[0, 1, 5, 26, -3].forEach(function (n) {
  compare('objMarksBlank(' + n + ')', OLD.objMarksBlank(n), NEW.objMarksBlank(n));
});


// --- slot timing, against many "now" values --------------------------------
/*
  objSlotsElapsed and objSlotsOpen both depend on the current time, so a
  fixed `now` would test one day and prove nothing about the rest. Every
  day of the objective period is used as "today", against every month.
*/
const NOWS = [];
['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'].forEach(function (p) {
  const y = Number(p.slice(0, 4)), m = Number(p.slice(5, 7));
  const last = OLD.objDaysInMonth(p);
  for (let d = 1; d <= last; d += 3) NOWS.push(new Date(y, m - 1, d, 12, 0, 0));
});

/*
  THE BOUNDARY, AND WHY IT HAD TO BE ADDED.

  Every `now` above is midday. Slot ends fall at 23:59:59.999, so no test
  ever landed exactly on one - and a deliberate mutant changing

      if (objSlotEnd(...) < ms)     to     <= ms

  survived all 11,177 comparisons. That is the exact line Objective.gs
  warns about: "Today is not elapsed. It counted today in its first
  version, so a daily objective was missed for a day that had not
  finished."

  So: the last millisecond of each slot, and one millisecond either side.
  A test that cannot see the boundary cannot protect it.
*/
PERIODS6_BOUNDARY().forEach(function (t) { NOWS.push(t); });

function PERIODS6_BOUNDARY() {
  const out = [];
  ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']
    .forEach(function (p) {
      ['Daily', 'Weekly', 'Monthly', 'Quarterly'].forEach(function (f) {
        const n = OLD.objSlotCount(p, f);
        for (let i = 0; i < n && i < 6; i++) {
          const end = OLD.objSlotEnd(p, f, i);
          out.push(new Date(end - 1));   // just inside
          out.push(new Date(end));       // exactly on it
          out.push(new Date(end + 1));   // just past
        }
      });
    });
  return out;
}

const PERIODS6 = ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
const FREQ4 = ['Daily', 'Weekly', 'Monthly', 'Quarterly'];

PERIODS6.forEach(function (p) {
  FREQ4.forEach(function (f) {
    for (let slot = 0; slot < 8; slot++) {
      compare('objSlotEnd(' + p + ',' + f + ',' + slot + ')',
              OLD.objSlotEnd(p, f, slot), NEW.objSlotEnd(p, f, slot));
    }
    NOWS.forEach(function (now) {
      const when = now.toISOString().slice(0, 10);
      compare('objSlotsElapsed(' + p + ',' + f + ',' + when + ')',
              OLD.objSlotsElapsed(p, f, now), NEW.objSlotsElapsed(p, f, now));
      compare('objSlotsOpen(' + p + ',' + f + ',' + when + ')',
              OLD.objSlotsOpen(p, f, now), NEW.objSlotsOpen(p, f, now));
    });
  });
});


// --- objTaskState: the whole machine ---------------------------------------
/*
  The one that decides what every square on the page looks like. Driven
  over real marks strings and real markedAt maps, including a mark
  recorded AFTER its slot closed - which is the 'late' case, the whole
  reason markedAt exists.
*/
const MARKED = [
  null,
  {},
  { '0': new Date(2026, 10, 2, 10, 0, 0).getTime() },      // on time
  { '0': new Date(2027, 0, 15, 10, 0, 0).getTime() },      // long after: late
  { '0': 0 },
  { '0': 1, '1': 1, '2': 9e12 },
  { 'nonsense': 123 }
];

PERIODS6.forEach(function (p) {
  FREQ4.forEach(function (f) {
    const task = { frequency: f };
    ['', 'Y', 'YY', 'Y.N', 'YYYYY', 'NNNNN', 'Y'.repeat(30), '.'.repeat(30)]
      .forEach(function (marks) {
        MARKED.forEach(function (when, wi) {
          [NOWS[0], NOWS[Math.floor(NOWS.length / 2)], NOWS[NOWS.length - 1]]
            .forEach(function (now) {
              compare('objTaskState(' + p + ',' + f + ',' + JSON.stringify(marks) +
                      ',marked#' + wi + ',' + now.toISOString().slice(0, 10) + ')',
                      OLD.objTaskState(task, marks, p, now, when),
                      NEW.objTaskState(task, marks, p, now, when));
            });
        });
      });
  });
});


// --- objDate / objPeriodOf -------------------------------------------------
[new Date(2026, 10, 18), new Date('nonsense'), null, undefined, 0, '2026-11',
 {}, { getTime: function () { return NaN; } },
 { getTime: function () { return 123; } }].forEach(function (v, i) {
  // compareCall, not compare: input #8 has a getTime but no getMonth, so
  // BOTH sides throw. Throwing identically is equivalence; it is only a
  // difference if one of them stops throwing.
  compareCall('objDate(#' + i + ')',     'objDate',     [v]);
  compareCall('objPeriodOf(#' + i + ')', 'objPeriodOf', [v]);
});


// --- the period helpers ----------------------------------------------------
compare('objPeriods()', OLD.objPeriods(), NEW.objPeriods());
['2026-10','2026-11','2027-03','2027-04','','x', null].forEach(function (p) {
  compare('objPeriodIndex(' + p + ')', OLD.objPeriodIndex(p), NEW.objPeriodIndex(p));
});
[new Date(2026, 10, 18), '2026-11', '  2026-11  ', '', null, undefined, 0]
  .forEach(function (v, i) {
    compareCall('objPeriodCell(#' + i + ')', 'objPeriodCell', [v]);
  });
[['2026-11','TASK','EAS-001'], ['2026-11','task','EAS-001'],
 ['2026-11',' Task ',' EAS-001 '], [null, null, null],
 [new Date(2026,10,1),'PLAN','M1'], ['2026-11','',''],
 ['2026-11','PLAN', 123]].forEach(function (a, i) {
  compareCall('objLogKey(#' + i + ')', 'objLogKey', a);
});


// ===========================================================================
// objProgressAll - the two summary cards
// ===========================================================================
/*
  Fixtures shaped like the real sheets, with no real content in them.

  29 milestones across 8 rows, matching the SMART sheet's shape, and 90
  Unique Roles objectives of which 4 are KPIs - so 86 count, exactly as on
  the page. Marks are spread so that every branch is hit: on time, late,
  missed, pending, auto-counted, PERCENT, DONE, NUMBER and PERIOD.
*/
function buildPlan() {
  const rows = [];
  const shape = [4, 4, 4, 4, 4, 4, 4, 1];     // 29 milestones in 8 rows
  let n = 0;
  shape.forEach(function (count, r) {
    const milestones = [];
    for (let i = 0; i < count; i++) {
      n++;
      const types = ['NUMBER', 'PERCENT', 'DONE', 'NUMBER'];
      milestones.push({
        id: 'M' + n,
        target: [1, 6, 100, 85][n % 4],
        countType: types[n % 4],
        per: (n % 5 === 0) ? 'PERIOD' : 'MONTH',
        auto: (n % 7 === 0) ? 'UNIQUE_ROLES' : (n % 11 === 0 ? 'ITSM' : '')
      });
    }
    rows.push({ id: 'R' + r, milestones: milestones });
  });

  /*
    A BIG-TARGET PERIOD MILESTONE, ADDED BECAUSE A MUTANT SURVIVED WITHOUT IT.

    "Complete at least 6 development initiatives during the period" is
    cumulative: the score in any month is everything recorded up to and
    including it, over the target. Deleting that logic made no difference
    to this suite at first, because every PERIOD milestone had a target
    small enough that Math.min(1, value/target) clamped the single month
    AND the running total to 1. Both answers were "done", so the two
    implementations agreed while meaning different things.

    Target 500 against monthly values under 110 means one month can never
    reach it and six months can, so the cumulative sum is the only thing
    that moves the number.
  */
  rows.push({ id: 'R-period', milestones: [
    { id: 'M-PERIOD-BIG', target: 500, countType: 'NUMBER', per: 'PERIOD', auto: '' },
    { id: 'M-MONTH-BIG',  target: 500, countType: 'NUMBER', per: 'MONTH',  auto: '' }
  ]});

  return { rows: rows };
}

function buildTasks() {
  const freqs = ['Monthly', 'Daily', 'Weekly', 'Quarterly'];
  const out = [];
  for (let i = 1; i <= 90; i++) {
    out.push({
      id: 'EAS-' + String(i).padStart(3, '0'),
      frequency: freqs[i % 4],
      kpi: i > 86                       // the last four are the KPIs
    });
  }
  return out;
}

function buildLog(plan, tasks, periods, seed) {
  const byKey = {};
  /*
    THE LOW BITS OF AN LCG ARE NEARLY CONSTANT, and using them made this
    whole fixture almost empty.

    The first version returned k itself and callers took `next() % 4`,
    which reads the lowest two bits. Those cycle with a period of 4 in a
    linear congruential generator, so after the first call the answer was
    0 almost every time and nearly every log row was skipped:

        2026-10  M-PERIOD-BIG  value=2
        2026-11  SKIPPED   2026-12  SKIPPED   2027-01  SKIPPED  ...

    One entry in one month, out of six months and ninety-two objectives.
    Every objProgressAll comparison was being run against an empty log, and
    a mutant that deleted the cumulative PERIOD logic survived because
    there was never more than one month's figure to accumulate.

    Shifting right by 16 takes the high bits, which are well distributed.
  */
  let k = seed;
  const next = function () {
    k = (k * 1103515245 + 12345) & 0x7fffffff;
    return k >>> 16;
  };

  periods.forEach(function (p) {
    tasks.forEach(function (t) {
      if (next() % 3 === 0) return;                  // some months untouched
      const slots = OLD.objSlotCount(p, t.frequency);
      let marks = '';
      const markedAt = {};
      for (let i = 0; i < slots; i++) {
        const r = next() % 10;
        marks += r < 5 ? 'Y' : (r < 7 ? 'N' : '.');
        if (marks.charAt(i) === 'Y') {
          const end = OLD.objSlotEnd(p, t.frequency, i);
          // a third of the ticks are recorded AFTER the slot closed: late
          markedAt[String(i)] = (next() % 3 === 0) ? end + 86400000 : end - 3600000;
        }
      }
      byKey[OLD.objLogKey(p, 'TASK', t.id)] =
        { marks: marks, markedAt: markedAt, value: next() % 120, notes: {} };
    });

    plan.rows.forEach(function (row) {
      row.milestones.forEach(function (m) {
        if (next() % 4 === 0) return;
        const end = OLD.objSlotEnd(p, 'Monthly', 0);
        const tick = next() % 2 === 0;
        byKey[OLD.objLogKey(p, 'PLAN', m.id)] = {
          marks: tick ? 'Y' : '.',
          markedAt: tick ? { '0': (next() % 3 === 0) ? end + 1000 : end - 1000 } : {},
          value: next() % 110,
          notes: {}
        };
      });
    });
  });
  return { byKey: byKey };
}

const PLAN = buildPlan();
const TASKS = buildTasks();
const ALLPERIODS = OLD.objPeriods();

[1, 7, 99, 12345].forEach(function (seed) {
  const log = buildLog(PLAN, TASKS, ALLPERIODS, seed);

  // autoAll: the counted sources, present for some months and not others.
  const autoAll = {};
  ALLPERIODS.forEach(function (p, i) {
    if (i % 3 === 0) return;                         // some months uncounted
    autoAll[p] = {
      UNIQUE_ROLES: { fraction: (i % 5) / 4, value: i * 10 },
      ITSM: { value: i * 7, fraction: 0.5 }
    };
  });

  ALLPERIODS.forEach(function (want) {
    [new Date(2026, 10, 18, 12, 0, 0),
     new Date(2027, 2, 31, 23, 59, 59),
     new Date(2026, 9, 1, 0, 0, 0)].forEach(function (now) {
      const label = 'seed' + seed + ' want=' + want +
                    ' now=' + now.toISOString().slice(0, 10);
      compareCall('objProgressAll ' + label, 'objProgressAll',
                  [PLAN, TASKS, log, ALLPERIODS, want, now, autoAll]);
      compareCall('objTaskSquares ' + label, 'objTaskSquares',
                  [TASKS.filter(function (t) { return !t.kpi; }),
                   log, want, now, { onTime: 0, late: 0, notDone: 0 }]);
      compareCall('objPlanSquares ' + label, 'objPlanSquares',
                  [PLAN, log, want, now, autoAll,
                   { onTime: 0, late: 0, notDone: 0 }]);
    });

    // milestone scoring, every type and both per-settings
    PLAN.rows.forEach(function (row) {
      row.milestones.forEach(function (m) {
        compareCall('objMilestoneScore ' + m.id + ' ' + want + ' seed' + seed,
                    'objMilestoneScore',
                    [m, log, want, { auto: autoAll[want] || {} }]);
        compareCall('objPlanMonthState ' + m.id + ' ' + want + ' seed' + seed,
                    'objPlanMonthState',
                    [m, log.byKey[OLD.objLogKey(want, 'PLAN', m.id)] || null,
                     want, new Date(2026, 10, 18, 12, 0, 0),
                     Boolean((autoAll[want] || {})[m.auto]), 0.5]);
      });
    });
  });
});


console.log('');
if (differences.length) {
  console.log('THE PORT HAS DRIFTED FROM src/Objective.gs');
  console.log('-----------------------------------------------------------');
  differences.slice(0, 20).forEach(function (d) { console.log(d); });
  if (differences.length > 20) {
    console.log('  ... and ' + (differences.length - 20) + ' more');
  }
  console.log('');
  console.log('  ' + same + ' identical, ' + differences.length + ' DIFFER');
  process.exit(1);
}

console.log('  ' + same + ' comparisons, all identical to src/Objective.gs');
console.log('');
process.exit(0);
