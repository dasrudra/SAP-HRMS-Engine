/**
 * Objective.gs - the department's six-month objectives, and their tracking.
 * =========================================================================
 *
 * WHAT THIS IS
 * EAS agrees a SMART objective for a six-month period: six categories, nine
 * weighted rows, twenty-nine milestones, weighting exactly 100. Underneath
 * the first of those milestones sits a second, much longer list - ninety
 * unique-role objectives, four of which are the KPIs the engine already
 * measures and eighty-six of which are recurring checks on business
 * processes.
 *
 * THE TWO LISTS ARE ONE HIERARCHY, WHICH IS THE WHOLE POINT OF THIS FILE.
 * The Operation row's first milestone reads, in the department's own words,
 * "Monitor 86 SAP processes ... and review 4 KPI results monthly". The
 * second sheet has ninety rows: four marked KPI, eighty-six not. It is not
 * a second table that happens to sit nearby - it IS that milestone, written
 * out. So that milestone is never typed in: it is COUNTED from the ninety,
 * and the number flows up into Operation, and Operation times its weight of
 * 20 is what reaches the score. Correct a row at the bottom and the figure
 * at the top moves.
 *
 * WHERE THE THREE TABS COME FROM, AND WHY THAT SPLIT
 *   OBJ_PLAN  the twenty-nine milestones. TYPED.
 *   OBJ_TASK  the ninety unique-role objectives. TYPED.
 *   OBJ_LOG   what was recorded, per month. WRITTEN BY THE PAGE.
 *
 * The first two are the agreed wording for the period. They belong in the
 * spreadsheet and not in this file for two reasons: correcting a sentence
 * should be a cell edit rather than a deployment, and this repository is
 * public while the objectives are not. See CONFIG.SHEETS.
 *
 * WHY A MARKS STRING RATHER THAN A ROW PER TICK
 * Thirty of the ninety are DAILY. A row per tick is 86 objectives times
 * twenty-two working days times six months - some eleven thousand rows, read
 * in full every time somebody opens the page. Instead each objective gets
 * ONE row per month carrying a short string with one character per slot:
 *
 *     'YYNYY.................'   a daily check, 8 November
 *      ^^^^^                     1st to 5th done, 3rd missed
 *
 * That is 90 x 6 = 540 rows for the whole period, one read, and the daily
 * detail is all still there. See objMarks* below.
 *
 * WHY THE WEEK IS SUNDAY TO THURSDAY
 * Because it is, here. A daily objective has about twenty-two slots in a
 * month and not thirty, and a system that counted Fridays would score every
 * person as missing eight days a month for ever, silently. It is in
 * CONFIG.OBJECTIVE.WORK_DAYS so that it is a stated decision rather than an
 * assumption buried in a loop.
 *
 * WHO MAY DO WHAT
 *   tick a unique-role objective   anyone signed in, for THEIR OWN group
 *   record a SMART milestone       section heads, the department head, admin
 *   add a new objective            admin only
 *
 * The middle one is the unusual one and it is deliberate: the ninety are
 * the daily work of whoever owns that module, and routing every tick through
 * a manager would mean the ticks stop happening. The twenty-nine are what
 * the department is scored on, which is a different kind of claim to make.
 */


/**
 * Column layout of the three tabs.
 *
 * OBJ_PLAN and OBJ_TASK are read BY POSITION and the headers are not
 * consulted, unlike the TEAM tab which is somebody else's spreadsheet and
 * gets a loose header match. These two are generated - the plan from the
 * objective workbook by a script, the tasks pasted straight out of it - so
 * the order is known and a loose match would only hide a bad paste.
 *
 * THE LAST TWO COLUMNS OF OBJ_PLAN ARE NOT IN THE ORIGINAL WORKBOOK.
 * 'Count Type' says which control the page draws - a counter, a percentage
 * or a yes/no - and 'Auto Source' names the three milestones the portal can
 * count by itself. Neither is a judgement about the objective; both are
 * about how it is recorded.
 */
const OBJ_PLAN_COLUMNS = [
  'Milestone ID', 'Row ID', 'Category', 'Weight', 'Objective',
  'Milestone', 'Expected Outcome', 'Count Type', 'Target', 'Per',
  'Owner', 'Auto Source'
];

/** Exactly the twelve columns of the Unique Roles sheet, in its order. */
const OBJ_TASK_COLUMNS = [
  'Objective ID', 'Category', 'Objective name', 'Group', 'Area', 'KPI',
  'Objective / Description', 'Target', 'Measurement Method', 'Frequency',
  'Responsible Person', 'Remarks / Outcome'
];

/**
 * The log. One row per objective per month, updated in place.
 *
 * History is JSON and last, like a share's attachment index and for the same
 * reason: it is a list nobody is meant to read by eye, and it keeps the
 * Updates timeline on the row it belongs to instead of in a second tab that
 * would have to be joined to this one on every page load.
 */
const OBJ_LOG_COLUMNS = [
  'Period', 'Kind', 'Ref ID', 'Marks', 'Value', 'Status', 'Note',
  'By', 'By ID', 'At', 'History', 'Marked', 'Notes'
];

/*
  NOTE AND NOTES ARE DIFFERENT COLUMNS, and the near-identical names are
  worth a word.

  'Note' was one note for the whole month, which is what the page had when
  a month was the only unit it knew. 'Notes' is one per PERIOD THAT COUNTS -
  a note against the 3rd, another against the 9th - which is what the thing
  is actually for: a square that is red says nobody recorded that day, and
  the only place the reason can live is beside that day.

  The old column is kept and still read. It is not written any more, and a
  row that has one shows it under the grid as what it is: a note somebody
  left against the month before the page could keep them per day.
*/


/**
 * What a slot in a Marks string can say.
 *
 * TWO OF THESE ARE WRITTEN AND THREE ARE READ. The page sends only DONE and
 * PENDING: pressing a square marks it, pressing again clears it. There is
 * no button that says "we missed this", because a miss is not something
 * anybody goes and records - it is what a period that came and went without
 * a mark IS, and the page works that out rather than waiting to be told.
 *
 * MISSED is still read, because rows written when the page did have that
 * button are still in the tab, and an 'N' means the same thing as a '.'
 * that got away: not done.
 */
const OBJ_PENDING = '.';
const OBJ_DONE    = 'Y';
const OBJ_MISSED  = 'N';

/** The two kinds of thing the log holds. */
const OBJ_KIND_PLAN = 'PLAN';
const OBJ_KIND_TASK = 'TASK';

/*
  How many past updates the page is given. The row keeps HISTORY_KEPT of
  them so a correction is never lost; the Updates timeline draws this many,
  and sending the rest to twenty-nine milestones on every load was several
  kilobytes an objective that nothing ever read.
*/
const OBJ_HISTORY_SHOWN = 8;


/**
 * Read once, remember for a few minutes, hand back a copy.
 *
 * WHY THE PAGE NEEDED THIS. Drawing the Objectives screen asked the
 * spreadsheet six separate questions - the plan, the ninety, the log, the
 * Knowledge feed, the 250-row Learnings index and the team directory - and
 * in Apps Script every one of those is a round trip to Google. The page
 * took about four seconds to appear, which on a screen somebody opens to
 * tick one box is long enough that they stop opening it.
 *
 * Five of the six barely change within a sitting, so they are cached and
 * only the log - the thing a tick actually writes - is read fresh every
 * time. The caller must still see its own writes, which is what objForget
 * is for.
 *
 * JSON in and out, so nothing with a Date in it can be cached through here.
 * Everything that is cached is plain numbers and strings by the time it
 * gets here; readObjLog, which carries timestamps, deliberately is not.
 */
function objCached(key, seconds, build) {
  let cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }

  if (cache) {
    try {
      const hit = cache.get(key);
      if (hit) return JSON.parse(hit);
    } catch (e) { /* a bad entry is not worth failing the page over */ }
  }

  const made = build();

  if (cache) {
    try {
      cache.put(key, JSON.stringify(made), seconds);
    } catch (e) { /* over 100KB, or no cache. The page still works. */ }
  }
  return made;
}


/** Throws away what objCached is holding, after something changed it. */
function objForget() {
  try {
    CacheService.getScriptCache()
      .removeAll(['obj.plan', 'obj.task', 'obj.counts']);
  } catch (e) { /* no cache, nothing to forget */ }
}


function objPlanTab() {
  return sheetWithHeaders(CONFIG.SHEETS.OBJ_PLAN, OBJ_PLAN_COLUMNS);
}

function objTaskTab() {
  return sheetWithHeaders(CONFIG.SHEETS.OBJ_TASK, OBJ_TASK_COLUMNS);
}

function objLogTab() {
  const sheet = sheetWithHeaders(CONFIG.SHEETS.OBJ_LOG, OBJ_LOG_COLUMNS);

  /*
    THE PERIOD COLUMN IS TEXT, and it has to be said out loud to Sheets.

    '2026-11' written into a General cell is parsed as a date, which is what
    made recording silently do nothing - see objPeriodCell. Every read
    normalises, so nothing depends on this; it is here so the tab stays
    legible to a person opening the spreadsheet, who should see 2026-11 and
    not "01/11/2026".

    Only on an empty tab, so this costs one call the first time the tab
    exists and nothing on any read after that.
  */
  try {
    if (sheet.getLastRow() <= 1) {
      sheet.getRange('A:A').setNumberFormat('@');
    }
  } catch (e) { /* a format is a courtesy; the normalising read is the fix */ }

  return sheet;
}


// ---------------------------------------------------------------------------
// THE PERIOD
// ---------------------------------------------------------------------------

/**
 * A Date out of a cell, or null.
 *
 * Duck-typed rather than `instanceof Date`, because this is also called from
 * the test harness where the Date a fixture built belongs to a different
 * realm than the one this code is evaluated in - and a cross-realm Date is
 * not `instanceof` the local one, so the check silently says "no date" for
 * something that plainly is one.
 */
function objDate(value) {
  if (!value) return null;
  if (typeof value.getTime !== 'function') return null;
  const ms = value.getTime();
  return (ms === ms) ? value : null;   // NaN fails its own equality
}


/** 'YYYY-MM' for a date. */
function objPeriodOf(date) {
  const d = objDate(date);
  if (!d) return '';
  const m = d.getMonth() + 1;
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : String(m));
}


/**
 * A period out of a spreadsheet cell, as 'YYYY-MM'.
 *
 * THIS IS NOT PARANOIA, IT IS THE BUG THAT MADE RECORDING SILENTLY DO
 * NOTHING. A value written to a cell is parsed exactly as though somebody
 * had typed it, and Sheets reads '2026-11' as a DATE - the first of
 * November 2026. So the write succeeded, the row was there, and the read
 * got a Date back where it expected the text '2026-11'. Every key missed,
 * every lookup came back empty, and the page reported "Nothing recorded"
 * directly above the row that had just been written. Worse, the next save
 * could not find the row either, so it appended another one.
 *
 * Normalising on the way OUT fixes it for rows already written as dates and
 * for rows written as text, which is why the fix is here and not only in
 * the column format - setupObjectiveTabs sets that too, so the tab stays
 * readable to a person, but no read depends on it having been set.
 */
