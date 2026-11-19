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
              'objSlotCount', 'objCountState', 'objTallyTotal', 'objTallyShare'];

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
    'const CONFIG = { OBJECTIVE: { WORK_DAYS: [0, 1, 2, 3, 4, 6] } };\n' +
    'const OBJ_WORK_DAYS = {};\nconst OBJ_SLOTS = {};\n';

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
