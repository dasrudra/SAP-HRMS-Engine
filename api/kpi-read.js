/**
 * kpi-read.js - KPI 1 for a month, a quarter, a list or the whole period.
 * ===========================================================================
 *
 * Ported from readKpi1 [Kpi.gs:625] and the part of recomputeKpiCache that
 * decides what gets scored.
 *
 * THE KPI_MONTHLY CACHE IS NOT PORTED, AND THAT IS A DECISION.
 *
 * The original scores every ticket into a cache tab after each upload, and
 * readKpi1 sums that cache. The cache exists because reading 25,000
 * spreadsheet rows on every page load is slow, and it carries a cost the
 * original lives with: it has to be rebuilt, and a month whose rebuild was
 * missed shows stale figures until somebody notices.
 *
 * Reading 25,000 indexed rows out of PostgreSQL is not the thing that cache
 * was protecting against. So this scores the tickets directly, every time,
 * and there is nothing that can go stale.
 *
 * THE ONE RULE THAT HAD TO SURVIVE DROPPING IT is in readKpi1's own note:
 *
 *   "Percentages cannot be averaged across periods of different size.
 *    January with 4 completed tickets and one delay scores 75%; August with
 *    2,640 and 11 scores 99.58%. Their mean is 87.29%, which describes
 *    nothing that happened. The true all-time rate is
 *    (sum successful / sum completed) x 100."
 *
 * Summing raw counts and recomputing from the sums is exactly what scoring
 * the underlying rows does, so dropping the cache preserves that rule
 * rather than endangering it - there is no intermediate percentage left to
 * be tempted into averaging.
 *
 * NOTHING HERE DOES ARITHMETIC OF ITS OWN. Every figure comes from
 * kpi.js, which is proved identical to Kpi.gs over 16,239 comparisons, and
 * every attribution from roster.js, proved over 5,681. This file decides
 * WHICH rows go into which bucket and nothing else.
 */

const db = require('./db');
const kpi = require('./kpi');
const roster = require('./roster');

// The dashboard's own clock. A ticket's month is the month it was raised in
// Bangladesh, not in UTC - see the long note in db/11-tickets.sql.
const TZ = 'Asia/Dhaka';


/**
 * The rows a scope covers, with their month already worked out.
 *
 * ONE QUERY, NOT ONE PER MONTH. A comparison across six months would
 * otherwise be six scans of the same table.
 *
 * Only the eight columns that decide anything are read. Pulling 25,000 full
 * ticket rows - titles, details, remarks - across the wire to count them
 * would be most of a megabyte spent on text nothing looks at.
 */
async function scoredRows(wanted) {
  const where = [];
  const args = [TZ];

  // null from monthsInScope means every month; an empty object means none.
  if (wanted) {
    const months = Object.keys(wanted);
    if (!months.length) return [];
    args.push(months);
    where.push("to_char(request_date AT TIME ZONE $1, 'YYYY-MM') = ANY($2)");
  }

  return db.query(
    `SELECT to_char(request_date AT TIME ZONE $1, 'YYYY-MM') AS month,
            in_charge, department, service, part,
            completion_date, delay_days, in_dept, in_overall
       FROM ticket
      WHERE request_date IS NOT NULL` +
    (where.length ? ' AND ' + where.join(' AND ') : ''),
    args);
}


/** kpi.scoreTickets over rows in this file's shape. */
function score(rows, standard) {
  return kpi.scoreTickets(rows.map(function (r) {
    return { completion: r.completion_date, delayDays: r.delay_days };
  }), standard);
}

/** A bucket of summed counts, which finaliseEntry turns into an entry. */
function tally(name, rows, standard) {
  const s = score(rows, standard);
  return { name: name, received: s.received, completed: s.completed,
           delayed: s.delayed, successful: s.successful };
}


/**
 * KPI 1 for one scope.   [Kpi.gs:625 readKpi1]
 *
 * @param month     'YYYY-MM', 'YYYY-Qn', a comma-separated list, or 'ALL'
 * @param standard  'EAS' for the internal target, anything else for the
 *                  company one
 */
