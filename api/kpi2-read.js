/**
 * kpi2-read.js - KPI 2 off the training table. Kpi2.gs getKpi2.
 * ===========================================================================
 *
 * The arithmetic is in kpi2.js and is proved identical to the original. This
 * is the part that reads rows and puts them in buckets.
 *
 *
 * THE SHAPE OF THE ANSWER IS THE ORIGINAL'S, KEY FOR KEY, because App.html
 * reads it and the page is ported separately. Totals, modules, zones,
 * quarters, sessions, questions, trainers - and the three lists of things
 * that could not be resolved, which matter more than they look:
 *
 *   unknownAnswers   a form wording nobody anticipated. It counts against
 *                    the rate, so it must be visible or the number moves
 *                    for no reason anybody can see.
 *   unassignedFiles  files whose module the filename did not name. They pool
 *                    into '(unassigned)', "which answers no question at all
 *                    unless you can see which files went into it".
 *   undatedFiles     files whose name carries no quarter, so the quarter had
 *                    to come from the session date - the unreliable source.
 *
 *
 * ONE DIFFERENCE FROM THE ORIGINAL, AND IT IS THE TIMEZONE AGAIN
 *
 * getKpi2 reads the month as monthKey(MONTH) || monthKey(SESSION_DATE), and
 * the second half hands a Date to monthKey, which reads it with
 * getFullYear() - in the timezone of whatever is running. Sheets made that
 * safe by accident: the script's timezone is Asia/Dhaka.
 *
 * A timestamptz read into Node is a Date too, and on a server set to UTC a
 * session at 02:00 on 1 September in Dhaka is 20:00 on 31 August - so the
 * month, and the quarter, and the figure, all move. The same bug
 * ticket-merge.js was fixed for.
 *
 * So the month comes out of the DATABASE already rendered, with
 * AT TIME ZONE 'Asia/Dhaka' said once in the query. monthKey still runs on
 * the stored Month column, which is text and has no timezone to get wrong.
 *
 *
 * NO REAL DATA IS IN THIS FILE.
 */

const db = require('./db');
const kpi2 = require('./kpi2');
const { ALL_MONTHS, monthsInScope, quarterOf, quarterLabel } = require('./kpi');

const TZ = 'Asia/Dhaka';

/** Shown for a response whose quarter nothing could establish. Kpi2.gs. */
const NO_QUARTER = '(no quarter)';

/** Shown for a response whose module nothing could establish. */
const UNASSIGNED = '(unassigned)';


/** Quarter keys in time order, with '(no quarter)' last rather than first. */
function byQuarterKey(a, b) {
  const av = a === NO_QUARTER ? 1 : 0;
  const bv = b === NO_QUARTER ? 1 : 0;
  if (av !== bv) return av - bv;
  return a < b ? -1 : a > b ? 1 : 0;
}


/** One scored group, flattened into the shape the Comparison screen reads. */
function comparisonEntry(s) {
  return {
    respondents: s.respondents,
    responses:   s.responses,
    positive:    s.positive,
    notPositive: s.responses - s.positive,
    rate:        s.rate,
    achievement: s.achievement,
    band:        s.band,
    headroom:    s.headroom
  };
}


// ---------------------------------------------------------------------------
// The aggregation
// ---------------------------------------------------------------------------

/**
 * Buckets a set of responses and scores every grouping. getKpi2's body.
 *
 * TAKES THE ROWS, DOES NO I/O. So it can be tested against a fixture with no
 * database, and so the comparison screen can score four quarters without
 * four round trips deciding how long the page takes.
 *
 * @param {Object[]} rows     from readKpi2's query
 * @param {Object} [opts]     { scope, trainers, kpi }
 */
