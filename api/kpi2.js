/**
 * kpi2.js - SAP User Training Satisfaction & Feedback, the arithmetic.
 * ===========================================================================
 *
 * THE PORT OF Kpi2.gs AND THE FEEDBACK HALF OF Config.gs.
 *
 * KPI 2 asks a different question from KPI 1 and asks it of different data.
 * KPI 1 scores TICKETS by SECTION. This scores ANSWERS by MODULE - "that is
 * how the existing Department Summary is built, and the two axes are
 * genuinely different questions".
 *
 *
 * IT IS NOT A POLICY KPI, AND THAT HAS TO SURVIVE THE PORT.
 *
 * Config.gs is blunt about it: TVL-KPI-001 section 5.3 gives EAS three KPIs
 * and this is not one of them, so it "is not reported to TVL against the
 * policy and must never be presented as though it were". It stays because
 * the team wants it - "training feedback is the only thing here that says
 * anything about how the people on the other end of a ticket are finding the
 * system".
 *
 * `policy: false` is carried through so every screen can keep labelling it
 * INTERNAL rather than letting it sit silently beside three approved
 * indicators.
 *
 *
 * WHAT IS NOT IN THIS FILE
 *
 * The bands, the achievement curve, the headroom and round2 are in kpi.js
 * already. They are not KPI 1's arithmetic that KPI 2 borrows - they are the
 * company's scoring rules, which both KPIs are scored by. One copy.
 *
 *
 * NO REAL DATA IS IN THIS FILE.
 */

const { round2, bandFor, achievementFor, headroomFor } = require('./kpi');


/**
 * The KPI 2 standard. CONFIG.KPIS.FEEDBACK.
 *
 * Target 90, yellow floor 81 - and the floor is worth a note, because the
 * policy text used to contradict itself. Config.gs:
 *
 *   "The earlier policy text said Avg Score / Max Score; the signed
 *    definition sheet replaces it with a positive-response ratio, and
 *    resolves the old contradictory thresholds (<90 yellow AND <60 red) into
 *    a clean 81.00-89.99 band."
 */
const KPI_FEEDBACK = {
  id: 'KPI2',
  name: 'SAP User Training Satisfaction & Feedback',
  shortName: 'Training Feedback',
  policy: false,
  layer: 3,
  slaLayer: 'Layer 3: Service Requests',
  measure: 'Actual Success Rate (%)',
  formula: '(Total Positive Responses / Total Applicable Responses) x 100',
  target: 90.00,
  yellowFloor: 81.00,
  unit: '%',
  period: 'monthly',
  active: true
};


/**
 * Does a skipped question count against the rate?
 *
 * CONFIG.COUNT_NON_RESPONSES, and the reasoning is worth keeping where
 * somebody will find it:
 *
 *   "The signed definition says 'Total APPLICABLE Responses', which reads as
 *    excluding a question nobody answered. The existing workbook includes
 *    them: PP reports 1107/1120, and 1120 counts its 4 non-responses.
 *
 *    TRUE keeps the figures continuous with everything reported so far, and
 *    is the more conservative of the two - it can only lower the rate.
 *    Across all 667 respondents the difference is 97.19% against 97.28%, so
 *    it changes no band today."
 */
const COUNT_NON_RESPONSES = true;


/**
 * Answer text to tier. CONFIG.FEEDBACK_ANSWERS.
 *
 * DERIVED FROM THE EXISTING WORKBOOK, NOT INVENTED. Overall_Feedback.xlsx
 * covers 32 training sessions, 667 respondents and 4,669 answers, and its
 * Department Summary splits them into Excellent & Good / Average / Poor /
 * Not Responded. This mapping reproduces those four totals exactly -
 * 4,538 / 121 / 6 / 4 - with no answer left unclassified.
 *
 * The seven questions use four different wordings for the same idea, and the
 * forms changed over time, so every variant seen across all 32 files is
 * listed.
 *
 * POSITIVE is the numerator. AVERAGE and POOR sit in the denominator but not
 * the numerator.
 */
