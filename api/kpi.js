/**
 * kpi.js - KPI 1 arithmetic, Error/Issue Resolution Time.
 * ===========================================================================
 *
 * Ported from src/Kpi.gs and the scoring helpers in src/Config.gs. PURE
 * FUNCTIONS ONLY - nothing here reads a database or an environment. Every
 * one of them is proved identical to the original by kpi-equivalence-test.js,
 * which lifts the real functions out of the .gs files and runs them beside
 * these over tens of thousands of inputs.
 *
 * THE FORMULA, from policy TVL-KPI-001 section 6.3:
 *
 *   Ticket Resolution Success Rate (%) = (Completed Successfully / Total Completed) x 100
 *   KPI Achievement (%)                = (Actual Success Rate / Target Success Rate) x 100
 *
 *   Total Completed        = tickets with a real Completion Date
 *   Completed with Delay   = completed AND Delay Days > 0
 *   Completed Successfully = Total Completed - Completed with Delay
 *
 * Verified in Kpi.gs against the PDF's worked example: 100 completed, 100
 * successful, target 99.50% -> success rate 100%, achievement 100.50%.
 *
 * THE TARGET MOVED ON 1 OCTOBER 2026 and the history is NOT rewritten.
 * Config.gs is explicit: it was 99.50 / 89.55, and TVL-KPI-001 v1.0 sets it
 * to 90.00 / 85.00. "The bands are worked out from these numbers every time
 * a screen is drawn - so every month shown, past and present, is scored
 * against the policy in force today." Months the old figure called YELLOW or
 * RED are GREEN now, deliberately. Nothing is cached that would freeze an
 * old band into place.
 */

// Config.gs KPI.RESOLUTION. The two numbers the bands turn on.
const KPI_RESOLUTION = {
  id: 'KPI1',
  name: 'Error/Issue Resolution Time',
  shortName: 'Resolution Time',
  measure: 'Ticket Resolution Success Rate (%)',
  target: 90.00,        // green at or above this
  yellowFloor: 85.00,   // below this is red
  unit: '%',
  period: 'monthly'
};

// Config.gs QUARTERS. Both KPIs use the calendar year today; the indirection
// stays because a company year starting in April is a one-line change there
// and an assumption buried in four places otherwise.
const QUARTERS = {
  RESOLUTION: { startMonth: 1, yearFrom: 'start' },
  FEEDBACK:   { startMonth: 1, yearFrom: 'start' }
};

const ALL_MONTHS = 'ALL';          // Kpi.gs:322


// ---------------------------------------------------------------------------
// Reading a cell
// ---------------------------------------------------------------------------

/**
 * Is this ticket completed?   [Kpi.gs:245]
 *
 * NOT AS SIMPLE AS "IS THE CELL NON-EMPTY". Two rows in the August export
 * carry a Completion Date consisting of nothing but whitespace. The ITSM
 * counts those as incomplete - they are the "1 incomplete" showing against
 * Account and CO on its own report. Treating them as complete throws the
 * figure off by one, and one ticket is the entire margin this KPI runs on.
 */
function isCompleted(value) {
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return true;
  return String(value).trim() !== '';
}

/**
 * Reads a number that might be a number, a float, or text.   [Kpi.gs:259]
 *
 * Delay Days arrives as int 0 in one export and float 0.0 in another, and
 * once a value has been through a spreadsheet it can come back as a string.
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const parsed = parseFloat(String(value).trim());
  return isNaN(parsed) ? 0 : parsed;
}

/** Rounds to two decimals without floating-point noise.   [Kpi.gs:1161] */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}


// ---------------------------------------------------------------------------
// Bands
// ---------------------------------------------------------------------------

/** GREEN at or above target, YELLOW down to the floor, RED below. */
function bandFor(rate, kpi) {
  if (rate >= kpi.target) return 'GREEN';
  if (rate >= kpi.yellowFloor) return 'YELLOW';
  return 'RED';
}

/** KPI Achievement (%) = (Actual / Target) x 100.   [Config.gs:2644] */
function achievementFor(rate, kpi) {
  return (rate / kpi.target) * 100;
}

