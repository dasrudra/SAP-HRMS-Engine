/**
 * Kpi2.gs — the calculation engine for KPI 2, SAP User Training Satisfaction
 * & Feedback.
 *
 * THE FORMULA (Layer 3 TVL-EAS KPI, SAP User Training Feedback, signed)
 *
 *   Actual Success Rate (%) = (Total Positive Responses / Total Applicable Responses) x 100
 *   KPI Achievement (%)     = (Actual Success Rate / Target Success Rate) x 100
 *
 *   Target 90.00%   GREEN >= 90.00   YELLOW 81.00-89.99   RED < 81.00
 *
 * Verified against the definition sheet's worked example: 76 positive of 77
 * applicable is 98.7%, achievement 109.7%.
 *
 * THE UNIT OF MEASUREMENT IS A RESPONSE, NOT A RESPONDENT
 * Each attendee answers seven scored questions, so fifteen attendees produce
 * one hundred and five responses. The rate is over responses. That is how the
 * existing Overall_Feedback workbook counts — its "Total Responses" column is
 * respondents x 7 — and this engine reproduces its figures exactly.
 *
 * NO CACHE
 * KPI 1 precomputes into KPI_MONTHLY because it scores tens of thousands of
 * tickets. Training feedback is a few hundred rows a year, so this reads the
 * TRAINING tab and scores live. One less thing that can go stale.
 */


/**
 * Everything the KPI 2 screen needs.
 *
 * @param {string} scope  'ALL', a month 'YYYY-MM', or a quarter '2026-Q3'
 * @return {Object}
 */
function getKpi2(scope) {
  const kpi = CONFIG.KPI.FEEDBACK;
  const wanted = monthsInScope(scope);

  const result = {
    scope: scope,
    allMonths: scope === ALL_MONTHS,
    monthsCovered: 0,
    hasData: false,
    target: kpi.target,
    yellowFloor: kpi.yellowFloor,
    total: null,
    modules: [],
    sessions: [],
    questions: [],
    trainers: [],
    // Answers no one anticipated. Surfaced rather than swallowed — a new form
    // wording that silently counted as positive would move the KPI without
    // anyone noticing.
    unknownAnswers: []
  };

  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;

  const width = CONFIG.TRAINING_COLUMNS.length;
  const rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();

  const COL2 = trainingColumns();
  const monthsSeen = {};
  const unknown = {};

  // One accumulator shape, used for every grouping.
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
  const byQuestion = QUESTION_LABELS.map(function (label) { return blank(label); });

  rows.forEach(function (r) {
    if (!String(r[COL2.RESPONSE_ID] || '').trim()) return;

    const month = monthKey(r[COL2.MONTH]) || monthKey(r[COL2.SESSION_DATE]);
    if (wanted && !wanted[month]) return;
    if (month) monthsSeen[month] = true;

    const moduleName  = String(r[COL2.MODULE]  || '').trim() || '(unassigned)';
    const sessionName = String(r[COL2.TITLE]   || '').trim() || '(untitled session)';
    const trainerName = String(r[COL2.TRAINER] || '').trim() || '(unnamed)';

    const m = bucket(byModule,  moduleOrder,  moduleName,  moduleName);
    const s = bucket(bySession, sessionOrder, sessionName, sessionName);
    const t = bucket(byTrainer, trainerOrder, trainerName, trainerName);

    overall.respondents++; m.respondents++; s.respondents++; t.respondents++;

    // The seven scored questions sit together, so one loop covers them all.
    for (let q = 0; q < QUESTION_LABELS.length; q++) {
      const answer = r[COL2.Q1 + q];
      const tier = answerTier(answer);

      if (tier === 'UNKNOWN') {
        const text = String(answer || '').trim();
        unknown[text] = (unknown[text] || 0) + 1;
      }

      const field = tier === 'POSITIVE' ? 'positive'
                  : tier === 'AVERAGE'  ? 'average'
                  : tier === 'POOR'     ? 'poor'
                  : tier === 'UNKNOWN'  ? 'unknown'
                  : 'noResponse';

      overall[field]++; m[field]++; s[field]++; t[field]++;
      byQuestion[q][field]++;
      byQuestion[q].respondents++;
    }
  });

  result.monthsCovered = Object.keys(monthsSeen).length;
  if (!overall.respondents) return result;

  result.hasData = true;
  result.total = scoreFeedback(overall, kpi);
  result.modules  = moduleOrder.map(function (k) { return scoreFeedback(byModule[k], kpi); })
                               .sort(byRespondents);
  result.sessions = sessionOrder.map(function (k) { return scoreFeedback(bySession[k], kpi); })
                                .sort(byRespondents);
  result.trainers = trainerOrder.map(function (k) { return scoreFeedback(byTrainer[k], kpi); })
                                .sort(byRespondents);
  // Questions keep their form order — Q1 to Q7 is how the survey reads.
  result.questions = byQuestion.map(function (q) { return scoreFeedback(q, kpi); });

  result.unknownAnswers = Object.keys(unknown).map(function (text) {
    return { answer: text, count: unknown[text] };
  }).sort(function (a, b) { return b.count - a.count; });

  return result;
}


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