const FEEDBACK_ANSWERS = {
  POSITIVE: [
    'Excellent', 'Good',                                        // Q1, Q3, Q4
    'Highly relevant and very useful', 'Relevant and useful',    // Q2
    'Extremely helpful', 'Very helpful', 'Helpful',              // Q5
    'Much more confident', 'More confident', 'Confident',        // Q6
    'Appropriate', 'Mostly appropriate'                          // Q7
  ],
  AVERAGE: [
    'Average',                  // Q1, Q3, Q4
    'Somewhat relevant',        // Q2
    'Slightly helpful',         // Q5
    'Slightly more confident',  // Q6
    'Somewhat appropriate'      // Q7
  ],
  POOR: [
    'Poor',                     // Q1, Q3, Q4
    'Not more confident at all' // Q6
  ],
  NO_RESPONSE: [
    'No response', 'N/A', 'NA', '-'
  ]
};

/**
 * The order the tiers are applied in when the lookup is built.
 *
 * IT DOES NOT MATTER, AND THAT IS A PROPERTY OF THE MAP ABOVE RATHER THAN OF
 * THIS LINE. Mutation testing reversed this array and not one of 27,000
 * answers changed tier - because the four lists do not overlap, so whichever
 * is applied last has nothing to overwrite.
 *
 * Left as it is, with a test in kpi2-equivalence-test.js that fails the day
 * an answer appears in two of the lists. Without that test this constant
 * would look like a decision when it is an accident waiting to become one:
 * add 'Helpful' to AVERAGE without removing it from POSITIVE, and the order
 * silently starts deciding a tier.
 */
const TIER_ORDER = ['POSITIVE', 'AVERAGE', 'POOR', 'NO_RESPONSE'];


/**
 * The SAP modules training is reported against. CONFIG.TRAINING_MODULES.
 *
 * `match` is tried in this order and the FIRST hit wins, which is why the
 * order is not alphabetical.
 */
const TRAINING_MODULES = [
  { key: 'EACC', name: 'E-Accounting',
    match: ['e-accounting', 'e accounting', 'eaccounting'] },
  // 'fi' folded in from what used to be a separate FI module, so a bare-FI
  // filename lands in the same row as FI_TR rather than a row of its own.
  // 'tr' is deliberately not here: it is safe against a short Part value but
  // not against a filename, where too much begins with 'Tr'.
  { key: 'FITR', name: 'FI/TR',
    match: ['fi_tr', 'fi-tr', 'fitr', 'fi tr', 'fi'] },
  { key: 'MM',   name: 'MM',   match: ['inventory', 'purchase', 'mcd', 'mm'] },
  { key: 'MD',   name: 'MD',   match: ['md'] },
  { key: 'PP',   name: 'PP',   match: ['production', 'ypl', 'pp'] },
  { key: 'SD',   name: 'SD',   match: ['development', 'export', 'shipping', 'sd'] },
  { key: 'CO',   name: 'CO',   match: ['co'] }
];


/**
 * The three plant zones training is reported against. CONFIG.ZONES.
 *
 * A FIXED, KNOWN SET - which is why the KPI 2 screen seeds all three rather
 * than discovering them. "KEPZ ran nothing this month" is a finding, and a
 * row that vanishes hides it.
 */
const ZONES = [
  { key: 'KEPZ', name: 'KEPZ', match: ['kepz', 'karnaphuli'] },
  { key: 'CEPZ', name: 'CEPZ', match: ['cepz', 'chittagong', 'chattogram'] },
  { key: 'DEPZ', name: 'DEPZ', match: ['depz', 'dhaka'] }
];

/** Shown for a session whose file names no zone. */
const ZONE_UNSPECIFIED = 'Unspecified';

/**
 * Plant code to zone. CONFIG.PLANT_ZONES, which is empty today.
 *
 * Kept because zoneFor consults it BEFORE falling back to the filename, so
 * it is the place a plant code gets an authoritative answer the day somebody
 * fills it in. An empty object is not a missing feature; it is the honest
 * state of a lookup nobody has needed yet.
 */
const PLANT_ZONES = {};