function scoreResponses(rows, opts) {
  const o = opts || {};
  const scope = o.scope === undefined ? ALL_MONTHS : o.scope;
  const trainers = o.trainers || kpi2.NO_TRAINERS;
  const kpi = o.kpi || kpi2.KPI_FEEDBACK;

  const wanted = monthsInScope(scope, 'FEEDBACK');

  /*
    ASKING FOR A QUARTER IS ANSWERED BY THE QUARTER EACH RESPONSE RESOLVES
    TO, not by its month. Kpi2.gs: those are the same thing only while the
    session dates are trustworthy, "and they are not: a file named Q1-2026
    whose dates Excel turned into January 1974 belongs in Q1 2026, and
    filtering by month would drop it".
  */
  const wantedQuarter = /^\d{4}-Q[1-4]$/.test(String(scope || '')) ? scope : '';

  const result = {
    scope: scope,
    allMonths: scope === ALL_MONTHS,
    monthsCovered: 0,
    hasData: false,
    target: kpi.target,
    yellowFloor: kpi.yellowFloor,
    total: null,
    modules: [], zones: [], quarters: [], sessions: [], questions: [],
    trainers: [],
    unknownAnswers: [], unassignedFiles: [], undatedFiles: []
  };

  const monthsSeen = {};
  const unknown = {};
  const unassigned = {};
  const undated = {};

  function blank(name) {
    return { name: name, respondents: 0, positive: 0, average: 0,
             poor: 0, noResponse: 0, unknown: 0 };
  }
  function bucket(store, order, key, name) {
    if (!store[key]) { store[key] = blank(name); order.push(key); }
    return store[key];
  }

  const overall = blank('EAS overall');
  const byModule = {}, moduleOrder = [];
  const bySession = {}, sessionOrder = [];
  const byTrainer = {}, trainerOrder = [];
  const byQuarter = {}, quarterOrder = [];
  const byQuestion = kpi2.QUESTION_LABELS.map(function (l) { return blank(l); });

  /*
    Zones are a fixed, known set, so they are SEEDED rather than discovered.
    "A zone with no training in the period stays on the table showing zero -
    'KEPZ ran nothing this month' is a finding, and a row that vanishes
    hides it." Unspecified is added only if something actually lands there.
  */
  const byZone = {}, zoneOrder = [];
  kpi2.ZONES.forEach(function (z) {
    byZone[z.name] = blank(z.name);
    byZone[z.name].sessionsSeen = {};
    zoneOrder.push(z.name);
  });

  const QCOLS = ['q1_overall', 'q2_relevance', 'q3_knowledge', 'q4_explanation',
                 'q5_materials', 'q6_confidence', 'q7_duration'];

  (rows || []).forEach(function (r) {
    if (!String(r.response_id || '').trim()) return;

    // See the timezone note at the top: session_month arrives already
    // rendered in Dhaka by the query.
    const month = kpi2.monthKey(r.month) || String(r.session_month || '');

    const namedQuarter = kpi2.quarterFromFileName(r.source_file);
    const quarterKey = namedQuarter || quarterOf(month, 'FEEDBACK');

    if (wantedQuarter) { if (quarterKey !== wantedQuarter) return; }
    else if (wanted && !wanted[month]) return;

    if (month) monthsSeen[month] = true;
    if (!namedQuarter) {
      const named = String(r.source_file || '').trim() || '(no source file)';
      if (!undated[named]) undated[named] = { respondents: 0, quarter: quarterKey };
      undated[named].respondents++;
    }

    const moduleName =
      kpi2.moduleForResponse(r.module, r.source_file, trainers) || UNASSIGNED;
    if (moduleName === UNASSIGNED) {
      const from = String(r.source_file || '').trim() || '(no source file)';
      unassigned[from] = (unassigned[from] || 0) + 1;
    }

    const sessionName = String(r.session_title || '').trim() || '(untitled session)';
    const trainerName = String(r.trainer || '').trim() || '(unnamed)';
    const zoneName = kpi2.zoneFor(r.source_file, r.plant, r.zone);

    const m = bucket(byModule,  moduleOrder,  moduleName,  moduleName);
    const s = bucket(bySession, sessionOrder, sessionName, sessionName);
    const t = bucket(byTrainer, trainerOrder, trainerName, trainerName);
    const z = bucket(byZone,    zoneOrder,    zoneName,    zoneName);
    const qk = quarterKey || NO_QUARTER;
    const q = bucket(byQuarter, quarterOrder, qk,
                     quarterKey ? quarterLabel(quarterKey) : NO_QUARTER);

    if (!z.sessionsSeen) z.sessionsSeen = {};
    z.sessionsSeen[sessionName] = true;

    overall.respondents++; m.respondents++; s.respondents++; t.respondents++;
    z.respondents++; q.respondents++;
    q.sessionsSeen = q.sessionsSeen || {};
    q.sessionsSeen[sessionName] = true;

    for (let i = 0; i < QCOLS.length; i++) {
      const answer = r[QCOLS[i]];
      const tier = kpi2.answerTier(answer);

      if (tier === 'UNKNOWN') {
        const text = String(answer || '').trim();
        unknown[text] = (unknown[text] || 0) + 1;
      }

      const field = tier === 'POSITIVE' ? 'positive'
                  : tier === 'AVERAGE'  ? 'average'
                  : tier === 'POOR'     ? 'poor'
                  : tier === 'UNKNOWN'  ? 'unknown'
                  : 'noResponse';

      overall[field]++; m[field]++; s[field]++; t[field]++; z[field]++;
      q[field]++;
      byQuestion[i][field]++;
      byQuestion[i].respondents++;
    }
  });

  result.monthsCovered = Object.keys(monthsSeen).length;
  if (!overall.respondents) return result;

  const score = function (b) { return kpi2.scoreFeedback(b, kpi); };

  result.hasData = true;
  result.total = score(overall);
  result.modules = moduleOrder.map(function (k) { return score(byModule[k]); })
                              .sort(kpi2.byRespondents);
  result.sessions = sessionOrder.map(function (k) { return score(bySession[k]); })
                                .sort(kpi2.byRespondents);

  // Zones keep their configured order - KEPZ, CEPZ, DEPZ - with Unspecified
  // last, "because the reader is comparing three known places, not ranking
  // them".
  result.zones = zoneOrder.map(function (k) {
    const scored = score(byZone[k]);
    scored.sessions = Object.keys(byZone[k].sessionsSeen || {}).length;
    return scored;
  });

  result.trainers = trainerOrder.map(function (k) { return score(byTrainer[k]); })
                                .sort(kpi2.byRespondents);

  // Quarters read left to right in time, NEVER by size - "a trend is the
  // whole point of the grouping, and sorting it by volume destroys one".
  result.quarters = quarterOrder.slice().sort(byQuarterKey).map(function (k) {
    const scored = score(byQuarter[k]);
    scored.key = k;
    scored.sessions = Object.keys(byQuarter[k].sessionsSeen || {}).length;
    return scored;
  });

  // Questions keep their form order - Q1 to Q7 is how the survey reads.
  result.questions = byQuestion.map(score);

  result.unknownAnswers = Object.keys(unknown).map(function (text) {
    return { answer: text, count: unknown[text] };
  }).sort(function (a, b) { return b.count - a.count; });

  result.unassignedFiles = Object.keys(unassigned).map(function (name) {
    return { fileName: name, respondents: unassigned[name] };
  }).sort(function (a, b) { return b.respondents - a.respondents; });

  result.undatedFiles = Object.keys(undated).map(function (name) {
    return {
      fileName: name,
      respondents: undated[name].respondents,
      quarter: undated[name].quarter,
      quarterLabel: undated[name].quarter ? quarterLabel(undated[name].quarter) : ''
    };
  }).sort(function (a, b) { return b.respondents - a.respondents; });

  return result;
}


// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The trainer fallback list, out of the table rather than out of the code. */
async function trainerList() {
  return (await db.query(
    'SELECT match_key, module FROM trainer_module ORDER BY match_key'))
    .map(function (r) { return { match: r.match_key, name: r.module }; });
}


/**
 * Every response, with its month rendered in Dhaka by the database.
 *
 * NOT FILTERED BY MONTH IN SQL, and that is deliberate rather than lazy. A
 * response's period can come from its filename, which the database cannot
 * parse - so narrowing here would drop exactly the rows the filename rule
 * exists to rescue. 667 rows is nothing to read; the filtering happens in
 * scoreResponses, where the rule lives.
 */
async function allResponses() {
  return db.query(
    `SELECT response_id, month, module, session_title, trainer, plant, zone,
            source_file,
            q1_overall, q2_relevance, q3_knowledge, q4_explanation,
            q5_materials, q6_confidence, q7_duration,
            coalesce(to_char(session_date AT TIME ZONE $1, 'YYYY-MM'), '')
              AS session_month
       FROM training
      ORDER BY response_id`, [TZ]);
}


/** KPI 2 for one scope. getKpi2. */
async function readKpi2(scope) {
  const [rows, trainers] = await Promise.all([allResponses(), trainerList()]);
  return scoreResponses(rows, { scope: scope, trainers: trainers });
}