/**
 * How many more delayed tickets before we drop out of green?
 *
 * THIS IS THE NUMBER THE DASHBOARD SHOULD LEAD WITH. In August 2026 the EAS
 * figure was 1 - the department passed by a single ticket. A band alone does
 * not tell you that; headroom does.
 *
 * Green requires successful / completed >= target/100, so the minimum
 * successful count is ceil(target/100 * completed).
 *
 * Positive = spare delays available, 0 = on the edge, negative = already
 * below target.
 */
function headroomFor(completed, successful, kpi) {
  if (!completed) return 0;
  const minimumNeeded = Math.ceil((kpi.target / 100) * completed);
  return successful - minimumNeeded;
}


// ---------------------------------------------------------------------------
// The KPI itself
// ---------------------------------------------------------------------------
/**
 * The actual KPI maths.   [Kpi.gs:203]
 *
 * TAKES THE TWO FIELDS IT READS, NOT A SPREADSHEET ROW. The original indexes
 * into an array with COL.COMPLETION and COL.DELAY_DAYS, which are positions
 * in a 25-column tab. Here the rows come from a query that can name its
 * columns, so passing the row shape through would be carrying a spreadsheet
 * layout into a system that no longer has one. `scoreRows` below adapts
 * whatever shape the caller has; this is the arithmetic.
 *
 * Every field the original returns is returned, including the derived ones.
 */
function scoreTickets(tickets, kpi) {
  let completed = 0;
  let delayed = 0;

  tickets.forEach(function (t) {
    if (!isCompleted(t.completion)) return;
    completed++;
    if (toNumber(t.delayDays) > 0) delayed++;
  });

  const successful = completed - delayed;
  const rate = completed ? (successful / completed) * 100 : 0;

  return {
    received:    tickets.length,
    completed:   completed,
    /*
      STILL OPEN, AND DERIVED RATHER THAN STORED. Every row counted in
      `received` either has a completion date or does not, and `completed`
      is exactly the ones that do - so this subtraction IS the count of
      tickets with a blank Completion Date. Deliberate: nothing has to be
      re-uploaded or recached for it to appear, and it cannot drift away
      from the two numbers it sits between.
    */
    open:        tickets.length - completed,
    delayed:     delayed,
    successful:  successful,
    rate:        rate,
    achievement: completed ? achievementFor(rate, kpi) : 0,
    band:        completed ? bandFor(rate, kpi) : 'NO DATA',
    headroom:    headroomFor(completed, successful, kpi)
  };
}

/**
 * The same, for callers holding rows in the spreadsheet's own shape.
 *
 * Kept so the equivalence test can drive the port with exactly the arrays it
 * drives Kpi.gs with, and so an importer reading the TICKETS tab has one
 * obvious way in.
 */
function scoreRows(rows, kpi, col) {
  const at = col || { COMPLETION: 15, DELAY_DAYS: 17 };
  return scoreTickets(rows.map(function (row) {
    return { completion: row[at.COMPLETION], delayDays: row[at.DELAY_DAYS] };
  }), kpi);
}


// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------
/**
 * Groups by whatever a function returns, biggest bucket first.  [Kpi.gs:283]
 *
 * A ticket's section is not a value sitting in a cell - it is derived from
 * who handled it and when - so the key is a function rather than a column.
 *
 * AN EMPTY KEY BECOMES '(unassigned)' rather than being dropped. A ticket
 * nobody can place is still a ticket the department was sent, and silently
 * losing it would make the totals disagree with the ITSM's own report.
 */
function groupByKey(rows, keyOf) {
  const buckets = {};
  rows.forEach(function (row) {
    const key = String(keyOf(row) || '').trim() || '(unassigned)';
    (buckets[key] = buckets[key] || []).push(row);
  });
  return Object.keys(buckets)
    .map(function (key) { return { key: key, rows: buckets[key] }; })
    .sort(function (a, b) { return b.rows.length - a.rows.length; });
}

/** Groups rows by one column, largest group first.   [Kpi.gs:268] */
function groupBy(rows, columnIndex) {
  return groupByKey(rows, function (row) { return row[columnIndex]; });
}


// ---------------------------------------------------------------------------
// Months and quarters
// ---------------------------------------------------------------------------