/**
 * Turns counted responses into the KPI.
 *
 * The denominator is the decision worth understanding. CONFIG.COUNT_NON_RESPONSES
 * decides whether a skipped question counts against the rate — see that
 * setting for why it defaults to counting them.
 *
 * An UNKNOWN answer always counts in the denominator and never in the
 * numerator. That is the safe direction: an unrecognised wording depresses the
 * rate and shows up on screen, rather than quietly inflating it.
 */
function scoreFeedback(b, kpi) {
  const answered = b.positive + b.average + b.poor + b.unknown;
  const applicable = CONFIG.COUNT_NON_RESPONSES ? answered + b.noResponse : answered;

  const rate = applicable ? (b.positive / applicable) * 100 : 0;

  return {
    name: b.name,
    respondents: b.respondents,
    responses: answered + b.noResponse,
    positive: b.positive,
    average: b.average,
    poor: b.poor,
    noResponse: b.noResponse,
    unknown: b.unknown,
    applicable: applicable,
    rate: round2(rate),
    achievement: round2(applicable ? achievementFor(rate, kpi) : 0),
    band: applicable ? bandFor(rate, kpi) : 'NO DATA',
    // How many more non-positive answers before the band drops. Same idea as
    // KPI 1's headroom: a percentage alone does not say how close it ran.
    headroom: headroomFor(applicable, b.positive, kpi)
  };
}


function byRespondents(a, b) {
  return b.respondents - a.respondents;
}


/** Column positions on the TRAINING tab, by name rather than by number. */
function trainingColumns() {
  const at = function (name) { return CONFIG.TRAINING_COLUMNS.indexOf(name); };
  return {
    RESPONSE_ID:  at('Response ID'),
    SESSION_DATE: at('Session Date'),
    MONTH:        at('Month'),
    MODULE:       at('Module'),
    TITLE:        at('Session Title'),
    TRAINER:      at('Trainer'),
    PLANT:        at('Plant'),
    EMP_ID:       at('Employee ID'),
    EMP_NAME:     at('Employee Name'),
    Q1:           at('Q1 Overall'),
    SOURCE:       at('Source File'),
    UPDATED:      at('Uploaded At')
  };
}


/**
 * Which months have training feedback loaded?
 *
 * @return {string[]} 'YYYY-MM', newest first
 */
function listFeedbackMonths() {
  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const COL2 = trainingColumns();
  const values = sheet.getRange(2, COL2.MONTH + 1, lastRow - 1, 1).getValues();

  const months = {};
  values.forEach(function (row) {
    const month = monthKey(row[0]);
    if (month) months[month] = true;
  });

  return Object.keys(months).sort().reverse();
}


/**
 * Prints KPI 2 to the Execution log.
 *
 * Open Kpi2.gs, pick runKpi2SelfTest in the function dropdown, press Run.
 * Checks the stored numbers without involving the browser at all — if the UI
 * and this disagree, the bug is in the UI.
 */
function runKpi2SelfTest() {
  const k = getKpi2(ALL_MONTHS);

  if (!k.hasData) {
    Logger.log('No training feedback loaded.');
    return;
  }

  const t = k.total;
  Logger.log('KPI 2 — SAP User Training Satisfaction & Feedback');
  Logger.log('  months covered   : %s', k.monthsCovered);
  Logger.log('  respondents      : %s', t.respondents);
  Logger.log('  responses        : %s  (%s x 7 questions)', t.responses, t.respondents);
  Logger.log('  positive         : %s', t.positive);
  Logger.log('  average          : %s', t.average);
  Logger.log('  poor             : %s', t.poor);
  Logger.log('  no response      : %s  (counted in denominator: %s)',
             t.noResponse, CONFIG.COUNT_NON_RESPONSES);
  Logger.log('  unrecognised     : %s', t.unknown);
  Logger.log('  applicable       : %s', t.applicable);
  Logger.log('  SUCCESS RATE     : %s%%   target %s%%', t.rate, k.target);
  Logger.log('  KPI ACHIEVEMENT  : %s%%', t.achievement);
  Logger.log('  BAND             : %s   headroom %s', t.band, t.headroom);

  Logger.log('');
  Logger.log('  by module:');
  k.modules.forEach(function (m) {
    Logger.log('    %s — %s respondents, %s%% (%s)',
               m.name, m.respondents, m.rate, m.band);
  });

  if (k.unknownAnswers.length) {
    Logger.log('');
    Logger.log('  UNRECOGNISED ANSWERS — add these to CONFIG.FEEDBACK_ANSWERS:');
    k.unknownAnswers.forEach(function (u) {
      Logger.log('    "%s" x%s', u.answer, u.count);
    });
  }
}