/**
 * The trainers whose usual module answers for a file that names none.
 *
 * NOT IN THIS FILE, AND THAT IS DELIBERATE. CONFIG.TRAINER_MODULES is three
 * colleagues' names, and this repository is public. It lives in the
 * `trainer_module` table instead, filled by node api/import-roster.js, for
 * the same reason the org chart does - see db/12-roster.sql.
 *
 * So every function that needs it TAKES it. Passed nothing, they behave as
 * though the list were empty, which is the correct behaviour for a system
 * whose roster has not been imported yet: a file that names no module falls
 * through to '(unassigned)' and is reported, rather than being filed under a
 * guess.
 */
const NO_TRAINERS = [];


/**
 * The TRAINING tab, column by column, in its own order.
 *
 * [ the spreadsheet heading, the database column ]
 *
 * THE ORDER MATTERS, because feedback rows arrive from the browser as plain
 * arrays in exactly this order - the same arrangement, and for the same
 * reason, as the ticket columns in ticket-merge.js.
 *
 * 'Zone' is last because it was added last. Config.gs had to put it there:
 * "Existing rows were written at the old width and are addressed by
 * position, so a column inserted anywhere else would shift every value
 * already stored." A database column is addressed by name, so that
 * constraint is gone here - but the ORDER of this list still has to match
 * the sheet's, because the browser is still sending arrays.
 */
const TRAINING_COLUMNS = [
  ['Response ID',          'response_id'],
  ['Session Date',         'session_date'],
  ['Month',                'month'],
  ['Module',               'module'],
  ['Session Title',        'session_title'],
  ['Trainer',              'trainer'],
  ['Plant',                'plant'],
  ['Employee ID',          'employee_id'],
  ['Employee Name',        'employee_name'],
  ['Q1 Overall',           'q1_overall'],
  ['Q2 Relevance',         'q2_relevance'],
  ['Q3 Trainer Knowledge', 'q3_knowledge'],
  ['Q4 Explanation',       'q4_explanation'],
  ['Q5 Materials',         'q5_materials'],
  ['Q6 Confidence',        'q6_confidence'],
  ['Q7 Duration',          'q7_duration'],
  ['Source File',          'source_file'],
  ['Uploaded At',          'uploaded_at'],
  ['Zone',                 'zone']
];

/** The spreadsheet headings, in order. CONFIG.TRAINING_COLUMNS. */
const TRAINING_HEADERS = TRAINING_COLUMNS.map(function (c) { return c[0]; });

/** The database column names, in order. */
const TRAINING_NAMES = TRAINING_COLUMNS.map(function (c) { return c[1]; });

/** Where each column sits, so a caller can address one by name. */
const TRAINING_AT = (function () {
  const index = {};
  TRAINING_COLUMNS.forEach(function (c, i) { index[c[1]] = i; });
  return index;
})();

/** The two columns that hold a timestamp rather than text. */
const TRAINING_DATES = ['session_date', 'uploaded_at'];


/** The seven scored questions, in the order the form asks them. */
const QUESTION_LABELS = [
  'Overall training session',
  'Content relevance & usefulness',
  'Trainer knowledge & expertise',
  'Concept explanation & Q&A',
  'Training materials',
  'Confidence after training',
  'Duration & pace'
];


// ---------------------------------------------------------------------------
// Classifying one answer
// ---------------------------------------------------------------------------

/**
 * Strips a feedback answer down to something matchable.
 *
 * THE BRACKETS ARE THE WHOLE REASON THIS EXISTS. Config.gs:
 *
 *   "The forms carry a Bangla gloss in brackets - 'Excellent [...]' - and the
 *    bracket style varies between square and round across batches. One
 *    respondent answered 'Confident (...]' with mismatched brackets, so the
 *    gloss is removed by looking for either kind rather than by pairing
 *    them."
 *
 * Which is why there are two passes: the first removes a bracketed run, the
 * second sweeps up a bracket left on its own by a respondent who opened one
 * kind and closed another. Pairing them properly would have left that one
 * answer unclassified, and an unclassified answer depresses the rate.
 */