function objPeriodCell(value) {
  const d = objDate(value);
  if (d) return objPeriodOf(d);
  return String(value === null || value === undefined ? '' : value).trim();
}


/**
 * Every month of the objective period, in order.
 *
 * Built from the two dates in CONFIG rather than listed, so that moving the
 * period is two lines and not a list somebody has to keep in step with them.
 */
function objPeriods() {
  const start = String(CONFIG.OBJECTIVE.PERIOD_START || '');
  const end   = String(CONFIG.OBJECTIVE.PERIOD_END || '');
  const out = [];

  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  if (!y || !m || !ey || !em) return out;

  // Bounded rather than `while (true)`: a mistyped end date earlier than the
  // start would otherwise spin until the script times out, and a page that
  // hangs is harder to diagnose than one that comes back short.
  for (let guard = 0; guard < 120; guard++) {
    out.push(y + '-' + (m < 10 ? '0' + m : String(m)));
    if (y === ey && m === em) break;
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}


/** Where a month sits in the period, or -1. */
function objPeriodIndex(period) {
  return objPeriods().indexOf(String(period || ''));
}


/** How many days a month has. */
function objDaysInMonth(period) {
  const y = Number(String(period).slice(0, 4));
  const m = Number(String(period).slice(5, 7));
  if (!y || !m) return 0;
  return new Date(y, m, 0).getDate();      // day 0 of the next month
}


/**
 * The working days of a month, as day-of-month numbers.
 *
 * Public holidays are NOT excluded, and that is a decision rather than an
 * omission: there is no holiday calendar in this project, inventing one
 * would mean maintaining it, and a check missed because the office was shut
 * is a thing the person recording it can say in the note. Over-counting the
 * slots is the honest failure - it shows as a gap somebody can explain,
 * where under-counting would silently forgive a real miss.
 */
/**
 * Worked out once per month per execution, not once per objective.
 *
 * THIS WAS THE PAGE'S HOT SPOT. Scoring the ninety across six months means
 * objSlotCount and objSlotsElapsed are each called about 540 times, and
 * both of them ask objWorkingDays, which builds a Date for every day of the
 * month - some sixteen thousand Date objects to draw one screen. The answer
 * is the same every time for a given month, so it is worked out once.
 *
 * Plain objects and not CacheService: these live for one call, where a
 * cache round trip would cost more than the loop it saves.
 */
const OBJ_WORK_DAYS = {};
const OBJ_SLOTS = {};


function objWorkingDays(period) {
  const key = String(period);
  if (OBJ_WORK_DAYS[key]) return OBJ_WORK_DAYS[key];

  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  const days = objDaysInMonth(key);
  const work = CONFIG.OBJECTIVE.WORK_DAYS || [0, 1, 2, 3, 4];
  const out = [];
  for (let d = 1; d <= days; d++) {
    if (work.indexOf(new Date(y, m - 1, d).getDay()) !== -1) out.push(d);
  }

  OBJ_WORK_DAYS[key] = out;
  return out;
}


/**
 * Which calendar quarter a month closes, if it closes one.
 *
 * A quarterly objective is due once a quarter, and the month it is due in is
 * the one that ends it - March, June, September, December. Over an October
 * to March period that is December and March, which is twice, which is what
 * "quarterly" means over six months.
 */
function objIsQuarterEnd(period) {
  const m = Number(String(period).slice(5, 7));
  return m === 3 || m === 6 || m === 9 || m === 12;
}


/**
 * The month an objective with no slot this month is next due in.
 *
 * "Not due in October 2026" is a true sentence that answers the wrong
 * question. The only objectives it ever appears on are the quarterly ones,
 * and what somebody looking at one actually wants to know is WHEN - so the
 * card says "Due in December" and the question does not arise.
 *
 * Empty when it is due this month, or when there is no month left in the
 * period that it falls in.
 */
function objDueIn(task, period) {
  if (objSlotCount(period, task.frequency)) return '';

  const periods = objPeriods();
  const from = periods.indexOf(String(period));
  if (from === -1) return '';

  for (let i = from + 1; i < periods.length; i++) {
    if (objSlotCount(periods[i], task.frequency)) return periods[i];
  }
  return '';
}


/**
 * How many slots an objective of this frequency has in this month.
 *
 * WEEKLY counts blocks of seven days from the 1st, not calendar weeks. A
 * calendar week straddles two months and would have to be attributed to one
 * of them; blocks of seven are entirely inside the month, are the same
 * number every time for a given month length, and can be explained to
 * somebody looking at the page in one sentence.
 */
function objSlotCount(period, frequency) {
  const freq = String(frequency || '').trim().toUpperCase();
  const key = period + '|' + freq;
  if (OBJ_SLOTS[key] !== undefined) return OBJ_SLOTS[key];

  let n;
  if (freq === 'DAILY')          n = objWorkingDays(period).length;
  else if (freq === 'WEEKLY')    n = Math.ceil(objDaysInMonth(period) / 7);
  else if (freq === 'QUARTERLY') n = objIsQuarterEnd(period) ? 1 : 0;
  else                           n = 1;       // MONTHLY, and anything unknown

  OBJ_SLOTS[key] = n;
  return n;
}


/**
 * How many of this month's slots have already come and gone.
 *
 * For a month that is over, all of them. For the month in progress, the ones
 * that have CLOSED - which is the same line objSlotEnd draws for deciding
 * whether a mark arrived late, and it has to be the same line, because a
 * slot that is still open enough to be marked on time cannot also be a slot
 * whose blankness is a miss.
 *
 * Today is not elapsed. It counted today in its first version, so a daily
 * objective went red at midnight for a day its owner had until the end of to
 * do, and the Behind card counted it. Marking somebody down on a Tuesday for
 * a check they have until Thursday to do is how a tracking system loses its
 * audience, and doing it at 9am for today's work is the same mistake one
 * period smaller.
 */
function objSlotsElapsed(period, frequency, now) {
  const slots = objSlotCount(period, frequency);
  if (!slots) return 0;

  const today = objDate(now) || new Date();
  const nowPeriod = objPeriodOf(today);
  if (period < nowPeriod) return slots;        // the month is closed
  if (period > nowPeriod) return 0;            // it has not started

  // Slot ends only ever move forwards, so this is a count of the ones behind
  // us. Monthly and quarterly end with the month, so in the month in progress
  // this is nought - which is what makes them "waiting" rather than behind.
  const ms = today.getTime();
  let n = 0;
  for (let i = 0; i < slots; i++) {
    if (objSlotEnd(period, frequency, i) < ms) n++;
  }
  return n;
}


/**
 * How many of this month's slots can be marked right now.
 *
 * NOT THE SAME QUESTION AS objSlotsElapsed, and conflating the two made a
 * monthly objective impossible to record in its own month. Elapsed means
 * "this period has closed, so an unmarked slot is a miss". Open means "this
 * period has begun, so you may record it" - and a monthly slot is open from
 * the 1st and does not close until the 30th.
 *
 * The two differ by exactly the slot in progress: today's square can be
 * pressed, and is not a miss until tonight.
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
    // Every working day whose date has arrived. On a Friday that is the
    // same count as elapsed: nothing to press, nothing pending.
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


// ---------------------------------------------------------------------------
// THE MARKS STRING
// ---------------------------------------------------------------------------

/** A fresh string of pending slots. */
function objMarksBlank(slots) {
  let s = '';
  for (let i = 0; i < Math.max(0, slots); i++) s += OBJ_PENDING;
  return s;
}


/**
 * A stored string, trimmed or padded to the length the month actually has.
 *
 * Both directions matter. Padding covers a row written before somebody fixed
 * the frequency; trimming covers the opposite. Neither is a silent data loss
 * worth refusing the page over - the alternative is an objective that cannot
 * be shown at all because its string is a character too long.
 */
function objMarksRead(cell, slots) {
  let s = String(cell === null || cell === undefined ? '' : cell)
    .replace(/[^YN.]/g, '');
  if (s.length > slots) s = s.slice(0, slots);
  while (s.length < slots) s += OBJ_PENDING;
  return s;
}


/** The same string with one slot changed. Out-of-range leaves it alone. */
function objMarksSet(marks, index, mark) {
  const s = String(marks || '');
  const i = Number(index);
  if (!(i >= 0) || i >= s.length) return s;
  const ch = (mark === OBJ_DONE || mark === OBJ_MISSED) ? mark : OBJ_PENDING;
  return s.slice(0, i) + ch + s.slice(i + 1);
}


/**
 * The last moment a slot could be marked and still count as on time.
 *
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
 * When each slot was marked, parsed. Bad JSON reads as nothing recorded.
 *
 * Kept beside the marks rather than inside them because a mark is one
 * character and a time is not - and because the question it answers is one
 * the page asks of a single square at a time: was this done when it should
 * have been, or caught up on later.
 */
function parseObjMarked(cell) {
  const text = String(cell || '').trim();
  if (!text) return {};
  try {
    const got = JSON.parse(text);
    if (!got || typeof got !== 'object') return {};
    const out = {};
    Object.keys(got).forEach(function (k) {
      const n = Number(got[k]);
      if (n > 0) out[String(Number(k))] = n;
    });
    return out;
  } catch (e) {
    return {};
  }
}


/**
 * The notes on a row, one per period that counts, parsed.
 *
 * SHAPE, and why it is this short:
 *
 *   { "2": { t: 'the text', by: 'Bilal Hossain', id: '20000012',
 *            at: 1762..., made: 1762..., n: 2 } }
 *
 * The key is the slot - the 3rd of November is slot 2 of a daily objective
 * - so a note is tied to the square it explains and cannot drift onto
 * another one when the month is read again. `made` is the first save and
 * `at` the last, with `n` the number of saves, so the page can say "saved
 * by X, edited twice" without a second tab to join against.
 *
 * One-letter keys because twenty-six of these share one cell. Spelling
 * them out costs about 1,400 characters a row for nothing anybody reads.
 */
function parseObjNotes(cell) {
  const text = String(cell || '').trim();
  if (!text) return {};
  let got;
  try {
    got = JSON.parse(text);
  } catch (e) {
    return {};
  }
  if (!got || typeof got !== 'object') return {};

  const out = {};
  Object.keys(got).forEach(function (k) {
    const slot = Number(k);
    const v = got[k];
    if (!(slot >= 0) || !v) return;
    // A note is its text. One with none is one that was cleared, and it is
    // dropped rather than kept as an empty box somebody has to look at.
    const t = String((typeof v === 'string' ? v : v.t) || '');
    if (!t) return;
    out[String(slot)] = {
      t: t,
      by: String((v && v.by) || ''),
      id: String((v && v.id) || ''),
      at: Number((v && v.at) || 0) || 0,
      made: Number((v && v.made) || (v && v.at) || 0) || 0,
      n: Number((v && v.n) || 1) || 1
    };
  });
  return out;
}


/**
 * The notes as they go into the cell, with the cell's own limit enforced.
 *
 * A cell holds 50,000 characters and the writer is the only place that can
 * know it is about to go past them. Refusing the save with a sentence that
 * says which note to shorten is the one outcome that does not lose
 * somebody's writing: Sheets would otherwise take the row and truncate it,
 * and the first anybody would know is a month of notes reading as nothing.
 */
function objNotesText(notes) {
  const text = JSON.stringify(notes || {});
  const max = CONFIG.OBJECTIVE.NOTES_CELL_MAX || 45000;
  if (text.length > max) {
    throw new Error('The notes on this objective have reached the limit of ' +
                    'what one row can hold. Shorten one of the longer ones ' +
                    'before adding another.');
  }
  return text;
}


/** How many of the first `upto` slots carry this mark. */
function objMarksCount(marks, mark, upto) {
  const s = String(marks || '');
  const n = (upto === undefined || upto === null) ? s.length
          : Math.min(Number(upto) || 0, s.length);
  let count = 0;
  for (let i = 0; i < n; i++) if (s.charAt(i) === mark) count++;
  return count;
}


// ---------------------------------------------------------------------------
// READING THE TABS
// ---------------------------------------------------------------------------

/**
 * The twenty-nine milestones.
 *
 * Weight is carried on every milestone of a row but belongs to the ROW - the
 * workbook weights rows, not milestones - so scoring groups by Row ID and
 * counts each row's weight once. A milestone whose Row ID is blank is
 * dropped rather than silently given its own weight, which would push the
 * total past 100 and make every figure on the page wrong.
 */
function readObjPlan() {
  const sheet = objPlanTab();
  const last = sheet.getLastRow();
  if (last < 2) return { plan: [], rows: [], weight: 0, filled: false };

  const raw = sheet.getRange(2, 1, last - 1, OBJ_PLAN_COLUMNS.length).getValues();
  const plan = [];

  raw.forEach(function (r) {
    const id = String(r[0] || '').trim();
    const rowId = String(r[1] || '').trim();
    const milestone = String(r[5] || '').trim();
    if (!id || !rowId || !milestone) return;

    plan.push({
      id: id,
      rowId: rowId,
      category: String(r[2] || '').trim(),
      weight: Number(r[3]) || 0,
      objective: String(r[4] || '').trim(),
      milestone: milestone,
      outcome: String(r[6] || '').trim(),
      countType: String(r[7] || 'DONE').trim().toUpperCase(),
      target: Number(r[8]),
      per: String(r[9] || 'MONTH').trim().toUpperCase(),
      owner: String(r[10] || '').trim(),
      auto: String(r[11] || '').trim().toUpperCase()
    });
  });

  // ---- group into the weighted rows ----
  const order = [];
  const byRow = {};
  plan.forEach(function (m) {
    if (!byRow[m.rowId]) {
      byRow[m.rowId] = {
        rowId: m.rowId, category: m.category, weight: m.weight, milestones: []
      };
      order.push(m.rowId);
    }
    byRow[m.rowId].milestones.push(m);
  });

  const rows = order.map(function (k) { return byRow[k]; });
  const weight = rows.reduce(function (sum, r) { return sum + r.weight; }, 0);

  return { plan: plan, rows: rows, weight: weight, filled: plan.length > 0 };
}


/**
 * The ninety unique-role objectives.
 *
 * `kpi` is the four that the KPI engine already measures. They are kept in
 * the list rather than filtered out because the milestone above counts
 * ninety things, and a page that showed eighty-six would not add up to what
 * the department's own sheet says.
 */
function readObjTask() {
  const sheet = objTaskTab();
  const last = sheet.getLastRow();
  if (last < 2) return { tasks: [], count: 0, groups: [], filled: false };

  const raw = sheet.getRange(2, 1, last - 1, OBJ_TASK_COLUMNS.length).getValues();
  const tasks = [];
  const groups = [];

  raw.forEach(function (r) {
    const id = String(r[0] || '').trim();
    const name = String(r[2] || '').trim();
    if (!id || !name) return;

    const group = String(r[3] || '').trim() || 'Unassigned';
    if (groups.indexOf(group) === -1) groups.push(group);

    tasks.push({
      id: id,
      category: String(r[1] || '').trim(),
      name: name,
      group: group,
      area: String(r[4] || '').trim(),
      kpi: /^y/i.test(String(r[5] || '').trim()),
      description: String(r[6] || '').trim(),
      target: String(r[7] === null || r[7] === undefined ? '' : r[7]).trim(),
      method: String(r[8] || '').trim(),
      frequency: String(r[9] || 'Monthly').trim(),
      owner: String(r[10] || '').trim(),
      remarks: String(r[11] || '').trim()
    });
  });

  return {
    tasks: tasks, count: tasks.length, groups: groups, filled: tasks.length > 0
  };
}


/** Past updates on a log row, parsed. Bad JSON reads as no history. */
function parseObjHistory(cell) {
  const text = String(cell || '').trim();
  if (!text) return [];
  try {
    const list = JSON.parse(text);
    if (!list || !list.length) return [];
    return list.filter(function (h) { return h && h.at; });
  } catch (e) {
    return [];
  }
}


/**
 * Everything recorded, keyed by period and reference.
 *
 * One read for the whole period. The key is deliberately the same shape as
 * the one the writers build, so a lookup here and a write there cannot drift
 * apart - see objLogKey.
 */
function readObjLog() {
  const sheet = objLogTab();
  const last = sheet.getLastRow();
  const byKey = {};
  if (last < 2) return { byKey: byKey, count: 0 };

  const raw = sheet.getRange(2, 1, last - 1, OBJ_LOG_COLUMNS.length).getValues();
  let count = 0;

  raw.forEach(function (r) {
    // objPeriodCell, not String(): Sheets stores '2026-11' as a date. See it.
    const period = objPeriodCell(r[0]);
    const kind = String(r[1] || '').trim().toUpperCase();
    const ref = String(r[2] || '').trim();
    if (!period || !kind || !ref) return;

    const at = objDate(r[9]);
    byKey[objLogKey(period, kind, ref)] = {
      period: period, kind: kind, ref: ref,
      marks: String(r[3] || ''),
      value: (r[4] === '' || r[4] === null || r[4] === undefined)
        ? null : Number(r[4]),
      status: String(r[5] || '').trim().toUpperCase(),
      note: String(r[6] || ''),
      by: String(r[7] || '').trim(),
      byId: String(r[8] || '').trim(),
      at: at ? at.getTime() : 0,
      history: parseObjHistory(r[10]),
      markedAt: parseObjMarked(r[11]),
      notes: parseObjNotes(r[12])
    };
    count++;
  });

  return { byKey: byKey, count: count };
}


/**
 * The one key shape, used by every reader and every writer.
 *
 * The period goes through objPeriodCell so that a key built from a cell and
 * a key built from a string agree even when Sheets turned the cell into a
 * date. The two have to agree or a saved row can never be found again.
 */
function objLogKey(period, kind, ref) {
  return objPeriodCell(period) + '|' +
         String(kind === null || kind === undefined ? '' : kind)
           .trim().toUpperCase() + '|' +
         String(ref === null || ref === undefined ? '' : ref).trim();
}


/** The row a log entry is on, or -1. */
function objLogRowOf(sheet, period, kind, ref) {
  const rows = objLogRowsOf(sheet, period, kind, ref);
  return rows.length ? rows[rows.length - 1] : -1;
}


/**
 * EVERY row for one key, in sheet order. Normally one.
 *
 * THE BUG THIS EXISTS FOR, because it cost a month of recording.
 *
 * readObjLog builds its index by walking the rows and overwriting as it
 * goes, so where a key appears twice the LAST row is the one the page
 * sees. The writer used to take the FIRST. With one row per key those are
 * the same row and everything works; with two, every save was written
 * into a row nobody reads, and the page went on showing the other one.
 *
 * From the outside that is the worst failure this app can have: the save
 * says it worked, the card closes, the number goes back to what it was,
 * and there is nothing to see in any log. Somebody marks a month, comes
 * back, finds it unmarked, and marks it again.
 *
 * Duplicates got there two ways, both now closed. Before objPeriodCell,
 * a Period cell that Sheets had turned into a date did not match the key
 * built from a string, so every save appended instead of updating. And
 * two ticks in flight at once could both find no row and both append -
 * which the page made more likely, not less, when it stopped sending
 * them one at a time. objWriteLog now takes a lock for exactly that.
 *
 * repairObjLog folds any that are already there.
 */
function objLogRowsOf(sheet, period, kind, ref) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const keys = sheet.getRange(2, 1, last - 1, 3).getValues();
  const want = objLogKey(period, kind, ref);
  const found = [];
  for (let i = 0; i < keys.length; i++) {
    if (objLogKey(keys[i][0], keys[i][1], keys[i][2]) === want) found.push(i + 2);
  }
  return found;
}


