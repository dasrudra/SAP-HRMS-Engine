// Objective.gs - the six-month objectives, on the server.
//
// WHY THIS EXISTS
// This file decides a number that goes to management: the department's
// achievement out of 100 for the period. Almost everything it can get wrong
// is wrong QUIETLY - a score that is plausible, stable, and not what the
// objective sheet says.
//
// WHAT IT GUARDS, worst first:
//
//   the working week            Sunday to Thursday. A daily objective has
//                               about 22 slots in a month, not 30. Counting
//                               Fridays scores every person as missing
//                               eight days a month, for ever, and the page
//                               looks completely normal while it does it
//   nothing recorded scores 0   not 100. Leaving an unrecorded milestone
//                               out of its row's average is the comfortable
//                               bug: a department that recorded nothing at
//                               all would score full marks
//   a row is a MEAN             Operation has four milestones and People
//                               and Organization's second row has one.
//                               Summing instead of averaging pays a row for
//                               being described in more detail
//   the weighting stays 100     a milestone added from the page joins an
//                               existing row and shares its weight. A tenth
//                               row would make every figure on the page a
//                               share of something other than 100
//   period targets accumulate   "at least 6 during the period" is not six
//                               a month
//   on schedule is strict       a slot that passed with nobody marking it
//                               counts against. The opposite reading makes
//                               the whole page an optimistic guess
//   whose objective it is       a person ticks their own module. The four
//                               KPIs are the engine's and nobody's to tick
//   the counted milestone       Operation milestone 1 is the ninety. It
//                               must refuse to be typed in, or the figure
//                               and the thing it counts drift apart
//
//   node tests/objective-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.001 : tol);

// ---------------------------------------------------------------------------
// three tabs, just real enough
// ---------------------------------------------------------------------------
function makeTab(name, headers, rows) {
  const all = [headers.slice()].concat((rows || []).map((r) => r.slice()));
  return {
    rows: all,
    getName: () => name,
    getLastRow: () => all.length,
    getLastColumn: () => all[0].length,
    appendRow: function (row) { all.push(row.slice()); },
    deleteRow: function (r) { all.splice(r - 1, 1); },
    getRange: function (r, c, n, w) {
      return {
        getValue: () => (all[r - 1] || [])[c - 1],
        setValue: function (v) {
          if (!all[r - 1]) all[r - 1] = [];
          all[r - 1][c - 1] = v;
        },
        getValues: function () {
          const got = [];
          for (let i = 0; i < (n === undefined ? 1 : n); i++) {
            got.push((all[r - 1 + i] || []).slice(c - 1, c - 1 + (w || 1)));
          }
          return got;
        },
        setValues: function (vals) {
          for (let i = 0; i < vals.length; i++) all[r - 1 + i] = vals[i].slice();
          return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) };
        }
      };
    }
  };
}

const PLAN_HEAD = ['Milestone ID', 'Row ID', 'Category', 'Weight', 'Objective',
  'Milestone', 'Expected Outcome', 'Count Type', 'Target', 'Per', 'Owner',
  'Auto Source'];
const TASK_HEAD = ['Objective ID', 'Category', 'Objective name', 'Group',
  'Area', 'KPI', 'Objective / Description', 'Target', 'Measurement Method',
  'Frequency', 'Responsible Person', 'Remarks / Outcome'];
const LOG_HEAD = ['Period', 'Kind', 'Ref ID', 'Marks', 'Value', 'Status',
  'Note', 'By', 'By ID', 'At', 'History'];

// A plan shaped like the real one: six categories, nine rows, weighting 100.
// Shortened to two or three milestones a row - the arithmetic this suite is
// about does not get more convincing at twenty-nine.
function planRows() {
  const m = (id, row, cat, w, mile, type, target, per, auto) =>
    [id, row, cat, w, 'Objective for ' + row, mile, 'Outcome', type, target,
     per, 'EAS Team', auto || ''];
  return [
    m('OBJ-001', 'OP',  'Operation', 20,
      'Monitor 86 SAP processes and review 4 KPI results monthly.',
      'PERCENT', 100, 'MONTH', 'UNIQUE_ROLES'),
    m('OBJ-002', 'OP',  'Operation', 20,
      'Complete at least 2 RCA per month.', 'NUMBER', 2, 'MONTH'),
    m('OBJ-003', 'DEV', 'Development Work & Project', 10,
      'Complete at least 6 development initiatives during the period.',
      'NUMBER', 6, 'PERIOD'),
    m('OBJ-004', 'PO1', 'People & Organization', 10,
      'Conduct at least 1 knowledge-sharing session per month.',
      'NUMBER', 1, 'MONTH', 'KNOWLEDGE'),
    m('OBJ-005', 'PO2', 'People & Organization', 5,
      'Conduct at least 1 user training session per month.',
      'NUMBER', 1, 'MONTH'),
    m('OBJ-006', 'PO3', 'People & Organization', 10,
      'Complete or update at least 2 documents per month.',
      'NUMBER', 2, 'MONTH', 'LEARN'),
    m('OBJ-007', 'PO4', 'People & Organization', 5,
      'Commit and practice adherence to TVL culture.', 'DONE', 1, 'PERIOD'),
    m('OBJ-008', 'COM', 'Commercial', 20,
      'SAP self-paced learning, module-wise.', 'DONE', 1, 'PERIOD'),
    m('OBJ-009', 'LEAD', 'Leadership', 10,
      'Maintain 100% compliance with SAP governance.', 'PERCENT', 100, 'MONTH'),
    m('OBJ-010', 'XF',  'Cross-Functional', 10,
      'Complete at least 1 cross-functional initiative per month.',
      'NUMBER', 1, 'MONTH')
  ];
}

// Eight unique-role objectives across four groups, plus the four KPIs, so
// 'the ninety' is twelve here and the proportions still mean something.
function taskRows() {
  const t = (id, name, group, kpi, freq, area) =>
    [id, group + ' Process Execution', name, group, area || 'RMG/MG',
     kpi ? 'Yes' : 'No', 'Description of ' + id, kpi ? '>= 99.50%' : 1,
     'Data from the system', freq, 'SAP Support Team', ''];
  return [
    t('OJT-001', 'SAP Incident & Emergency Management', 'All', true, 'Monthly'),
    t('OJT-002', 'SAP Server Availability', 'All', true, 'Monthly'),
    t('OJT-003', 'User Training Feedback analysis', 'All', true, 'Quarterly'),
    t('OJT-004', 'Error/Issue Resolution Time', 'All', true, 'Monthly'),
    t('OJT-005', 'Unnecessary delivery order monitoring', 'SD', false, 'Monthly'),
    t('OJT-006', 'GI vs. POD check', 'SD', false, 'Weekly'),
    t('OJT-007', 'Proof of delivery vs. Billing', 'SD', false, 'Daily'),
    t('OJT-008', 'Requisition-based GI Status check', 'MM', false, 'Monthly'),
    t('OJT-009', 'Weekly RM Leftover Declaration', 'MM', false, 'Weekly'),
    t('OJT-010', 'Plan Cost & Activity Monitoring', 'CO', false, 'Monthly'),
    t('OJT-011', 'Aging Report', 'MD', false, 'Monthly'),
    t('OJT-012', 'Bank key Mapping check', 'SD', false, 'Daily')
  ];
}

// ---------------------------------------------------------------------------
// the context
// ---------------------------------------------------------------------------
// 10 November 2026, a Tuesday, which is the real date this was written on.
// November 2026 opens on a Sunday, so it has exactly 22 working days and
// 8 of them have gone by the 10th - numbers this suite asserts by hand
// rather than by calling the code it is checking.
const TODAY = [2026, 10, 10];     // month is 0-based, as Date wants it

function load(opts) {
  const o = opts || {};
  const logs = [];
  const tabs = {
    OBJ_PLAN: makeTab('OBJ_PLAN', PLAN_HEAD,
      o.plan === undefined ? planRows() : o.plan),
    OBJ_TASK: makeTab('OBJ_TASK', TASK_HEAD,
      o.tasks === undefined ? taskRows() : o.tasks),
    OBJ_LOG: makeTab('OBJ_LOG', LOG_HEAD, o.log || [])
  };

  const ctx = {
    console: console,
    Logger: {
      log: function (fmt) {
        const args = Array.prototype.slice.call(arguments, 1);
        let i = 0;
        logs.push(String(fmt).replace(/%s/g, () =>
          (i < args.length ? String(args[i++]) : '%s')));
      }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => null, setProperty: () => {}
      })
    },
    Utilities: {
      formatDate: (d, tz, fmt) => String(fmt) + ':' + d.getTime()
    },
    SpreadsheetApp: {},
    DriveApp: {}
  };

  vm.createContext(ctx);

  // A FIXED TODAY. Half of what this file decides is "has that slot gone
  // by", so a suite whose answer changes with the wall clock proves nothing
  // in December. The shim keeps the real Date for every other use - only
  // the no-argument constructor and now() are pinned.
  vm.runInContext(
    '(function () {' +
    '  var Real = Date;' +
    '  var FIXED = new Real(' + TODAY[0] + ',' + TODAY[1] + ',' + TODAY[2] +
    ',10,0,0).getTime();' +
    '  function Fake(a, b, c, d, e, f, g) {' +
    '    if (arguments.length === 0) return new Real(FIXED);' +
    '    if (arguments.length === 1) return new Real(a);' +
    '    return new Real(a, b, c, d || 0, e || 0, f || 0, g || 0);' +
    '  }' +
    '  Fake.now = function () { return FIXED; };' +
    '  Fake.parse = Real.parse; Fake.UTC = Real.UTC;' +
    '  Fake.prototype = Real.prototype;' +
    '  Date = Fake;' +
    /*
      AND A WAY TO MOVE IT ON.

      A pinned clock makes two writes in a row land on the same
      millisecond, so "the first time this was written survived the edit"
      reads as true whether the code keeps that time or replaces it with
      now. The assertion passes and the behaviour it exists to protect is
      gone. Advancing the clock between the two is what tells them apart -
      and it is also what actually happens, a day later.
    */
    '  globalThis.__advance = function (ms) { FIXED += ms; };' +
    '})();', ctx);

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), ctx);

  // Every tab read is counted, because "how many times does drawing this
  // page ask Google a question" is the whole of why it took four seconds.
  const reads = { OBJ_PLAN: 0, OBJ_TASK: 0, OBJ_LOG: 0, TEAM: 0 };
  ctx.sheetWithHeaders = (name) => {
    if (!tabs[name]) throw new Error('no such tab: ' + name);
    reads[name]++;
    return tabs[name];
  };
  ctx.__tabs = tabs;
  ctx.__reads = reads;

  /*
    A cache, only when a test asks for one.

    Without it CacheService is simply not defined in this context, objCached
    catches the ReferenceError and every read goes through - which is the
    right default for the suites that are about the arithmetic rather than
    about how often the sheet is asked.
  */
  if (o.cache) {
    ctx.CacheService = {
      getScriptCache: () => ({
        get: (k) => (k in o.cache ? o.cache[k] : null),
        put: (k, v) => { o.cache[k] = v; },
        remove: (k) => { delete o.cache[k]; },
        removeAll: (ks) => { (ks || []).forEach((k) => { delete o.cache[k]; }); }
      })
    };
  }
  ctx.__logs = logs;
  ctx.CONFIG_TZ = () => 'Asia/Dhaka';
  ctx.requireSignedIn = () => {};
  ctx.requireAdmin = () => {
    if (!o.admin) throw new Error('That action needs the admin login.');
  };
  ctx.currentSession = () => o.session || { u: '20990001', r: 'USER' };
  ctx.rankOf = (r) => ({ USER: 1, ADMIN: 2, MASTER: 3 }[r] || 0);
  ctx.ROLE_ADMIN = 'ADMIN';

  // The directory. Module cells are written for people to read - 'MM/MD' is
  // two modules - so the shapes that actually appear in the TEAM tab are
  // the shapes here.
  ctx.readTeam = () => {
    reads.TEAM++;
    if (o.teamThrows) throw new Error('TEAM is mid-edit');
    return o.team || {
      lead: { name: 'Utpal Biswas', id: '20990000', module: 'MM/MD',
              leads: 'Yes' },
      sections: [{
        head: { name: 'Ayesha Rahman', id: '20990002', module: 'SD',
                leads: 'Yes' },
        members: [
          { name: 'Bilal Hossain', id: '20990001', module: 'SD' },
          { name: 'Nadia Karim', id: '20990003', module: 'CO' },
          { name: 'Imran Chowdhury', id: '20990004', module: '' }
        ]
      }]
    };
  };

  ctx.readKnowledge = () => {
    if (o.knowledgeThrows) throw new Error('no KNOWLEDGE tab');
    return { shares: o.shares || [] };
  };
  ctx.readLearn = () => {
    if (o.learnThrows) throw new Error('no LEARN tab');
    return { docs: o.docs || [] };
  };

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Objective.gs'), 'utf8'), ctx);
  return ctx;
}