function normaliseAnswer(answer) {
  return String(answer === null || answer === undefined ? '' : answer)
    .replace(/[\(\[][^\)\]]*[\)\]]/g, ' ')   // drop the bracketed gloss
    .replace(/[\(\[\)\]]/g, ' ')             // and any orphaned bracket
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}


/**
 * Normalised answer -> tier, built from a map of tiers to answer lists.
 *
 * TAKES THE MAP, so a test can score a form wording that does not exist yet
 * without editing the real one. Defaults to FEEDBACK_ANSWERS, which is what
 * every caller uses.
 */
function answerTiers(answers) {
  const source = answers || FEEDBACK_ANSWERS;
  const tiers = {};

  TIER_ORDER.forEach(function (tier) {
    (source[tier] || []).forEach(function (answer) {
      const key = normaliseAnswer(answer);
      if (key) tiers[key] = tier;
    });
  });

  return tiers;
}

/* Built once for the default map. Rebuilding it per answer would be forty
   normalisations per respondent for a result that cannot change. */
const DEFAULT_TIERS = answerTiers();


/**
 * Which tier does one feedback answer fall into?
 *
 * UNKNOWN IS A REAL ANSWER AND NOT AN ERROR. Config.gs: "An answer nobody
 * anticipated returns 'UNKNOWN' rather than being quietly counted as
 * positive or quietly dropped. Unknowns are surfaced on the KPI 2 screen so
 * a new form wording gets noticed instead of silently moving the number."
 *
 * A blank is NO_RESPONSE, not UNKNOWN - somebody skipping a question is a
 * thing the form expects, and it has its own tier.
 *
 * @return {string} 'POSITIVE' | 'AVERAGE' | 'POOR' | 'NO_RESPONSE' | 'UNKNOWN'
 */
function answerTier(answer, answers) {
  const key = normaliseAnswer(answer);
  if (!key) return 'NO_RESPONSE';
  const tiers = answers ? answerTiers(answers) : DEFAULT_TIERS;
  return tiers[key] || 'UNKNOWN';
}


// ---------------------------------------------------------------------------
// Which module a session belongs to
// ---------------------------------------------------------------------------

/**
 * Which SAP module does a training file belong to?
 *
 * FROM THE FILENAME, because the feedback form itself has no module field.
 * First match wins. Matched at a word boundary so 'CO' does not fire on
 * 'Accounting' - which is not hypothetical, it is why the boundary is there.
 *
 * @param {string} fileName
 * @param {Array} [list] the module table, for testing
 * @return {string} module name, or '' when nothing matches
 */
function moduleFor(fileName, list) {
  const text = String(fileName || '').toLowerCase();
  const modules = list || TRAINING_MODULES;

  for (let i = 0; i < modules.length; i++) {
    const module = modules[i];
    for (let j = 0; j < module.match.length; j++) {
      const pattern = module.match[j].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp('(^|[^a-z0-9])' + pattern + '([^a-z0-9]|$)').test(text)) {
        return module.name;
      }
    }
  }

  return '';
}


/**
 * Which module does one RESPONSE belong to? Config.gs moduleForResponse.
 *
 * THREE SOURCES, IN ORDER, AND THE ORDER IS THE WHOLE RULE.
 *
 *   1. What the respondent answered. If the form asked and somebody typed a
 *      module, that is the answer and nothing overrides it.
 *   2. The filename, via moduleFor.
 *   3. The trainer's usual module - and ONLY as a fallback. Config.gs is
 *      explicit about why: one trainer runs sessions in two modules, so
 *      'Trainee Feedback- E-Accounting_<trainer>.xlsx' is filed as
 *      E-Accounting by its filename and never reaches this list. Only a file
 *      that names no module at all falls through to their usual one.
 *
 * Resolved when the figures are read, never frozen at upload. Correcting the
 * mapping re-files every affected response on the next page load, with
 * nothing to re-upload.
 *
 * @param {string} answered    the Module column of the response
 * @param {string} sourceFile  the file it arrived in
 * @param {Array} [trainers]   [{match, name}] from the trainer_module table
 * @return {string} module name, or ''
 */