async function readKpi1(month, standard) {
  const standardUsed = kpi.resolutionStandard(standard);
  const everyMonth = (month === kpi.ALL_MONTHS);
  const wanted = kpi.monthsInScope(month);

  const result = {
    month: month,
    allMonths: everyMonth,
    monthsCovered: 0,
    hasData: false,
    basis: null,
    total: null,
    departments: [],
    parts: [],
    // NOT YET. The module breakdown needs moduleForTicket, which reads a
    // module out of the Part column by pattern and falls back to the
    // person who handled the ticket. That is its own subsystem and gets
    // its own equivalence test, like the roster did. Empty rather than
    // missing, so the page's shape does not change when it arrives.
    modules: [],
    people: [],
    sources: [],
    target: standardUsed.target,
    yellowFloor: standardUsed.yellowFloor,
    standard: standardUsed.standard,
    standardLabel: standardUsed.standardLabel,
    standardNote: standardUsed.standardNote
  };

  const rows = await scoredRows(wanted);
  if (!rows.length) return result;

  const byMonth = {};
  rows.forEach(function (r) {
    if (!r.month) return;
    (byMonth[r.month] = byMonth[r.month] || []).push(r);
  });

  const months = Object.keys(byMonth).sort();
  result.monthsCovered = months.length;

  const index = await roster.loadIndex();

  /*
    THE BASIS IS DECIDED PER MONTH, AND SUMMED ACROSS THEM.

    Kpi.gs, in its file header: "The four department exports are the
    accurate scope. The overall Service/Part report is wider - it also
    contains work by engineers who belong to no EAS department (9 tickets
    across 6 people in August 2026), so scoring EAS on it credits the
    department with work it did not do. But you may upload only the overall
    report, or only department files, or both. So the engine scores
    whichever population it has and records WHICH."

    A range can therefore be mixed, and MIXED IS REPORTED AS OVERALL: "that
    direction is the safe one: it warns that some month in the range counted
    people outside EAS."
  */
  const basis = { scored: 0, total: 0, allDepartment: true, seen: false };

  // Summed across months before anything is scored, because a rate must be
  // worked out from summed counts and never from averaged percentages.
  const eas = [];
  const bySection = {};
  const byPart = {};
  const byPerson = {};
  const personSection = {};
  let both = 0, deptOnly = 0, overallOnly = 0;

  months.forEach(function (m) {
    const all = byMonth[m];

    // Prefer the department exports when we have them; fall back to the
    // whole set when only the overall report has been uploaded.
    const deptRows = all.filter(function (r) { return r.in_dept === true; });
    const usingDept = deptRows.length > 0;
    const scored = usingDept ? deptRows : all;

    basis.seen = true;
    basis.scored += scored.length;
    basis.total += all.length;
    if (!usingDept) basis.allDepartment = false;

    scored.forEach(function (r) { eas.push(r); });

    /*
      SECTIONS ARE GROUPED BY WHO HANDLED THE TICKET AND WHEN, not by the
      Department column the upload wrote. Kpi.gs: "the column records what
      a file claimed, the roster decides what is true, and the two differ
      for a combined export, for the pre-August months, and for the three
      people whose module role is not their section."

      Only when department files were loaded - a breakdown by section of a
      population that includes non-EAS engineers is not a breakdown of EAS.
    */
    if (usingDept) {
      kpi.groupByKey(scored, function (r) {
        return roster.sectionFor(index, r.in_charge, m, r.department);
      }).forEach(function (g) {
        (bySection[g.key] = bySection[g.key] || []).push.apply(bySection[g.key], g.rows);
      });
    }

    // Service / Part, present in both reports, and how the ITSM's own
    // Performance Report is organised. Part is scoped to Service because
    // the same Part name under two Services is two different things.
    kpi.groupByKey(scored, function (r) {
      return String(r.service || '').trim() + ' / ' + String(r.part || '').trim();
    }).forEach(function (g) {
      (byPart[g.key] = byPart[g.key] || []).push.apply(byPart[g.key], g.rows);
    });

    /*
      PEOPLE ARE KEYED ON THE PERSON, NOT ON 'Section :: Person'. Kpi.gs:
      "Someone who was in Functional until July and Manufacturing from
      August carries two different labels across the range, and keying on
      the whole string would list them twice - half their year in each row.
      The individual is the unit of that table, so one person is one row."

      The section shown beside them is the LAST one seen, months ascending,
      so a person appears under the section they are in now with their
      whole-period totals beside it.
    */
    kpi.groupByKey(scored, function (r) { return r.in_charge; })
      .forEach(function (g) {
        (byPerson[g.key] = byPerson[g.key] || []).push.apply(byPerson[g.key], g.rows);
        personSection[g.key] =
          roster.sectionFor(index, g.rows[0].in_charge, m, g.rows[0].department);
      });

    // Which reports each ticket came from. Counted over ALL rows of the
    // month rather than the scored ones: the point of this table is to say
    // what was uploaded, including what the scoring left out.
    all.forEach(function (r) {
      if (r.in_dept && r.in_overall) both++;
      else if (r.in_dept) deptOnly++;
      else if (r.in_overall) overallOnly++;
    });
  });

  if (basis.seen) {
    result.basis = {
      source: basis.allDepartment ? 'DEPARTMENT' : 'OVERALL',
      scored: basis.scored,
      total: basis.total
    };
  }

  if (eas.length) {
    result.total = kpi.finaliseEntry(
      tally(basis.allDepartment ? 'EAS (department exports)'
                                : 'All tickets (overall report)',
            eas, standardUsed),
      standardUsed);
    result.hasData = true;
  }

  Object.keys(bySection).forEach(function (name) {
    result.departments.push(
      kpi.finaliseEntry(tally(name, bySection[name], standardUsed), standardUsed));
  });
  Object.keys(byPart).forEach(function (name) {
    result.parts.push(
      kpi.finaliseEntry(tally(name, byPart[name], standardUsed), standardUsed));
  });
  Object.keys(byPerson).forEach(function (name) {
    const entry = kpi.finaliseEntry(
      tally(name, byPerson[name], standardUsed), standardUsed);
    entry.department = personSection[name] || '';
    result.people.push(entry);
  });

  result.sources = [
    { name: 'In both reports',     count: both },
    { name: 'Department only',     count: deptOnly },
    { name: 'Overall report only', count: overallOnly }
  ];

  // Busiest first. For a single month this reproduces the cache's own
  // order; across months it is the only order that makes sense, since a
  // name's rank in January says nothing about its rank overall.
  result.departments.sort(kpi.byReceived);
  result.parts.sort(kpi.byReceived);
  result.people.sort(kpi.byReceived);

  return result;
}


/** Every month there are tickets for, newest first. */
async function monthsAvailable() {
  const rows = await db.query(
    `SELECT DISTINCT to_char(request_date AT TIME ZONE $1, 'YYYY-MM') AS month
       FROM ticket WHERE request_date IS NOT NULL ORDER BY month DESC`, [TZ]);
  return rows.map(function (r) { return r.month; });
}


module.exports = { readKpi1, monthsAvailable, scoredRows };