// ===========================================================================
// 1. the period
// ===========================================================================
{
  const ctx = load();
  const p = ctx.objPeriods();
  check('the period is the six months from the config',
    p.length === 6 && p[0] === '2026-10' && p[5] === '2027-03', p.join(' '));
  check('a month knows where it sits in the period',
    ctx.objPeriodIndex('2026-11') === 1 &&
    ctx.objPeriodIndex('2027-03') === 5 &&
    ctx.objPeriodIndex('2027-04') === -1);

  // A start after the end is a typo somebody will make exactly once. The
  // loop must come back, not spin until the script is killed.
  //
  // Reached through runInContext because CONFIG is a `const` inside the vm
  // and so is not a property of the context object.
  const runaway = vm.runInContext(
    'CONFIG.OBJECTIVE.PERIOD_START = "2027-03";' +
    'CONFIG.OBJECTIVE.PERIOD_END = "2026-10";' +
    'objPeriods();', ctx);
  check('a backwards period is bounded, not an infinite loop',
    runaway.length === 120, 'got ' + runaway.length);
}

// ===========================================================================
// 2. the working week - the one that fails silently
// ===========================================================================
{
  const ctx = load();

  // Counted by hand from a calendar. November 2026 opens on a Sunday and
  // has four Fridays - the 6th, 13th, 20th and 27th.
  check('November 2026 has 26 working days, not 30',
    ctx.objWorkingDays('2026-11').length === 26,
    'got ' + ctx.objWorkingDays('2026-11').length);
  check('October 2026 has 26, because it has five Fridays',
    ctx.objWorkingDays('2026-10').length === 26,
    'got ' + ctx.objWorkingDays('2026-10').length);
  check('December 2026 has 27',
    ctx.objWorkingDays('2026-12').length === 27,
    'got ' + ctx.objWorkingDays('2026-12').length);

  const nov = ctx.objWorkingDays('2026-11');
  // SATURDAY IS A WORKING DAY HERE. This was Sunday to Thursday until the
  // team said otherwise, which cost a daily objective four slots a month.
  check('Friday is the weekend, and Saturday is not',
    nov.indexOf(6) === -1 && nov.indexOf(13) === -1 &&
    nov.indexOf(7) !== -1 && nov.indexOf(14) !== -1,
    nov.join(','));
  check('so the working days run Saturday to Thursday',
    nov[0] === 1 && nov[4] === 5 && nov[5] === 7 && nov[25] === 30,
    nov.slice(0, 8).join(','));

  check('a daily objective has a slot per working day',
    ctx.objSlotCount('2026-11', 'Daily') === 26);
  check('a weekly objective has blocks of seven from the 1st',
    ctx.objSlotCount('2026-11', 'Weekly') === 5 &&
    ctx.objSlotCount('2026-12', 'Weekly') === 5);
  check('a monthly objective has one slot',
    ctx.objSlotCount('2026-11', 'Monthly') === 1);
  check('a quarterly objective has a slot only when the quarter ends',
    ctx.objSlotCount('2026-11', 'Quarterly') === 0 &&
    ctx.objSlotCount('2026-12', 'Quarterly') === 1 &&
    ctx.objSlotCount('2027-03', 'Quarterly') === 1);
  check('an unknown frequency is treated as monthly, not as nothing',
    ctx.objSlotCount('2026-11', 'Fortnightly') === 1);
}

// ===========================================================================
// 3. what has already gone by
// ===========================================================================
{
  const ctx = load();
  const now = new Date(2026, 10, 10, 10, 0, 0);   // 10 November

  /*
    TODAY IS NOT ELAPSED. Eight of November"s working days have CLOSED by
    the morning of the 10th - the 1st to the 5th, then the 7th, 8th and
    9th, Friday the 6th not being one. The 10th is in progress: it can
    still be marked on time, so it cannot also be a miss.
  */
  check('8 of November"s working days have closed by the 10th',
    ctx.objSlotsElapsed('2026-11', 'Daily', now) === 8,
    'got ' + ctx.objSlotsElapsed('2026-11', 'Daily', now));
  check('but nine of them may be pressed, today included',
    ctx.objSlotsOpen('2026-11', 'Daily', now) === 9,
    'got ' + ctx.objSlotsOpen('2026-11', 'Daily', now));
  check('the 10th is inside week 2, so only week 1 has closed',
    ctx.objSlotsElapsed('2026-11', 'Weekly', now) === 1 &&
    ctx.objSlotsOpen('2026-11', 'Weekly', now) === 2,
    ctx.objSlotsElapsed('2026-11', 'Weekly', now) + ' elapsed, ' +
    ctx.objSlotsOpen('2026-11', 'Weekly', now) + ' open');
  check('a monthly slot is not elapsed until the month is',
    ctx.objSlotsElapsed('2026-11', 'Monthly', now) === 0);
  /*
    THE TWO AGREE ON A DAY THAT IS NOT A WORKING ONE. Friday the 6th has
    nothing of its own to press, so there is no slot in progress and
    nothing is left looking pending.
  */
  check('on a Friday nothing is open that has not also closed',
    ctx.objSlotsElapsed('2026-11', 'Daily', new Date(2026, 10, 6, 10, 0)) ===
    ctx.objSlotsOpen('2026-11', 'Daily', new Date(2026, 10, 6, 10, 0)),
    'elapsed ' + ctx.objSlotsElapsed('2026-11', 'Daily',
      new Date(2026, 10, 6, 10, 0)));
  check('a closed month has all of its slots elapsed',
    ctx.objSlotsElapsed('2026-10', 'Daily', now) === 26 &&
    ctx.objSlotsElapsed('2026-10', 'Monthly', now) === 1);
  check('a month that has not started has none',
    ctx.objSlotsElapsed('2026-12', 'Daily', now) === 0);
}

// ===========================================================================
// 4. the marks string
// ===========================================================================
{
  const ctx = load();
  check('a blank month is all pending', ctx.objMarksBlank(5) === '.....');

  check('a stored string is padded to the month it is read for',
    ctx.objMarksRead('YY', 5) === 'YY...');
  check('a stored string too long for its month is trimmed',
    ctx.objMarksRead('YYYYYYY', 3) === 'YYY');
  check('anything that is not a mark is stripped',
    ctx.objMarksRead('Y N!y', 5) === 'YN...',
    ctx.objMarksRead('Y N!y', 5));

  check('one slot changes and the rest do not',
    ctx.objMarksSet('.....', 2, 'Y') === '..Y..');
  check('an out-of-range slot changes nothing',
    ctx.objMarksSet('.....', 9, 'Y') === '.....' &&
    ctx.objMarksSet('.....', -1, 'Y') === '.....');
  check('an unknown mark clears the slot rather than writing itself',
    ctx.objMarksSet('YYYYY', 1, 'Z') === 'Y.YYY');

  check('marks are counted only up to the slots that elapsed',
    ctx.objMarksCount('YYYYY', 'Y', 3) === 3 &&
    ctx.objMarksCount('YYYYY', 'Y') === 5 &&
    ctx.objMarksCount('YNY..', 'N', 5) === 1);
}

