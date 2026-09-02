/**
 * Kpi.gs — the calculation engine for KPI 1, Error/Issue Resolution Time.
 *
 * THE FORMULA (policy TVL-KPI-001 §6.3, confirmed by SAP_Error_Issue_
 * Resolution_Time_KPI_Final.pdf)
 *
 *   Ticket Resolution Success Rate (%) = (Completed Successfully / Total Completed) x 100
 *   KPI Achievement (%)                = (Actual Success Rate / Target Success Rate) x 100
 *
 *   Total Completed        = tickets with a real Completion Date
 *   Completed with Delay   = completed AND Delay Days > 0
 *   Completed Successfully = Total Completed - Completed with Delay
 *
 * Verified against the PDF's worked example: 100 completed, 100 successful,
 * target 99.50% -> success rate 100%, achievement 100.50%. And against the
 * ITSM's own on-screen reports, which reconcile cell for cell.
 *
 * WHAT COUNTS AS "EAS"
 * The union of the four department exports — NOT the overall Service/Part
 * report. That report also contains work done by engineers who belong to no
 * EAS department (9 tickets across 6 people in August 2026). Scoring EAS on it
 * would credit the department with work it did not do. So the KPI counts rows
 * flagged `In Dept Report`.
 *
 * WHY THE RESULTS ARE CACHED
 * Reading and grouping 20,000+ rows takes seconds. Doing that every time
 * someone opens the page would make the dashboard feel broken. Instead the
 * numbers are computed once when data is uploaded, written to KPI_MONTHLY, and
 * read back from there — a couple of dozen rows instead of tens of thousands.
 */


/**
 * Recomputes every month's KPI figures and rewrites the KPI_MONTHLY tab.
 * Called automatically at the end of an upload; safe to run by hand.
 *
 * @return {string[]} the months found, newest first
 */
function recomputeKpiCache() {
  const tickets = sheetFor(CONFIG.SHEETS.TICKETS);
  const lastRow = tickets.getLastRow();

  const cache = sheetFor(CONFIG.SHEETS.KPI_MONTH);
  const cacheLast = cache.getLastRow();
  if (cacheLast > 1) {
    cache.getRange(2, 1, cacheLast - 1, CONFIG.KPI_COLUMNS.length).clearContent();
  }

  if (lastRow < 2) return [];

  const rows = tickets.getRange(2, 1, lastRow - 1, COL.WIDTH).getValues();
  const kpi = CONFIG.KPI.RESOLUTION;
  const computedAt = new Date();
  const out = [];

  // Bucket every row by month first, so each month is scored independently.
  // The policy measures monthly — a rolling all-time figure would hide a bad
  // month behind a good one.
  const byMonth = {};
  rows.forEach(function (row) {
    const id = String(row[COL.TICKET_ID] || '').trim();
    if (!id) return;
    const month = monthKey(row[COL.REQUEST_DATE]);
    if (!month) return;
    (byMonth[month] = byMonth[month] || []).push(row);
  });

  Object.keys(byMonth).sort().forEach(function (month) {
    const all = byMonth[month];

    // The EAS population: rows a department export vouched for.
    const eas = all.filter(function (r) { return truthy(r[COL.IN_DEPT]); });

    out.push(kpiRow(month, 'EAS', 'All departments', eas, kpi, computedAt));

    groupBy(eas, COL.DEPARTMENT).forEach(function (entry) {
      out.push(kpiRow(month, 'DEPARTMENT', entry.key, entry.rows, kpi, computedAt));
    });

    groupBy(eas, COL.IN_CHARGE).forEach(function (entry) {
      out.push(kpiRow(month, 'PERSON', entry.key, entry.rows, kpi, computedAt));
    });

    // Reconciliation between the ITSM's two reports. Not a KPI — a data
    // integrity figure. In August 2026 six tickets sat in a department export
    // and not in the overall one, which is larger than the entire headroom the
    // KPI turns on. It gets surfaced, not swept up.
    let both = 0, deptOnly = 0, overallOnly = 0;
    all.forEach(function (r) {
      const d = truthy(r[COL.IN_DEPT]);
      const o = truthy(r[COL.IN_OVERALL]);
      if (d && o) both++;
      else if (d) deptOnly++;
      else if (o) overallOnly++;
    });
    out.push(countRow(month, 'SOURCE', 'In both reports',       both,        computedAt));
    out.push(countRow(month, 'SOURCE', 'Department only',       deptOnly,    computedAt));
    out.push(countRow(month, 'SOURCE', 'Overall report only',   overallOnly, computedAt));
  });

  if (out.length) {
    cache.getRange(2, 1, out.length, CONFIG.KPI_COLUMNS.length).setValues(out);
  }

  Logger.log('Recomputed %s cache rows across %s month(s).', out.length, Object.keys(byMonth).length);
  return Object.keys(byMonth).sort().reverse();
}