// ---------------------------------------------------------------------------
// SCORING
// ---------------------------------------------------------------------------

/**
 * Where one unique-role objective stands in one month.
 *
 * `onSchedule` is the strict reading: every slot that has already passed was
 * marked done. A slot that passed and was never marked counts against it,
 * the same as one marked missed - an untouched objective is not a passing
 * one, and the opposite reading would make the whole page an optimistic
 * guess at what people meant to do.
 */
function objTaskState(task, marks, period, now, markedAt) {
  const slots = objSlotCount(period, task.frequency);
  const elapsed = objSlotsElapsed(period, task.frequency, now);
  const open = objSlotsOpen(period, task.frequency, now);
  const s = objMarksRead(marks, slots);
  const done = objMarksCount(s, OBJ_DONE, elapsed);
  const missed = objMarksCount(s, OBJ_MISSED, elapsed);

  /*
    WHAT COLOUR EACH SQUARE IS, worked out here so the page does not have
    to and cannot disagree with the score.

      done      marked, and marked while its own period was still open
      late      marked, but after that period had closed. The work was
                done; it was recorded afterwards, and the square says so
                rather than pretending either that it was on time or that
                it never happened
      missed    the period came and went with no mark. Nobody records this
                - it is what the absence IS
      pending   the period has not closed yet

    Marking late still counts as done for the score. It was done. The
    colour is the honest record of when, and a scoring rule that threw the
    work away because the note was late would teach people not to catch up.
  */
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
      from `done` and is the one the card prints.

      A monthly objective has one slot and it is not elapsed until the month
      is over, so `done` - which counts only inside `elapsed` - is zero all
      month even after somebody ticks it, and the card read "0 of 0 done"
      over a green button saying Done. Scoring still uses `done`: a slot
      that has not come round yet cannot be late, and should not count as
      early credit either.
    */
    marked: objMarksCount(s, OBJ_DONE),
    // How many slots may be pressed. See objSlotsOpen - a monthly one is
    // open all month, and elapsed only the day after it ends.
    open: open,
    late: late,
    cells: marksState,
    marks: s,
    onSchedule: elapsed === 0 ? true : done === elapsed,
    // Waiting on somebody: the slot that can be pressed right now is blank.
    due: open > 0 && s.charAt(Math.max(0, open - 1)) === OBJ_PENDING
  };
}