// ===========================================================================
// 5. where one objective stands - and the strict reading
// ===========================================================================
{
  const ctx = load();
  const now = new Date(2026, 10, 10, 10, 0, 0);
  const daily = { frequency: 'Daily' };

  // Nine marks: the eight working days that have closed, and today.
  const all = ctx.objTaskState(daily, 'YYYYYYYYY.................', '2026-11', now);
  check('every elapsed day marked done is on schedule',
    all.onSchedule === true && all.done === 8 && all.elapsed === 8,
    'done ' + all.done + ' of ' + all.elapsed);
  /*
    AND TODAY, UNMARKED, IS NOT HELD AGAINST ANYBODY. Same objective,
    nothing recorded for the 10th: still on schedule, because the 10th is
    not over. It becomes a miss tonight if it is still blank, and that is
    the whole of the difference between the two.
  */
  const sofar = ctx.objTaskState(daily, 'YYYYYYYY..................', '2026-11', now);
  check('a day still in progress is not yet a miss',
    sofar.onSchedule === true && sofar.elapsed === 8 && sofar.silent === 0,
    'silent ' + sofar.silent);
  check('and the same month read tomorrow morning does count it',
    ctx.objTaskState(daily, 'YYYYYYYY..................', '2026-11',
      new Date(2026, 10, 11, 9, 0)).onSchedule === false);

  const missed = ctx.objTaskState(daily, 'YYNYYYYYY.................', '2026-11', now);
  check('a day marked missed is not on schedule',
    missed.onSchedule === false && missed.missed === 1 && missed.done === 7,
    'missed ' + missed.missed + ' done ' + missed.done);

  // THE ONE THAT MATTERS. Six days ticked, two days nobody touched. The
  // comfortable reading calls that on schedule because nothing says missed.
  const silent = ctx.objTaskState(daily, 'YYYYYY....................', '2026-11', now);
  check('a slot that passed with nobody marking it counts against',
    silent.onSchedule === false && silent.silent === 2 && silent.done === 6,
    'done ' + silent.done + ' silent ' + silent.silent);

  const ahead = ctx.objTaskState({ frequency: 'Monthly' }, '.', '2026-12', now);
  check('a month that has not started is not already failing',
    ahead.onSchedule === true && ahead.elapsed === 0);

  // A MONTHLY OBJECTIVE, TICKED, IN THE MONTH IT IS TICKED IN. Its one slot
  // is not elapsed until the month ends, so `done` is zero all month - which
  // is right for scoring and read as "0 of 0 done" on a card above a green
  // button saying Done. `marked` is the count the card prints.
  const monthly = ctx.objTaskState({ frequency: 'Monthly' }, 'Y', '2026-11', now);
  check('a monthly objective ticked mid-month says so, even though its ' +
    'slot has not come round',
    monthly.marked === 1 && monthly.done === 0 && monthly.elapsed === 0,
    'marked ' + monthly.marked + ' done ' + monthly.done);
  const early = ctx.objUniqueRolesScore(
    [{ id: 'X', frequency: 'Monthly', kpi: false }],
    { byKey: {} }, '2026-11', now);
  check('an objective not yet due is waiting, not a win',
    early.due === 0 && early.waiting === 1 && early.on === 0 &&
    early.fraction === 1,
    'due ' + early.due + ' waiting ' + early.waiting +
    ' fraction ' + early.fraction);

  const ahead2 = ctx.objTaskState(daily, 'YYNYYYYYY.Y...............', '2026-11', now);
  check('marked counts every slot, done counts only the elapsed ones',
    ahead2.marked === 9 && ahead2.done === 7,
    'marked ' + ahead2.marked + ' done ' + ahead2.done);

  const due = ctx.objTaskState(daily, 'YYYYYYYY..................', '2026-11', now);
  check('the current slot being blank is what "due" means',
    due.due === true && all.due === false);
}

// ===========================================================================
// 6. the weighted score
// ===========================================================================
{
  // Nothing recorded at all. The comfortable bug scores this 100.
  const ctx = load();
  const plan = ctx.readObjPlan();
  check('the plan is nine weighted rows summing to 100',
    plan.rows.length === 9 && plan.weight === 100,
    plan.rows.length + ' rows, weight ' + plan.weight);

  const empty = ctx.objScore(plan, { byKey: {} }, '2026-11', null);
  check('a month with nothing recorded scores zero, not full marks',
    empty.score === 0 && empty.outOf === 100, 'got ' + empty.score);

  // A row is the MEAN of its milestones. Operation has two; record one of
  // them in full and the row is worth half its weight, which is 10.
  const log = { byKey: {} };
  log.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-002')] =
    { value: 2, status: 'ON_TRACK', marks: '', history: [] };
  const half = ctx.objScore(plan, log, '2026-11', null);
  check('a row is the mean of its milestones, not their sum',
    near(half.score, 10), 'got ' + half.score);

  // Over target is not over 100.
  const over = { byKey: {} };
  over.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-002')] =
    { value: 99, status: 'ON_TRACK', marks: '', history: [] };
  check('beating the target does not score more than meeting it',
    near(ctx.objScore(plan, over, '2026-11', null).score, 10));

  // A whole row done: Leadership is one milestone at 100%, weight 10.
  const lead = { byKey: {} };
  lead.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-009')] =
    { value: 100, status: 'ON_TRACK', marks: '', history: [] };
  check('a percentage milestone scores its row in full at 100',
    near(ctx.objScore(plan, lead, '2026-11', null).score, 10));

  // DONE is yes or no, and only the status says so.
  const done = { byKey: {} };
  done.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-008')] =
    { value: null, status: 'DONE', marks: '', history: [] };
  check('a done/not-done milestone scores on its status',
    near(ctx.objScore(plan, done, '2026-11', null).score, 20),
    'Commercial is weight 20 with one milestone');

  const notDone = { byKey: {} };
  notDone.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-008')] =
    { value: null, status: 'ON_TRACK', marks: '', history: [] };
  check('"on track" is not "done" for a done/not-done milestone',
    ctx.objScore(plan, notDone, '2026-11', null).score === 0);
}

// ===========================================================================
// 7. period targets accumulate
// ===========================================================================
{
  const ctx = load();
  const plan = ctx.readObjPlan();
  const log = { byKey: {} };
  const put = (p, v) => {
    log.byKey[ctx.objLogKey(p, 'PLAN', 'OBJ-003')] =
      { value: v, status: 'ON_TRACK', marks: '', history: [] };
  };

  // The score is published to one decimal, so these are the figures the
  // page actually prints: 10 x 2/6 is 3.33, which is 3.3 on screen.
  put('2026-10', 2);
  check('a period target counts only what has happened so far',
    ctx.objScore(plan, log, '2026-10', null).score === 3.3,
    'two of six by October, got ' +
    ctx.objScore(plan, log, '2026-10', null).score);

  put('2026-11', 3);
  check('a later month adds to the earlier ones rather than replacing them',
    ctx.objScore(plan, log, '2026-11', null).score === 8.3,
    'five of six by November, got ' +
    ctx.objScore(plan, log, '2026-11', null).score);

  check('an earlier month is not changed by a later one',
    ctx.objScore(plan, log, '2026-10', null).score === 3.3);

  put('2026-12', 4);
  check('a period target is met and does not overshoot',
    near(ctx.objScore(plan, log, '2026-12', null).score, 10));
}

// ===========================================================================
// 8. the milestone that is counted, not typed
// ===========================================================================
{
  const ctx = load();
  const plan = ctx.readObjPlan();
  const tasks = ctx.readObjTask();
  const now = new Date(2026, 10, 10, 10, 0, 0);

  check('the ninety includes its four KPIs',
    tasks.count === 12 && tasks.tasks.filter((t) => t.kpi).length === 4,
    tasks.count + ' tasks');

  // November: the quarterly KPI has no slot, so eleven of the twelve count.
  const none = ctx.objUniqueRolesScore(tasks.tasks, { byKey: {} }, '2026-11', now);
  check('a quarterly objective is not counted in a month it is not due',
    none.total === 11, 'got ' + none.total);

  /*
    THE FIGURE THE PAGE SHOWS IS OUT OF WHAT IS DUE, NOT OUT OF EVERYTHING.

    Seven of the eleven live objectives here are monthly, and a monthly slot
    is not elapsed until the month ends. Counting those as "on schedule"
    - true, since nothing not yet due can be late - made the page report
    "30 of 85 on schedule" and a milestone sitting at 35% in a month where
    nobody had recorded anything at all. A number that starts at 35% and can
    only fall is not a measure of anything.
  */
  check('nothing recorded scores zero of what is due, not a free 7 of 11',
    none.on === 0 && none.due === 4 && none.fraction === 0,
    'on ' + none.on + ' of ' + none.due + ' due, ' + none.waiting + ' waiting');
  check('and the ones that are not due yet are counted and reported apart',
    none.waiting === 7 && none.total === 11,
    'waiting ' + none.waiting + ' total ' + none.total);

  const log = { byKey: {} };
  // The three SD/MM dailies and weeklies, all ticked up to date.
  log.byKey[ctx.objLogKey('2026-11', 'TASK', 'OJT-006')] = { marks: 'YY...' };
  log.byKey[ctx.objLogKey('2026-11', 'TASK', 'OJT-007')] =
    { marks: 'YYYYYYYYY.................' };
  log.byKey[ctx.objLogKey('2026-11', 'TASK', 'OJT-009')] = { marks: 'YY...' };
  log.byKey[ctx.objLogKey('2026-11', 'TASK', 'OJT-012')] =
    { marks: 'YYYYYYYYY.................' };
  const all = ctx.objUniqueRolesScore(tasks.tasks, log, '2026-11', now);
  check('ticking everything that is due puts the ninety on schedule',
    all.on === 4 && all.due === 4 && near(all.fraction, 1),
    'on ' + all.on + ' of ' + all.due);

  check('the count separates the KPIs from the processes',
    all.kpiDue === 0 && all.processDue === 4,
    'kpi ' + all.kpiDue + ' process ' + all.processDue);

  // And it reaches the score. Operation is weight 20 with two milestones,
  // so the counted one in full is worth 10.
  const auto = { UNIQUE_ROLES: all };
  check('the ninety flow up into the Operation milestone and the score',
    near(ctx.objScore(plan, log, '2026-11', { auto: auto }).score, 10),
    'got ' + ctx.objScore(plan, log, '2026-11', { auto: auto }).score);

  const partial = { UNIQUE_ROLES: none };
  const lower = ctx.objScore(plan, log, '2026-11', { auto: partial }).score;
  const higher = ctx.objScore(plan, log, '2026-11', { auto: auto }).score;
  check('a worse month below gives a lower score above',
    lower < higher && lower === 0 && higher === 10,
    lower + ' against ' + higher);
}

// ===========================================================================
// 9. what the portal already knows
// ===========================================================================
{
  const stamp = (y, m, d) => new Date(y, m, d, 9, 0, 0).getTime();
  const ctx = load({
    shares: [{ stamp: stamp(2026, 10, 3) }, { stamp: stamp(2026, 10, 20) },
             { stamp: stamp(2026, 9, 9) }],
    docs: [{ stamp: stamp(2026, 10, 2) }, { stamp: stamp(2026, 10, 4) },
           { stamp: stamp(2026, 10, 6) }, { stamp: stamp(2026, 8, 1) }]
  });
  const tasks = ctx.readObjTask();
  const auto = ctx.objAutoSources(tasks.tasks, { byKey: {} }, '2026-11',
                                  new Date(2026, 10, 10));

  check('knowledge shares are counted into the month they were posted',
    auto.KNOWLEDGE.value === 2, 'got ' + auto.KNOWLEDGE.value);
  check('library documents are counted by when they were updated',
    auto.LEARN.value === 3, 'got ' + auto.LEARN.value);

  const plan = ctx.readObjPlan();
  // Knowledge target is 1 a month and two were posted, so that milestone is
  // its row in full: PO1 is weight 10 with one milestone.
  const scored = ctx.objScore(plan, { byKey: {} }, '2026-11', { auto: auto });
  const po1 = scored.rows.filter((r) => r.rowId === 'PO1')[0];
  const po3 = scored.rows.filter((r) => r.rowId === 'PO3')[0];
  check('a counted milestone scores without anybody recording it',
    near(po1.fraction, 1) && near(po3.fraction, 1),
    'PO1 ' + po1.fraction + ' PO3 ' + po3.fraction);

  // EVERY MONTH, NOT JUST THE ONE ON SCREEN. The six pips under a milestone
  // need the other five, and the first version worked the auto sources out
  // only for the month being looked at - so a counted milestone drew five
  // red pips for months that had been fine.
  const every = ctx.objAutoAll(ctx.readObjTask().tasks, { byKey: {} },
    ctx.objPeriods(), new Date(2026, 10, 10));
  check('the auto sources are worked out for every month of the period',
    Object.keys(every).length === 6 &&
    every['2026-10'].KNOWLEDGE.value === 1 &&
    every['2026-11'].KNOWLEDGE.value === 2 &&
    every['2026-12'].KNOWLEDGE.value === 0,
    'Oct ' + every['2026-10'].KNOWLEDGE.value +
    ' Nov ' + every['2026-11'].KNOWLEDGE.value);
  check('and the library count is split by month the same way',
    every['2026-11'].LEARN.value === 3 && every['2026-09'] === undefined &&
    every['2027-03'].LEARN.value === 0);
  check('each month gets its own reading of the ninety',
    Boolean(every['2026-10'].UNIQUE_ROLES) &&
    Boolean(every['2027-03'].UNIQUE_ROLES));
}