function moduleForResponse(answered, sourceFile, trainers) {
  const said = String(answered === null || answered === undefined ? '' : answered).trim();
  if (said) return said;

  const byName = moduleFor(sourceFile);
  if (byName) return byName;

  const text = String(sourceFile || '').toLowerCase();
  const list = trainers || NO_TRAINERS;
  for (let i = 0; i < list.length; i++) {
    const pattern = String(list[i].match)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('(^|[^a-z0-9])' + pattern + '([^a-z0-9]|$)').test(text)) {
      return list[i].name;
    }
  }

  return '';
}


// ---------------------------------------------------------------------------
// Which zone a session was run in
// ---------------------------------------------------------------------------

/**
 * Reads a zone out of a piece of text, or ''. Config.gs matchZone.
 *
 * Matched at a word boundary so 'KEPZ' cannot fire inside a longer token -
 * 'DEPZONE' is not DEPZ. An exact name still wins outright, which is the
 * normal case for a dropdown answer.
 */
function matchZone(value, list) {
  const text = String(value === null || value === undefined ? '' : value)
    .trim().toLowerCase();
  if (!text) return '';

  const zones = list || ZONES;
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (text === zone.name.toLowerCase()) return zone.name;
    for (let j = 0; j < zone.match.length; j++) {
      if (new RegExp('(^|[^a-z0-9])' + zone.match[j] + '([^a-z0-9]|$)').test(text)) {
        return zone.name;
      }
    }
  }
  return '';
}


/**
 * Which zone, from the answer, the plant code, or the filename. Config.gs.
 *
 * Same shape of rule as moduleForResponse: what somebody said beats a lookup,
 * a lookup beats a guess from a filename, and a guess beats nothing.
 */
function zoneFor(sourceFile, plant, answered, zones, plantZones) {
  const said = matchZone(answered, zones);
  if (said) return said;

  const code = String(plant === null || plant === undefined ? '' : plant).trim();
  const table = plantZones || PLANT_ZONES;
  if (code && table[code]) return table[code];

  return matchZone(sourceFile, zones) || ZONE_UNSPECIFIED;
}


// ---------------------------------------------------------------------------
// Which period a response belongs to
// ---------------------------------------------------------------------------

/**
 * 'YYYY-MM' out of a date or a date-ish string. Code.gs monthKey.
 *
 * It reads the FIRST SEVEN CHARACTERS of a text value rather than parsing
 * it, which looks lazy and is not: '2026-08-20 19:59:35' and '2026-08-20'
 * both mean August, and handing either to `new Date` would reintroduce the
 * timezone question that ticket-merge.js exists to settle. The month is
 * already written in the text; there is nothing to work out.
 */
function monthKey(value) {
  if (!value) return '';

  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    return y + '-' + m;
  }

  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})/);
  return match ? match[1] + '-' + match[2] : '';
}


/** 2026 + 1 -> '2026-Q1'. Two-digit years become 20xx. Config.gs. */
function quarterKeyFrom(year, quarter) {
  let y = Number(year);
  if (!isFinite(y) || !y) return '';
  if (y < 100) y += 2000;
  if (y < 2000 || y > 2099) return '';
  return y + '-Q' + Number(quarter);
}


/**
 * The quarter a file NAMES, or ''. Config.gs quarterFromFileName.
 *
 * WHY THE FILENAME BEATS THE SESSION DATE, which is the surprising part.
 * Kpi2.gs: "a file named Q1-2026 whose dates Excel turned into January 1974
 * belongs in Q1 2026, and filtering by month would drop it". The person who
 * named the file knew which quarter it was; the date column has been through
 * a spreadsheet.
 *
 * Both orders are read - 'Q1-2026' and '2026-Q1' - and the q must start a
 * token, so 'FAQ1-2026' cannot fire.
 */
