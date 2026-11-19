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


// ===========================================================================
// THE SLOT STATE MACHINE
// ===========================================================================
// What colour each square is, worked out on the server so the page cannot
// disagree with the score. Ported from Objective.gs lines 134-1003.

const OBJ_PENDING = '.';   // [Objective.gs:134]
const OBJ_DONE    = 'Y';   // [Objective.gs:135]
const OBJ_MISSED  = 'N';   // [Objective.gs:136]


/** A Date, or null for anything that is not one.   [Objective.gs:247] */
function objDate(value) {
  if (!value) return null;
  if (typeof value.getTime !== 'function') return null;
  const ms = value.getTime();
  return (ms === ms) ? value : null;   // NaN fails its own equality
}


/** 'YYYY-MM' for a date.   [Objective.gs:256] */
function objPeriodOf(date) {
  const d = objDate(date);
  if (!d) return '';
  const m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m));
}


/**
 * The marks string, cleaned to exactly one character per slot.
 *                                                    [Objective.gs:537]
 * Anything that is not Y, N or . is stripped, the string is cut to length
 * if it is too long, and padded with pending if it is too short. A cell
 * somebody has typed in by hand cannot therefore change how many squares
 * a month has.
 */
function objMarksRead(cell, slots) {
  let s = String(cell === null || cell === undefined ? '' : cell)
    .replace(/[^YN.]/g, '');
  if (s.length > slots) s = s.slice(0, slots);
  while (s.length < slots) s += OBJ_PENDING;
  return s;
}


/** The same string with one slot changed.   [Objective.gs:547] */
function objMarksSet(marks, index, mark) {
  const s = String(marks || '');
  const i = Number(index);
  if (!(i >= 0) || i >= s.length) return s;
  const ch = (mark === OBJ_DONE || mark === OBJ_MISSED) ? mark : OBJ_PENDING;
  return s.slice(0, i) + ch + s.slice(i + 1);
}


/** A fresh string of pending slots.   [Objective.gs:521] */
function objMarksBlank(slots) {
  let s = '';
  for (let i = 0; i < Math.max(0, slots); i++) s += OBJ_PENDING;
  return s;
}


/** How many slots carry a mark, optionally only in the first `upto`.
 *                                                    [Objective.gs:680] */
function objMarksCount(marks, mark, upto) {
  const s = String(marks || '');
  const n = (upto === undefined || upto === null) ? s.length
          : Math.min(Number(upto) || 0, s.length);
  let count = 0;
  for (let i = 0; i < n; i++) if (s.charAt(i) === mark) count++;
  return count;
}


/**
 * The last moment a slot could be marked and still count as on time.
 *                                                    [Objective.gs:564]
 * A daily slot closes at the end of its own date, a weekly one at the end
 * of its seven-day block, a monthly or quarterly one at the end of the
 * month. Marking after that is not a miss - the work was done - but it is
 * not on time either, and the page shows the difference.
 */
function objSlotEnd(period, frequency, slot) {
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(5, 7));
  const days = objDaysInMonth(period);
  const freq = String(frequency || '').trim().toUpperCase();
  const i = Number(slot) || 0;

  let last = days;
  if (freq === 'DAILY') {
    const work = objWorkingDays(period);
    last = work[i] || days;
  } else if (freq === 'WEEKLY') {
    last = Math.min((i + 1) * 7, days);
  }
  return new Date(y, m - 1, last, 23, 59, 59, 999).getTime();
}


/**
 * How many of this month's slots have closed.   [Objective.gs:457]
 *
 * TODAY IS NOT ELAPSED. An earlier version counted today, so a daily
 * objective was "missed" for a day that had not finished.
 */
function objSlotsElapsed(period, frequency, now) {
  const slots = objSlotCount(period, frequency);
  if (!slots) return 0;

  const today = objDate(now) || new Date();
  const nowPeriod = objPeriodOf(today);
  if (period < nowPeriod) return slots;        // the month is closed
  if (period > nowPeriod) return 0;            // it has not started

  const ms = today.getTime();
  let n = 0;
  for (let i = 0; i < slots; i++) {
    if (objSlotEnd(period, frequency, i) < ms) n++;
  }
  return n;
}