// ===========================================================================
// 10. a source that cannot be read must not take the page down
// ===========================================================================
{
  const ctx = load({ knowledgeThrows: true, learnThrows: true });
  const tasks = ctx.readObjTask();
  let auto = null;
  let threw = false;
  try {
    auto = ctx.objAutoSources(tasks.tasks, { byKey: {} }, '2026-11',
                              new Date(2026, 10, 10));
  } catch (e) { threw = true; }

  check('a missing Knowledge or Learn tab does not throw',
    !threw && auto && !auto.KNOWLEDGE && !auto.LEARN);
  check('the ninety are still counted when the other two fail',
    Boolean(auto && auto.UNIQUE_ROLES));

  // And the milestone falls back to what was typed rather than scoring zero.
  const plan = ctx.readObjPlan();
  const log = { byKey: {} };
  log.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-004')] =
    { value: 1, status: 'ON_TRACK', marks: '', history: [] };
  const scored = ctx.objScore(plan, log, '2026-11', { auto: auto });
  const po1 = scored.rows.filter((r) => r.rowId === 'PO1')[0];
  check('an unreadable source falls back to what was recorded by hand',
    near(po1.fraction, 1), 'got ' + po1.fraction);
}

// ===========================================================================
// 11. who may do what
// ===========================================================================
{
  // A member of the SD section, not a head.
  const ctx = load({ session: { u: '20990001', r: 'USER' } });
  const me = ctx.objWhoAmI('t');
  check('a team member is identified by name and module',
    me.name === 'Bilal Hossain' && me.groups.join(',') === 'SD' &&
    me.planner === false && me.admin === false);

  const SD = { group: 'SD', kpi: false };
  const MM = { group: 'MM', kpi: false };
  const KPI = { group: 'All', kpi: true };

  check('a member may tick their own module and not another',
    ctx.objMayTick(me, SD) === true && ctx.objMayTick(me, MM) === false);
  check('nobody ticks the four KPIs - those are the engine"s',
    ctx.objMayTick(me, KPI) === false);

  const head = load({ session: { u: '20990002', r: 'USER' } }).objWhoAmI('t');
  check('a section head may record against the SMART objective',
    head.planner === true && head.name === 'Ayesha Rahman');

  const lead = load({ session: { u: '20990000', r: 'USER' } }).objWhoAmI('t');
  check('the department head counts as a head too',
    lead.planner === true);
  check('a module cell of MM/MD is two modules, not one',
    lead.groups.length === 2 && lead.groups.indexOf('MM') !== -1 &&
    lead.groups.indexOf('MD') !== -1, lead.groups.join(','));

  const blank = load({ session: { u: '20990004', r: 'USER' } }).objWhoAmI('t');
  check('an empty module cell can tick nothing, and is told why',
    blank.groups.length === 0 &&
    ctx.objMayTick(blank, SD) === false &&
    /Module cell/.test(blank.reason), blank.reason);

  const admin = load({ session: { u: '20990009', r: 'ADMIN' }, admin: true })
    .objWhoAmI('t');
  check('an admin is a planner and may tick any module',
    admin.admin === true && admin.planner === true && admin.all === true &&
    ctx.objMayTick(admin, MM) === true);

  // THE ONE THE GROUP NAME ALONE GOT WRONG. An admin passes the module
  // test for everything, so if being a KPI is not checked here the page
  // draws a tick button on the four and the server refuses the press.
  check('not even an admin ticks a KPI',
    ctx.objMayTick(admin, KPI) === false);

  // Fails closed. Every caller reaches this past requireSignedIn, so an
  // empty `me` means something upstream broke rather than that somebody is
  // signed out - and the safe answer to "may this nobody tick it" is no.
  check('a caller with no identity, and a missing objective, may tick nothing',
    ctx.objMayTick(null, SD) === false &&
    ctx.objMayTick({ id: '', groups: ['SD'] }, SD) === false &&
    ctx.objMayTick(me, null) === false);

  const stranger = load({ session: { u: '29999999', r: 'USER' } }).objWhoAmI('t');
  check('somebody not in the directory is told that, not silently allowed',
    stranger.groups.length === 0 && /not in the team directory/.test(stranger.reason));

  const broken = load({ teamThrows: true, session: { u: '20990001', r: 'USER' } })
    .objWhoAmI('t');
  check('a directory that cannot be read does not hand out permissions',
    broken.groups.length === 0 && broken.planner === false);
}

// ===========================================================================
// 12. recording a milestone
// ===========================================================================
{
  const ctx = load({ session: { u: '20990002', r: 'USER' } });   // a head
  const r = ctx.recordObjMilestone('t', 'OBJ-002', '2026-11',
    { value: 2, status: 'ON_TRACK' });
  check('a section head can record a milestone', r.ok === true &&
    r.by === 'Ayesha Rahman');

  const row = ctx.__tabs.OBJ_LOG.rows[1];
  check('the log holds the month, the kind, the reference and the value',
    row[0] === '2026-11' && row[1] === 'PLAN' && row[2] === 'OBJ-002' &&
    row[4] === 2 && row[5] === 'ON_TRACK');
  check('who recorded it and when are stored with it',
    row[7] === 'Ayesha Rahman' && row[8] === '20990002' && row[9]);

  check('recording twice updates the row rather than adding another',
    (ctx.recordObjMilestone('t', 'OBJ-002', '2026-11', { value: 1 }),
     ctx.__tabs.OBJ_LOG.rows.length === 2),
    ctx.__tabs.OBJ_LOG.rows.length + ' rows');

  const history = JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][10]);
  check('the value it replaced is kept, so a correction is not an erasure',
    history.length === 1 && history[0].value === 2 &&
    history[0].by === 'Ayesha Rahman', JSON.stringify(history));

  /*
    RECORDING IT IS THE MARK, which is what gives the SMART objective the
    same four colours the ninety have. November was recorded in November,
    so its square is green; the same figure typed in January would be
    yellow, and a November that ended with nothing is red.
  */
  check('recording a milestone marks the month it was recorded in',
    ctx.__tabs.OBJ_LOG.rows[1][3] === 'Y' &&
    JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][11])['0'] > 0,
    ctx.__tabs.OBJ_LOG.rows[1][3] + ' ' + ctx.__tabs.OBJ_LOG.rows[1][11]);

  /*
    AND THE STAMP IS SET ONCE. Correcting November's figure in December is
    a correction, not a late record of November, and a square that went
    yellow every time somebody fixed a number would be punishing the fix.
  */
  const first = JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][11])['0'];
  ctx.__advance(26 * 3600 * 1000);          // the next day
  ctx.recordObjMilestone('t', 'OBJ-002', '2026-11', { value: 3 });
  const again = JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][11])['0'];
  check('and correcting it later does not restamp it as a late record',
    again === first && ctx.__tabs.OBJ_LOG.rows[1][9].getTime() > first,
    first + ' -> ' + again);
}

// ===========================================================================
// 13. recording a milestone - what is refused
// ===========================================================================
{
  const member = load({ session: { u: '20990001', r: 'USER' } });
  let msg = '';
  try {
    member.recordObjMilestone('t', 'OBJ-002', '2026-11', { value: 1 });
  } catch (e) { msg = e.message; }
  check('a team member cannot record against the SMART objective',
    /section heads/.test(msg), msg);

  const head = load({ session: { u: '20990002', r: 'USER' } });

  msg = '';
  try {
    head.recordObjMilestone('t', 'OBJ-001', '2026-11', { value: 50 });
  } catch (e) { msg = e.message; }
  check('the counted milestone refuses to be typed in',
    /counted from the ninety/.test(msg), msg);

  msg = '';
  try {
    head.recordObjMilestone('t', 'OBJ-002', '2027-09', { value: 1 });
  } catch (e) { msg = e.message; }
  check('a month outside the period is refused',
    /outside the objective period/.test(msg), msg);

  msg = '';
  try {
    head.recordObjMilestone('t', 'OBJ-404', '2026-11', { value: 1 });
  } catch (e) { msg = e.message; }
  check('an unknown milestone is refused', /no milestone with that id/.test(msg));

  msg = '';
  try {
    head.recordObjMilestone('t', 'OBJ-009', '2026-11', { value: 140 });
  } catch (e) { msg = e.message; }
  check('a percentage over 100 is refused', /cannot be more than 100/.test(msg));

  msg = '';
  try {
    head.recordObjMilestone('t', 'OBJ-002', '2026-11', { value: -3 });
  } catch (e) { msg = e.message; }
  check('a negative count is refused', /not a number/.test(msg));

  msg = '';
  try {
    head.recordObjMilestone('t', 'OBJ-002', '2026-11', { status: 'FINE' });
  } catch (e) { msg = e.message; }
  check('a status that is not one of the four is refused',
    /not a status/.test(msg));

  check('nothing refused was written',
    head.__tabs.OBJ_LOG.rows.length === 1,
    head.__tabs.OBJ_LOG.rows.length + ' rows');
}