/*
  THE CELLS, SMALL ENOUGH TO SEND.

  objTaskState hands back one object per slot - {slot, state, at} - which
  is the right shape to work with and the wrong one to put on a wire.
  Measured: 945 bytes for a single daily objective's twenty-six squares,
  and there are ninety objectives, so the colours alone were eighty-five
  kilobytes of a hundred-and-fifty kilobyte answer. Through the Apps
  Script sandbox bridge, which serialises everything twice, that is a
  visible part of why this page took seconds to appear.

  One character per slot says the same thing in a thirtieth of the room,
  and the times go beside it for only the slots that have one - which is
  what the tooltips need and no more. The page expands it once on arrival
  and everything downstream of that is unchanged.

  The SERVER still decides every colour. This is a shorter way of saying
  the same answer, not the page working it out for itself.
*/
const OBJ_STATE_CHAR = { done: 'y', late: 'l', missed: 'n', pending: '.' };

function objStateChars(cells) {
  let out = '';
  (cells || []).forEach(function (c) {
    out += OBJ_STATE_CHAR[c.state] || OBJ_PENDING;
  });
  return out;
}

/** Only the slots that carry a time: what "Marked 10 Nov" is drawn from. */
function objCellTimes(cells) {
  const out = {};
  (cells || []).forEach(function (c) {
    if (c.at) out[String(c.slot)] = c.at;
  });
  return out;
}


/**
 * One month of one SMART milestone, in the same four states as a square on
 * the other sheet.
 *
 * THE TWO SHEETS NOW READ THE SAME WAY. A milestone is recorded once a
 * month, so its month IS its monitoring period and the colours mean what
 * they mean everywhere else: green recorded while the month was running,
 * yellow written up after it closed, red a month that ended with nothing,
 * blank a month that has not come round. It is the same objTaskState doing
 * the work on a one-slot monthly frequency, rather than a second set of
 * rules that could disagree with the first.
 *
 * A COUNTED MILESTONE IS NEVER LATE AND NEVER MISSED. Nobody records the
 * three the portal counts for itself - the figure is there the moment the
 * month is - so marking them red for an empty log row would be the page
 * complaining that an automatic thing was not done by hand.
 */
function objPlanMonthState(milestone, entry, period, now, counted, fraction) {
  if (milestone.auto) {
    /*
      A COUNTED MONTH IS COLOURED BY WHAT WAS COUNTED.

      It used to go green for any month the portal could count at all -
      which is every month that has begun - so a milestone reading "0 of
      85 due so far" drew a green October underneath it. That is the
      page saying the month was fine on a month where nothing was
      recorded at all, and it is worse than no colour.

      There is no mark to show here and never will be: nobody records
      these by hand. So the square says how the counted figure did,
      which is the only thing it knows - met it, part of it, or none of
      it. The tooltip carries the actual numbers so the colour is never
      the whole story.
    */
    const current = objPeriodOf(objDate(now) || new Date());
    if (period > current) return { state: 'pending', at: 0, auto: true };
    if (!counted) return { state: 'pending', at: 0, auto: true };
    const got = Number(fraction) || 0;
    return {
      state: got >= 1 ? 'done' : (got > 0 ? 'part' : 'missed'),
      at: 0, auto: true
    };
  }

  /*
    THE MARK IS THE WHOLE ANSWER, and nothing else is consulted.

    An earlier version also read a month as recorded when the row carried
    a figure, on the grounds that a number is evidence somebody was there.
    That reading cannot survive the square being pressable: un-ticking a
    month you had ticked would leave the figure behind, the figure would
    say "recorded", and the square would refuse to go out. A square that
    will not clear is worse than one that is occasionally generous.

    So the figure is the achievement and the mark is the monitoring, and
    they are allowed to disagree - which they should, because "we hit the
    target" and "somebody checked this month" are different claims.
  */
  const state = objTaskState({ frequency: 'Monthly' },
                             entry ? entry.marks : '', period, now,
                             entry ? entry.markedAt : null);
  const cell = state.cells[0] || { state: 'pending', at: 0 };
  return { state: cell.state, at: cell.at, auto: false };
}


/** 'nine of eighty-five on schedule', for a counted month's tooltip. */
function objCountedSays(milestone, auto, scored) {
  if (milestone.auto === 'UNIQUE_ROLES') {
    const u = auto.UNIQUE_ROLES;
    if (!u) return '';
    return u.on + ' of ' + u.due + ' on schedule';
  }
  if (!scored) return '';
  return scored.value + ' of ' + scored.target;
}


/**
 * The milestone that is counted rather than typed: how the ninety are doing.
 *
 * Returns a fraction, which is what the scorer wants, plus the counts the
 * page prints beside it. The four KPI rows are included - they are four of
 * the ninety and the milestone's own wording counts them.
 */
