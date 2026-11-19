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


// ===========================================================================
// THE PERIOD, THE LOG KEY, AND THE SCORE
// ===========================================================================

const OBJ_KIND_PLAN = 'PLAN';   // [Objective.gs:139]
const OBJ_KIND_TASK = 'TASK';   // [Objective.gs:140]

/*
  The objective period, from Config.gs OBJECTIVE.PERIOD_START / PERIOD_END.
  Overridable by environment variable for the same reason WORK_DAYS is: the
  period moves every half year and must move in one place.
*/
const PERIOD_START = String(process.env.OBJ_PERIOD_START || '2026-10');
const PERIOD_END   = String(process.env.OBJ_PERIOD_END   || '2027-03');


/** A fresh tally.   [Objective.gs:1230] */
function objTally() {
  return { onTime: 0, late: 0, notDone: 0 };
}


/** A period out of a cell, which may already be a Date.
 *                                                   [Objective.gs:281] */
function objPeriodCell(value) {
  const d = objDate(value);
  if (d) return objPeriodOf(d);
  return String(value === null || value === undefined ? '' : value).trim();
}


/**
 * Every month of the objective period, in order.   [Objective.gs:294]
 *
 * BOUNDED AT 120 RATHER THAN while(true): a mistyped end date earlier than
 * the start would otherwise spin until the script times out, and a page
 * that hangs is harder to diagnose than one that comes back short.
 */