// ===========================================================================
// 14. ticking a unique-role objective
// ===========================================================================
{
  const ctx = load({ session: { u: '20990001', r: 'USER' } });   // SD member
  const r = ctx.tickObjTask('t', 'OJT-007', '2026-11', 0, 'Y');
  check('a member can tick their own module"s objective',
    r.ok === true && r.marks.charAt(0) === 'Y' && r.done === 1);
  check('the marks string is the length of the month, not of the tick',
    r.marks.length === 26, 'got ' + r.marks.length);

  ctx.tickObjTask('t', 'OJT-007', '2026-11', 2, 'N');
  const row = ctx.__tabs.OBJ_LOG.rows[1];
  check('a second tick changes its own slot and leaves the first alone',
    row[3] === 'Y.N' + '.'.repeat(23), row[3]);
  check('ticking stays on one row per objective per month',
    ctx.__tabs.OBJ_LOG.rows.length === 2);

  let msg = '';
  try { ctx.tickObjTask('t', 'OJT-008', '2026-11', 0, 'Y'); }
  catch (e) { msg = e.message; }
  check('a member cannot tick another module"s objective',
    /belongs to the MM module/.test(msg), msg);

  msg = '';
  try { ctx.tickObjTask('t', 'OJT-001', '2026-11', 0, 'Y'); }
  catch (e) { msg = e.message; }
  check('a KPI cannot be ticked by hand', /comes from the KPI/.test(msg), msg);

  msg = '';
  try { ctx.tickObjTask('t', 'OJT-007', '2026-11', 40, 'Y'); }
  catch (e) { msg = e.message; }
  check('a slot past the end of the month is refused',
    /no slot 40/.test(msg), msg);

  msg = '';
  try { ctx.tickObjTask('t', 'OJT-006', '2026-11', 4, 'Y'); }
  catch (e) { msg = e.message; }
  check('a weekly objective has five slots and no sixth',
    msg === '' && ctx.tickObjTask('t', 'OJT-006', '2026-11', 4, 'Y').ok === true);

  msg = '';
  try { ctx.tickObjTask('t', 'OJT-006', '2026-11', 5, 'Y'); }
  catch (e) { msg = e.message; }
  check('and the sixth is refused', /no slot 5/.test(msg), msg);

  const blank = load({ session: { u: '20990004', r: 'USER' } });
  msg = '';
  try { blank.tickObjTask('t', 'OJT-007', '2026-11', 0, 'Y'); }
  catch (e) { msg = e.message; }
  check('somebody with no module is told what to do about it',
    /Module cell/.test(msg), msg);

  const admin = load({ session: { u: '20990009', r: 'ADMIN' }, admin: true });
  check('an admin may tick any module',
    admin.tickObjTask('t', 'OJT-008', '2026-11', 0, 'Y').ok === true);
}

// ===========================================================================
// 15. adding a milestone must not move the weighting
// ===========================================================================
{
  const ctx = load({ session: { u: '20990009', r: 'ADMIN' }, admin: true });
  const before = ctx.readObjPlan();

  const made = ctx.createObjMilestone('t', {
    rowId: 'PO2', objective: 'Improve user understanding.',
    milestone: 'Run 2 refresher sessions a month.',
    countType: 'NUMBER', target: 2, per: 'MONTH'
  });
  check('a new milestone gets the next id in sequence',
    made.id === 'OBJ-011', made.id);
  check('it joins an existing row and takes that row"s weight',
    made.rowId === 'PO2' && made.weight === 5 && made.sharedAcross === 2);

  const after = ctx.readObjPlan();
  check('the weighting is still exactly 100',
    after.weight === 100 && after.rows.length === before.rows.length,
    'weight ' + after.weight + ' rows ' + after.rows.length);
  check('the row it joined now has two milestones',
    after.rows.filter((r) => r.rowId === 'PO2')[0].milestones.length === 2);

  // That row is now a mean of two, so recording one of them is worth half.
  const log = { byKey: {} };
  log.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-005')] =
    { value: 1, status: 'ON_TRACK', marks: '', history: [] };
  check('adding a milestone shares the row rather than adding to the total',
    near(ctx.objScore(after, log, '2026-11', null).score, 2.5),
    'got ' + ctx.objScore(after, log, '2026-11', null).score);

  let msg = '';
  try {
    ctx.createObjMilestone('t', { rowId: 'NOPE', milestone: 'Something.' });
  } catch (e) { msg = e.message; }
  check('a category that does not exist is refused',
    /no category with the id/.test(msg), msg);

  msg = '';
  try { ctx.createObjMilestone('t', { rowId: 'PO2' }); }
  catch (e) { msg = e.message; }
  check('a milestone with no measure is refused', /needs its measure/.test(msg));

  msg = '';
  try {
    ctx.createObjMilestone('t', { rowId: 'PO2', milestone: 'X.',
                                  countType: 'VIBES' });
  } catch (e) { msg = e.message; }
  check('an unknown count type is refused', /counted as a number/.test(msg));
}

// ===========================================================================
// 16. adding is the admin"s alone
// ===========================================================================
{
  const head = load({ session: { u: '20990002', r: 'USER' }, admin: false });
  let msg = '';
  try {
    head.createObjMilestone('t', { rowId: 'PO2', milestone: 'Something.' });
  } catch (e) { msg = e.message; }
  check('a section head cannot add an objective', /admin login/.test(msg), msg);
  check('and nothing was written',
    head.__tabs.OBJ_PLAN.rows.length === 11,
    head.__tabs.OBJ_PLAN.rows.length + ' rows');
}

// ===========================================================================
// 17. a plan that is not quite right
// ===========================================================================
{
  // A milestone whose Row ID somebody blanked. Counted, it would get its own
  // weight and push the total past 100.
  const rows = planRows();
  rows[4][1] = '';
  const ctx = load({ plan: rows });
  const plan = ctx.readObjPlan();
  check('a milestone with no row is dropped rather than weighted on its own',
    plan.weight === 95 && plan.plan.length === 9,
    'weight ' + plan.weight + ' of ' + plan.plan.length);

  const empty = load({ plan: [], tasks: [] });
  check('empty tabs read as empty rather than throwing',
    empty.readObjPlan().filled === false &&
    empty.readObjTask().filled === false &&
    empty.readObjLog().count === 0);

  empty.setupObjectiveTabs();
  check('setup says which tab is empty and what to do about it',
    empty.__logs.join('\n').indexOf('Import OBJ_PLAN.csv') !== -1 &&
    empty.__logs.join('\n').indexOf('A1:L91') !== -1);

  const short = load({ plan: planRows().slice(0, 3) });
  short.setupObjectiveTabs();
  check('a weighting that is not 100 is called out, because every figure ' +
    'on the page is a share of it',
    short.__logs.join('\n').indexOf('WEIGHTING IS 30, NOT 100') !== -1,
    short.__logs.join('\n').split('\n').filter((l) => /WEIGHT/.test(l))[0]);
}

