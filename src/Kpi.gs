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
 * target 99.50% -> success rate 100%, achievement 100.50%.
 *
 * WHAT COUNTS AS "EAS" DEPENDS ON WHAT YOU UPLOADED
 * The four department exports are the accurate scope. The overall Service/Part
 * report is wider — it also contains work by engineers who belong to no EAS
 * department (9 tickets across 6 people in August 2026), so scoring EAS on it
 * credits the department with work it did not do.
 *
 * But you may upload only the overall report, or only department files, or
 * both. So the engine scores whichever population it has and records WHICH,
 * rather than silently returning nothing or silently mixing the two.
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

  // Bucket by month first. The policy measures monthly — a rolling all-time
  // figure would let a good month hide a bad one.
  const byMonth = {};
  rows.forEach(function (row) {
    if (!String(row[COL.TICKET_ID] || '').trim()) return;
    const month = monthKey(row[COL.REQUEST_DATE]);
    if (!month) return;
    (byMonth[month] = byMonth[month] || []).push(row);
  });

  Object.keys(byMonth).sort().forEach(function (month) {
    const all = byMonth[month];

    // Prefer the department exports when we have them; fall back to the whole
    // set when only the overall report has been uploaded.
    const deptRows = all.filter(function (r) { return truthy(r[COL.IN_DEPT]); });
    const usingDept = deptRows.length > 0;
    const scored = usingDept ? deptRows : all;

    out.push(basisRow(month, usingDept, scored.length, all.length, computedAt));
    out.push(kpiRow(month, 'EAS', usingDept ? 'EAS (department exports)'
                                            : 'All tickets (overall report)',
                    scored, kpi, computedAt));

    // Department breakdown only makes sense when department files were loaded.
    if (usingDept) {
      // Grouped by the SECTION THE PERSON BELONGED TO THAT MONTH, not by the
      // Department column the upload wrote. See sectionFor() in Config.gs:
      // the column records what a file claimed, the roster decides what is
      // true, and the two differ for a combined export, for the pre-August
      // months, and for the three people whose module role is not their
      // section.
      groupByKey(scored, function (row) {
        return sectionFor(row[COL.IN_CHARGE], month, row[COL.DEPARTMENT]);
      }).forEach(function (entry) {
        out.push(kpiRow(month, 'DEPARTMENT', entry.key, entry.rows, kpi, computedAt));
      });
    }

    // Service/Part is present in both reports, so this always works — and it
    // is how the ITSM's own Performance Report is organised.
    groupBy2(scored, COL.SERVICE, COL.PART).forEach(function (entry) {
      out.push(kpiRow(month, 'PART', entry.key, entry.rows, kpi, computedAt));
    });

    // Each individual is tagged with their department so the screen can filter
    // the individuals table by department without a second lookup.
    groupByKey(scored, function (row) {
      // Group on the matched key, not the raw name, so 'Md. Jafar Ullah' and
      // 'Md.Jafar Ullah' are one person rather than two half-rows.
      return matchPerson(row[COL.IN_CHARGE]) || String(row[COL.IN_CHARGE] || '').trim();
    }).forEach(function (entry) {
      // Display the name as the ITSM wrote it on the first ticket we saw.
      const name = String(entry.rows[0][COL.IN_CHARGE] || '').trim() || '(unassigned)';
      const dept = sectionFor(name, month, entry.rows[0][COL.DEPARTMENT]);
      out.push(kpiRow(month, 'PERSON', (dept ? dept + ' :: ' : '') + name,
                      entry.rows, kpi, computedAt));
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
    out.push(countRow(month, 'SOURCE', 'In both reports',     both,        computedAt));
    out.push(countRow(month, 'SOURCE', 'Department only',     deptOnly,    computedAt));
    out.push(countRow(month, 'SOURCE', 'Overall report only', overallOnly, computedAt));
  });

  if (out.length) {
    // Force the Month column to plain text BEFORE writing. Left alone, Sheets
    // parses '2026-08' into a Date, and every later lookup by month string
    // fails to match. Reads are normalised too (see getKpi1) so data written
    // before this fix still resolves.
    cache.getRange(2, 1, out.length, 1).setNumberFormat('@');
    cache.getRange(2, 1, out.length, CONFIG.KPI_COLUMNS.length).setValues(out);
  }

  Logger.log('Recomputed %s cache rows across %s month(s).',
             out.length, Object.keys(byMonth).length);
  return Object.keys(byMonth).sort().reverse();
}


/** Records which population the month was scored from. */
function basisRow(month, usingDept, scoredCount, totalCount, computedAt) {
  return [
    month, 'BASIS',
    usingDept ? 'DEPARTMENT' : 'OVERALL',
    scoredCount, totalCount, '', '', '', '', '', '', computedAt
  ];
}


/** Scores one set of rows and shapes it as a KPI_MONTHLY row. */
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
 * its own report. Treating them as complete throws the figure off by one, and
 * one ticket is the entire margin this KPI runs on.
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
 * a value has been through a spreadsheet it can come back as a string.
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  const parsed = parseFloat(String(value).trim());
  return isNaN(parsed) ? 0 : parsed;
}


