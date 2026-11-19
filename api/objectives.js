/**
 * objectives.js - the progress arithmetic, ported from src/Objective.gs.
 * ===========================================================================
 *
 * THIS IS A PORT, NOT A REWRITE. Every function below has a counterpart in
 * Objective.gs with the same name, and the line numbers are given so the two
 * can be read side by side. Where this file differs from that one, it is a
 * bug - not an improvement.
 *
 * WHY THE ARITHMETIC IS ITS OWN FILE
 *
 * Because it is the part that was already got wrong once, in public, and
 * caught by the person who uses it. Rudra looked at a page claiming 60% for
 * November with three green squares and one amber on screen, and asked how
 * three out of twenty-nine could be sixty per cent. It could not. The
 * denominator was collapsing to touched milestones only.
 *
 * Keeping it separate from the endpoints means it can be tested on its own,
 * against that exact case, without a database or a server. See
 * objectives-test.js - the November case is the first test in it.
 */


/**
 * Add one square's state into a tally.   [Objective.gs:1290]
 *
 * EVERYTHING THAT IS NOT A TICK IS NOT DONE: missed, part, and pending
 * alike. A pending square is work this month holds that nobody has done
 * YET, which is exactly what the empty part of a progress bar is.
 *
 * THIS LINE IS THE 60% BUG. The earlier version left pending squares out of
 * the tally altogether, so a month where one milestone of twenty-nine had
 * been touched divided by one, not by twenty-nine.
 */
function objCountState(tally, state) {
  if (state === 'done') tally.onTime++;
  else if (state === 'late') tally.late++;
  else tally.notDone++;
}


/** [Objective.gs:1236] */
function objTallyTotal(t) {
  return t.onTime + t.late + t.notDone;
}


/**
 * A tally as whole percents that add to exactly 100.   [Objective.gs:1249]
 *
 * Rounding each share on its own gives 33/33/33 and a pie with a gap in it.
 * So two are rounded and the third takes what is left, which is why onTime
 * is computed by subtraction rather than by its own Math.round.
 */
function objTallyShare(t) {
  const total = objTallyTotal(t);
  if (!total) {
    /*
      SIX KEYS HERE, NOT EIGHT, and that is copied rather than tidied.

      The original omits onTimeN and lateN from the empty case, so they
      read undefined. Adding zeros looks like an improvement and is a
      behaviour change, so it is not made here: this file is a port.

      It is safe because the page guards on total before reading them -
      App.html:9647 renders "nothing to record this month" instead of the
      footer. Any new caller must guard the same way.
    */
    return { onTime: 0, late: 0, notDone: 0, done: 0, ticked: 0, total: 0 };
  }

  const late = Math.round((t.late / total) * 100);
  const notDone = Math.round((t.notDone / total) * 100);
  const onTime = Math.max(0, 100 - late - notDone);

  return {
    onTime: onTime,
    late: late,
    notDone: notDone,
    // What the big number on the card is: clicked at all, on time or not.
    done: Math.min(100, onTime + late),
    /*
      AND THE FRACTION IT CAME FROM, printed beside it.

      "60%" with nothing to divide is a number a reader can only take on
      trust, and the first person to count the green squares on the page
      and get a different answer is right to stop trusting it. "3 of 29"
      can be checked against the column in a second.

      That is not a decoration. It is the thing that made the bug visible.
    */
    ticked: t.onTime + t.late,
    total: total,
    // The same split as the percentages, as plain counts, because the
    // footer says "3 on time, 0 delayed" and a reader checking it against
    // the column is counting squares, not working out shares.
    onTimeN: t.onTime,
    lateN: t.late
  };
}


/** An empty tally, so callers do not each invent their own shape. */
function objNewTally() {
  return { onTime: 0, late: 0, notDone: 0 };
}


// ---------------------------------------------------------------------------
// How many squares a month holds
// ---------------------------------------------------------------------------

/** Days in the month of '2026-11'.   [Objective.gs, objDaysInMonth] */
function objDaysInMonth(period) {
  const key = String(period);
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  if (!y || !m) return 0;
  return new Date(y, m, 0).getDate();      // day 0 of the next month
}


/*
  THE WORKING WEEK IS A SETTING, NOT A FACT, and getting that wrong was a
  real bug in the first draft of this file.

  Config.gs has:

      WORK_DAYS: [0, 1, 2, 3, 4, 6]

  Sunday, Monday, Tuesday, Wednesday, Thursday AND SATURDAY. A six-day
  week - only Friday is off. The first version of this port assumed the
  five-day Sun-Thu week and hard-coded "skip Friday and Saturday", which
  came out 4 to 5 squares short per DAILY objective every single month:

      2026-10  configured 26, assumed 21
      2026-11  configured 26, assumed 22
      2026-12  configured 27, assumed 23

  Every daily objective would have been scored against the wrong
  denominator - the same class of fault as the 60% bug, arrived at from the
  other direction.

  So it is read from configuration here too, with the SAME default, and the
  default is the configured value rather than a guess at what a week is.
  Changing it in one place must change it everywhere.
*/
const WORK_DAYS = (function () {
  const said = String(process.env.OBJ_WORK_DAYS || '').trim();
  if (!said) return [0, 1, 2, 3, 4, 6];        // Config.gs OBJECTIVE.WORK_DAYS
  const parsed = said.split(',')
    .map(function (s) { return Number(s.trim()); })
    .filter(function (n) { return Number.isInteger(n) && n >= 0 && n <= 6; });
  return parsed.length ? parsed : [0, 1, 2, 3, 4, 6];
})();


/**
 * Working days in the month.   [Objective.gs:359]
 *
 * Built with local-time Dates exactly as the original does. A date made at
 * local midnight and read with getDay() gives the weekday of that calendar
 * date, which is the question being asked.
 */
function objWorkingDays(period) {
  const key = String(period);
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const out = [];
  if (!y || !m) return out;

  const last = objDaysInMonth(key);
  for (let d = 1; d <= last; d++) {
    if (WORK_DAYS.indexOf(new Date(y, m - 1, d).getDay()) !== -1) out.push(d);
  }
  return out;
}


/** Is this month the end of a quarter? */
function objIsQuarterEnd(period) {
  const m = Number(String(period).slice(5, 7));
  return m === 3 || m === 6 || m === 9 || m === 12;
}


/**
 * How many squares this month holds for an objective.   [Objective.gs:425]
 *
 * ANYTHING UNRECOGNISED IS MONTHLY, deliberately - a typo in the Frequency
 * cell must not make an objective vanish from the count. That is the same
 * fallback as String(r[9] || 'Monthly') on the read side.
 */
function objSlotCount(period, frequency) {
  const freq = String(frequency || '').trim().toUpperCase();
  if (freq === 'DAILY')     return objWorkingDays(period).length;
  if (freq === 'WEEKLY')    return Math.ceil(objDaysInMonth(period) / 7);
  if (freq === 'QUARTERLY') return objIsQuarterEnd(period) ? 1 : 0;
  return 1;   // MONTHLY, and anything unknown
}


module.exports = {
  objCountState, objTallyTotal, objTallyShare, objNewTally,
  objSlotCount, objDaysInMonth, objWorkingDays, objIsQuarterEnd,
  WORK_DAYS
};