// ===========================================================================
// 18. a broken History cell
// ===========================================================================
{
  const ctx = load({
    log: [['2026-11', 'PLAN', 'OBJ-002', '', 2, 'ON_TRACK', 'A note',
           'Ayesha Rahman', '20990002', new Date(2026, 10, 4), '{not json']]
  });
  const log = ctx.readObjLog();
  check('a broken history cell reads as no history, not as an exception',
    log.count === 1 &&
    log.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-002')].history.length === 0);
  check('and the entry it belongs to is still readable',
    log.byKey[ctx.objLogKey('2026-11', 'PLAN', 'OBJ-002')].value === 2);
}

// ===========================================================================
// 18b. THE PERIOD COLUMN COMES BACK AS A DATE
// ===========================================================================
// Sheets parses '2026-11' written into a cell as the first of November
// 2026. This is not a hypothetical: it is what made Save appear to work and
// record nothing. The write landed, the read looked for the text '2026-11',
// got a Date, missed every key, and the page said "Nothing recorded"
// directly above the row that had just been written.
{
  const ctx = load();
  const asDate = new Date(2026, 10, 1);          // what the cell really holds

  check('a period cell holding a Date reads back as its month',
    ctx.objPeriodCell(asDate) === '2026-11' &&
    ctx.objPeriodCell('2026-11') === '2026-11' &&
    ctx.objPeriodCell('  2026-11  ') === '2026-11',
    ctx.objPeriodCell(asDate));

  check('and the key built from either one is the same key',
    ctx.objLogKey(asDate, 'PLAN', 'OBJ-002') ===
    ctx.objLogKey('2026-11', 'PLAN', 'OBJ-002'),
    ctx.objLogKey(asDate, 'PLAN', 'OBJ-002'));

  // A tab written before the fix: the period is a Date, as Sheets stored it.
  const dated = load({
    session: { u: '20990002', r: 'USER' },
    log: [[asDate, 'PLAN', 'OBJ-002', '', 2, 'ON_TRACK', 'Both closed.',
           'Ayesha Rahman', '20990002', new Date(2026, 10, 4), '[]']]
  });

  const read = dated.readObjLog();
  check('a row stored with a Date period is still found',
    Boolean(read.byKey[dated.objLogKey('2026-11', 'PLAN', 'OBJ-002')]),
    Object.keys(read.byKey).join(' '));
  check('and it scores, rather than reading as nothing recorded',
    near(dated.objScore(dated.readObjPlan(), read, '2026-11', null).score, 10),
    'got ' + dated.objScore(dated.readObjPlan(), read, '2026-11', null).score);

  // THE SECOND HALF OF THE BUG. A save that cannot find its own row appends
  // another one, so the tab fills with duplicates of the same month.
  dated.recordObjMilestone('t', 'OBJ-002', '2026-11', { value: 1 });
  check('saving again updates that row instead of appending a duplicate',
    dated.__tabs.OBJ_LOG.rows.length === 2,
    dated.__tabs.OBJ_LOG.rows.length + ' rows');
  check('and the value it replaced is kept',
    JSON.parse(dated.__tabs.OBJ_LOG.rows[1][10])[0].value === 2,
    dated.__tabs.OBJ_LOG.rows[1][10]);

  check('the page reads back what was just saved',
    dated.getObjectives('t').plan.rows
      .filter((r) => r.rowId === 'OP')[0].milestones
      .filter((m) => m.id === 'OBJ-002')[0].value === 1);
}

// ===========================================================================
// 18c. reading six tabs once instead of every time
// ===========================================================================
{
  // A cache that actually caches, so the saving can be counted.
  const store = {};
  const ctx = load({ cache: store, session: { u: '20990009', r: 'ADMIN' },
                     admin: true });

  const before = ctx.__reads.OBJ_PLAN;
  ctx.getObjectives('t');
  ctx.getObjectives('t');
  ctx.getObjectives('t');
  const after = ctx.__reads.OBJ_PLAN;

  check('the plan is read once however many times the page is drawn',
    after - before === 1, (after - before) + ' reads for 3 page loads');
  check('and so are the ninety and the directory',
    ctx.__reads.OBJ_TASK === 1 && ctx.__reads.TEAM === 1,
    'task ' + ctx.__reads.OBJ_TASK + ' team ' + ctx.__reads.TEAM);

  // THE LOG IS NOT CACHED, and must not be: it is what a tick writes, and a
  // cached one means pressing a button and watching nothing happen.
  check('the log is read fresh every single time',
    ctx.__reads.OBJ_LOG === 3, ctx.__reads.OBJ_LOG + ' reads');

  ctx.createObjMilestone('t', { rowId: 'PO2', milestone: 'Something new.',
                                countType: 'NUMBER', target: 1, per: 'MONTH' });
  ctx.getObjectives('t');
  check('adding a milestone throws the cached plan away, so it shows at once',
    ctx.__reads.OBJ_PLAN > after &&
    ctx.getObjectives('t').plan.count === 11,
    'reads ' + ctx.__reads.OBJ_PLAN);
}

// ===========================================================================
// 18c-ii. the answer is small enough to send
// ===========================================================================
/*
  WHAT THIS IS GUARDING, measured rather than assumed.

  Every byte here crosses the Apps Script sandbox bridge, which serialises
  the whole answer twice. The first version sent one object per slot per
  objective - {slot, state, at} - which came to 945 bytes for a single
  daily objective"s twenty-six squares. Ninety objectives of those is
  eighty-five kilobytes of colour, and the page took seconds to appear.

  A ceiling rather than an exact figure: the point is that somebody adding
  a field to the row finds out here if it is an expensive one.
*/
{
  const ctx = load();
  const page = ctx.getObjectives('t');
  const tasks = page.tasks.list.length;
  const milestones = page.plan.count;

  const perTask = JSON.stringify(page.tasks).length / tasks;
  check('a unique-role objective costs a few hundred bytes, not a few ' +
    'thousand',
    perTask < 500, Math.round(perTask) + ' bytes each');

  const daily = page.tasks.list.filter((t) => t.slots > 20)[0];
  check('the colours of a whole month are a string, not an object a slot',
    typeof daily.states === 'string' && daily.states.length === daily.slots &&
    daily.cells === undefined,
    JSON.stringify(daily.states));
  check('and only the slots that were marked carry a time',
    Object.keys(daily.times).length === 0, JSON.stringify(daily.times));

  const perMilestone = JSON.stringify(page.plan).length / milestones;
  check('a milestone costs under a kilobyte, with its six months on it',
    perMilestone < 1000, Math.round(perMilestone) + ' bytes each');

  /*
    AND ONLY AS MUCH TIMELINE AS THE TIMELINE DRAWS.

    The row keeps twenty past versions so that a correction is never an
    erasure. The Updates panel shows eight, and the other twelve were
    being sent for all twenty-nine milestones on every load and read by
    nobody - a couple of kilobytes a milestone for a scroll that does
    not exist.
  */
  const deep = load({ session: { u: '20990002', r: 'USER' } });
  for (let i = 0; i < 14; i++) {
    deep.__advance(60000);
    deep.recordObjMilestone('t', 'OBJ-002', '2026-11', { value: i });
  }
  const m = deep.getObjectives('t').plan.rows
    .reduce(function (hit, r) {
      return hit || r.milestones.filter((x) => x.id === 'OBJ-002')[0];
    }, null);
  // Thirteen, not fourteen: the first write had no row to push onto the
  // timeline, so fourteen records leave thirteen versions behind them.
  check('thirteen corrections are kept, and eight are sent',
    JSON.parse(deep.__tabs.OBJ_LOG.rows[1][10]).length === 13 &&
    m.history.length === 8,
    'kept ' + JSON.parse(deep.__tabs.OBJ_LOG.rows[1][10]).length +
      ', sent ' + m.history.length);
  check('and the marks string is not sent on each of them',
    m.history.every((h) => h.marks === undefined),
    JSON.stringify(m.history[0]));

  // The sheet has these columns and no part of this screen draws them.
  check('columns nothing draws are not sent at all',
    daily.method === undefined && daily.owner === undefined,
    JSON.stringify({ m: daily.method, o: daily.owner }));
}

// ===========================================================================
// 18d. the month is worked out once, not sixteen thousand times
// ===========================================================================
{
  const ctx = load();

  // Same array back, which is the whole proof: scoring the ninety across
  // six months calls this about a thousand times, and it used to build a
  // Date for every day of the month on every one of them.
  const first = ctx.objWorkingDays('2026-11');
  check('a month"s working days are worked out once and kept',
    ctx.objWorkingDays('2026-11') === first, 'a second call rebuilt them');
  check('and a different month is not confused with it',
    ctx.objWorkingDays('2026-10') !== first &&
    ctx.objWorkingDays('2026-10').length === 26);

  /*
    The slot count is kept too, and proving it needs a spy rather than a
    comparison: the ANSWER is 22 either way, so asking twice and checking
    the number says nothing about whether it was worked out twice.
  */
  const spied = load();
  const real = spied.objWorkingDays;
  let asked = 0;
  spied.objWorkingDays = function (p) { asked++; return real(p); };

  check('the slot count is kept per month and frequency too',
    spied.objSlotCount('2026-11', 'Daily') === 26 &&
    spied.objSlotCount('2026-11', 'Daily') === 26 &&
    spied.objSlotCount('2026-11', 'Daily') === 26 &&
    asked === 1,
    'the month was consulted ' + asked + ' time(s) for 3 identical asks');
  check('and a different frequency is still worked out',
    spied.objSlotCount('2026-11', 'Weekly') === 5 &&
    spied.objSlotCount('2026-12', 'Daily') === 27 && asked === 2,
    'asked ' + asked);

  /*
    A MONTH THAT IS OVER IS ANSWERED WITHOUT WALKING IT.

    objSlotsElapsed counts the slots whose end is behind us, and for a
    closed month that is all of them - so the loop would give the right
    answer on its own and the early return looks like a line worth
    deleting. It is not. Six months of ninety objectives is 540 of these
    calls per page, and the Objective tab was already slow enough to be
    complained about; walking 26 working days and building a Date for each
    to re-learn "October is over" is 14,000 Dates for nothing.

    Counted rather than reasoned about, because the ANSWER is 26 either
    way: only a spy can tell a short-circuit from a loop.
  */
  const sp2 = load();
  const realEnd = sp2.objSlotEnd;
  let ends = 0;
  sp2.objSlotEnd = function (p, f, i) { ends++; return realEnd(p, f, i); };
  const nov10 = new Date(2026, 10, 10, 10, 0, 0);
  check('a closed month gives all its slots without walking them',
    sp2.objSlotsElapsed('2026-10', 'Daily', nov10) === 26 && ends === 0,
    'built ' + ends + ' slot ends for a month that is over');
  check('and a month that has not started is answered the same way',
    sp2.objSlotsElapsed('2026-12', 'Daily', nov10) === 0 && ends === 0,
    'built ' + ends + ' slot ends');
  check('while the month in progress does have to be walked',
    sp2.objSlotsElapsed('2026-11', 'Daily', nov10) === 8 && ends === 26,
    'built ' + ends + ' slot ends');

  // THE CALENDAR THE PAGE DRAWS FROM. Thirty cells, of which 22 count.
  const page = ctx.getObjectives('t');
  check('the page is given the month as a calendar, not just a slot count',
    page.days.count === 30 && page.days.work.length === 26 &&
    page.days.work[0] === 1 && page.days.work[5] === 7,
    'count ' + page.days.count + ' work ' + page.days.work.length);
  check('and Friday alone is absent from the days that count',
    page.days.work.indexOf(6) === -1 && page.days.work.indexOf(13) === -1 &&
    page.days.work.indexOf(7) !== -1 && page.days.work.indexOf(28) !== -1);
}

// ===========================================================================
// 18e. a tick answers with the row, so the page need not reload
// ===========================================================================
{
  const ctx = load({ session: { u: '20990001', r: 'USER' } });
  const r = ctx.tickObjTask('t', 'OJT-007', '2026-11', 0, 'Y');

  check('a tick comes back with everything needed to redraw that one row',
    r.id === 'OJT-007' && r.marks.length === 26 && r.slots === 26 &&
    r.elapsed === 8 && r.done === 1 && r.onSchedule === false &&
    typeof r.marked === 'number' && typeof r.due === 'boolean',
    JSON.stringify({ id: r.id, done: r.done, elapsed: r.elapsed }));
  check('including who marked it and when',
    r.by === 'Bilal Hossain' && r.at > 0);
}

// ===========================================================================
// 18f. green, yellow and red
// ===========================================================================
// Green and yellow are the SAME MARK. Only when it was made tells them
// apart, which is why the moment of each mark is stored beside it - and why
// red needs nothing stored at all, being what a period that came and went
// without a mark simply is.
{
  const ctx = load();
  const now = new Date(2026, 10, 10, 10, 0, 0);
  const daily = { frequency: 'Daily' };

  const onTime = new Date(2026, 10, 3, 14, 0, 0).getTime();   // the 3rd
  const caught = new Date(2026, 10, 10, 9, 0, 0).getTime();   // a week later

  // Slot 2 is the 3rd of November - working days run 1,2,3,4,5,7,...
  const green = ctx.objTaskState(daily, '..Y.......................',
    '2026-11', now, { '2': onTime });
  check('a mark made while its own day was still open is green',
    green.cells[2].state === 'done' && green.late === 0,
    green.cells[2].state);

  const yellow = ctx.objTaskState(daily, '..Y.......................',
    '2026-11', now, { '2': caught });
  check('the same mark made a week later is yellow, not green',
    yellow.cells[2].state === 'late' && yellow.late === 1,
    yellow.cells[2].state);
  check('and it carries the moment it was made, for the tooltip',
    yellow.cells[2].at === caught);

  check('an unmarked day that has been and gone is red, with nothing stored',
    yellow.cells[1].state === 'missed' && yellow.cells[1].at === 0);
  check('and one that has not arrived yet is neither',
    yellow.cells[20].state === 'pending');

  // Late is still DONE. The work happened; it was written down afterwards.
  check('a late mark still counts as done for the score',
    yellow.done === 1 && green.done === 1,
    'late done ' + yellow.done + ', on-time done ' + green.done);

  // A monthly slot closes at the end of the month, so marking it on the
  // 10th is on time - this is the case that makes the window matter.
  const monthly = ctx.objTaskState({ frequency: 'Monthly' }, 'Y', '2026-11',
    now, { '0': caught });
  check('a monthly mark made mid-month is on time, not late',
    monthly.cells[0].state === 'done' && monthly.late === 0);

  const lateMonth = ctx.objTaskState({ frequency: 'Monthly' }, 'Y', '2026-10',
    now, { '0': caught });
  check('but the same mark against last month is late',
    lateMonth.cells[0].state === 'late' && lateMonth.late === 1);
}

// ===========================================================================
// 18f2. the moment of a mark is written down, and taken away again
// ===========================================================================
// The timestamp is the ONLY thing that separates a green square from a
// yellow one, so it has to be recorded at the moment the mark is made -
// and cleared when the mark is cleared, or the row keeps a time for
// something that is not marked.
{
  const ctx = load({ session: { u: '20990001', r: 'USER' } });
  // The vm's clock, not Node's: this suite pins today to 10 November 2026,
  // and comparing a mark made in there against the real wall clock would
  // only ever be a test of what year it is now.
  const before = vm.runInContext('Date.now()', ctx);

  ctx.tickObjTask('t', 'OJT-007', '2026-11', 3, 'Y');
  const row = ctx.__tabs.OBJ_LOG.rows[1];
  const stamps = JSON.parse(row[11] || '{}');

  check('ticking records WHEN, beside the mark',
    Object.keys(stamps).join(',') === '3' && stamps['3'] >= before,
    row[11]);

  ctx.tickObjTask('t', 'OJT-007', '2026-11', 5, 'Y');
  check('a second tick adds to it rather than replacing it',
    Object.keys(JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][11])).sort().join(',')
      === '3,5', ctx.__tabs.OBJ_LOG.rows[1][11]);

  ctx.tickObjTask('t', 'OJT-007', '2026-11', 3, '.');
  check('and clearing a mark takes its time away with it',
    Object.keys(JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][11])).join(',') === '5',
    ctx.__tabs.OBJ_LOG.rows[1][11]);

  // Marking day 4 (slot 3 is the 4th) long after it closed reads as late.
  const page = ctx.getObjectives('t');
  const t7 = page.tasks.list.filter((t) => t.id === 'OJT-007')[0];
  // One character per slot on the wire - see objStateChars. 'l' is late.
  check('and the page is told which squares are late',
    t7.states.charAt(5) === 'l' && t7.states.charAt(3) === 'n',
    t7.states);
  check('and the time each was marked, for the ones that carry one',
    t7.times['5'] > 0 && t7.times['3'] === undefined,
    JSON.stringify(t7.times));
}