/**
 * How many of this month's slots can be marked right now.
 *                                                    [Objective.gs:490]
 * NOT THE SAME QUESTION AS objSlotsElapsed, and conflating the two made a
 * monthly objective impossible to record in its own month. Elapsed means
 * "this period has closed, so an unmarked slot is a miss". Open means
 * "this period has begun, so you may record it" - and a monthly slot is
 * open from the 1st and does not close until the 30th.
 */
function objSlotsOpen(period, frequency, now) {
  const slots = objSlotCount(period, frequency);
  if (!slots) return 0;

  const today = objDate(now) || new Date();
  const nowPeriod = objPeriodOf(today);
  if (period < nowPeriod) return slots;   // the month is over; all of it
  if (period > nowPeriod) return 0;       // it has not started

  const freq = String(frequency || '').trim().toUpperCase();
  const day = today.getDate();

  if (freq === 'DAILY') {
    const work = objWorkingDays(period);
    let n = 0;
    for (let i = 0; i < work.length; i++) if (work[i] <= day) n++;
    return n;
  }
  if (freq === 'WEEKLY') {
    return Math.min(slots, Math.floor((day - 1) / 7) + 1);
  }
  return slots;                           // the month has begun, so it is open
}


/**
 * One objective's month: every square, its colour, and the counts.
 *                                                    [Objective.gs:932]
 *
 *   done      marked while its own period was still open
 *   late      marked after that period had closed. The work WAS done; it
 *             was recorded afterwards, and the square says so rather than
 *             pretending either that it was on time or that it never
 *             happened
 *   missed    the period came and went with no mark. Nobody records this -
 *             it is what the absence IS
 *   pending   the period has not closed yet
 *
 * MARKING LATE STILL COUNTS AS DONE FOR THE SCORE. It was done. A scoring
 * rule that threw the work away because the note was late would teach
 * people not to catch up.
 */
function objTaskState(task, marks, period, now, markedAt) {
  const slots = objSlotCount(period, task.frequency);
  const elapsed = objSlotsElapsed(period, task.frequency, now);
  const open = objSlotsOpen(period, task.frequency, now);
  const s = objMarksRead(marks, slots);
  const done = objMarksCount(s, OBJ_DONE, elapsed);
  const missed = objMarksCount(s, OBJ_MISSED, elapsed);

  const when = markedAt || {};
  const marksState = [];
  let late = 0;
  for (let i = 0; i < slots; i++) {
    const ch = s.charAt(i);
    const at = when[String(i)] || 0;
    if (ch === OBJ_DONE) {
      const isLate = at > 0 && at > objSlotEnd(period, task.frequency, i);
      if (isLate) late++;
      marksState.push({ slot: i, state: isLate ? 'late' : 'done', at: at });
    } else if (i < elapsed) {
      marksState.push({ slot: i, state: 'missed', at: 0 });
    } else {
      marksState.push({ slot: i, state: 'pending', at: 0 });
    }
  }

  return {
    slots: slots,
    elapsed: elapsed,
    done: done,
    missed: missed,
    // Slots that came and went without anybody saying either way.
    silent: Math.max(0, elapsed - done - missed),
    /*
      EVERY slot marked done, elapsed or not, which is a different question
      from `done` and is the one the card prints. A monthly objective has
      one slot and it is not elapsed until the month is over, so `done` was
      zero all month even after somebody ticked it, and the card read
      "0 of 0 done" over a green button saying Done.
    */
    marked: objMarksCount(s, OBJ_DONE),
    open: open,
    late: late,
    cells: marksState,
    marks: s,
    onSchedule: elapsed === 0 ? true : done === elapsed,
    // Waiting on somebody: the slot that can be pressed right now is blank.
    due: open > 0 && s.charAt(Math.max(0, open - 1)) === OBJ_PENDING
  };
}


module.exports = {
  objCountState, objTallyTotal, objTallyShare, objNewTally,
  objSlotCount, objDaysInMonth, objWorkingDays, objIsQuarterEnd,
  WORK_DAYS,
  OBJ_PENDING, OBJ_DONE, OBJ_MISSED,
  objDate, objPeriodOf, objMarksRead, objMarksSet, objMarksBlank,
  objMarksCount, objSlotEnd, objSlotsElapsed, objSlotsOpen, objTaskState
};
