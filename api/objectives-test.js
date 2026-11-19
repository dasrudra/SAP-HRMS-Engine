/**
 * objectives-test.js - the arithmetic, checked against the case that broke.
 * ===========================================================================
 *
 *     cd api
 *     node objectives-test.js
 *
 * No database and no server. The arithmetic is pure, so it is tested pure.
 *
 * THE FIRST TEST IS THE ONE THAT MATTERS. It is November 2026 exactly as it
 * appeared on screen when Rudra said: "You said 60% progress for Nov. But
 * only 3 marked and 1 yellow. How can it become 60%?"
 *
 * He was right, and that question is now a test. If anybody ever makes
 * pending squares stop counting again, this file says so before the page
 * does.
 */

const {
  objCountState, objTallyTotal, objTallyShare, objNewTally,
  objSlotCount, objDaysInMonth, objWorkingDays, objIsQuarterEnd, WORK_DAYS
} = require('./objectives');

let pass = 0, fail = 0;

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ok   ' + name); }
  else {
    fail++;
    console.log('  FAIL ' + name);
    console.log('         got  ' + JSON.stringify(got));
    console.log('         want ' + JSON.stringify(want));
  }
}


console.log('');
console.log('THE NOVEMBER CASE - 3 of 29, which must not read 60%');
console.log('-----------------------------------------------------------');
{
  /*
    29 SMART milestones. Three were ticked on time, one late, and the other
    twenty-five are still pending - nobody has touched them, because the
    month is not over.

    The old code left those twenty-five out of the denominator entirely, so
    it divided 3 by (3+1+1) and printed 60%. Every pending square counts.
  */
  const tally = objNewTally();
  for (let i = 0; i < 3;  i++) objCountState(tally, 'done');
  for (let i = 0; i < 1;  i++) objCountState(tally, 'late');
  for (let i = 0; i < 25; i++) objCountState(tally, 'pending');

  check('the denominator is every square the month holds',
        objTallyTotal(tally), 29);

  const share = objTallyShare(tally);

  check('"ticked" is 4 of 29, not 4 of 4',
        { ticked: share.ticked, total: share.total }, { ticked: 4, total: 29 });

  check('the big number reads 14%, not 60%',
        share.done, 14);

  check('the footer counts match the squares',
        { onTimeN: share.onTimeN, lateN: share.lateN }, { onTimeN: 3, lateN: 1 });

  // The exact figure from the original report: three ticked, nothing late.
  const three = objNewTally();
  for (let i = 0; i < 3;  i++) objCountState(three, 'done');
  for (let i = 0; i < 26; i++) objCountState(three, 'pending');
  check('3 of 29 with nothing late reads 10%, not 60%',
        objTallyShare(three).done, 10);
}


console.log('');
console.log('EVERYTHING THAT IS NOT A TICK IS NOT DONE');
console.log('-----------------------------------------------------------');
{
  // missed, part and pending must all land in notDone - the same bucket.
  ['missed', 'part', 'pending', 'open', '', null, undefined, 'anything']
    .forEach(function (state) {
      const t = objNewTally();
      objCountState(t, state);
      check('"' + state + '" counts as not done',
            { onTime: t.onTime, late: t.late, notDone: t.notDone },
            { onTime: 0, late: 0, notDone: 1 });
    });

  const d = objNewTally(); objCountState(d, 'done');
  check('"done" is on time', [d.onTime, d.late, d.notDone], [1, 0, 0]);

  const l = objNewTally(); objCountState(l, 'late');
  check('"late" is late',    [l.onTime, l.late, l.notDone], [0, 1, 0]);
}