function quarterFromFileName(fileName) {
  const text = String(fileName === null || fileName === undefined ? '' : fileName).trim();
  if (!text) return '';

  let found = text.match(/(?:^|[^a-z0-9])q\s*([1-4])\s*[-_. \/]\s*(\d{4}|\d{2})(?!\d)/i);
  if (found) return quarterKeyFrom(found[2], found[1]);

  found = text.match(/(?:^|[^0-9])(\d{4}|\d{2})\s*[-_. \/]?\s*q\s*([1-4])(?!\d)/i);
  if (found) return quarterKeyFrom(found[1], found[2]);

  return '';
}


// ---------------------------------------------------------------------------
// The KPI itself
// ---------------------------------------------------------------------------

/**
 * Turns counted answers into the KPI. Kpi2.gs scoreFeedback.
 *
 * @param {{name, respondents, positive, average, poor, noResponse, unknown}} b
 * @param {Object} [kpi] defaults to KPI_FEEDBACK
 *
 * THE DENOMINATOR IS THE DECISION WORTH UNDERSTANDING, and there are two
 * halves to it.
 *
 * COUNT_NON_RESPONSES decides whether a skipped question counts - see that
 * constant.
 *
 * An UNKNOWN answer always counts in the denominator and never in the
 * numerator. "That is the safe direction: an unrecognised wording depresses
 * the rate and shows up on screen, rather than quietly inflating it."
 *
 * NO DATA IS NOT ZERO PER CENT. A module with no applicable answers gets
 * band 'NO DATA' and achievement 0, not a rate of 0 and a red band - there
 * is a difference between "they scored nothing" and "nobody asked".
 */
function scoreFeedback(b, kpi) {
  const standard = kpi || KPI_FEEDBACK;

  const positive   = Number(b.positive) || 0;
  const average    = Number(b.average) || 0;
  const poor       = Number(b.poor) || 0;
  const unknown    = Number(b.unknown) || 0;
  const noResponse = Number(b.noResponse) || 0;

  const answered = positive + average + poor + unknown;
  const applicable = COUNT_NON_RESPONSES ? answered + noResponse : answered;

  const rate = applicable ? (positive / applicable) * 100 : 0;

  return {
    name:        b.name,
    respondents: Number(b.respondents) || 0,
    responses:   answered + noResponse,
    positive:    positive,
    average:     average,
    poor:        poor,
    noResponse:  noResponse,
    unknown:     unknown,
    applicable:  applicable,
    rate:        round2(rate),
    /*
      THE TWO GUARDS ARE NOT BOTH LOAD-BEARING, and it is worth knowing
      which is which before somebody tidies one away.

      The band guard IS: bandFor(0) is RED, so without it a module nobody
      was asked about reads as a failing one.

      The achievement guard is NOT: achievementFor is (rate / target) * 100,
      so at a rate of 0 it already returns 0. Removing it changes nothing -
      mutation testing confirmed that. Kept because it is the original's
      line, and because it says in the code that no data is not nought per
      cent, which is the thing a reader needs to know.
    */
    achievement: round2(applicable ? achievementFor(rate, standard) : 0),
    band:        applicable ? bandFor(rate, standard) : 'NO DATA',
    // How many more non-positive answers before the band drops. Same idea as
    // KPI 1's headroom: a percentage alone does not say how close it ran.
    headroom:    headroomFor(applicable, positive, standard)
  };
}


/** Busiest module first. Kpi2.gs byRespondents. */
function byRespondents(a, b) {
  return b.respondents - a.respondents;
}


module.exports = {
  KPI_FEEDBACK, COUNT_NON_RESPONSES, FEEDBACK_ANSWERS, TIER_ORDER,
  TRAINING_MODULES, QUESTION_LABELS,
  TRAINING_COLUMNS, TRAINING_HEADERS, TRAINING_NAMES, TRAINING_AT, TRAINING_DATES,
  ZONES, ZONE_UNSPECIFIED, PLANT_ZONES, NO_TRAINERS,
  normaliseAnswer, answerTiers, answerTier, moduleFor, moduleForResponse,
  matchZone, zoneFor,
  monthKey, quarterKeyFrom, quarterFromFileName,
  scoreFeedback, byRespondents
};