/**
 * Scores one set of rows and shapes it as a KPI_MONTHLY row.
 *
 * @return {Array}
 */
function kpiRow(month, scopeType, scopeValue, rows, kpi, computedAt) {
  const s = scoreRows(rows, kpi);
  return [
    month, scopeType, scopeValue,
    s.received, s.completed, s.delayed, s.successful,
    round2(s.rate), round2(s.achievement), s.band, s.headroom,
    computedAt
  ];
}


/** A plain count row — used for the source reconciliation. */
function countRow(month, scopeType, scopeValue, count, computedAt) {
  return [month, scopeType, scopeValue, count, '', '', '', '', '', '', '', computedAt];
}


/**
 * The actual KPI maths.
 *
 * @param {Array[]} rows
 * @param {Object}  kpi   CONFIG.KPI.RESOLUTION
 * @return {Object}
 */
function scoreRows(rows, kpi) {
  let completed = 0;
  let delayed = 0;

  rows.forEach(function (row) {
    if (!isCompleted(row)) return;
    completed++;
    if (toNumber(row[COL.DELAY_DAYS]) > 0) delayed++;
  });

  const successful = completed - delayed;
  const rate = completed ? (successful / completed) * 100 : 0;

  return {
    received:    rows.length,
    completed:   completed,
    delayed:     delayed,
    successful:  successful,
    rate:        rate,
    achievement: completed ? achievementFor(rate, kpi) : 0,
    band:        completed ? bandFor(rate, kpi) : 'NO DATA',
    headroom:    headroomFor(completed, successful, kpi)
  };
}


/**
 * Is this ticket completed?
 *
 * Not as simple as "is the cell non-empty". Two rows in the August export carry
 * a Completion Date consisting of nothing but whitespace. The ITSM counts those
 * as incomplete — they are the "1 incomplete" showing against Account and CO on
 * its own report. Treating them as complete throws the whole figure off by one,
 * and one ticket is the entire margin this KPI runs on.
 *
 * @param {Array} row
 * @return {boolean}
 */
function isCompleted(row) {
  const value = row[COL.COMPLETION];
  if (value === null || value === undefined) return false;
  if (value instanceof Date) return true;
  return String(value).trim() !== '';
}


/**
 * Reads a number that might be a number, a float, or text.
 *
 * Delay Days arrives as int 0 in one export and float 0.0 in another, and once
 * a value has been through a spreadsheet it can come back as a string. All of
 * them have to compare correctly against zero.
 *
 * @param {*} value
 * @return {number}
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const parsed = parseFloat(String(value).trim());
  return isNaN(parsed) ? 0 : parsed;
}


/**
 * Groups rows by the value in one column, largest group first.
 *
 * @return {Object[]} [{ key, rows }]
 */
function groupBy(rows, columnIndex) {
  const buckets = {};

  rows.forEach(function (row) {
    const key = String(row[columnIndex] || '').trim() || '(unassigned)';
    (buckets[key] = buckets[key] || []).push(row);
  });

  return Object.keys(buckets)
    .map(function (key) { return { key: key, rows: buckets[key] }; })
    .sort(function (a, b) { return b.rows.length - a.rows.length; });
}


