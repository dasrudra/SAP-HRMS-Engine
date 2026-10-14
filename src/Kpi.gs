/**
 * Kpi.gs - the calculation engine for KPI 1, Error/Issue Resolution Time.
 *
 * THE FORMULA (policy TVL-KPI-001 section 6.3, confirmed by SAP_Error_Issue_
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
 * report is wider - it also contains work by engineers who belong to no EAS
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

  // Bucket by month first. The policy measures monthly - a rolling all-time
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

    // Service/Part is present in both reports, so this always works - and it
    // is how the ITSM's own Performance Report is organised.
    groupBy2(scored, COL.SERVICE, COL.PART).forEach(function (entry) {
      out.push(kpiRow(month, 'PART', entry.key, entry.rows, kpi, computedAt));
    });

    // Modules. Grouped HERE rather than rolled up from the Part rows above,
    // because a Part that names no module has to fall through to the person
    // who handled the ticket - and only the ticket row carries both columns.
    groupByKey(scored, function (row) {
      return moduleForTicket(row[COL.PART], row[COL.IN_CHARGE], month);
    }).forEach(function (entry) {
      out.push(kpiRow(month, 'MODULE', entry.key, entry.rows, kpi, computedAt));
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

    // Each individual AGAIN, split by the module each ticket belonged to.
    //
    // WHY A CROSS-TAB RATHER THAN A MODULE COLUMN ON THE PERSON ROW ABOVE
    // Nobody is in exactly one module. moduleForTicket() reads the module off
    // the ticket's own Part column first and only falls back to the person's
    // role, so somebody whose role is PP handles MM tickets and those tickets
    // ARE MM. Tagging each person with a single module would therefore be a
    // guess, and filtering the individuals table by that guess would show a
    // person's whole caseload under one module's name - 2,578 tickets against
    // MD when a few hundred of them were MD.
    //
    // Grouping by both answers the question that was actually asked. Pick a
    // module and the table shows the people who worked in it and what they
    // did IN IT, which is the only honest reading of "who works on MD".
    //
    // The cost is rows: about as many as there are person-and-module pairs
    // that really occur, which is far fewer than 37 x 9 because most people
    // work in one or two. They are written once per rebuild and read like any
    // other scope.
    groupByKey(scored, function (row) {
      // \u0000 as the joiner, not ' :: '. This key is never displayed and a
      // module or a name containing the display separator would silently merge
      // two groups into one.
      return moduleForTicket(row[COL.PART], row[COL.IN_CHARGE], month) + '\u0000' +
             (matchPerson(row[COL.IN_CHARGE]) ||
              String(row[COL.IN_CHARGE] || '').trim());
    }).forEach(function (entry) {
      const moduleName = entry.key.split('\u0000')[0];
      const first = entry.rows[0];
      const who = String(first[COL.IN_CHARGE] || '').trim() || '(unassigned)';
      const section = sectionFor(who, month, first[COL.DEPARTMENT]);
      out.push(kpiRow(month, 'PERSON_MODULE',
                      moduleName + ' :: ' + (section ? section + ' :: ' : '') + who,
                      entry.rows, kpi, computedAt));
    });

    // Reconciliation between the ITSM's two reports. Not a KPI - a data
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


/** A plain count row - used for the source reconciliation. */
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
    // Still open. Every row counted in `received` either has a completion date
    // or does not, and `completed` is exactly the ones that do - so this
    // subtraction IS the count of tickets with a blank Completion Date. It is
    // derived rather than stored, which is deliberate: nothing has to be
    // re-uploaded or recached for it to appear, and it cannot drift away from
    // the two numbers it sits between.
    open:        rows.length - completed,
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
 * as incomplete - they are the "1 incomplete" showing against Account and CO on
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
 * Needed because a ticket's section is no longer a value sitting in a cell -
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
 * Groups by two columns joined with a slash - used for Service / Part.
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
 * silently turns into "all time" - the two mean very different things when the
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
function monthsInScope(scope, scheme) {
  const text = String(scope || '').trim();
  if (!text || text === ALL_MONTHS) return null;

  // A comma-separated list is several months at once - 'compare January and
  // August without the seven months between them', which neither a single
  // month nor a quarter can express. Each part is resolved on its own, so a
  // list may mix months and quarters, and a list containing ALL collapses to
  // every month, because "all of them plus August" is just all of them.
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


/** The quarter rules for a KPI, defaulting to KPI 1's. */
function quarterScheme(scheme) {
  return (CONFIG.QUARTERS && CONFIG.QUARTERS[scheme || 'RESOLUTION']) ||
         { startMonth: 1, yearFrom: 'start' };
}


/**
 * The three months a quarter covers, oldest first.
 *
 * Driven by CONFIG.QUARTERS, so a company year that starts in April is
 * described in one place rather than assumed in several. With startMonth 4,
 * '2026-Q4' is January to March of 2027 - the quarter crosses the calendar
 * year, which is the whole reason this is not arithmetic on the month number.
 *
 * @param {string} key     'YYYY-Qn'
 * @param {string} scheme  'RESOLUTION' (default) or 'FEEDBACK'
 * @return {string[]} 'YYYY-MM'
 */
function monthsOfQuarter(key, scheme) {
  const parts = String(key || '').match(/^(\d{4})-Q([1-4])$/);
  if (!parts) return [];

  const rules = quarterScheme(scheme);
  const startMonth = Number(rules.startMonth) || 1;
  const offset = (Number(parts[2]) - 1) * 3;

  // Month index counted from the start of the labelled year.
  let year = Number(parts[1]);
  if (rules.yearFrom === 'end' && startMonth > 1) year -= 1;

  const out = [];
  for (let i = 0; i < 3; i++) {
    const n = startMonth + offset + i;                 // 1-based, may exceed 12
    const y = year + Math.floor((n - 1) / 12);
    const m = ((n - 1) % 12) + 1;
    out.push(y + '-' + String(m).padStart(2, '0'));
  }
  return out;
}


/**
 * The quarter a month falls in: '2026-08' -> '2026-Q3'.
 *
 * @param {string} month 'YYYY-MM'
 * @return {string} 'YYYY-Qn', or '' if unreadable
 */
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


/**
 * 'Quarter 1 (2026)', and what it covers.
 *
 * @param {string} key  'YYYY-Qn'
 * @return {string}
 */
function quarterLabel(key) {
  const parts = String(key || '').match(/^(\d{4})-Q([1-4])$/);
  if (!parts) return String(key || '');
  return 'Quarter ' + parts[2] + ' (' + parts[1] + ')';
}


/**
 * Everything the KPI 1 screen needs. The ENDPOINT - a browser calls this.
 *
 * The figures are in readKpi1() below; this is the guard in front of them.
 * They are two functions because a maintenance function run from the editor
 * has no token to pass and must not pretend to have one: getKpi1(null, month)
 * does not skip the check, it fails it, with "Your session has ended" in the
 * execution log of something nobody was signed in to.
 *
 * @param {string} token  the caller's session - see Auth.gs
 * @param {string} month  'YYYY-MM', or ALL_MONTHS for the whole period
 * @return {Object}
 */
function getKpi1(token, month) {
  requireSignedIn(token);
  return readKpi1(month);
}


/**
 * The same figures, with no session check. NOT AN ENDPOINT in spirit - every
 * global in an Apps Script project is reachable, so the rule is that anything
 * calling this must have checked who is asking first. getKpi1() checks a
 * token; the editor-only functions check requireOwner().
 *
 * WHY AN ALL-MONTHS FIGURE IS NOT AN AVERAGE
 * Percentages cannot be averaged across periods of different size. January
 * with 4 completed tickets and one delay scores 75%; August with 2,640 and 11
 * scores 99.58%. Their mean is 87.29%, which describes nothing that happened.
 * The true all-time rate is (sum successful / sum completed) x 100.
 *
 * So this sums the RAW COUNTS the cache stores beside each rate, then
 * recomputes rate, achievement, band and headroom from those sums. The answer
 * is identical to scoring every ticket in one pass, without re-reading the
 * TICKETS tab.
 *
 * @param {string} month  'YYYY-MM', or ALL_MONTHS for the whole period
 * @return {Object}
 */
function readKpi1(month) {
  const kpi = CONFIG.KPI.RESOLUTION;
  const everyMonth = (month === ALL_MONTHS);

  // null means "take every month"; otherwise a lookup of the ones wanted.
  // One month, a quarter's three, or all of them go down the same path - the
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
    modules: [],
    people: [],
    // One row per person PER MODULE, so the individuals table can be sliced by
    // module and still show figures that belong to that module. Empty until a
    // rebuild has been run since this scope was added - the screen checks and
    // says so rather than offering a filter that would do nothing.
    peopleByModule: [],
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
    // would list them twice - half their year in each row. The individual is
    // the unit of that table, so one person is one row.
    let key;
    let label = name;
    if (scopeType === 'EAS') {
      key = 'EAS';
    } else if (scopeType === 'PERSON') {
      const split = name.split(' :: ');
      label = split.length > 1 ? split[1] : split[0];
      key = 'PERSON\u0000' + label;
    } else if (scopeType === 'PERSON_MODULE') {
      // 'Module :: Section :: Name', or 'Module :: Name' when the person had
      // no section that month. Read from both ends rather than by position:
      // the module is always first and the name always last, whether or not
      // there is a section between them.
      const split = name.split(' :: ');
      label = split[split.length - 1];
      key = 'PERSON_MODULE\u0000' + split[0] + '\u0000' + label;
    } else {
      key = scopeType + '\u0000' + name;
    }

    if (!buckets[key]) {
      buckets[key] = {
        scope: scopeType, name: label,
        section: '',
        module: '',
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

    if (scopeType === 'PERSON_MODULE') {
      const split = name.split(' :: ');
      b.module = split[0];
      // Three parts means a section sits between the module and the name. Two
      // means the person had none that month, and the section stays blank
      // rather than being filled with the module's name.
      if (split.length > 2) b.section = split[1];
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
      // Not a KPI - countRow() puts its figure in the received column.
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
    } else if (b.scope === 'MODULE') {
      result.modules.push(entry);
    } else if (b.scope === 'PERSON') {
      entry.department = b.section;
      result.people.push(entry);
    } else if (b.scope === 'PERSON_MODULE') {
      entry.department = b.section;
      entry.module = b.module;
      result.peopleByModule.push(entry);
    }
  });

  // Busiest first. For a single month this reproduces the cache's own order;
  // across months it is the only order that makes sense, since a name's rank
  // in January says nothing about its rank overall.
  result.departments.sort(byReceived);
  result.parts.sort(byReceived);
  result.people.sort(byReceived);
  result.modules.sort(byReceived);
  result.peopleByModule.sort(byReceived);

  assignPersonModules(result);

  return result;
}


/**
 * Gives every individual ONE module: the one they belong to.
 *
 * WHICH QUESTION THIS ANSWERS, AND WHICH IT DOES NOT
 * "Who works in PP" and "whose tickets were PP" are different questions with
 * different answers, and the By individuals filter was built on the wrong one.
 * A Financial person who covered a single PP ticket is not in PP; they are in
 * Financial, and they covered a ticket. The module cross-tab still records
 * that - it is how the busiest module below is worked out - but it is not who
 * the module's people are.
 *
 * HOW SOMEBODY IS PLACED, best source first:
 *
 *   1. PERSON_MODULES. Somebody on the team said so. Nothing overrules it,
 *      because a confirmed fact beats a count every time - Md. Nasir Uddin is
 *      MM even though more of his tickets are MD.
 *
 *   2. The module most of their tickets are in. This is what makes the filter
 *      usable at all: the roster can only ever produce five of the eight
 *      modules, so MD - the largest, 7,362 tickets - would have had nobody in
 *      it, and so would Account and E-Accounting.
 *
 *   3. Their section's usual module, for somebody with no tickets in the
 *      period being looked at.
 *
 *   4. '(unassigned)', visible rather than guessed at.
 *
 * `moduleWhy` records which of those it was, so listPersonModules() can show
 * the derived ones for checking and the confirmed ones can be left alone.
 *
 * TO CORRECT ONE: add the person to PERSON_MODULES in Config.gs and rebuild.
 * That is rule 1, and it wins.
 */
function assignPersonModules(result) {
  // The busiest module per person, from the cross-tab. '(unassigned)' is not
  // a module somebody can belong to, so it cannot win here.
  const busiest = {};
  result.peopleByModule.forEach(function (row) {
    if (!row.module || row.module === '(unassigned)') return;
    const seen = busiest[row.name];
    if (!seen || row.received > seen.received) {
      busiest[row.name] = { module: row.module, received: row.received };
    }
  });

  result.people.forEach(function (person) {
    const confirmed = confirmedModuleFor(person.name);
    const byWork = busiest[person.name] ? busiest[person.name].module : '';
    const bySection = CONFIG.SECTION_MODULES[person.department] || '';

    person.module = confirmed || byWork || bySection || '(unassigned)';
    person.moduleWhy = confirmed ? 'listed'
      : byWork ? 'busiest'
      : bySection ? 'section' : 'none';
    // How lopsided the split is, so a person who is genuinely half in two
    // modules can be told from one who is plainly in one.
    person.moduleShare = (byWork && person.received)
      ? Math.round((busiest[person.name].received / person.received) * 1000) / 10
      : 0;
  });
}


/** Recomputes the derived figures from summed counts. */
function finaliseEntry(b, kpi) {
  const rate = b.completed ? (b.successful / b.completed) * 100 : 0;

  return {
    name:        b.name,
    received:    b.received,
    completed:   b.completed,
    // See scoreRows(): tickets whose Completion Date is blank. Clamped only
    // because these two are summed from the cache rather than counted off one
    // set of rows, so a half-written cache row must not print a negative.
    open:        Math.max(0, b.received - b.completed),
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
 * month - six months would otherwise mean six full reads of the same tab.
 *
 * @param {string[]} months  e.g. ['2026-06','2026-07','2026-08']
 * @return {Object} { periods: [...], sections: [...], totals: {period: {...}} }
 */
function getKpiComparison(token, months) {
  // Needs a session - see Auth.gs.
  requireSignedIn(token);
  const wanted = {};
  (months || []).forEach(function (m) { wanted[m] = true; });

  const result = {
    periods: (months || []).slice().sort(),
    sections: [],
    totals: {},        // period -> total entry
    bySection: {},     // section -> { period -> entry }
    target: CONFIG.KPI.RESOLUTION.target,

    // The Comparison screen renders whatever a KPI declares here rather than
    // hardcoding KPI 1's columns - see getKpi2Comparison for the other side of
    // the contract.
    kpi: 'KPI1',
    name: CONFIG.KPI.RESOLUTION.name || 'Error/Issue Resolution Time',
    unit: '%',

    // A KPI names its own reporting period. Tickets arrive daily, so KPI 1 is
    // read month by month; training runs a few times a quarter, so KPI 2 is
    // read quarter by quarter. The screen takes both from here rather than
    // assuming months and mislabelling one of them.
    periodKind: 'MONTH',
    periodLabel: 'Month',
    periodLabelPlural: 'months',

    sectionLabel: 'Section',
    rateLabel: 'Success Rate',
    volumeKey: 'completed',
    volumeLabel: 'Tickets completed',
    measures: [
      { key: 'received',   label: 'Received' },
      { key: 'completed',  label: 'Completed' },
      { key: 'open',       label: 'Open' },
      { key: 'delayed',    label: 'Delayed' },
      { key: 'successful', label: 'Successful' }
    ]
  };

  const cache = sheetFor(CONFIG.SHEETS.KPI_MONTH);
  const lastRow = cache.getLastRow();
  if (lastRow < 2 || !result.periods.length) return result;

  const rows = cache.getRange(2, 1, lastRow - 1, CONFIG.KPI_COLUMNS.length).getValues();
  const sectionSeen = {};

  rows.forEach(function (r) {
    const month = monthKey(r[0]);
    if (!wanted[month]) return;

    const scopeType = String(r[1]);
    if (scopeType !== 'EAS' && scopeType !== 'DEPARTMENT') return;

    /*
      COUNTS ARE READ. JUDGEMENTS ARE RECOMPUTED.

      KPI_MONTHLY stores eight numbers per row, and they are not the same kind
      of thing. Received, Completed, Completed With Delay and Completed
      Successfully are FACTS about what happened in that month - they are read
      back exactly as stored, because nothing can change them after the event.

      Success Rate, KPI Achievement, Band and Headroom are JUDGEMENTS AGAINST A
      TARGET. They were true of the target in force on the day the file was
      uploaded, and they stop being true the moment the target moves. This is
      not hypothetical: KPI 1's target went from 99.50% to 90.00% when
      TVL-KPI-001 v1.0 was approved, and every row cached before that still
      carries the old verdict.

      Reading those four back was a live defect. The Comparison screen showed
      Sales Applications at 99.08% for August marked YELLOW, while the KPI 1
      screen showed the same section, the same month and the same 99.08% marked
      GREEN - because one recomputed and the other did not. It was almost
      invisible: every other cell in that table was above 99.50% as well as
      above 90%, so only the single section that fell between the two targets
      showed the disagreement. Achievement and Headroom were wrong in every
      cell and simply looked plausible - 100.13% instead of 110.70%, +4 instead
      of +308.

      So the four are derived here, from the two counts, through the same
      functions the KPI 1 screen uses. The stored columns stay on the sheet as
      a record of what was judged at the time; nothing reads them.
    */
    const completed  = Number(r[4]) || 0;
    const successful = Number(r[6]) || 0;
    const kpi = CONFIG.KPI.RESOLUTION;
    const rate = completed ? (successful / completed) * 100 : 0;

    const entry = {
      received:    Number(r[3]) || 0,
      completed:   completed,
      delayed:     Number(r[5]) || 0,
      successful:  successful,
      rate:        rate,
      achievement: completed ? achievementFor(rate, kpi) : 0,
      band:        completed ? bandFor(rate, kpi) : 'NO DATA',
      headroom:    headroomFor(completed, successful, kpi)
    };
    // Derived here too, from the same two columns - see scoreRows().
    entry.open = Math.max(0, entry.received - entry.completed);

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
 * Checks the stored numbers without involving the browser at all - if the UI
 * and this disagree, the bug is in the UI.
 */
function runKpiSelfTest() {
  // Owner-only, like explainModule() and listPersonModules(). It was the one
  // of the three with no guard, and it is the most expensive: every global in
  // an Apps Script project is reachable from a browser, so without this a
  // viewer could trigger a full rebuild of the cache as often as they liked.
  requireOwner();

  const months = recomputeKpiCache();

  if (!months.length) {
    Logger.log('No ticket data loaded yet \u2014 upload some files first.');
    return;
  }

  months.forEach(function (month) {
    // readKpi1, not getKpi1. This said "the /dev shortcut covers it" and it
    // did not: that shortcut lives in doGet and does nothing for a function
    // run from the editor, so this threw "Your session has ended" every time.
    const k = readKpi1(month);

    if (!k.hasData) {
      Logger.log('%s \u2014 no scored rows found. (cache lookup problem)', month);
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
    if (!flagged) Logger.log('    none \u2014 every engineer at or above target');

    Logger.log('  source reconciliation:');
    k.sources.forEach(function (s) {
      Logger.log('    %-30s %s', s.name, s.count);
    });
  });
}


/**
 * Prints who the dashboard thinks works in which module. Run from the editor.
 *
 *   listPersonModules()             every month
 *   listPersonModules('2026-08')    one month
 *
 * THIS IS THE LIST TO CHECK. Only the people in PERSON_MODULES were confirmed
 * by the team; everyone else was placed by where most of their work is, which
 * is a good guess and still a guess. The ones marked `busiest` are the ones
 * worth an argument, and the argument is settled by adding that person to
 * PERSON_MODULES in Config.gs and rebuilding - rule 1 beats rule 2.
 *
 * The share column says how lopsided the split was. 100% is somebody who only
 * ever works in one module; 58% is somebody genuinely spread across two, and
 * those are the names to look at first.
 *
 * Owner-only, like the other maintenance functions: it prints every name.
 *
 * @param {string} [month]  'YYYY-MM', or omitted for every month
 * @return {Array} the same rows the log prints
 */
function listPersonModules(month) {
  requireOwner();

  const k = readKpi1(month || null);
  if (!k.hasData) {
    Logger.log('No tickets in %s.', month || 'any month');
    return [];
  }

  const rows = k.people.slice().sort(function (a, b) {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    return b.received - a.received;
  });

  Logger.log('');
  Logger.log('=========================================================');
  Logger.log(' Who works in which module');
  Logger.log(' %s', month || 'every month');
  Logger.log('=========================================================');
  Logger.log(' %-30s %-13s %-9s %6s %6s  %s',
             'PERSON', 'MODULE', 'DECIDED BY', 'SHARE', 'TICKETS', 'SECTION');

  let guessed = 0;
  rows.forEach(function (p) {
    if (p.moduleWhy === 'busiest') guessed++;
    Logger.log(' %-30s %-13s %-9s %5s%% %6s  %s',
               p.name, p.module, p.moduleWhy,
               p.moduleShare || 0, p.received, p.department || '(none)');
  });

  Logger.log('');
  Logger.log(' %s people. %s confirmed in PERSON_MODULES, %s placed by their work.',
             rows.length, rows.length - guessed, guessed);
  Logger.log(' To correct one: add it to PERSON_MODULES in Config.gs, then rebuild.');
  Logger.log('=========================================================');

  return rows.map(function (p) {
    return { name: p.name, module: p.module, why: p.moduleWhy,
             share: p.moduleShare, tickets: p.received, section: p.department };
  });
}


/** Rounds to two decimals without floating-point noise. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}


// ---------------------------------------------------------------------------
// WHY IS THIS TICKET IN THIS MODULE?
// ---------------------------------------------------------------------------
//
// Asked the first time somebody noticed people from Financial and Sales under
// PP on the By individuals table, and it is not a question the screen can
// answer: it shows the ANSWER (the module) and never the reason.
//
// There are three reasons a ticket can be in a module, and they are not
// equally trustworthy:
//
//   1. The Part column named it.  Strong - the ITSM's own categorisation.
//   2. The person's own module role, from PERSON_MODULES.  Strong - somebody
//      confirmed it. This is why Md. Abdullah Al Mamun sits in Supply Chain
//      and his tickets are PP, which is correct and looks wrong.
//   3. Their section's usual module, from SECTION_MODULES.  A default.
//
// And reason 1 has a trap in it. The patterns include ordinary English words -
// 'production', 'development', 'export', 'purchase', 'inventory' - which are
// matched BEFORE the short module codes, because the list is sorted longest
// first. So a Part value of 'FI Production Report' is filed under PP rather
// than FI/TR: the descriptive word wins over the module code sitting next to
// it. Whether that is actually happening in this database is a question about
// the data, not the code, and explainModule() is how to answer it.


/**
 * Which module a ticket lands in, AND why.
 *
 * Deliberately a separate function from moduleForTicket() rather than a flag
 * on it. moduleForTicket runs on every ticket of a twenty-thousand-row
 * rebuild and must stay a lookup; this one builds an object and is for
 * reading, not for scoring. They walk the same list in the same order, so
 * they cannot disagree about the answer.
 *
 * @param {string} part      the Part column
 * @param {string} inCharge  Current Activity In Charge
 * @param {string} month     'YYYY-MM', for the section the person was in then
 * @return {{module: string, how: string, detail: string}}
 *         how is 'part' | 'person' | 'section' | 'none'
 */
function whyModule(part, inCharge, month) {
  const text = String(part || '').toLowerCase().trim();

  if (text) {
    const patterns = ticketModulePatterns();
    for (let i = 0; i < patterns.length; i++) {
      if (patterns[i].re.test(text)) {
        return { module: patterns[i].name, how: 'part', detail: patterns[i].pattern };
      }
    }
  }

  const theirs = moduleForPerson(inCharge, month);
  if (theirs) {
    // Their own entry, or their section's default? The difference matters:
    // one was confirmed by the team, the other was assumed from where they
    // sit, and only the second is worth arguing with.
    const key = matchPerson(inCharge);
    const listed = key ? personModuleIndex()[key] : '';
    return listed
      ? { module: theirs, how: 'person', detail: 'PERSON_MODULES' }
      : { module: theirs, how: 'section', detail: sectionFor(inCharge, null, '') };
  }

  return { module: '(unassigned)', how: 'none', detail: '' };
}


/**
 * Prints why every ticket in one module is in it. Run from the editor.
 *
 *   explainModule('PP')             every month
 *   explainModule('PP', '2026-08')  one month
 *
 * Reads the ticket sheet, so it is owner-only like the other maintenance
 * functions - it prints Part values and names verbatim.
 *
 * WHAT TO LOOK FOR
 * Under BY PERSON, somebody from another section with a handful of tickets is
 * either genuine cover - which the dashboard should show - or a Part value
 * that matched the wrong pattern. The example Part text beside each count is
 * what tells the two apart. 'Production Planning' under PP is right.
 * 'FI Production Report' under PP is the trap described above.
 *
 * @param {string} moduleName  as TICKET_MODULES spells it, e.g. 'PP'
 * @param {string} [month]     'YYYY-MM', or omitted for every month
 * @return {Object} the same figures the log prints, for anything that wants them
 */
function explainModule(moduleName, month) {
  requireOwner();

  const want = String(moduleName || '').trim();
  if (!want) throw new Error('Name a module, e.g. explainModule(\u0027PP\u0027).');

  const tickets = sheetFor(CONFIG.SHEETS.TICKETS);
  const lastRow = tickets.getLastRow();
  if (lastRow < 2) {
    Logger.log('No tickets stored.');
    return { module: want, total: 0, reasons: {}, people: [] };
  }

  const rows = tickets.getRange(2, 1, lastRow - 1, COL.WIDTH).getValues();
  const reasons = {};          // 'part:production' -> count
  const byPerson = {};         // name -> { count, section, reasons, examples }
  let total = 0;

  rows.forEach(function (row) {
    if (!String(row[COL.TICKET_ID] || '').trim()) return;
    const rowMonth = monthKey(row[COL.REQUEST_DATE]);
    if (!rowMonth) return;
    if (month && rowMonth !== month) return;

    const why = whyModule(row[COL.PART], row[COL.IN_CHARGE], rowMonth);
    if (why.module !== want) return;

    total++;
    const label = why.how === 'part'
      ? 'the Part column matched \u0027' + why.detail + '\u0027'
      : why.how === 'person' ? 'their own module role (PERSON_MODULES)'
      : why.how === 'section' ? 'their section\u0027s usual module (' + why.detail + ')'
      : 'nothing - unassigned';
    reasons[label] = (reasons[label] || 0) + 1;

    const who = String(row[COL.IN_CHARGE] || '').trim() || '(unassigned)';
    const seen = byPerson[who] || (byPerson[who] = {
      name: who, count: 0,
      section: sectionFor(who, rowMonth, row[COL.DEPARTMENT]),
      reasons: {}, examples: {}
    });
    seen.count++;
    seen.reasons[label] = (seen.reasons[label] || 0) + 1;
    // Up to three distinct Part values per person: enough to recognise a
    // pattern, few enough to stay readable in the execution log.
    const part = String(row[COL.PART] || '').trim() || '(blank)';
    if (!seen.examples[label]) seen.examples[label] = [];
    if (seen.examples[label].length < 3 &&
        seen.examples[label].indexOf(part) === -1) {
      seen.examples[label].push(part);
    }
  });

  const people = Object.keys(byPerson)
    .map(function (name) { return byPerson[name]; })
    .sort(function (a, b) { return b.count - a.count; });

  Logger.log('');
  Logger.log('=========================================================');
  Logger.log(' %s \u2014 why each ticket is filed here', want);
  Logger.log(' %s', month || 'every month');
  Logger.log('=========================================================');
  Logger.log(' %s tickets', total);

  Logger.log('');
  Logger.log(' HOW THEY GOT HERE');
  Object.keys(reasons)
    .sort(function (a, b) { return reasons[b] - reasons[a]; })
    .forEach(function (label) {
      Logger.log('   %6s  %s', reasons[label], label);
    });

  Logger.log('');
  Logger.log(' BY PERSON  (section is where they sit, not what the ticket was about)');
  people.forEach(function (p) {
    Logger.log('   %-32s %6s   %s', p.name, p.count, p.section || '(no section)');
    Object.keys(p.reasons).forEach(function (label) {
      const eg = (p.examples[label] || []).map(function (t) { return '"' + t + '"'; });
      Logger.log('       %6s  %s%s', p.reasons[label], label,
                 eg.length ? '   e.g. ' + eg.join(', ') : '');
    });
  });
  Logger.log('=========================================================');

  return { module: want, month: month || '', total: total,
           reasons: reasons, people: people };
}
