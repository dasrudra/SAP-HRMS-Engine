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
const modules = require('./modules');

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
  const byModule = {};
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
      MODULES ARE GROUPED HERE, not rolled up from the Part rows above, and
      Kpi.gs says why: "a Part that names no module has to fall through to
      the person who handled the ticket - and only the ticket row carries
      both columns."

      A Part row knows its Part and nothing about who handled it, so
      summing Part rows into modules would file every unlabelled Part under
      '(unassigned)' instead of under the module of the person who did the
      work.
    */
    /*
      THE MONTH IS PASSED AND CURRENTLY CHANGES NOTHING, which is worth
      saying rather than leaving as a puzzle. moduleForPerson reads the
      section at TODAY'S names whatever month the ticket is from -
      'Functional Applications' covered three modules at once and cannot
      name just one - so the month never reaches a decision. Replacing it
      with null is an equivalent mutation: no test can catch it, because
      there is no behaviour to catch.

      It stays because moduleForTicket takes it in Config.gs and a port
      that quietly drops an argument is a port that has decided something.
    */
    kpi.groupByKey(scored, function (r) {
      return modules.moduleForTicket(index, r.part, r.in_charge, m);
    }).forEach(function (g) {
      (byModule[g.key] = byModule[g.key] || []).push.apply(byModule[g.key], g.rows);
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
  Object.keys(byModule).forEach(function (name) {
    result.modules.push(
      kpi.finaliseEntry(tally(name, byModule[name], standardUsed), standardUsed));
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
  result.modules.sort(kpi.byReceived);
  result.people.sort(kpi.byReceived);

  return result;
}


/**
 * KPI 1 across several months at once.   [Kpi.gs:825 getKpiComparison]
 *
 * ONE PASS, NOT ONE readKpi1 PER MONTH. Six months would otherwise be six
 * scans of the same table, which is the same reason the original reads its
 * cache once and buckets by month rather than calling getKpi1 six times.
 *
 * COUNTS ARE FACTS. JUDGEMENTS ARE RECOMPUTED. The original stores eight
 * numbers per row and is emphatic that they are not the same kind of
 * thing, because reading the stored verdicts back was a live defect:
 *
 *   "The Comparison screen showed Sales Applications at 99.08% for August
 *    marked YELLOW, while the KPI 1 screen showed the same section, the
 *    same month and the same 99.08% marked GREEN - because one recomputed
 *    and the other did not. It was almost invisible: every other cell in
 *    that table was above 99.50% as well as above 90%, so only the single
 *    section that fell between the two targets showed the disagreement.
 *    Achievement and Headroom were wrong in every cell and simply looked
 *    plausible - 100.13% instead of 110.70%, +4 instead of +308."
 *
 * There is nothing stored to read back here, so that defect cannot recur -
 * every figure on this screen is worked out from the tickets when the
 * screen is drawn, by the same functions KPI 1 uses.
 *
 * AND IT FOLLOWS THE SAME STANDARD TOGGLE, for the same reason: the two
 * screens read the same counts, so judging them against different targets
 * would put the same section in the same month in two different bands.
 */
async function kpiComparison(months, standard) {
  const standardUsed = kpi.resolutionStandard(standard);
  const wanted = {};
  (months || []).forEach(function (m) {
    const text = String(m || '').trim();
    if (text) wanted[text] = true;
  });

  const result = {
    periods: Object.keys(wanted).sort(),
    sections: [],
    totals: {},        // period -> entry
    bySection: {},     // section -> { period -> entry }
    target: standardUsed.target,
    standard: standardUsed.standard,
    standardLabel: standardUsed.standardLabel,

    /*
      THE SCREEN RENDERS WHAT THE KPI DECLARES HERE rather than hardcoding
      KPI 1's columns, so the same table can draw KPI 2 without a second
      implementation. A KPI also names its own reporting period: tickets
      arrive daily so KPI 1 is read month by month, training runs a few
      times a quarter so KPI 2 is read quarter by quarter. Taking that from
      here is what stops one of them being mislabelled.
    */
    kpi: 'KPI1',
    name: standardUsed.name || 'Error/Issue Resolution Time',
    unit: '%',
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

  if (!result.periods.length) return result;

  const rows = await scoredRows(wanted);
  if (!rows.length) return result;

  const byMonth = {};
  rows.forEach(function (r) {
    if (r.month) (byMonth[r.month] = byMonth[r.month] || []).push(r);
  });

  const index = await roster.loadIndex();
  const seen = {};

  Object.keys(byMonth).sort().forEach(function (m) {
    const all = byMonth[m];
    const deptRows = all.filter(function (r) { return r.in_dept === true; });
    const usingDept = deptRows.length > 0;
    const scored = usingDept ? deptRows : all;

    result.totals[m] = kpi.finaliseEntry(tally(m, scored, standardUsed),
                                         standardUsed);

    // A month with no department file has no section rows, exactly as the
    // original's cache has none to read - a breakdown by section of a
    // population that includes non-EAS engineers is not a breakdown of EAS.
    if (!usingDept) return;

    kpi.groupByKey(scored, function (r) {
      return roster.sectionFor(index, r.in_charge, m, r.department);
    }).forEach(function (g) {
      if (!seen[g.key]) { seen[g.key] = true; result.sections.push(g.key); }
      (result.bySection[g.key] = result.bySection[g.key] || {})[m] =
        kpi.finaliseEntry(tally(g.key, g.rows, standardUsed), standardUsed);
    });
  });

  // Alphabetical, not busiest-first: this table's rows are a fixed list of
  // sections read across several columns, and a row that moved between
  // months would be unreadable.
  result.sections.sort();
  return result;
}


/** Every month there are tickets for, newest first. */
async function monthsAvailable() {
  const rows = await db.query(
    `SELECT DISTINCT to_char(request_date AT TIME ZONE $1, 'YYYY-MM') AS month
       FROM ticket WHERE request_date IS NOT NULL ORDER BY month DESC`, [TZ]);
  return rows.map(function (r) { return r.month; });
}


// ---------------------------------------------------------------------------
// By affiliate   [Kpi.gs:492 readAffiliateList, Kpi.gs:524 readPeopleByAffiliate]
// ---------------------------------------------------------------------------
/*
  AN AFFILIATE IS A FACT ABOUT A TICKET, NOT ABOUT A PERSON.

  Nobody belongs to KSL; tickets do. That is why this is the one filter on
  the KPI 1 screen that RECOMPUTES rather than hides rows: there is no other
  thing "show me KSL" could honestly mean. Every other filter there narrows
  a list that has already been scored.

  It also explains why these two functions exist at all instead of the
  affiliate being another grouping inside readKpi1. The original kept a
  monthly cache with no affiliate column in it, so the filter had to go back
  to the tickets; this port has no cache, but the reason to keep it separate
  survives - the figures a person has under one affiliate are not a slice of
  their overall figures that anything else on the screen shows.

  A blank affiliate is a real answer and is counted as '(none given)'.
  Hiding those rows would make the filtered totals disagree with the
  unfiltered ones for no reason anybody could see.
*/

/** Every affiliate in scope, busiest first. */
async function affiliateList(month) {
  const wanted = kpi.monthsInScope(month);
  /*
    THE TIMEZONE GOES IN ONLY IF THE QUERY ASKS FOR IT.

    This started as `const args = [TZ]` with the month clause appended, the
    way scoredRows does it - but scoredRows always names $1 in its SELECT
    list and this one names it only inside the WHERE. On 'ALL months' there
    is no WHERE, so $1 appeared nowhere and PostgreSQL refused the whole
    statement: "bind message supplies 1 parameters, but prepared statement
    requires 0". A parameter list has to match what the SQL actually
    references, not what it might have.
  */
  const args = [];
  let where = '';

  if (wanted) {
    const months = Object.keys(wanted);
    if (!months.length) return [];
    args.push(TZ, months);
    where = " AND to_char(request_date AT TIME ZONE $1, 'YYYY-MM') = ANY($2)";
  }

  const rows = await db.query(
    `SELECT coalesce(nullif(btrim(affiliate), ''), '(none given)') AS name,
            count(*)::int AS tickets
       FROM ticket
      WHERE request_date IS NOT NULL` + where + `
      GROUP BY 1
      ORDER BY tickets DESC, name`, args);

  return rows.map(function (r) { return { name: r.name, tickets: r.tickets }; });
}


/**
 * One affiliate's people, scored from that affiliate's tickets alone.
 *
 * @param month     'YYYY-MM', 'YYYY-Qn', a comma list, or 'ALL'
 * @param affiliate the affiliate to score, or '' for everybody
 * @param standard  the same standard the rest of the table is read under -
 *                  otherwise these rows are banded against one target while
 *                  the rows above them are banded against the other
 */
async function peopleByAffiliate(month, affiliate, standard) {
  const standardUsed = kpi.resolutionStandard(standard);
  const want = String(affiliate || '').trim();
  const wanted = kpi.monthsInScope(month);

  const out = { affiliate: want, affiliates: [], people: [], hasData: false,
                standard: standardUsed.standard };

  const args = [TZ];
  let where = '';
  if (wanted) {
    const months = Object.keys(wanted);
    if (!months.length) return out;
    args.push(months);
    where = " AND to_char(request_date AT TIME ZONE $1, 'YYYY-MM') = ANY($2)";
  }

  const rows = await db.query(
    `SELECT to_char(request_date AT TIME ZONE $1, 'YYYY-MM') AS month,
            in_charge, department,
            coalesce(nullif(btrim(affiliate), ''), '(none given)') AS affiliate,
            completion_date, delay_days
       FROM ticket
      WHERE request_date IS NOT NULL` + where, args);

  const index = await roster.loadIndex();
  const seen = {};
  const byPerson = {};
  const sections = {};

  rows.forEach(function (r) {
    seen[r.affiliate] = (seen[r.affiliate] || 0) + 1;
    if (want && r.affiliate !== want) return;

    const who = String(r.in_charge || '').trim();
    if (!who) return;

    (byPerson[who] || (byPerson[who] = [])).push(r);
    // The last month seen wins, so somebody who moved mid-year is shown
    // under the section they are in now - the rule the main table follows.
    const section = roster.sectionFor(index, who, r.month, r.department);
    if (section) sections[who] = section;
  });

  out.affiliates = Object.keys(seen)
    .sort(function (a, b) { return seen[b] - seen[a] || (a < b ? -1 : 1); })
    .map(function (name) { return { name: name, tickets: seen[name] }; });

  out.people = Object.keys(byPerson).map(function (name) {
    const entry = kpi.finaliseEntry(
      tally(name, byPerson[name], standardUsed), standardUsed);
    entry.department = sections[name] || '';
    return entry;
  }).sort(kpi.byReceived);

  out.hasData = out.people.length > 0;
  return out;
}


module.exports = { readKpi1, kpiComparison, monthsAvailable, scoredRows,
                   affiliateList, peopleByAffiliate };