/**
 * KPI 2 quarter by quarter, shaped exactly like KPI 1's comparison.
 *
 * WHY QUARTERS AND NOT MONTHS. Kpi2.gs: "a module is trained once or twice a
 * quarter, so a month-by-month reading is mostly empty columns and the rest
 * carry a rate over a handful of responses. Comparing two of those compares
 * noise."
 *
 * ONE READ, NOT ONE PER PERIOD. The original called getKpi2 per period, and
 * each call re-read the whole tab. Here the rows are fetched once and scored
 * once per period, which is the same answer for a fraction of the work.
 */
async function kpi2Comparison(periods) {
  const kpi = kpi2.KPI_FEEDBACK;
  const list = (periods || []).slice().sort();

  const result = {
    kpi: 'KPI2',
    name: kpi.name,
    periods: list,
    sections: [],
    bySection: {},
    totals: {},
    target: kpi.target,
    unit: '%',
    periodKind: 'QUARTER',
    periodLabel: 'Quarter',
    periodLabelPlural: 'quarters',
    sectionLabel: 'Module',
    rateLabel: 'Success Rate',
    volumeKey: 'respondents',
    volumeLabel: 'Attendees trained',
    measures: [
      { key: 'respondents', label: 'Attendees' },
      { key: 'responses',   label: 'Responses' },
      { key: 'positive',    label: 'Positive' },
      { key: 'notPositive', label: 'Not positive' }
    ]
  };

  if (!list.length) return result;

  const [rows, trainers] = await Promise.all([allResponses(), trainerList()]);
  const seen = {};

  list.forEach(function (period) {
    const k = scoreResponses(rows, { scope: period, trainers: trainers });
    if (!k.hasData) return;

    result.totals[period] = comparisonEntry(k.total);

    k.modules.forEach(function (m) {
      if (!seen[m.name]) { seen[m.name] = true; result.sections.push(m.name); }
      (result.bySection[m.name] = result.bySection[m.name] || {})[period] =
        comparisonEntry(m);
    });
  });

  result.sections.sort();
  return result;
}


/** Which months have training feedback loaded. Newest first. */
async function feedbackMonths() {
  const rows = await db.query(
    `SELECT DISTINCT
            coalesce(nullif(btrim(month), ''),
                     to_char(session_date AT TIME ZONE $1, 'YYYY-MM')) AS m
       FROM training
      WHERE coalesce(nullif(btrim(month), ''),
                     to_char(session_date AT TIME ZONE $1, 'YYYY-MM')) IS NOT NULL
      ORDER BY m DESC`, [TZ]);

  return rows.map(function (r) { return r.m; }).filter(Boolean);
}


/**
 * Which quarters have training feedback. Newest first.
 *
 * DONE IN JAVASCRIPT, NOT IN SQL, because a quarter can come from the
 * FILENAME and the database cannot read one out of 'Feedback Q1-2026.xlsx'.
 * A query that grouped by month would miss precisely the files whose dates
 * are wrong, which are the ones the filename rule exists for.
 */
async function feedbackQuarters() {
  const rows = await db.query(
    `SELECT month, source_file,
            coalesce(to_char(session_date AT TIME ZONE $1, 'YYYY-MM'), '')
              AS session_month
       FROM training`, [TZ]);

  const seen = {};
  rows.forEach(function (r) {
    const month = kpi2.monthKey(r.month) || String(r.session_month || '');
    const key = kpi2.quarterFromFileName(r.source_file) ||
                quarterOf(month, 'FEEDBACK');
    if (key) seen[key] = true;
  });

  return Object.keys(seen).sort().reverse();
}


module.exports = {
  NO_QUARTER, UNASSIGNED,
  byQuarterKey, comparisonEntry, scoreResponses,
  trainerList, allResponses,
  readKpi2, kpi2Comparison, feedbackMonths, feedbackQuarters
};