function objUniqueRolesScore(tasks, log, period, now) {
  let on = 0;
  let due = 0;
  let waiting = 0;
  let total = 0;
  let kpiOn = 0;
  let kpiDue = 0;

  tasks.forEach(function (t) {
    const slots = objSlotCount(period, t.frequency);
    if (!slots) return;                 // a quarterly item in a quiet month
    total++;

    const entry = log.byKey[objLogKey(period, OBJ_KIND_TASK, t.id)];
    const state = objTaskState(t, entry ? entry.marks : '', period, now,
                               entry ? entry.markedAt : null);

    /*
      ONLY WHAT HAS ACTUALLY COME ROUND COUNTS.

      The first version scored every objective whose slot had not arrived
      yet as "on schedule" - true, in the sense that nothing not yet due can
      be late, and badly misleading as a number. Thirty of the ninety are
      monthly, and a monthly slot is not elapsed until the month ends, so on
      the 10th of November the page reported "30 of 85 on schedule" and a
      milestone sitting at 35% on a month where nobody had recorded a single
      thing. A figure that starts at 35% and can only go down is not a
      measure of anything.

      So the denominator is what is DUE, and the thirty that are not yet due
      are reported separately rather than counted as wins.
    */
    if (!state.elapsed) {
      waiting++;
      return;
    }

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
 * How far one milestone got in one month, as a fraction of its target.
 *
 * A month with nothing recorded scores zero. That is the honest reading and
 * it is worth saying out loud, because the comfortable alternative - leaving
 * it out of the average - makes a department that recorded nothing at all
 * score 100, which is exactly backwards.
 *
 * PERIOD targets are cumulative. "Complete at least 6 development
 * initiatives during the period" is not six a month; it is six by March, so
 * its score in any month is everything recorded up to and including that
 * month, over six.
 */
function objMilestoneScore(milestone, log, period, context) {
  const auto = milestone.auto;
  const key = objLogKey(period, OBJ_KIND_PLAN, milestone.id);
  const entry = log.byKey[key] || null;

  // ---- the three that are counted, not typed ----
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
    // The source could not be read. Fall through and use whatever was typed
    // rather than scoring a real milestone zero because another tab is
    // mid-edit.
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
      THE SQUARE IS THE ANSWER for a yes-or-no milestone.

      It used to be a status somebody picked from three buttons - Done,
      In progress, Not done - beside a row of month squares that meant
      the same thing and disagreed with it freely. There is one way to
      say a month happened now, and it is the one every other row on
      this page uses.
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
 * The weighted figure out of 100 for one month.
 *
 * A row's achievement is the MEAN of its milestones, not their sum: the
 * workbook gives Operation four milestones and People and Organization's
 * second row only one, and summing would make a row worth more for being
 * described in more detail.
 */
function objScore(plan, log, period, context) {
  const rows = [];
  let total = 0;

  plan.rows.forEach(function (row) {
    let sum = 0;
    const scored = row.milestones.map(function (m) {
      const s = objMilestoneScore(m, log, period, context);
      sum += s.fraction;
      return { id: m.id, fraction: s.fraction, value: s.value,
               target: s.target, auto: s.auto };
    });

    const fraction = row.milestones.length ? sum / row.milestones.length : 0;
    total += fraction * row.weight;
    rows.push({
      rowId: row.rowId, category: row.category, weight: row.weight,
      fraction: fraction, points: fraction * row.weight, milestones: scored
    });
  });

  return {
    period: period,
    score: Math.round(total * 10) / 10,
    outOf: plan.weight,
    rows: rows
  };
}


// ---------------------------------------------------------------------------
// WHAT THE PORTAL ALREADY KNOWS
// ---------------------------------------------------------------------------

/**
 * The three milestones nobody has to type, for EVERY month at once.
 *
 * ALL SIX MONTHS, not just the one on screen, and that is the point of the
 * shape. Each milestone shows six pips - how it went in each month of the
 * period - and the first version worked the auto sources out only for the
 * month being looked at. The other five fell back to what had been TYPED
 * against a milestone that is never typed, which is nothing, so three of
 * the ten milestones drew five red pips for months that had been fine. The
 * pips are the drifting signal; wrong pips are worse than none.
 *
 * The two Drive-backed sources are read ONCE and counted per month from
 * what came back, rather than read once per month. Six sheet reads where
 * one will do is the kind of thing that turns a page into a slow page.
 *
 * Every source is wrapped. The objectives page must open when the Learnings
 * index is mid-rebuild or the Knowledge tab has not been made yet; a source
 * that cannot be read is simply not counted, and the milestone falls back to
 * whatever was recorded by hand.
 */
function objAutoAll(tasks, log, periods, now) {
  const byPeriod = {};
  periods.forEach(function (p) { byPeriod[p] = {}; });

  periods.forEach(function (p) {
    try {
      byPeriod[p].UNIQUE_ROLES = objUniqueRolesScore(tasks, log, p, now);
    } catch (e) { /* the ninety are unreadable; the milestone can be typed */ }
  });

  /*
    The Knowledge feed and the 250-row Learnings index, boiled down to one
    small number per month and CACHED as that. Both are whole-tab reads and
    neither moves often; what comes out is six integers.
  */
  const tally = function (stamps) {
    const out = {};
    stamps.forEach(function (ms) {
      if (!ms) return;
      const p = objPeriodOf(new Date(ms));
      out[p] = (out[p] || 0) + 1;
    });
    return out;
  };

  const counts = objCached('obj.counts', 600, function () {
    const made = { KNOWLEDGE: null, LEARN: null };
    try {
      made.KNOWLEDGE = tally((readKnowledge().shares || [])
        .map(function (s) { return s.stamp; }));
    } catch (e) { /* no Knowledge tab yet */ }
    try {
      // `stamp` is the Updated cell as milliseconds, which readLearn already
      // works out. Re-parsing its formatted `updated` string would mean
      // guessing at a date format for no gain.
      made.LEARN = tally(((readLearn() || {}).docs || [])
        .map(function (d) { return d.stamp; }));
    } catch (e) { /* no library index yet */ }
    return made;
  });

  ['KNOWLEDGE', 'LEARN'].forEach(function (key) {
    if (!counts[key]) return;           // that source could not be read
    periods.forEach(function (p) {
      byPeriod[p][key] = { value: counts[key][p] || 0 };
    });
  });

  return byPeriod;
}


/** The same thing for one month, which is what the editor tools want. */
function objAutoSources(tasks, log, period, now) {
  return objAutoAll(tasks, log, [period], now)[period] || {};
}


// ---------------------------------------------------------------------------
// WHO MAY DO WHAT
// ---------------------------------------------------------------------------

/**
 * The groups a person may tick, and whether they may record a milestone.
 *
 * A person's groups come from their Module cell in the TEAM tab, split on
 * the separators that cell actually uses - 'MM/MD' is two modules, and the
 * cell is written for a human to read rather than for this to parse.
 *
 * SOMEBODY WITH AN EMPTY MODULE CELL CAN TICK NOTHING, and the page says so
 * in those words. That is a real consequence and it is the right one: the
 * alternative is to let anybody tick anything, which makes the owner column
 * decorative. It also surfaces a gap in the directory, which is fixable in
 * one cell, rather than hiding it.
 */
function objWhoAmI(token) {
  const session = currentSession(token);
  const id = session ? String(session.u || '') : '';
  const admin = Boolean(session) &&
                rankOf(session.r) >= rankOf(ROLE_ADMIN);

  const me = {
    id: id, name: id, admin: admin,
    groups: [], all: admin, planner: admin, reason: ''
  };
  if (!id) return me;

  /*
    The directory read is cached per person. It is a whole-tab read that
    answers two small questions - what modules are against your name, and
    are you a head - and neither changes during a sitting. Keyed on the
    employee ID and on the role, so signing in as admin does not inherit
    the viewer's cached answer.
  */
  let team = null;
  try {
    team = objCached('obj.team.' + id + '.' + (admin ? 'a' : 'u'), 600,
                     function () {
      const read = readTeam();
      // Trimmed to what this function uses. The full directory carries
      // photo URLs and phone numbers, which have no business in a cache
      // and would push it past the 100KB a cache entry holds.
      const flat = [];
      const add = function (person, head) {
        if (!person) return;
        flat.push({ id: String(person.id || ''), name: person.name || '',
                    module: person.module || '', head: head });
      };
      add(read.lead, true);
      (read.sections || []).forEach(function (s) {
        add(s.head, true);
        (s.members || []).forEach(function (m) { add(m, false); });
      });
      return { flat: flat };
    });
  } catch (e) { team = null; }
  if (!team) {
    me.reason = 'The team directory could not be read, so your modules are ' +
                'not known. An admin can still record.';
    return me;
  }

  let found = null;
  const everyone = (team && team.flat) || [];
  for (let i = 0; i < everyone.length; i++) {
    if (everyone[i].id === id) { found = everyone[i]; break; }
  }

  if (!found) {
    me.reason = 'Your employee ID is not in the team directory, so there is ' +
                'no module against your name.';
    return me;
  }

  me.name = found.name || id;
  // A section head records milestones; so does the department head. That is
  // what 'head' means on the organogram and there is no second list to keep.
  if (found.head) me.planner = true;

  const modules = String(found.module || '')
    .split(/[\/,&+;]| and /i)
    .map(function (m) { return m.trim().toUpperCase(); })
    .filter(Boolean);

  me.groups = modules;
  if (!modules.length && !admin) {
    me.reason = 'No module is set against your name in the team directory, ' +
                'so there is nothing here for you to tick yet. Ask for your ' +
                'Module cell to be filled in.';
  }
  return me;
}


/**
 * Whether this person may tick this objective.
 *
 * TAKES THE OBJECTIVE, NOT ITS GROUP NAME, so that the two rules that decide
 * this - it is a KPI, and it is not your module - live together in one
 * function. The first version took the group, which meant an admin got
 * `true` for the four KPIs: the page drew a tick button on them and
 * tickObjTask then refused the press. A button that does nothing is worse
 * than no button, and the rule was in two places to drift apart.
 *
 * A KPI is nobody's to tick, an admin included. Its figure comes from the
 * engine, and a hand-set tick beside a measured percentage is a second,
 * quieter answer to a question that already has one.
 */
function objMayTick(me, task) {
  if (!me || !me.id || !task) return false;
  if (task.kpi) return false;
  if (me.all) return true;
  const g = String(task.group || '').trim().toUpperCase();
  return me.groups.indexOf(g) !== -1;
}


// ---------------------------------------------------------------------------
// WHAT THE PAGE CALLS
// ---------------------------------------------------------------------------

/**
 * Everything the Objectives page needs, in one call.
 *
 * One round trip rather than three, because the two sheets are one hierarchy
 * and the page cannot draw either half honestly without the other: the
 * Operation milestone's figure IS the ninety, and the ninety's header says
 * which milestone they roll up into.
 */
function getObjectives(token, period) {
  requireSignedIn(token);

  const periods = objPeriods();
  const now = new Date();
  const current = objPeriodOf(now);
  const want = String(period || '').trim() ||
               (periods.indexOf(current) !== -1 ? current : periods[0]) || '';

  /*
    THE LOG IS READ FRESH; EVERYTHING ELSE IS CACHED.

    The plan and the ninety are the agreed wording for a six-month period -
    they change when somebody edits the spreadsheet, which is rare, and the
    cache is thrown away when the page itself adds a milestone. The log is
    what a tick writes, so a cached one would mean pressing a button and
    watching nothing happen.
  */
  const plan = objCached('obj.plan', 600, readObjPlan);
  const tasks = objCached('obj.task', 600, readObjTask);
  const log = readObjLog();
  // Every month, not just the one on screen - the six pips under each
  // milestone need the other five. See objAutoAll.
  const autoAll = objAutoAll(tasks.tasks, log, periods, now);
  const auto = autoAll[want] || {};
  const me = objWhoAmI(token);

  // ---- the plan side, with this month's standing on each milestone ----
  const rows = plan.rows.map(function (row) {
    return {
      rowId: row.rowId, category: row.category, weight: row.weight,
      milestones: row.milestones.map(function (m) {
        const s = objMilestoneScore(m, log, want, { auto: auto });
        const entry = s.entry;
        // Every month at a glance, for the six pips under the bar. Each one
        // is scored against ITS OWN month's auto sources, not against the
        // month on screen - a counted milestone has a different figure every
        // month and the pips are the only place that shows the shape of it.
        const months = periods.map(function (p) {
          const e = log.byKey[objLogKey(p, OBJ_KIND_PLAN, m.id)];
          /*
            A counted milestone needs its figure for that month to be
            coloured by it; a typed one is coloured by its mark and does
            not need scoring six times over on every page load.
          */
          const ms = m.auto
            ? objMilestoneScore(m, log, p, { auto: autoAll[p] || {} })
            : null;
          const st = objPlanMonthState(m, e, p, now,
                                       Boolean((autoAll[p] || {})[m.auto]),
                                       ms ? ms.fraction : 0);
          /*
            EVERY MONTH"S NOTE, not only the one on screen.

            A milestone"s six squares are its monitoring periods, and
            double-clicking any of them has to show what was written
            against it. Fetching that month on its own would be a round
            trip per square on a page already too slow; six notes on
            twenty-nine milestones is a few kilobytes.
          */
          return {
            period: p,
            state: st.state,
            at: st.at,
            // What the portal counted that month, for the tooltip. The
            // colour alone cannot say "0 of 85"; this can.
            says: ms ? objCountedSays(m, autoAll[p] || {}, ms) : '',
            note: (e && e.notes && e.notes['0']) || null
          };
        });
        return {
          id: m.id, rowId: m.rowId, category: m.category, weight: m.weight,
          objective: m.objective, milestone: m.milestone,
          countType: m.countType, target: s.target, per: m.per,
          auto: m.auto,
          value: s.value, fraction: s.fraction,
          // Whether a figure has been typed for the month on screen,
          // which is a different question from whether it was marked.
          recorded: Boolean(entry && entry.value !== null &&
                            entry.value !== undefined),
          status: entry ? entry.status : '',
          note: entry ? entry.note : '',
          by: entry ? entry.by : '',
          at: entry ? entry.at : 0,
          /*
            AS MANY AS THE TIMELINE DRAWS, which is eight. The row keeps
            twenty so a correction is never lost, but the other twelve
            were being sent for all twenty-nine milestones on every load
            and shown on none of them.
          */
          history: entry
            ? entry.history.slice(0, OBJ_HISTORY_SHOWN).map(function (h) {
                // What the timeline prints, and not the marks string it
                // also keeps - twenty-six characters a line for nobody.
                return { at: h.at, by: h.by, value: h.value,
                         status: h.status, note: h.note };
              })
            : [],
          months: months
        };
      })
    };
  });

  // ---- the ninety, with this month's marks on each ----
  const list = tasks.tasks.map(function (t) {
    const entry = log.byKey[objLogKey(want, OBJ_KIND_TASK, t.id)];
    const state = objTaskState(t, entry ? entry.marks : '', want, now,
                               entry ? entry.markedAt : null);
    return {
      /*
        WHAT THE PAGE DRAWS, and nothing else. Measurement, Remarks and
        Responsible Person are real columns of the sheet that no part of
        this screen puts on screen - three hundred bytes an objective,
        ninety times over, serialised twice on the way out for nobody.
      */
      id: t.id, category: t.category, name: t.name, group: t.group,
      area: t.area, kpi: t.kpi, description: t.description,
      target: t.target, frequency: t.frequency,
      marks: state.marks, slots: state.slots, elapsed: state.elapsed,
      done: state.done, missed: state.missed, silent: state.silent,
      marked: state.marked, late: state.late,
      // See objStateChars: the colours, one character each.
      states: objStateChars(state.cells), times: objCellTimes(state.cells),
      open: state.open, onSchedule: state.onSchedule, due: state.due,
      dueIn: objDueIn(t, want),
      mine: objMayTick(me, t),
      // One per period that counts, keyed by slot. See parseObjNotes.
      notes: entry ? entry.notes : {},
      // The month note, from before notes were kept per period. Shown
      // under the grid where a row has one; never written any more.
      note: entry ? entry.note : '',
      by: entry ? entry.by : '',
      at: entry ? entry.at : 0
    };
  });

  return {
    period: want,
    periods: periods,
    periodLabel: CONFIG.OBJECTIVE.PERIOD_LABEL,
    monthIndex: periods.indexOf(want),
    /*
      The month it actually is, which is NOT the same question as which
      month is being looked at. The page needs both: `period` to draw, and
      this to know that there is nothing yet to record against February.
      Worked out here because the browser's clock is the user's and can be
      anything at all.
    */
    current: current,
    closed: want < current,

    /*
      THE MONTH AS A CALENDAR, so a daily objective can be shown by date.

      It used to draw one cell per WORKING day - twenty-two of them, with a
      line underneath explaining that Friday and Saturday were not counted.
      That is a true sentence about a grid nobody could check, because the
      numbers in it were working-day ordinals, not dates: the eighth cell
      was the 11th.

      Now the page draws all thirty days and greys the ones that do not
      count. The STORED form has not changed - a mark still belongs to a
      working day, and `work` is what maps one to the other - so nothing
      recorded before this needs migrating.
    */
    days: { count: objDaysInMonth(want), work: objWorkingDays(want) },
    plan: { rows: rows, weight: plan.weight, filled: plan.filled,
            count: plan.plan.length },
    tasks: { list: list, count: tasks.count, groups: tasks.groups,
             filled: tasks.filled },
    unique: auto.UNIQUE_ROLES || null,
    score: objScore(plan, log, want, { auto: auto }),
    me: { id: me.id, name: me.name, admin: me.admin, planner: me.planner,
          groups: me.groups, all: me.all, reason: me.reason }
  };
}


/**
 * Writes a log row, keeping the last few versions of it beside it.
 *
 * The row is updated in place rather than appended to, so the tab stays one
 * row per objective per month; the version it replaces is pushed onto the
 * History column first, which is what the Updates timeline is drawn from.
 * Correcting a number therefore does not erase the number it corrected.
 */
function objWriteLog(period, kind, ref, fields, who) {
  /*
    ONE WRITER AT A TIME.

    This is find-the-row-then-write-it, and the page now sends ticks
    concurrently on purpose - pressing five days in a row fires five
    calls without waiting. Two of those landing together both find no
    row and both append one, and from then on the key has two rows and
    every later save goes into whichever one the reader does not use.
    That is how a month of recording disappears.

    Thirty seconds is far longer than this ever needs; a tick is one
    read and one write. If the lock cannot be had at all the write is
    refused out loud, because the alternative is writing anyway and
    producing exactly the duplicate this is here to prevent.
  */
  let lock = null;
  try {
    lock = LockService.getScriptLock();
    lock.waitLock(30000);
  } catch (e) {
    throw new Error('Somebody else is recording against the objectives ' +
                    'right now. Press it again in a moment.');
  }
  try {
    return objWriteLogLocked(period, kind, ref, fields, who);
  } finally {
    try { lock.releaseLock(); } catch (e) { /* already gone */ }
  }
}


function objWriteLogLocked(period, kind, ref, fields, who) {
  const sheet = objLogTab();
  const row = objLogRowOf(sheet, period, kind, ref);
  const now = new Date();

  let history = [];
  let marks = '';
  let value = '';
  let status = '';
  let note = '';
  let markedAt = {};
  let notes = {};

  if (row !== -1) {
    const had = sheet.getRange(row, 1, 1, OBJ_LOG_COLUMNS.length).getValues()[0];
    marks = String(had[3] || '');
    value = had[4];
    status = String(had[5] || '');
    note = String(had[6] || '');
    history = parseObjHistory(had[10]);
    markedAt = parseObjMarked(had[11]);
    notes = parseObjNotes(had[12]);

    const at = objDate(had[9]);
    if (at) {
      const entry = {
        at: at.getTime(),
        by: String(had[7] || ''),
        byId: String(had[8] || ''),
        value: (value === '' || value === null || value === undefined)
          ? null : Number(value),
        status: status,
        note: note,
        marks: marks
      };
      /*
        WHAT A NOTE SAID BEFORE IT WAS EDITED, and only that.

        The timeline cannot carry the whole Notes column - twenty versions
        of twenty-six notes is several times what a cell holds - so an edit
        leaves behind the one note it replaced, cut to a couple of lines.
        That is enough to answer "what did it say before", which is the
        only question anybody asks of an edited note, and it is bounded by
        the number of versions rather than by the number of notes.
      */
      if (fields.noteSlot !== undefined) {
        const was = notes[String(fields.noteSlot)];
        entry.noteSlot = Number(fields.noteSlot);
        entry.noteWas = was ? String(was.t).slice(0, 240) : '';
      }
      history.unshift(entry);
    }
    history = history.slice(0, CONFIG.OBJECTIVE.HISTORY_KEPT || 20);
  }

  const next = [
    period, kind, ref,
    fields.marks !== undefined ? fields.marks : marks,
    fields.value !== undefined ? fields.value : value,
    fields.status !== undefined ? fields.status : status,
    fields.note !== undefined ? fields.note : note,
    who.name, who.id, now,
    JSON.stringify(history),
    JSON.stringify(fields.markedAt !== undefined ? fields.markedAt : markedAt),
    objNotesText(fields.notes !== undefined ? fields.notes : notes)
  ];

  if (row === -1) {
    sheet.appendRow(next);
  } else {
    sheet.getRange(row, 1, 1, OBJ_LOG_COLUMNS.length).setValues([next]);
  }

  return { at: now.getTime(), by: who.name, history: history };
}


/**
 * Records a SMART milestone for a month.
 *
 * Section heads, the department head and admins. Not everybody, because
 * these twenty-nine are what the department is scored on - see the file
 * header.
 */
function recordObjMilestone(token, milestoneId, period, update) {
  requireSignedIn(token);

  const me = objWhoAmI(token);
  if (!me.planner) {
    throw new Error('Recording against the SMART objective is for section ' +
                    'heads and the department head. You can still tick the ' +
                    'unique-role objectives for your own module.');
  }

  const periods = objPeriods();
  const p = String(period || '').trim();
  if (periods.indexOf(p) === -1) {
    throw new Error('That month is outside the objective period (' +
                    CONFIG.OBJECTIVE.PERIOD_LABEL + ').');
  }

  const plan = readObjPlan();
  let milestone = null;
  plan.plan.forEach(function (m) {
    if (m.id === String(milestoneId || '').trim()) milestone = m;
  });
  if (!milestone) throw new Error('There is no milestone with that id.');

  if (milestone.auto === 'UNIQUE_ROLES') {
    throw new Error('That milestone is counted from the ninety unique-role ' +
                    'objectives and is not recorded by hand. Tick those and ' +
                    'this moves with them.');
  }

  const u = update || {};
  const fields = {};

  if (u.value !== undefined && u.value !== null && u.value !== '') {
    const v = Number(u.value);
    if (!(v >= 0)) throw new Error('That is not a number this can record.');
    if (milestone.countType === 'PERCENT' && v > 100) {
      throw new Error('A percentage cannot be more than 100.');
    }
    fields.value = v;
  }

  /*
    THE FIGURE ONLY. THE MARK IS THE SQUARE.

    This used to set the mark as well, on the grounds that typing a
    figure is reviewing the month. It made the square impossible to take
    back: press it to clear November, save the figure for any reason,
    and November was marked again - which is exactly what "I unclick it
    and it does not save" looks like from the outside.

    They are two claims and they are allowed to disagree. "We completed
    two RCAs" is what was achieved; "somebody reviewed this in November"
    is the monitoring, and only the square says that.
  */
  const written = objWriteLog(p, OBJ_KIND_PLAN, milestone.id, fields,
                              { name: me.name, id: me.id });
  return { ok: true, at: written.at, by: written.by };
}


/**
 * Marks one slot of one unique-role objective.
 *
 * The slot is an index into the month's Marks string, which the page already
 * holds - so a daily objective ticked on the 8th sends the index of the 8th
 * working day and not the date. The server recomputes the string's length
 * from the frequency before writing, so a page holding a stale idea of how
 * long the month is cannot write past the end of it.
 */
function tickObjTask(token, taskId, period, slot, mark) {
  requireSignedIn(token);

  const me = objWhoAmI(token);
  const periods = objPeriods();
  const p = String(period || '').trim();
  if (periods.indexOf(p) === -1) {
    throw new Error('That month is outside the objective period (' +
                    CONFIG.OBJECTIVE.PERIOD_LABEL + ').');
  }

  const all = readObjTask();
  let task = null;
  all.tasks.forEach(function (t) {
    if (t.id === String(taskId || '').trim()) task = t;
  });
  if (!task) throw new Error('There is no objective with that id.');

  if (task.kpi) {
    throw new Error('That one is a KPI. Its figure comes from the KPI ' +
                    'engine and is not ticked by hand.');
  }

  if (!objMayTick(me, task)) {
    throw new Error(me.reason ||
      ('That objective belongs to the ' + task.group + ' module. You can ' +
       'tick the ones for your own module.'));
  }

  const slots = objSlotCount(p, task.frequency);
  const i = Number(slot);
  if (!(i >= 0) || i >= slots) {
    throw new Error('There is no slot ' + slot + ' in ' + p + ' for a ' +
                    task.frequency.toLowerCase() + ' objective.');
  }

  const log = readObjLog();
  const had = log.byKey[objLogKey(p, OBJ_KIND_TASK, task.id)];
  const marks = objMarksSet(objMarksRead(had ? had.marks : '', slots), i, mark);

  /*
    WHEN, as well as whether.

    The time is what tells a square marked on its own day from one caught
    up on afterwards - green from yellow - so it is recorded at the moment
    the mark is made and cleared when the mark is cleared. Unmarking and
    marking again therefore resets the clock, which is correct: it is a
    fresh claim about when the work was recorded.
  */
  const markedAt = {};
  const hadTimes = (had && had.markedAt) || {};
  Object.keys(hadTimes).forEach(function (k) { markedAt[k] = hadTimes[k]; });
  if (marks.charAt(i) === OBJ_DONE) {
    markedAt[String(i)] = new Date().getTime();
  } else {
    delete markedAt[String(i)];
  }

  // A mark is a mark. Notes go through saveObjSlotNote, which keeps one per
  // period rather than one per month - see the comment on OBJ_LOG_COLUMNS.
  const fields = { marks: marks, markedAt: markedAt };
  objWriteLog(p, OBJ_KIND_TASK, task.id, fields, { name: me.name, id: me.id });

  /*
    EVERYTHING THE PAGE NEEDS TO REDRAW THAT ONE ROW, and nothing else.

    A tick used to be followed by a full getObjectives - six tab reads and
    the whole ninety scored again - to show one square changing colour. On
    this connection that is two round trips of several seconds for one
    press, which is why pressing two buttons in a row looked like the
    second one did nothing.

    The page now patches the row it pressed from this, and works the strip
    and the counters out from it locally.
  */
  const state = objTaskState(task, marks, p, new Date(), markedAt);
  return {
    ok: true,
    id: task.id,
    marks: state.marks, slots: state.slots, elapsed: state.elapsed,
    done: state.done, missed: state.missed, silent: state.silent,
    marked: state.marked, late: state.late,
    states: objStateChars(state.cells), times: objCellTimes(state.cells),
    open: state.open, onSchedule: state.onSchedule, due: state.due,
    by: me.name, at: new Date().getTime()
  };
}


/**
 * Marks, or unmarks, one month of one SMART milestone.
 *
 * THE SAME PRESS THE NINETY HAVE. A milestone is monitored once a month,
 * so a month is its square, and pressing it means exactly what pressing a
 * day means on the other sheet: somebody looked at this, this month. Press
 * again and the mark comes off. A month that ends unmarked goes red on its
 * own, and a mark made after the month closed is yellow with the date it
 * was made - all of that from objTaskState, so the two sheets cannot drift
 * into meaning different things by the same colour.
 *
 * THE FIGURE AND THE MARK ARE DIFFERENT CLAIMS, and this is the call that
 * makes that true. "We completed two RCAs" is the achievement and is typed;
 * "somebody reviewed this in November" is the monitoring and is pressed.
 * Recording a figure also marks the month, because typing it IS reviewing
 * it - but un-ticking afterwards clears the square and leaves the figure,
 * which is the only way a square can be taken back at all.
 *
 * Section heads, the department head and admins, like recording: these
 * twenty-nine are what the department is scored on.
 */
function tickObjMilestone(token, milestoneId, period, mark) {
  requireSignedIn(token);

  const me = objWhoAmI(token);
  if (!me.planner) {
    throw new Error('Marking the SMART objective is for section heads and ' +
                    'the department head. You can tick the unique-role ' +
                    'objectives for your own module.');
  }

  const periods = objPeriods();
  const p = String(period || '').trim();
  if (periods.indexOf(p) === -1) {
    throw new Error('That month is outside the objective period (' +
                    CONFIG.OBJECTIVE.PERIOD_LABEL + ').');
  }

  const plan = objCached('obj.plan', 600, readObjPlan);
  let milestone = null;
  plan.plan.forEach(function (m) {
    if (m.id === String(milestoneId || '').trim()) milestone = m;
  });
  if (!milestone) throw new Error('There is no milestone with that id.');

  if (milestone.auto) {
    throw new Error('That milestone is counted by the portal itself, so ' +
                    'there is nothing to tick. It moves when the thing it ' +
                    'counts moves.');
  }

  const log = readObjLog();
  const had = log.byKey[objLogKey(p, OBJ_KIND_PLAN, milestone.id)];
  const marks = (mark === OBJ_DONE) ? OBJ_DONE : OBJ_PENDING;

  // When, as well as whether - it is what tells green from yellow. Clearing
  // the mark clears the time with it, so marking again is a fresh claim.
  const markedAt = {};
  if (marks === OBJ_DONE) markedAt['0'] = new Date().getTime();

  objWriteLog(p, OBJ_KIND_PLAN, milestone.id,
              { marks: marks, markedAt: markedAt },
              { name: me.name, id: me.id });

  const state = objPlanMonthState(milestone,
    { marks: marks, markedAt: markedAt }, p, new Date(), false);

  return { ok: true, id: milestone.id, period: p, marks: marks,
           state: state.state, at: state.at, by: me.name };
}


/**
 * Saves the note on ONE PERIOD of one objective - one day, one week, one
 * month, one quarter - on either sheet.
 *
 * ONE NOTE PER MONTH WAS THE WRONG UNIT. A daily objective has twenty-six
 * squares in November and a single box underneath; the note that explains
 * why the 3rd is red had to share it with the note about the 19th, and
 * whoever wrote the second one had to decide whether to delete the first.
 * The unit of a note is the unit of the thing it explains.
 *
 * Separate from tickObjTask and recordObjMilestone because a note is not a
 * mark. Somebody who could not record a day writes down why - that is most
 * of what this is for - and a note that could only be saved by also
 * pressing something is a note nobody writes.
 *
 * Writing one needs the same permission as recording the thing it is
 * about: a note on somebody else"s module is the same intrusion as a mark
 * on it, and a note against the SMART objective is as much a claim about
 * the department as a number is. READING one needs nothing beyond being
 * signed in - the whole point is that the reason a square is red should be
 * visible to whoever is looking at it.
 *
 * An empty note deletes the note. There is no separate delete, because the
 * only sensible way to take back something you wrote is to clear the box
 * it is in.
 */
function saveObjSlotNote(token, kind, refId, period, slot, note) {
  requireSignedIn(token);

  const me = objWhoAmI(token);
  const p = String(period || '').trim();
  if (objPeriods().indexOf(p) === -1) {
    throw new Error('That month is outside the objective period (' +
                    CONFIG.OBJECTIVE.PERIOD_LABEL + ').');
  }

  const k = String(kind || '').trim().toUpperCase();
  const ref = String(refId || '').trim();
  const i = Number(slot);
  let slots;

  if (k === OBJ_KIND_PLAN) {
    if (!me.planner) {
      throw new Error('Notes on the SMART objective are for section heads ' +
                      'and the department head. You can write them on the ' +
                      'unique-role objectives for your own module.');
    }
    const plan = objCached('obj.plan', 600, readObjPlan);
    let milestone = null;
    plan.plan.forEach(function (m) { if (m.id === ref) milestone = m; });
    if (!milestone) throw new Error('There is no milestone with that id.');
    // A milestone is recorded once a month, so its month is its one slot.
    slots = 1;
  } else if (k === OBJ_KIND_TASK) {
    const all = objCached('obj.task', 600, readObjTask);
    let task = null;
    all.tasks.forEach(function (t) { if (t.id === ref) task = t; });
    if (!task) throw new Error('There is no objective with that id.');
    if (!objMayTick(me, task)) {
      throw new Error(me.reason ||
        ('That objective belongs to the ' + task.group + ' module. You can ' +
         'write notes on the ones for your own module.'));
    }
    slots = objSlotCount(p, task.frequency);
  } else {
    throw new Error('That is not something notes are kept against.');
  }

  if (!(i >= 0) || i >= slots) {
    throw new Error('There is no such period in ' + p + ' to write against.');
  }

  const max = CONFIG.OBJECTIVE.NOTE_MAX || 1000;
  const text = String(note === null || note === undefined ? '' : note).trim();
  if (text.length > max) {
    throw new Error('That note is too long - ' + max + ' characters at ' +
                    'most, and this one is ' + text.length + '.');
  }

  const log = readObjLog();
  const had = log.byKey[objLogKey(p, k, ref)];
  const notes = {};
  const hadNotes = (had && had.notes) || {};
  Object.keys(hadNotes).forEach(function (key) { notes[key] = hadNotes[key]; });

  const key = String(i);
  const before = notes[key];
  const at = new Date().getTime();

  if (!text) {
    delete notes[key];
  } else {
    notes[key] = {
      t: text,
      by: me.name,
      id: me.id,
      at: at,
      // WHEN IT WAS FIRST WRITTEN survives an edit. "Saved on the 3rd,
      // edited on the 9th" is a different account of a month from "saved
      // on the 9th", and only the first one is true.
      made: (before && before.made) || at,
      n: ((before && before.n) || 0) + 1
    };
  }

  objWriteLog(p, k, ref, { notes: notes, noteSlot: i },
              { name: me.name, id: me.id });

  return {
    ok: true, kind: k, id: ref, period: p, slot: i,
    note: notes[key] || null
  };
}


/**
 * Adds a milestone to the SMART objective. Admin only.
 *
 * It joins an EXISTING weighted row rather than bringing a weight of its
 * own, because the nine weights are the agreed split of 100 and a page that
 * let somebody add a tenth would quietly make every score on it a fraction
 * of something other than 100. Adding to a row shares that row's weight
 * across one more milestone; the total does not move.
 */
function createObjMilestone(token, draft) {
  requireAdmin(token);

  const d = draft || {};
  const rowId = String(d.rowId || '').trim();
  const milestone = String(d.milestone || '').trim();
  const objective = String(d.objective || '').trim();

  if (!rowId) throw new Error('Pick which category it belongs to.');
  if (!milestone) throw new Error('A milestone needs its measure - what has to happen.');
  if (milestone.length > 2000) throw new Error('That milestone is too long.');
  if (objective.length > 2000) throw new Error('That objective is too long.');

  const plan = readObjPlan();
  let row = null;
  plan.rows.forEach(function (r) { if (r.rowId === rowId) row = r; });
  if (!row) throw new Error('There is no category with the id ' + rowId + '.');

  const countType = String(d.countType || 'NUMBER').trim().toUpperCase();
  if (['NUMBER', 'PERCENT', 'DONE'].indexOf(countType) === -1) {
    throw new Error('Say whether it is counted as a number, a percentage, ' +
                    'or done and not done.');
  }

  const per = String(d.per || 'MONTH').trim().toUpperCase();
  if (['MONTH', 'PERIOD', 'QUARTER'].indexOf(per) === -1) {
    throw new Error('Say whether the target is per month, per quarter, or ' +
                    'for the whole period.');
  }

  let target = Number(d.target);
  if (countType === 'DONE') target = 1;
  if (countType === 'PERCENT' && !target) target = 100;
  if (!(target > 0)) throw new Error('That target is not a number.');

  // The next id in sequence, from what is there rather than from the count -
  // a deleted row would otherwise hand a new milestone an id that is already
  // on the sheet.
  let highest = 0;
  plan.plan.forEach(function (m) {
    const n = Number(String(m.id).replace(/[^0-9]/g, ''));
    if (n > highest) highest = n;
  });
  const id = 'OBJ-' + ('00' + (highest + 1)).slice(-3);

  objPlanTab().appendRow([
    id, rowId, row.category, row.weight, objective, milestone,
    String(d.outcome || '').trim(), countType, target, per,
    String(d.owner || 'EAS Team').trim(), ''
  ]);

  // The plan is cached, and a page that adds a milestone and then cannot
  // see it for ten minutes looks exactly like a page that did not add it.
  objForget();

  return { ok: true, id: id, rowId: rowId, category: row.category,
           weight: row.weight, sharedAcross: row.milestones.length + 1 };
}


// ---------------------------------------------------------------------------
// RUN FROM THE EDITOR
// ---------------------------------------------------------------------------

/**
 * Creates the OBJ_LOG tab, and says what the other two still need.
 *
 * Only the log is created. OBJ_PLAN and OBJ_TASK are pasted from the
 * objective workbook, and a tool that made them empty with the right
 * headers would look exactly like a tool that had filled them in.
 */
/** How many keys are on more than one row, and how many rows that is. */
function objLogDuplicates() {
  const sheet = objLogTab();
  const last = sheet.getLastRow();
  if (last < 2) return { keys: 0, extra: 0 };

  const rows = sheet.getRange(2, 1, last - 1, 3).getValues();
  const seen = {};
  let keys = 0, extra = 0;
  rows.forEach(function (r) {
    if (!r[0] || !r[1] || !r[2]) return;
    const key = objLogKey(r[0], r[1], r[2]);
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] === 2) keys++;
    if (seen[key] > 1) extra++;
  });
  return { keys: keys, extra: extra };
}


/**
 * Folds duplicate rows in OBJ_LOG, keeping everything that was written
 * into any of them. Run from the editor; prints what it did.
 *
 * WHY THERE ARE DUPLICATES AT ALL, and why they are worth recovering
 * rather than deleting.
 *
 * readObjLog overwrites as it walks, so where a key appears twice the
 * page reads the LAST row. The writer used to take the FIRST. Every save
 * after the duplicate appeared therefore went into a row nobody reads -
 * and the marks, notes and figures in it are still sitting there, out of
 * sight. Somebody has been recording a month into a row the page will
 * never show them.
 *
 * So this MERGES rather than discards: a slot marked in any row is
 * marked, the newest note for a slot wins, and the figure, status and
 * timeline come from whichever row was written last. Then the extra rows
 * go, because a shadowed row is the thing that caused this.
 *
 * Safe to run twice: with no duplicates it changes nothing and says so.
 */
function repairObjLog() {
  const sheet = objLogTab();
  const last = sheet.getLastRow();
  if (last < 2) {
    Logger.log('%s is empty - nothing to repair.', CONFIG.SHEETS.OBJ_LOG);
    return;
  }

  const width = OBJ_LOG_COLUMNS.length;
  const raw = sheet.getRange(2, 1, last - 1, width).getValues();
  const order = [];
  const groups = {};

  raw.forEach(function (r, i) {
    const key = objLogKey(r[0], r[1], r[2]);
    if (!r[0] || !r[1] || !r[2]) return;       // a blank row is not a row
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push({ row: i + 2, cells: r });
  });

  const doubled = order.filter(function (k) { return groups[k].length > 1; });
  if (!doubled.length) {
    Logger.log('%s: %s row(s), no duplicates. Nothing to do.',
               CONFIG.SHEETS.OBJ_LOG, raw.length);
    return;
  }

  Logger.log('%s: %s row(s), %s key(s) appearing more than once.',
             CONFIG.SHEETS.OBJ_LOG, raw.length, doubled.length);
  Logger.log('');

  const drop = [];
  let recovered = 0;

  doubled.forEach(function (key) {
    const rows = groups[key];
    const keep = rows[rows.length - 1];        // the one the page reads
    const merged = keep.cells.slice();

    // MARKS: a slot marked in any of them is marked. The length is
    // whichever row knew the most about the month.
    let marks = '';
    rows.forEach(function (r) {
      const s2 = String(r.cells[3] || '');
      if (s2.length > marks.length) marks = marks + objMarksBlank(s2.length - marks.length);
      for (let i = 0; i < s2.length; i++) {
        if (s2.charAt(i) === OBJ_DONE) marks = objMarksSet(marks, i, OBJ_DONE);
        else if (s2.charAt(i) === OBJ_MISSED && marks.charAt(i) === OBJ_PENDING) {
          marks = objMarksSet(marks, i, OBJ_MISSED);
        }
      }
    });

    const when = {};
    const notes = {};
    rows.forEach(function (r) {
      const at = parseObjMarked(r.cells[11]);
      Object.keys(at).forEach(function (k) {
        if (!when[k] || at[k] < when[k]) when[k] = at[k];   // the first claim
      });
      const got = parseObjNotes(r.cells[12]);
      Object.keys(got).forEach(function (k) {
        if (!notes[k] || got[k].at > notes[k].at) notes[k] = got[k];
      });
    });

    // The figure, status and note come from the row written last, which
    // is the one that was on screen.
    let newest = rows[0];
    rows.forEach(function (r) {
      const a = objDate(r.cells[9]);
      const b = objDate(newest.cells[9]);
      if (a && (!b || a.getTime() >= b.getTime())) newest = r;
    });
    merged[3] = marks;
    merged[4] = newest.cells[4];
    merged[5] = newest.cells[5];
    merged[6] = newest.cells[6];
    merged[7] = newest.cells[7];
    merged[8] = newest.cells[8];
    merged[9] = newest.cells[9];

    let history = [];
    rows.forEach(function (r) {
      history = history.concat(parseObjHistory(r.cells[10]));
    });
    history.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    merged[10] = JSON.stringify(
      history.slice(0, CONFIG.OBJECTIVE.HISTORY_KEPT || 20));
    merged[11] = JSON.stringify(when);
    merged[12] = JSON.stringify(notes);

    const was = objMarksCount(String(keep.cells[3] || ''), OBJ_DONE);
    const now = objMarksCount(marks, OBJ_DONE);
    if (now > was) recovered += now - was;

    Logger.log('%s  %s rows -> 1   marks %s -> %s, notes %s',
               key, rows.length, was, now, Object.keys(notes).length);

    sheet.getRange(keep.row, 1, 1, width).setValues([merged]);
    rows.forEach(function (r) { if (r.row !== keep.row) drop.push(r.row); });
  });

  // Bottom up, so the rows above keep the numbers they were found at.
  drop.sort(function (a, b) { return b - a; });
  drop.forEach(function (r) { sheet.deleteRow(r); });
  objForget();

  Logger.log('');
  Logger.log('%s duplicate row(s) removed.', drop.length);
  if (recovered) {
    Logger.log('%s mark(s) recovered from rows the page could not read.',
               recovered);
  }
  Logger.log('Reload the Objectives page to see it.');
}


function setupObjectiveTabs() {
  const log = objLogTab();
  Logger.log('Tab "%s" is ready, with %s columns. The page writes it; ' +
             'nothing is typed in.', log.getName(), OBJ_LOG_COLUMNS.length);
  Logger.log('');

  const plan = readObjPlan();
  const tasks = readObjTask();

  Logger.log('%s  %s milestone(s), weighting %s',
             padTo(CONFIG.SHEETS.OBJ_PLAN, 10), padTo(plan.plan.length, 4),
             plan.weight);
  Logger.log('%s  %s objective(s)',
             padTo(CONFIG.SHEETS.OBJ_TASK, 10), padTo(tasks.count, 4));
  Logger.log('');

  if (!plan.filled) {
    Logger.log('%s is empty. Import OBJ_PLAN.csv into it - File > Import >',
               CONFIG.SHEETS.OBJ_PLAN);
    Logger.log('Upload, and choose "Insert new sheet", then rename the tab.');
  } else if (plan.weight !== 100) {
    Logger.log('WEIGHTING IS %s, NOT 100. Every figure on the page is a share',
               plan.weight);
    Logger.log('of this number, so it should be 100. Check the Weight column:');
    Logger.log('it carries the ROW weight, repeated on each milestone of that');
    Logger.log('row, and each row is counted once.');
  }

  if (!tasks.filled) {
    Logger.log('%s is empty. Copy A1:L91 from the Objective_Unique Roles',
               CONFIG.SHEETS.OBJ_TASK);
    Logger.log('sheet of the workbook and paste it in.');
  }
}


/**
 * What is recorded, and what is not, month by month.
 *
 * The thing worth looking at here is the SILENT column - slots that came and
 * went with nobody saying either way. Those score as misses, which is
 * correct, but a large number of them means the page is not being used
 * rather than that the work is not being done, and those are different
 * problems with different fixes.
 */
function checkObjectives() {
  const plan = readObjPlan();
  const tasks = readObjTask();
  const log = readObjLog();
  const now = new Date();
  const current = objPeriodOf(now);

  if (!plan.filled && !tasks.filled) {
    Logger.log('Neither objective tab has anything in it yet.');
    Logger.log('Run setupObjectiveTabs for what to do about that.');
    return;
  }

  Logger.log('%s - %s milestones, %s unique-role objectives, %s log row(s).',
             CONFIG.OBJECTIVE.PERIOD_LABEL, plan.plan.length, tasks.count,
             log.count);

  /*
    DUPLICATE ROWS, SAID FIRST, because nothing else on this page matters
    while there are any. A key on two rows means the page reads one of
    them and writes the other, so every save appears to work and changes
    nothing anybody can see.
  */
  const dup = objLogDuplicates();
  if (dup.keys) {
    Logger.log('');
    Logger.log('%s KEY(S) ARE ON MORE THAN ONE ROW - %s row(s) too many.',
               dup.keys, dup.extra);
    Logger.log('While that is true, saving against them does nothing you');
    Logger.log('can see: the page reads the last row and writes the one it');
    Logger.log('finds first. Run repairObjLog() to fold them together - it');
    Logger.log('keeps every mark and note from all of them.');
  }
  Logger.log('');
  Logger.log('%s %s %s %s %s', padTo('MONTH', 9), padTo('SCORE', 7),
             padTo('ON SCH.', 9), padTo('SILENT', 8), 'MILESTONES RECORDED');

  // Read once for the whole period rather than once a month - six Drive
  // reads where one does is what turns a check into a slow check.
  const autoAll = objAutoAll(tasks.tasks, log, objPeriods(), now);

  objPeriods().forEach(function (p) {
    if (p > current) return;
    const auto = autoAll[p] || {};
    const scored = objScore(plan, log, p, { auto: auto });
    const unique = auto.UNIQUE_ROLES || { on: 0, total: 0 };

    let silent = 0;
    tasks.tasks.forEach(function (t) {
      const e = log.byKey[objLogKey(p, OBJ_KIND_TASK, t.id)];
      silent += objTaskState(t, e ? e.marks : '', p, now,
                             e ? e.markedAt : null).silent;
    });

    let recorded = 0;
    plan.plan.forEach(function (m) {
      if (log.byKey[objLogKey(p, OBJ_KIND_PLAN, m.id)]) recorded++;
    });

    Logger.log('%s %s %s %s %s', padTo(p, 9),
               padTo(scored.score + '/' + scored.outOf, 7),
               padTo(unique.on + '/' + unique.total, 9),
               padTo(silent, 8),
               recorded + ' of ' + plan.plan.length);
  });

  Logger.log('');
  Logger.log('SILENT is slots that passed with nobody marking them either');
  Logger.log('way. They score as missed, which is right - but a big number');
  Logger.log('here means the page is not being used, not that the work is');
  Logger.log('not being done.');
}