function objPeriods() {
  const out = [];
  let y = Number(PERIOD_START.slice(0, 4));
  let m = Number(PERIOD_START.slice(5, 7));
  const ey = Number(PERIOD_END.slice(0, 4));
  const em = Number(PERIOD_END.slice(5, 7));
  if (!y || !m || !ey || !em) return out;

  for (let guard = 0; guard < 120; guard++) {
    out.push(y + '-' + (m < 10 ? '0' + m : String(m)));
    if (y === ey && m === em) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}


/** Where a month sits in the period, or -1.   [Objective.gs:319] */
function objPeriodIndex(period) {
  return objPeriods().indexOf(String(period || ''));
}


/** One log row's key.   [Objective.gs:866] */
function objLogKey(period, kind, ref) {
  return objPeriodCell(period) + '|' +
         String(kind === null || kind === undefined ? '' : kind)
           .trim().toUpperCase() + '|' +
         String(ref === null || ref === undefined ? '' : ref).trim();
}


/**
 * How far one milestone got in one month, as a fraction of its target.
 *                                                   [Objective.gs:1466]
 *
 * A MONTH WITH NOTHING RECORDED SCORES ZERO. That is the honest reading
 * and it is worth saying out loud, because the comfortable alternative -
 * leaving it out of the average - makes a department that recorded nothing
 * at all score 100, which is exactly backwards.
 *
 * PERIOD targets are cumulative. "Complete at least 6 development
 * initiatives during the period" is not six a month; it is six by March,
 * so its score in any month is everything recorded up to and including
 * that month, over six.
 */
function objMilestoneScore(milestone, log, period, context) {
  const auto = milestone.auto;
  const key = objLogKey(period, OBJ_KIND_PLAN, milestone.id);
  const entry = log.byKey[key] || null;

  // ---- the ones that are counted, not typed ----
  if (auto) {
    const counted = context && context.auto && context.auto[auto];
    if (counted) {
      const target = Number(milestone.target) || 1;
      const value = (auto === 'UNIQUE_ROLES')
        ? counted.fraction * target          // already a fraction of its own
        : counted.value;
      return {
        fraction: Math.max(0, Math.min(1, value / target)),
        value: value, target: target, auto: auto, entry: entry
      };
    }
    /*
      The source could not be read. Fall through and use whatever was
      typed rather than scoring a real milestone zero because another tab
      is mid-edit.
    */
  }

  const target = Number(milestone.target);
  const type = milestone.countType;

  if (type === 'PERCENT') {
    const v = entry && entry.value !== null ? entry.value : 0;
    return { fraction: Math.max(0, Math.min(1, v / (target || 100))),
             value: v, target: target || 100, auto: '', entry: entry };
  }

  if (type === 'DONE') {
    /*
      THE SQUARE IS THE ANSWER for a yes-or-no milestone. It used to be a
      status picked from three buttons beside a row of month squares that
      meant the same thing and disagreed with it freely.
    */
    const done = Boolean(entry) &&
                 objMarksRead(entry.marks, 1).charAt(0) === OBJ_DONE;
    return { fraction: done ? 1 : 0, value: done ? 1 : 0, target: 1,
             auto: '', entry: entry };
  }

  // NUMBER
  let value = entry && entry.value !== null ? entry.value : 0;
  if (milestone.per === 'PERIOD') {
    value = 0;
    const periods = objPeriods();
    const upto = objPeriodIndex(period);
    for (let i = 0; i <= upto && i < periods.length; i++) {
      const e = log.byKey[objLogKey(periods[i], OBJ_KIND_PLAN, milestone.id)];
      if (e && e.value !== null) value += e.value;
    }
  }
  const t = target || 1;
  return { fraction: Math.max(0, Math.min(1, value / t)),
           value: value, target: t, auto: '', entry: entry };
}


/**
 * What colour one milestone's month square is.   [Objective.gs:1062]
 *
 * A COUNTED MONTH IS COLOURED BY WHAT WAS COUNTED. It used to go green for
 * any month the portal could count at all - which is every month that has
 * begun - so a milestone reading "0 of 85 due so far" drew a green October
 * underneath it. That is the page saying the month was fine on a month
 * where nothing was recorded, and it is worse than no colour.
 *
 * For the rest, THE MARK IS THE WHOLE ANSWER and nothing else is
 * consulted. An earlier version also read a month as recorded when the row
 * carried a figure; un-ticking a month you had ticked left the figure
 * behind, so the square refused to go out.
 */
function objPlanMonthState(milestone, entry, period, now, counted, fraction) {
  if (milestone.auto) {
    const current = objPeriodOf(objDate(now) || new Date());
    if (period > current) return { state: 'pending', at: 0, auto: true };
    if (!counted) return { state: 'pending', at: 0, auto: true };
    const got = Number(fraction) || 0;
    return {
      state: got >= 1 ? 'done' : (got > 0 ? 'part' : 'missed'),
      at: 0, auto: true
    };
  }

  const state = objTaskState({ frequency: 'Monthly' },
                             entry ? entry.marks : '', period, now,
                             entry ? entry.markedAt : null);
  const cell = state.cells[0] || { state: 'pending', at: 0 };
  return { state: cell.state, at: cell.at, auto: false };
}


/** Every square of the ninety - or the eighty-six - in one month.
 *                                                  [Objective.gs:1298] */
function objTaskSquares(tasks, log, period, now, tally) {
  tasks.forEach(function (t) {
    if (!objSlotCount(period, t.frequency)) return;   // nothing due this month
    const entry = log.byKey[objLogKey(period, OBJ_KIND_TASK, t.id)];
    const state = objTaskState(t, entry ? entry.marks : '', period, now,
                               entry ? entry.markedAt : null);
    state.cells.forEach(function (cell) {
      objCountState(tally, cell.state);
    });
  });
  return tally;
}


/** Every milestone's square for one month: one each, so 29 of them.
 *                                                  [Objective.gs:1313] */
function objPlanSquares(plan, log, period, now, autoAll, tally) {
  const auto = autoAll[period] || {};
  plan.rows.forEach(function (row) {
    row.milestones.forEach(function (m) {
      const entry = log.byKey[objLogKey(period, OBJ_KIND_PLAN, m.id)];
      const scored = m.auto
        ? objMilestoneScore(m, log, period, { auto: auto })
        : null;
      const st = objPlanMonthState(m, entry, period, now,
                                   Boolean(auto[m.auto]),
                                   scored ? scored.fraction : 0);
      objCountState(tally, st.state);
    });
  });
  return tally;
}


/**
 * The two figures both sheets show: this month, and the whole period.
 *                                                  [Objective.gs:1344]
 *
 * This is what feeds the two summary cards - "Progress this month" and
 * "Overall progress".
 *
 * `base` is what the card says it is counting: the twenty-nine milestones,
 * and the eighty-six EAS objectives. THE FOUR KPIs ARE LEFT OUT of the
 * ninety on purpose - nobody ticks them, the engine measures them from
 * ITSM, and squares nobody can press do not belong in a figure about
 * pressing squares.
 *
 * `overall` STOPS AT THE MONTH IT ACTUALLY IS. Counting the months still
 * ahead would put the whole period's worth of untouched squares into the
 * "not done" slice in October and make the pie meaningless until March.
 */
function objProgressAll(plan, tasks, log, periods, want, now, autoAll) {
  const eas = tasks.filter(function (t) { return !t.kpi; });
  const current = objPeriodOf(objDate(now) || new Date());
  const done = periods.filter(function (p) { return p <= current; });

  const planMonth = objPlanSquares(plan, log, want, now, autoAll, objTally());
  const taskMonth = objTaskSquares(eas, log, want, now, objTally());
  const planAll = objTally();
  const taskAll = objTally();

  done.forEach(function (p) {
    objPlanSquares(plan, log, p, now, autoAll, planAll);
    objTaskSquares(eas, log, p, now, taskAll);
  });

  return {
    months: done.length,
    plan: {
      base: plan.rows.reduce(function (n, r) {
        return n + r.milestones.length;
      }, 0),
      month: objTallyShare(planMonth),
      overall: objTallyShare(planAll)
    },
    tasks: {
      base: eas.length,
      month: objTallyShare(taskMonth),
      overall: objTallyShare(taskAll)
    }
  };
}


/**
 * How the ninety are doing in one month.   [Objective.gs:1130]
 *
 * ONLY WHAT HAS ACTUALLY COME ROUND COUNTS. The first version scored every
 * objective whose slot had not arrived yet as "on schedule" - true, in the
 * sense that nothing not yet due can be late, and badly misleading as a
 * number. Thirty of the ninety are monthly, and a monthly slot is not
 * elapsed until the month ends, so on the 10th of November the page
 * reported "30 of 85 on schedule" on a month where nobody had recorded
 * anything. A figure that starts at 35% and can only go down measures
 * nothing.
 *
 * So the denominator is what is DUE, and the ones not yet due are reported
 * separately rather than counted as wins.
 */
function objUniqueRolesScore(tasks, log, period, now) {
  let on = 0, due = 0, waiting = 0, total = 0, kpiOn = 0, kpiDue = 0;

  tasks.forEach(function (t) {
    const slots = objSlotCount(period, t.frequency);
    if (!slots) return;                 // a quarterly item in a quiet month
    total++;

    const entry = log.byKey[objLogKey(period, OBJ_KIND_TASK, t.id)];
    const state = objTaskState(t, entry ? entry.marks : '', period, now,
                               entry ? entry.markedAt : null);

    if (!state.elapsed) { waiting++; return; }

    due++;
    if (t.kpi) kpiDue++;
    if (state.onSchedule) {
      on++;
      if (t.kpi) kpiOn++;
    }
  });

  return {
    // Nothing due yet is not a failure, and not a success either. It scores
    // as met so that the first of the month does not open at zero.
    fraction: due ? on / due : 1,
    on: on, due: due, waiting: waiting, total: total,
    kpiOn: kpiOn, kpiDue: kpiDue,
    processOn: on - kpiOn, processDue: due - kpiDue
  };
}


/**
 * The counted sources, per month.   [Objective.gs:1517]
 *
 * ONLY UNIQUE_ROLES IS COMPUTED HERE SO FAR, and that is a gap, not a
 * design. Objective.gs also counts KNOWLEDGE and LEARN, from two tabs that
 * have not been ported yet.
 *
 * What happens to those milestones meanwhile is already decided by
 * objPlanMonthState: a milestone whose source cannot be read shows
 * 'pending', not 'missed'. That is the existing behaviour for an
 * unreadable source, deliberately - a real milestone is not scored zero
 * because another tab is mid-edit. Three of the twenty-nine are affected
 * (the UNIQUE_ROLES one is fine; KNOWLEDGE and LEARN are not).
 *
 * The try/catch is kept: if the ninety are unreadable, the milestone can
 * still be typed.
 */
function objAutoAll(tasks, log, periods, now) {
  const byPeriod = {};
  periods.forEach(function (p) { byPeriod[p] = {}; });

  periods.forEach(function (p) {
    try {
      byPeriod[p].UNIQUE_ROLES = objUniqueRolesScore(tasks, log, p, now);
    } catch (e) { /* the ninety are unreadable; the milestone can be typed */ }
  });

  return byPeriod;
}


module.exports = {
  objCountState, objTallyTotal, objTallyShare, objNewTally,
  objSlotCount, objDaysInMonth, objWorkingDays, objIsQuarterEnd,
  WORK_DAYS,
  OBJ_PENDING, OBJ_DONE, OBJ_MISSED,
  objDate, objPeriodOf, objMarksRead, objMarksSet, objMarksBlank,
  objMarksCount, objSlotEnd, objSlotsElapsed, objSlotsOpen, objTaskState,
  OBJ_KIND_PLAN, OBJ_KIND_TASK, PERIOD_START, PERIOD_END,
  objTally, objPeriodCell, objPeriods, objPeriodIndex, objLogKey,
  objMilestoneScore, objPlanMonthState, objTaskSquares, objPlanSquares,
  objProgressAll, objUniqueRolesScore, objAutoAll
};