console.log('');
console.log('PERCENTAGES ADD TO EXACTLY 100, WITH NO GAP IN THE PIE');
console.log('-----------------------------------------------------------');
{
  // The awkward case: thirds. Rounding each separately gives 33+33+33 = 99
  // and a pie with a wedge missing.
  const t = objNewTally();
  objCountState(t, 'done'); objCountState(t, 'late'); objCountState(t, 'pending');
  const s = objTallyShare(t);
  check('thirds still add to 100', s.onTime + s.late + s.notDone, 100);

  // A spread of sizes, none of which may drift off 100.
  [[1,1,1],[2,3,5],[7,0,0],[0,0,9],[1,0,2],[13,1,15],[3,1,25]].forEach(function (c) {
    const tt = objNewTally();
    for (let i=0;i<c[0];i++) objCountState(tt,'done');
    for (let i=0;i<c[1];i++) objCountState(tt,'late');
    for (let i=0;i<c[2];i++) objCountState(tt,'pending');
    const ss = objTallyShare(tt);
    check('[' + c.join(',') + '] adds to 100',
          ss.onTime + ss.late + ss.notDone, 100);
  });
}


console.log('');
console.log('NOTHING RECORDED IS NOT A DIVISION BY ZERO');
console.log('-----------------------------------------------------------');
{
  const s = objTallyShare(objNewTally());
  // Six keys, not eight - onTimeN and lateN are absent in the empty case,
  // exactly as in Objective.gs. The page guards on total before reading
  // them. See the note in objectives.js.
  check('an empty month is all zeros, not NaN',
        s, { onTime:0, late:0, notDone:0, done:0, ticked:0, total:0 });
}


console.log('');
console.log('HOW MANY SQUARES A MONTH HOLDS');
console.log('-----------------------------------------------------------');
{
  check('November 2026 has 30 days', objDaysInMonth('2026-11'), 30);
  check('February 2026 has 28',      objDaysInMonth('2026-02'), 28);
  check('February 2028 has 29 (leap year)', objDaysInMonth('2028-02'), 29);

  check('monthly is one square',   objSlotCount('2026-11', 'Monthly'), 1);
  check('a blank frequency is monthly', objSlotCount('2026-11', ''), 1);
  check('a typo is monthly, not zero',  objSlotCount('2026-11', 'Munthly'), 1);
  check('weekly in a 30-day month is 5', objSlotCount('2026-11', 'Weekly'), 5);
  check('quarterly counts only at a quarter end',
        [objSlotCount('2026-11','Quarterly'), objSlotCount('2026-12','Quarterly')],
        [0, 1]);
  check('case does not matter', objSlotCount('2026-11', 'dAiLy'),
                                objSlotCount('2026-11', 'DAILY'));

  /*
    THE WORKING WEEK IS SIX DAYS. Config.gs says
    WORK_DAYS: [0,1,2,3,4,6] - Sun to Thu AND Saturday. Only Friday is off.

    The first draft of the port assumed a five-day Sun-Thu week and came
    out 4 squares short for November. These numbers are taken from running
    the ORIGINAL Objective.gs code, not from what a week ought to be.
  */
  check('the working week is the configured six days',
        WORK_DAYS, [0, 1, 2, 3, 4, 6]);
  check('Nov 2026 has 26 working days, not 22',
        objWorkingDays('2026-11').length, 26);
  check('only Friday is excluded',
        objWorkingDays('2026-11').filter(function (d) {
          return new Date(2026, 10, d).getDay() === 5;
        }).length, 0);
  check('Saturdays ARE working days',
        objWorkingDays('2026-11').filter(function (d) {
          return new Date(2026, 10, d).getDay() === 6;
        }).length > 0, true);

  // Every month of the objective period, against the original's answers.
  check('working days across the whole period',
        ['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03']
          .map(function (p) { return objWorkingDays(p).length; }),
        [26, 26, 27, 26, 24, 27]);

  check('quarter ends are Mar Jun Sep Dec',
        ['2026-03','2026-06','2026-09','2026-12','2026-01','2026-07']
          .map(objIsQuarterEnd),
        [true, true, true, true, false, false]);
}


console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