/**
 * Everything the KPI 1 screen needs for one month, read from the cache.
 *
 * @param {string} month  'YYYY-MM'
 * @return {Object}
 */
function getKpi1(month) {
  const cache = sheetFor(CONFIG.SHEETS.KPI_MONTH);
  const lastRow = cache.getLastRow();

  const empty = {
    month: month, hasData: false,
    total: null, departments: [], people: [], sources: [],
    target: CONFIG.KPI.RESOLUTION.target,
    yellowFloor: CONFIG.KPI.RESOLUTION.yellowFloor
  };
  if (lastRow < 2) return empty;

  const rows = cache.getRange(2, 1, lastRow - 1, CONFIG.KPI_COLUMNS.length).getValues();

  const result = {
    month: month, hasData: false,
    total: null, departments: [], people: [], sources: [],
    target: CONFIG.KPI.RESOLUTION.target,
    yellowFloor: CONFIG.KPI.RESOLUTION.yellowFloor
  };

  rows.forEach(function (r) {
    if (String(r[0]) !== month) return;

    const scopeType = String(r[1]);
    const entry = {
      name:        String(r[2]),
      received:    Number(r[3]) || 0,
      completed:   Number(r[4]) || 0,
      delayed:     Number(r[5]) || 0,
      successful:  Number(r[6]) || 0,
      rate:        Number(r[7]) || 0,
      achievement: Number(r[8]) || 0,
      band:        String(r[9]),
      headroom:    Number(r[10]) || 0
    };

    if (scopeType === 'EAS')             { result.total = entry; result.hasData = true; }
    else if (scopeType === 'DEPARTMENT') { result.departments.push(entry); }
    else if (scopeType === 'PERSON')     { result.people.push(entry); }
    else if (scopeType === 'SOURCE')     { result.sources.push({ name: entry.name, count: entry.received }); }
  });

  return result;
}


/**
 * Prints the KPI table to the Execution log.
 *
 * Run this from the editor after uploading, to check the numbers without
 * involving the browser at all. If the UI and this disagree, the bug is in the
 * UI; if they agree and both look wrong, the bug is here.
 */
function runKpiSelfTest() {
  const months = recomputeKpiCache();

  if (!months.length) {
    Logger.log('No ticket data loaded yet — upload some files first.');
    return;
  }

  months.forEach(function (month) {
    const k = getKpi1(month);
    if (!k.hasData) return;

    Logger.log('');
    Logger.log('=== %s ===  target %s%%', month, k.target);
    Logger.log('%-30s %7s %7s %7s %9s %9s %8s %6s',
               'Scope', 'Recvd', 'Compl', 'Delay', 'Rate%', 'Ach%', 'Band', 'Head');

    const t = k.total;
    Logger.log('%-30s %7s %7s %7s %9s %9s %8s %6s',
               'EAS (all departments)', t.received, t.completed, t.delayed,
               t.rate, t.achievement, t.band, t.headroom);

    k.departments.forEach(function (d) {
      Logger.log('%-30s %7s %7s %7s %9s %9s %8s %6s',
                 '  ' + d.name, d.received, d.completed, d.delayed,
                 d.rate, d.achievement, d.band, d.headroom);
    });

    Logger.log('  people below target:');
    let flagged = 0;
    k.people.forEach(function (p) {
      if (p.delayed > 0 || p.band !== 'GREEN') {
        Logger.log('    %-28s %7s tickets %5s delayed  %8s%%  %s',
                   p.name, p.received, p.delayed, p.rate, p.band);
        flagged++;
      }
    });
    if (!flagged) Logger.log('    none — every engineer at or above target');

    Logger.log('  source reconciliation:');
    k.sources.forEach(function (s) {
      Logger.log('    %-28s %s', s.name, s.count);
    });
  });
}


/** Rounds to two decimals without floating-point noise. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