/** The quarter rules for a KPI, defaulting to KPI 1's.   [Kpi.gs:374] */
function quarterScheme(scheme) {
  return QUARTERS[scheme || 'RESOLUTION'] || { startMonth: 1, yearFrom: 'start' };
}

/**
 * The three months a quarter covers, oldest first.   [Kpi.gs:392]
 *
 * Driven by the scheme, so a company year that starts in April is described
 * in one place rather than assumed in several. With startMonth 4, '2026-Q4'
 * is January to March of 2027 - the quarter crosses the calendar year, which
 * is the whole reason this is not arithmetic on the month number.
 */
function monthsOfQuarter(key, scheme) {
  const parts = String(key || '').match(/^(\d{4})-Q([1-4])$/);
  if (!parts) return [];

  const rules = quarterScheme(scheme);
  const startMonth = Number(rules.startMonth) || 1;
  const offset = (Number(parts[2]) - 1) * 3;

  let year = Number(parts[1]);
  if (rules.yearFrom === 'end' && startMonth > 1) year -= 1;

  const out = [];
  for (let i = 0; i < 3; i++) {
    const n = startMonth + offset + i;               // 1-based, may exceed 12
    const y = year + Math.floor((n - 1) / 12);
    const m = ((n - 1) % 12) + 1;
    out.push(y + '-' + String(m).padStart(2, '0'));
  }
  return out;
}

/** The quarter a month falls in: '2026-08' -> '2026-Q3'.   [Kpi.gs:421] */
function quarterOf(month, scheme) {
  const parts = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!parts) return '';

  const rules = quarterScheme(scheme);
  const startMonth = Number(rules.startMonth) || 1;
  const year = Number(parts[1]);
  const m = Number(parts[2]);

  // How far into the company year this month sits, 0-11.
  const into = ((m - startMonth) + 12) % 12;
  const q = Math.floor(into / 3) + 1;

  // A month before the start month belongs to the year that began earlier.
  let label = (m >= startMonth) ? year : year - 1;
  if (rules.yearFrom === 'end' && startMonth > 1) label += 1;

  return label + '-Q' + q;
}

/** 'Quarter 1 (2026)'.   [Kpi.gs:448] */
function quarterLabel(key) {
  const parts = String(key || '').match(/^(\d{4})-Q([1-4])$/);
  if (!parts) return String(key || '');
  return 'Quarter ' + parts[2] + ' (' + parts[1] + ')';
}

/**
 * Which months a scope covers.   [Kpi.gs:339]
 *
 *   'ALL'                  every month      -> null
 *   '2026-Q3'              the three months of a company quarter
 *   '2026-08'              one month
 *   '2026-01,2026-08'      several at once
 *
 * NULL MEANS EVERY MONTH, and that is not the same as an empty object, which
 * means no months at all. Callers test for null first.
 *
 * A comma-separated list is "compare January and August without the seven
 * months between them", which neither a single month nor a quarter can
 * express. Each part resolves on its own, so a list may mix months and
 * quarters, and a list containing ALL collapses to every month - because
 * "all of them plus August" is just all of them.
 */
function monthsInScope(scope, scheme) {
  const text = String(scope || '').trim();
  if (!text || text === ALL_MONTHS) return null;

  if (text.indexOf(',') !== -1) {
    const wanted = {};
    const parts = text.split(',');

    for (let i = 0; i < parts.length; i++) {
      const one = monthsInScope(parts[i], scheme);
      if (one === null) return null;                 // ALL was in the list
      Object.keys(one).forEach(function (m) { wanted[m] = true; });
    }
    return wanted;
  }

  const quarter = text.match(/^(\d{4})-Q([1-4])$/);
  if (quarter) {
    const wanted = {};
    monthsOfQuarter(text, scheme).forEach(function (m) { wanted[m] = true; });
    return wanted;
  }

  const single = {};
  single[text] = true;
  return single;
}


module.exports = {
  KPI_RESOLUTION, QUARTERS, ALL_MONTHS,
  isCompleted, toNumber, round2,
  bandFor, achievementFor, headroomFor,
  scoreTickets, scoreRows,
  groupBy, groupByKey,
  quarterScheme, monthsOfQuarter, quarterOf, quarterLabel, monthsInScope
};