/** Groups rows by one column, largest group first. */
function groupBy(rows, columnIndex) {
  return groupByKey(rows, function (row) { return row[columnIndex]; });
}


/**
 * Groups by whatever a function returns, rather than by a column.
 *
 * Needed because a ticket's section is no longer a value sitting in a cell —
 * it is derived from who handled it and when (see sectionFor in Config.gs).
 *
 * @param {Array[]} rows
 * @param {Function} keyOf  row -> grouping key
 * @return {Array<{key: string, rows: Array[]}>} biggest bucket first
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


/**
 * Groups by two columns joined with a slash — used for Service / Part.
 *
 * Part is scoped to Service: 'e-Accounting' as a Part only exists under the
 * e-Accounting service, so grouping on Part alone would merge unrelated things.
 */
function groupBy2(rows, indexA, indexB) {
  const buckets = {};
  rows.forEach(function (row) {
    const a = String(row[indexA] || '').trim() || '(none)';
    const b = String(row[indexB] || '').trim() || '(none)';
    const key = a + ' / ' + b;
    (buckets[key] = buckets[key] || []).push(row);
  });
  return Object.keys(buckets)
    .map(function (key) { return { key: key, rows: buckets[key] }; })
    .sort(function (a, b) { return b.rows.length - a.rows.length; });
}


/**
 * The month picker's "every month" option.
 *
 * A sentinel rather than an empty string, so an accidental blank never
 * silently turns into "all time" — the two mean very different things when the
 * number ends up in a K-SOX pack.
 */
const ALL_MONTHS = 'ALL';


/**
 * Which months does a scope cover?
 *
 * A scope is one of three shapes:
 *   'ALL'        every month in the cache
 *   '2026-Q3'    the three months of a company quarter
 *   '2026-08'    one month
 *
 * Quarters follow the company calendar: Q1 Jan-Mar, Q2 Apr-Jun, Q3 Jul-Sep,
 * Q4 Oct-Dec.
 *
 * @param {string} scope
 * @return {Object|null} a lookup of wanted months, or null for 'every month'
 */
function monthsInScope(scope) {
  const text = String(scope || '').trim();
  if (!text || text === ALL_MONTHS) return null;

  const quarter = text.match(/^(\d{4})-Q([1-4])$/);
  if (quarter) {
    const year = quarter[1];
    const first = (Number(quarter[2]) - 1) * 3 + 1;
    const wanted = {};
    for (let i = 0; i < 3; i++) {
      wanted[year + '-' + String(first + i).padStart(2, '0')] = true;
    }
    return wanted;
  }

  const single = {};
  single[text] = true;
  return single;
}


/**
 * The quarter a month falls in: '2026-08' -> '2026-Q3'.
 *
 * @param {string} month 'YYYY-MM'
 * @return {string} 'YYYY-Qn', or '' if unreadable
 */
function quarterOf(month) {
  const parts = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!parts) return '';
  return parts[1] + '-Q' + (Math.floor((Number(parts[2]) - 1) / 3) + 1);
}


/**
 * Everything the KPI 1 screen needs, read from the cache.
 *
 * WHY AN ALL-MONTHS FIGURE IS NOT AN AVERAGE
 * Percentages cannot be averaged across periods of different size. January
 * with 4 completed tickets and one delay scores 75%; August with 2,640 and 11
 * scores 99.58%. Their mean is 87.29%, which describes nothing that happened.
 * The true all-time rate is (Σ successful / Σ completed) × 100.
 *
 * So this sums the RAW COUNTS the cache stores beside each rate, then
 * recomputes rate, achievement, band and headroom from those sums. The answer
 * is identical to scoring every ticket in one pass, without re-reading the
 * TICKETS tab.
 *
 * @param {string} month  'YYYY-MM', or ALL_MONTHS for the whole period
 * @return {Object}
 */