// ===========================================================================
// 18g. open is not elapsed
// ===========================================================================
// Conflating the two made a monthly objective impossible to record in its
// own month: its slot is not ELAPSED until the 30th, and a page that only
// let you press elapsed slots therefore let you press nothing at all.
{
  const ctx = load();
  const now = new Date(2026, 10, 10, 10, 0, 0);

  check('a monthly slot is open all month and elapsed only after it',
    ctx.objSlotsOpen('2026-11', 'Monthly', now) === 1 &&
    ctx.objSlotsElapsed('2026-11', 'Monthly', now) === 0);
  // A quarterly one the same, once the month it falls in has started -
  // and not before it, which is a different thing from "not due".
  const inDec = new Date(2026, 11, 4, 10, 0, 0);
  check('a quarterly slot opens once its month begins, and not before',
    ctx.objSlotsOpen('2026-12', 'Quarterly', inDec) === 1 &&
    ctx.objSlotsOpen('2026-12', 'Quarterly', now) === 0,
    'December from December ' +
    ctx.objSlotsOpen('2026-12', 'Quarterly', inDec) +
    ', from November ' + ctx.objSlotsOpen('2026-12', 'Quarterly', now));
  check('for daily and weekly the two agree, because the day in progress ' +
    'already counts',
    ctx.objSlotsOpen('2026-11', 'Daily', now) === 9 &&
    ctx.objSlotsOpen('2026-11', 'Weekly', now) === 2);
  check('a month that has not started is open for nothing',
    ctx.objSlotsOpen('2026-12', 'Monthly', now) === 0);
  check('and a closed one is open for all of it',
    ctx.objSlotsOpen('2026-10', 'Daily', now) === 26);

  const page = ctx.getObjectives('t');
  const monthly = page.tasks.list.filter((t) => t.id === 'OJT-005')[0];
  check('the page is told how many slots it may let somebody press',
    monthly.open === 1 && monthly.elapsed === 0,
    'open ' + monthly.open + ' elapsed ' + monthly.elapsed);
  check('so a monthly objective is waiting on somebody, not closed off',
    monthly.due === true);
}

// ===========================================================================
// 18h. a quarterly objective says WHEN, not just "no"
// ===========================================================================
{
  const ctx = load();
  const page = ctx.getObjectives('t', '2026-10');
  const q = page.tasks.list.filter((t) => t.id === 'OJT-003')[0];

  check('a quarterly objective has no slot in a month that does not close ' +
    'its quarter',
    q.slots === 0, q.slots + ' slots in October');
  check('and the page is told the month it IS due in, so it can say so',
    q.dueIn === '2026-12', q.dueIn);

  const dec = ctx.getObjectives('t', '2026-12').tasks.list
    .filter((t) => t.id === 'OJT-003')[0];
  check('in December it is due, and says nothing about a later month',
    dec.slots === 1 && dec.dueIn === '', dec.slots + ' / ' + dec.dueIn);
}

// ===========================================================================
// 18h-ii. a milestone's month is a square, and it is pressed
// ===========================================================================
/*
  THE ONE PART OF THE TWO SHEETS THAT STILL WORKED DIFFERENTLY.

  A milestone's months showed a colour and opened a note, and that was
  all: the SMART objective was the sheet you could not tick. It is
  monitored once a month, so a month is its square and it answers to the
  same press a day does on the other sheet.
*/
{
  const head = load({ session: { u: '20990002', r: 'USER' } });

  const r = head.tickObjMilestone('t', 'OBJ-002', '2026-11', 'Y');
  check('a section head can mark a milestone"s month',
    r.ok === true && r.state === 'done' && r.at > 0, JSON.stringify(r));
  check('and it lands on the row as a mark, not as a figure',
    head.__tabs.OBJ_LOG.rows[1][3] === 'Y' &&
    head.__tabs.OBJ_LOG.rows[1][4] === '',
    JSON.stringify(head.__tabs.OBJ_LOG.rows[1].slice(3, 5)));

  const off = head.tickObjMilestone('t', 'OBJ-002', '2026-11', '.');
  check('pressing it again clears it, and November is not yet a miss',
    off.state === 'pending' && head.__tabs.OBJ_LOG.rows[1][3] === '.',
    off.state);
  check('and the time goes with the mark',
    JSON.stringify(JSON.parse(head.__tabs.OBJ_LOG.rows[1][11])) === '{}',
    head.__tabs.OBJ_LOG.rows[1][11]);

  /*
    A MONTH THAT HAS BEEN AND GONE IS RED WHEN CLEARED and yellow when
    marked, because marking it now is catching up. Nobody presses a
    button that says "we did not do this".
  */
  const oct = head.tickObjMilestone('t', 'OBJ-002', '2026-10', 'Y');
  check('marking a month that has already closed is late, so yellow',
    oct.state === 'late', oct.state);
  check('and clearing it turns red on its own',
    head.tickObjMilestone('t', 'OBJ-002', '2026-10', '.').state === 'missed');

  /*
    THE FIGURE AND THE MARK ARE DIFFERENT CLAIMS. Un-ticking a month has
    to leave the figure where it is - and the square has to stay out.
  */
  head.recordObjMilestone('t', 'OBJ-002', '2026-10', { value: 2 });
  const cleared = head.tickObjMilestone('t', 'OBJ-002', '2026-10', '.');
  const row = head.__tabs.OBJ_LOG.rows.filter(function (x) {
    return String(x[0]) === '2026-10' && x[2] === 'OBJ-002';
  })[0];
  check('un-ticking a month leaves its figure alone',
    Number(row[4]) === 2, JSON.stringify(row[4]));
  check('and the square stays out rather than being relit by the figure',
    cleared.state === 'missed', cleared.state);

  let msg = '';
  const member = load({ session: { u: '20990001', r: 'USER' } });
  try { member.tickObjMilestone('t', 'OBJ-002', '2026-11', 'Y'); }
  catch (e) { msg = e.message; }
  check('a team member cannot mark the SMART objective',
    /section heads/.test(msg), msg);

  msg = '';
  try { head.tickObjMilestone('t', 'OBJ-001', '2026-11', 'Y'); }
  catch (e) { msg = e.message; }
  check('and a milestone the portal counts for itself has nothing to tick',
    /counted by the portal/.test(msg), msg);

  msg = '';
  try { head.tickObjMilestone('t', 'OBJ-002', '2027-09', 'Y'); }
  catch (e) { msg = e.message; }
  check('and a month outside the period is refused',
    /outside the objective period/.test(msg), msg);
}


// ===========================================================================
// 18i. one note per period
// ===========================================================================
/*
  A MONTH WAS THE WRONG UNIT FOR A NOTE.

  A daily objective has twenty-six squares in November and had one box
  underneath all of them, so the sentence explaining why the 3rd is red
  shared a paragraph with the sentence about the 19th, and whoever wrote
  the second had to decide what to do with the first. A note belongs to
  the period it explains - which is the same unit as the square.
*/
{
  const ctx = load({ session: { u: '20990001', r: 'USER' } });   // SD member
  // Slot 2 is the 3rd of November: working days run 1, 2, 3, 4, 5, 7, ...
  const r = ctx.saveObjSlotNote('t', 'TASK', 'OJT-007', '2026-11', 2,
    'POD report was not generated.');
  check('a note saves against one period, without marking anything',
    r.ok === true && r.slot === 2 && r.note.by === 'Bilal Hossain',
    JSON.stringify(r.note));

  const row = ctx.__tabs.OBJ_LOG.rows[1];
  check('it lands on the objective"s own row for that month',
    row[0] === '2026-11' && row[2] === 'OJT-007' && row[3] === '',
    'marks left alone: ' + JSON.stringify(row[3]));

  const stored = JSON.parse(row[12]);
  check('and in the Notes column, under the slot it was written against',
    stored['2'].t === 'POD report was not generated.' &&
    stored['2'].n === 1 && stored['2'].made === stored['2'].at,
    JSON.stringify(stored));
  check('the old month-note column is left alone, not written through',
    row[6] === '', JSON.stringify(row[6]));

  check('and the page reads it back on the slot it belongs to',
    ctx.getObjectives('t').tasks.list
      .filter((t) => t.id === 'OJT-007')[0].notes['2'].t ===
      'POD report was not generated.');

  /*
    TWO PERIODS, TWO NOTES. The second must not land on top of the first,
    which is the whole difference between this and what it replaced.
  */
  ctx.saveObjSlotNote('t', 'TASK', 'OJT-007', '2026-11', 8,
    'Out at the Chittagong site.');
  const both = JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][12]);
  check('a note on another period does not overwrite the first',
    both['2'].t === 'POD report was not generated.' &&
    /Chittagong/.test(both['8'].t), Object.keys(both).join(','));

  /*
    AN EDIT KEEPS THE DATE IT WAS FIRST WRITTEN. "Saved on the 3rd, edited
    on the 9th" and "saved on the 9th" are different accounts of a month,
    and only one of them is true.
  */
  ctx.__advance(26 * 3600 * 1000);          // the next day
  ctx.saveObjSlotNote('t', 'TASK', 'OJT-007', '2026-11', 2,
    'POD report was not generated. SD raised INC-4471.');
  const edited = JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][12])['2'];
  check('editing a note counts the edit and keeps when it was first made',
    edited.n === 2 && edited.made === stored['2'].made &&
    edited.at > edited.made && /INC-4471/.test(edited.t),
    JSON.stringify(edited));

  const hist = JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][10]);
  check('and what it said before the edit is kept on the row"s timeline',
    hist[0].noteSlot === 2 &&
    hist[0].noteWas === 'POD report was not generated.',
    JSON.stringify(hist[0] || {}));

  // CLEARING IT IS HOW IT IS DELETED. There is no other sensible way to
  // take back something you wrote than emptying the box it is in.
  ctx.saveObjSlotNote('t', 'TASK', 'OJT-007', '2026-11', 2, '   ');
  check('an empty note removes it rather than storing a blank one',
    JSON.parse(ctx.__tabs.OBJ_LOG.rows[1][12])['2'] === undefined,
    ctx.__tabs.OBJ_LOG.rows[1][12]);

  let msg = '';
  try { ctx.saveObjSlotNote('t', 'TASK', 'OJT-008', '2026-11', 0, 'x'); }
  catch (e) { msg = e.message; }
  check('a note on somebody else"s module is refused, like a mark',
    /belongs to the MM module/.test(msg), msg);

  msg = '';
  try {
    ctx.saveObjSlotNote('t', 'TASK', 'OJT-007', '2026-11', 2,
                        'x'.repeat(5000));
  } catch (e) { msg = e.message; }
  check('and one too long for a cell that holds twenty-six of them',
    /1000 characters at most/.test(msg), msg);

  msg = '';
  try { ctx.saveObjSlotNote('t', 'TASK', 'OJT-007', '2026-11', 99, 'x'); }
  catch (e) { msg = e.message; }
  check('and a period the month does not have',
    /no such period/.test(msg), msg);
}