function getKpi1(month) {
  const kpi = CONFIG.KPI.RESOLUTION;
  const everyMonth = (month === ALL_MONTHS);

  // null means "take every month"; otherwise a lookup of the ones wanted.
  // One month, a quarter's three, or all of them go down the same path — the
  // summing below does not care how many months it was handed.
  const wanted = monthsInScope(month);

  const result = {
    month: month,
    allMonths: everyMonth,
    monthsCovered: 0,
    hasData: false,
    basis: null,
    total: null,
    departments: [],
    parts: [],
    people: [],
    sources: [],
    target: kpi.target,
    yellowFloor: kpi.yellowFloor
  };

  const cache = sheetFor(CONFIG.SHEETS.KPI_MONTH);
  const lastRow = cache.getLastRow();
  if (lastRow < 2) return result;

  const rows = cache.getRange(2, 1, lastRow - 1, CONFIG.KPI_COLUMNS.length).getValues();

  const buckets = {};        // key -> summed counts
  const order = [];          // keys in first-seen order, so output is stable
  const monthsSeen = {};
  const basis = { scored: 0, total: 0, allDepartment: true, seen: false };

  rows.forEach(function (r) {
    // monthKey() rather than String(). Sheets may have stored '2026-08' as a
    // Date, in which case String() gives 'Sat Aug 01 2026 00:00:00 GMT+0600...'
    // and nothing ever matches. monthKey normalises Date and text alike.
    const rowMonth = monthKey(r[0]);
    if (!rowMonth) return;
    if (wanted && !wanted[rowMonth]) return;

    monthsSeen[rowMonth] = true;

    const scopeType = String(r[1]);
    const name = String(r[2]);

    if (scopeType === 'BASIS') {
      basis.seen = true;
      basis.scored += Number(r[3]) || 0;
      basis.total  += Number(r[4]) || 0;
      // Mixed is treated as OVERALL. That direction is the safe one: it warns
      // that some month in the range counted people outside EAS.
      if (name !== 'DEPARTMENT') basis.allDepartment = false;
      return;
    }

    // EAS is bucketed on scope alone. Its label changes with the basis
    // ('EAS (department exports)' vs 'All tickets (overall report)'), so
    // keying on the name would split one total into two across a mixed range.
    //
    // PERSON is bucketed on the person, NOT on 'Section :: Person'. Someone
    // who was in Functional until July and Manufacturing from August carries
    // two different labels across the range, and keying on the whole string
    // would list them twice — half their year in each row. The individual is
    // the unit of that table, so one person is one row.
    let key;
    let label = name;
    if (scopeType === 'EAS') {
      key = 'EAS';
    } else if (scopeType === 'PERSON') {
      const split = name.split(' :: ');
      label = split.length > 1 ? split[1] : split[0];
      key = 'PERSON\u0000' + label;
    } else {
      key = scopeType + '\u0000' + name;
    }

    if (!buckets[key]) {
      buckets[key] = {
        scope: scopeType, name: label,
        section: '',
        received: 0, completed: 0, delayed: 0, successful: 0
      };
      order.push(key);
    }

    const b = buckets[key];

    if (scopeType === 'PERSON') {
      // Cache rows are written month-ascending, so the last one wins: a person
      // is shown under the section they are in NOW, with their whole-period
      // totals beside it.
      const split = name.split(' :: ');
      if (split.length > 1) b.section = split[0];
    }

    b.received   += Number(r[3]) || 0;
    b.completed  += Number(r[4]) || 0;
    b.delayed    += Number(r[5]) || 0;
    b.successful += Number(r[6]) || 0;
  });

  result.monthsCovered = Object.keys(monthsSeen).length;

  if (basis.seen) {
    result.basis = {
      source: basis.allDepartment ? 'DEPARTMENT' : 'OVERALL',
      scored: basis.scored,
      total: basis.total
    };
  }

  order.forEach(function (key) {
    const b = buckets[key];

    if (b.scope === 'SOURCE') {
      // Not a KPI — countRow() puts its figure in the received column.
      result.sources.push({ name: b.name, count: b.received });
      return;
    }

    const entry = finaliseEntry(b, kpi);

    if (b.scope === 'EAS') {
      result.total = entry;
      result.hasData = true;
    } else if (b.scope === 'DEPARTMENT') {
      result.departments.push(entry);
    } else if (b.scope === 'PART') {
      result.parts.push(entry);
    } else if (b.scope === 'PERSON') {
      entry.department = b.section;
      result.people.push(entry);
    }
  });

  // Busiest first. For a single month this reproduces the cache's own order;
  // across months it is the only order that makes sense, since a name's rank
  // in January says nothing about its rank overall.
  result.departments.sort(byReceived);
  result.parts.sort(byReceived);
  result.people.sort(byReceived);

  return result;
}


/** Recomputes the derived figures from summed counts. */
function finaliseEntry(b, kpi) {
  const rate = b.completed ? (b.successful / b.completed) * 100 : 0;

  return {
    name:        b.name,
    received:    b.received,
    completed:   b.completed,
    delayed:     b.delayed,
    successful:  b.successful,
    rate:        round2(rate),
    achievement: round2(b.completed ? achievementFor(rate, kpi) : 0),
    band:        b.completed ? bandFor(rate, kpi) : 'NO DATA',
    headroom:    headroomFor(b.completed, b.successful, kpi)
  };
}