// ===========================================================================
// 18j. notes on the SMART objective, which is the same idea
// ===========================================================================
{
  const member = load({ session: { u: '20990001', r: 'USER' } });
  let msg = '';
  try { member.saveObjSlotNote('t', 'PLAN', 'OBJ-002', '2026-11', 0, 'x'); }
  catch (e) { msg = e.message; }
  check('a team member cannot write against the SMART objective either',
    /section heads/.test(msg), msg);

  const head = load({ session: { u: '20990002', r: 'USER' } });
  const r = head.saveObjSlotNote('t', 'PLAN', 'OBJ-002', '2026-11', 0,
    'The second RCA is with FI.');
  check('a section head can, and it is kept the same way',
    r.ok === true && r.note.t === 'The second RCA is with FI.',
    JSON.stringify(r.note));

  const page = head.getObjectives('t');
  let m = null;
  page.plan.rows.forEach(function (row) {
    row.milestones.forEach(function (x) { if (x.id === 'OBJ-002') m = x; });
  });
  const nov = m.months.filter((x) => x.period === '2026-11')[0];
  check('and the month it belongs to carries it, so any month can be read',
    nov.note && /second RCA/.test(nov.note.t), JSON.stringify(nov));

  /*
    WRITING A NOTE IS NOT RECORDING THE MILESTONE, and the square has to
    keep saying so. "I have written down why I could not do this" and "I
    have done this" are different claims, and a page that turned the
    month green for the first would be letting a note stand in for the
    work.
  */
  const before = m.months.filter((x) => x.period === '2026-11')[0];
  check('but a note on its own does not mark the month as recorded',
    before.state === 'pending', before.state);

  /*
    AND THE COLOUR REACHES THE PAGE, not just the function that works it
    out: October ended with nothing, November is recorded, December has
    not come round.
  */
  head.recordObjMilestone('t', 'OBJ-002', '2026-11', { value: 2 });
  const after = head.getObjectives('t');
  let m2 = null;
  after.plan.rows.forEach(function (row) {
    row.milestones.forEach(function (x) { if (x.id === 'OBJ-002') m2 = x; });
  });
  const states = m2.months.map((x) => x.period + ':' + x.state).join(' ');
  check('every month comes down with the state its square is drawn from',
    states === '2026-10:missed 2026-11:done 2026-12:pending ' +
      '2027-01:pending 2027-02:pending 2027-03:pending', states);

  msg = '';
  try { head.saveObjSlotNote('t', 'PLAN', 'OBJ-002', '2026-11', 1, 'x'); }
  catch (e) { msg = e.message; }
  check('a milestone has one period a month and no second one',
    /no such period/.test(msg), msg);
}


// ===========================================================================
// 18k. the SMART objective keeps the same four colours
// ===========================================================================
{
  const ctx = load();
  const now = new Date(2026, 10, 11, 10, 0, 0);
  const manual = { id: 'OBJ-002', auto: '' };

  const onTime = { marks: 'Y', status: 'ON_TRACK', value: 2,
                   markedAt: { '0': new Date(2026, 10, 9, 9, 0).getTime() } };
  check('a month recorded while it was still running is green',
    ctx.objPlanMonthState(manual, onTime, '2026-11', now).state === 'done',
    ctx.objPlanMonthState(manual, onTime, '2026-11', now).state);

  const late = { marks: 'Y', status: 'ON_TRACK', value: 2,
                 markedAt: { '0': new Date(2026, 10, 2, 9, 0).getTime() } };
  check('October written up on the 2nd of November is yellow, not green',
    ctx.objPlanMonthState(manual, late, '2026-10', now).state === 'late',
    ctx.objPlanMonthState(manual, late, '2026-10', now).state);

  check('a month that ended with nothing recorded is red',
    ctx.objPlanMonthState(manual, null, '2026-10', now).state === 'missed');
  check('and the month in progress is blank, not already a miss',
    ctx.objPlanMonthState(manual, null, '2026-11', now).state === 'pending');
  check('as is one that has not come round',
    ctx.objPlanMonthState(manual, null, '2026-12', now).state === 'pending');

  /*
    THE MARK IS THE WHOLE ANSWER, and a figure left beside it is not.

    This used to read a row carrying a number as recorded, on the grounds
    that a number is evidence somebody was there. That cannot survive the
    square being pressable: un-ticking a month leaves the figure behind,
    and a square that reads the figure would light itself straight back
    up. A square that will not clear is worse than one that is generous.
  */
  check('a figure left behind by an un-tick does not keep the square lit',
    ctx.objPlanMonthState(manual, { value: 2, marks: '', markedAt: {} },
                          '2026-10', now).state === 'missed',
    ctx.objPlanMonthState(manual, { value: 2, marks: '', markedAt: {} },
                          '2026-10', now).state);
  check('and in the month in progress it is simply not marked yet',
    ctx.objPlanMonthState(manual, { value: 2, marks: '.', markedAt: {} },
                          '2026-11', now).state === 'pending');

  /*
    AND THE THREE THE PORTAL COUNTS ITSELF ARE NEVER LATE OR MISSED.
    Nobody records them by hand, so a red square would be the page
    complaining that an automatic thing was not done manually.
  */
  const auto = { id: 'OBJ-001', auto: 'UNIQUE_ROLES' };
  check('a counted milestone is not marked down for an empty log row',
    ctx.objPlanMonthState(auto, null, '2026-10', now, true).state === 'done' &&
    ctx.objPlanMonthState(auto, null, '2027-02', now, true).state ===
      'pending');
}

// ===========================================================================
// 19. a Date from another realm
// ===========================================================================
{
  // The fixtures build dates with Node's Date; the code runs in the vm's.
  // `instanceof Date` is false across that boundary, which would make every
  // timestamp read as missing - and nothing on the page would say so.
  const ctx = load();
  const foreign = new Date(2026, 10, 4, 9, 0, 0);
  check('a Date built outside the script is still a date',
    ctx.objDate(foreign) === foreign &&
    ctx.objPeriodOf(foreign) === '2026-11');
  check('and something that is not a date is not mistaken for one',
    ctx.objDate('2026-11-04') === null && ctx.objDate(null) === null &&
    ctx.objDate(new Date('nonsense')) === null);
}

// ===========================================================================
// 20. the whole page in one call
// ===========================================================================
{
  const ctx = load({ session: { u: '20990001', r: 'USER' } });
  ctx.tickObjTask('t', 'OJT-007', '2026-11', 0, 'Y');
  const page = ctx.getObjectives('t');

  check('the page defaults to the month we are actually in',
    page.period === '2026-11' && page.monthIndex === 1);
  check('it carries both sheets and the score in one call',
    page.plan.rows.length === 9 && page.tasks.list.length === 12 &&
    typeof page.score.score === 'number');
  check('every month of the period is offered',
    page.periods.length === 6 && page.periodLabel.indexOf('October 2026') === 0);

  const mine = page.tasks.list.filter((t) => t.mine);
  check('the page is told which objectives are this person"s to tick',
    mine.length === 4 && mine.every((t) => t.group === 'SD'),
    mine.length + ' mine');

  const kpi = page.tasks.list.filter((t) => t.kpi);
  check('the four KPIs are present but nobody"s to tick',
    kpi.length === 4 && kpi.every((t) => !t.mine));

  // The page draws its tick buttons from `mine`, so an admin - who passes
  // the module test for every group - must still see none on the KPIs.
  const asAdmin = load({ session: { u: '20990009', r: 'ADMIN' }, admin: true })
    .getObjectives('t');
  check('an admin sees tick buttons on the eight, not on the four KPIs',
    asAdmin.tasks.list.filter((t) => t.mine).length === 8 &&
    asAdmin.tasks.list.filter((t) => t.kpi).every((t) => !t.mine),
    asAdmin.tasks.list.filter((t) => t.mine).length + ' tickable');

  const op1 = page.plan.rows.filter((r) => r.rowId === 'OP')[0].milestones[0];
  check('the counted milestone says so, so the page can hide its control',
    op1.auto === 'UNIQUE_ROLES');
  check('each milestone carries all six months for the pips',
    op1.months.length === 6 && op1.months[0].period === '2026-10');

  check('the person"s own permissions come from the server, not the browser',
    page.me.planner === false && page.me.admin === false &&
    page.me.groups.join(',') === 'SD');

  const ticked = page.tasks.list.filter((t) => t.id === 'OJT-007')[0];
  check('a tick made a moment ago is in what the page reads back',
    ticked.done === 1 && ticked.marks.charAt(0) === 'Y' &&
    ticked.elapsed === 8 && ticked.onSchedule === false);

  const closed = ctx.getObjectives('t', '2026-10');
  check('an earlier month can be asked for, and knows it is closed',
    closed.period === '2026-10' && closed.closed === true);
  check('the month in progress is not closed', page.closed === false);
}

// ===========================================================================
console.log('');
const bad = out.filter((x) => !x).length;
// run.js scans for "N/N passed", so the tally has to be in that shape or
// the suite shows up in the summary as "(no result)" while quietly passing.
console.log((out.length - bad) + '/' + out.length + ' passed' +
            (bad ? ', ' + bad + ' failed' : ''));
process.exit(bad ? 1 : 0);