function byReceived(a, b) {
  return b.received - a.received;
}


/**
 * KPI 1 figures for several months at once, for the comparison screen.
 *
 * Reads the cache once and buckets by month rather than calling getKpi1() per
 * month — six months would otherwise mean six full reads of the same tab.
 *
 * @param {string[]} months  e.g. ['2026-06','2026-07','2026-08']
 * @return {Object} { months: [...], sections: [...], rows: {month: {...}} }
 */
function getKpiComparison(months) {
  const wanted = {};
  (months || []).forEach(function (m) { wanted[m] = true; });

  const result = {
    months: (months || []).slice().sort(),
    sections: [],
    totals: {},        // month -> total entry
    bySection: {},     // section -> { month -> entry }
    target: CONFIG.KPI.RESOLUTION.target
  };

  const cache = sheetFor(CONFIG.SHEETS.KPI_MONTH);
  const lastRow = cache.getLastRow();
  if (lastRow < 2 || !result.months.length) return result;

  const rows = cache.getRange(2, 1, lastRow - 1, CONFIG.KPI_COLUMNS.length).getValues();
  const sectionSeen = {};

  rows.forEach(function (r) {
    const month = monthKey(r[0]);
    if (!wanted[month]) return;

    const scopeType = String(r[1]);
    if (scopeType !== 'EAS' && scopeType !== 'DEPARTMENT') return;

    const entry = {
      received:    Number(r[3]) || 0,
      completed:   Number(r[4]) || 0,
      delayed:     Number(r[5]) || 0,
      successful:  Number(r[6]) || 0,
      rate:        Number(r[7]) || 0,
      achievement: Number(r[8]) || 0,
      band:        String(r[9]),
      headroom:    Number(r[10]) || 0
    };

    if (scopeType === 'EAS') {
      result.totals[month] = entry;
      return;
    }

    const section = String(r[2]);
    if (!sectionSeen[section]) {
      sectionSeen[section] = true;
      result.sections.push(section);
    }
    (result.bySection[section] = result.bySection[section] || {})[month] = entry;
  });

  result.sections.sort();
  return result;
}


/**
 * Prints the KPI table to the Execution log.
 *
 * Open Kpi.gs, choose runKpiSelfTest in the function dropdown, press Run.
 * Checks the stored numbers without involving the browser at all — if the UI
 * and this disagree, the bug is in the UI.
 */
function runKpiSelfTest() {
  const months = recomputeKpiCache();

  if (!months.length) {
    Logger.log('No ticket data loaded yet — upload some files first.');
    return;
  }

  months.forEach(function (month) {
    const k = getKpi1(month);

    if (!k.hasData) {
      Logger.log('%s — no scored rows found. (cache lookup problem)', month);
      return;
    }

    Logger.log('');
    Logger.log('=== %s ===  target %s%%', month, k.target);
    if (k.basis) {
      Logger.log('scored from: %s  (%s of %s tickets)',
                 k.basis.source, k.basis.scored, k.basis.total);
    }
    Logger.log('%-32s %7s %7s %7s %9s %9s %8s %6s',
               'Scope', 'Recvd', 'Compl', 'Delay', 'Rate%', 'Ach%', 'Band', 'Head');

    const t = k.total;
    Logger.log('%-32s %7s %7s %7s %9s %9s %8s %6s',
               t.name, t.received, t.completed, t.delayed,
               t.rate, t.achievement, t.band, t.headroom);

    k.departments.forEach(function (d) {
      Logger.log('%-32s %7s %7s %7s %9s %9s %8s %6s',
                 '  ' + d.name, d.received, d.completed, d.delayed,
                 d.rate, d.achievement, d.band, d.headroom);
    });

    Logger.log('  by service / part:');
    k.parts.forEach(function (p) {
      Logger.log('%-32s %7s %7s %7s %9s %9s %8s %6s',
                 '    ' + p.name, p.received, p.completed, p.delayed,
                 p.rate, p.achievement, p.band, p.headroom);
    });

    Logger.log('  engineers below target:');
    let flagged = 0;
    k.people.forEach(function (p) {
      if (p.delayed > 0 || p.band !== 'GREEN') {
        Logger.log('    %-30s %5s tickets  %3s delayed  %8s%%  %s',
                   p.name, p.received, p.delayed, p.rate, p.band);
        flagged++;
      }
    });
    if (!flagged) Logger.log('    none — every engineer at or above target');

    Logger.log('  source reconciliation:');
    k.sources.forEach(function (s) {
      Logger.log('    %-30s %s', s.name, s.count);
    });
  });
}


/** Rounds to two decimals without floating-point noise. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
