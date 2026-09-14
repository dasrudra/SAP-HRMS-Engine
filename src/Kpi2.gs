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
  const wanted = monthsInScope(scope, 'FEEDBACK');

  // Asking for a quarter is answered by the quarter each response resolves to,
  // not by its month. Those are the same thing only while the session dates
  // are trustworthy, and they are not: a file named Q1-2026 whose dates Excel
  // turned into January 1974 belongs in Q1 2026, and filtering by month would
  // drop it. See quarterForFeedback.
  const wantedQuarter = /^\d{4}-Q[1-4]$/.test(String(scope || '')) ? scope : '';

  const result = {
    scope: scope,
    allMonths: scope === ALL_MONTHS,
    monthsCovered: 0,
    hasData: false,
    target: kpi.target,
    yellowFloor: kpi.yellowFloor,
    total: null,
    modules: [],
    zones: [],
    quarters: [],
    sessions: [],
    questions: [],
    trainers: [],
    // Answers no one anticipated. Surfaced rather than swallowed — a new form
    // wording that silently counted as positive would move the KPI without
    // anyone noticing.
    unknownAnswers: [],

    // Files whose module the filename did not name. They pool into
    // '(unassigned)', which answers no question at all unless you can see
    // which files went into it.
    unassignedFiles: [],

    // Files whose name carries no quarter, so their quarter had to come from
    // the session date. Surfaced for the same reason as unassignedFiles:
    // the date is the unreliable source, so it matters which rows lean on it.
    undatedFiles: []
  };

  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return result;

  const width = CONFIG.TRAINING_COLUMNS.length;
  const rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();

  const COL2 = trainingColumns();
  const monthsSeen = {};
  const unknown = {};
  const unassigned = {};
  const undated = {};

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
  const byQuarter = {}, quarterOrder = [];
  const byQuestion = QUESTION_LABELS.map(function (label) { return blank(label); });

  // Zones are a fixed, known set, so they are seeded rather than discovered.
  // A zone with no training in the period stays on the table showing zero —
  // "KEPZ ran nothing this month" is a finding, and a row that vanishes hides
  // it. Unspecified is added only if something actually lands there.
  const byZone = {}, zoneOrder = [];
  CONFIG.ZONES.forEach(function (z) {
    byZone[z.name] = blank(z.name);
    byZone[z.name].sessionsSeen = {};
    zoneOrder.push(z.name);
  });

  rows.forEach(function (r) {
    if (!String(r[COL2.RESPONSE_ID] || '').trim()) return;

    const month = monthKey(r[COL2.MONTH]) || monthKey(r[COL2.SESSION_DATE]);

    // Resolved here rather than stored, like the module and the zone: renaming
    // a file and re-uploading is not needed, and neither is a new column —
    // correcting the convention re-files every affected response on reload.
    const namedQuarter = quarterFromFileName(r[COL2.SOURCE]);
    const quarterKey = namedQuarter || quarterOf(month, 'FEEDBACK');

    if (wantedQuarter) { if (quarterKey !== wantedQuarter) return; }
    else if (wanted && !wanted[month]) return;

    if (month) monthsSeen[month] = true;
    if (!namedQuarter) {
      const named = String(r[COL2.SOURCE] || '').trim() || '(no source file)';
      if (!undated[named]) undated[named] = { respondents: 0, quarter: quarterKey };
      undated[named].respondents++;
    }

    // Resolved here, not frozen at upload: a response stores what the form
    // said and the file it came in, and the mapping from those to a module
    // lives in Config. Correcting TRAINER_MODULES re-files every affected
    // response on the next reload, with nothing to re-upload.
    const moduleName = moduleForResponse(r[COL2.MODULE], r[COL2.SOURCE]) || '(unassigned)';
    if (moduleName === '(unassigned)') {
      const from = String(r[COL2.SOURCE] || '').trim() || '(no source file)';
      unassigned[from] = (unassigned[from] || 0) + 1;
    }
    const sessionName = String(r[COL2.TITLE]   || '').trim() || '(untitled session)';
    const trainerName = String(r[COL2.TRAINER] || '').trim() || '(unnamed)';

    const zoneName = zoneFor(r[COL2.SOURCE], r[COL2.PLANT], r[COL2.ZONE]);

    const m = bucket(byModule,  moduleOrder,  moduleName,  moduleName);
    const s = bucket(bySession, sessionOrder, sessionName, sessionName);
    const t = bucket(byTrainer, trainerOrder, trainerName, trainerName);
    const z = bucket(byZone,    zoneOrder,    zoneName,    zoneName);
    const qk = quarterKey || NO_QUARTER;
    const q = bucket(byQuarter, quarterOrder, qk,
                     quarterKey ? quarterLabel(quarterKey) : NO_QUARTER);

    // Only the discovered zones (Unspecified) need this; the seeded ones have it.
    if (!z.sessionsSeen) z.sessionsSeen = {};
    z.sessionsSeen[sessionName] = true;

    overall.respondents++; m.respondents++; s.respondents++; t.respondents++;
    z.respondents++; q.respondents++;
    q.sessionsSeen = q.sessionsSeen || {};
    q.sessionsSeen[sessionName] = true;

    // The seven scored questions sit together, so one loop covers them all.
    for (let i = 0; i < QUESTION_LABELS.length; i++) {
      const answer = r[COL2.Q1 + i];
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

      overall[field]++; m[field]++; s[field]++; t[field]++; z[field]++;
      q[field]++;
      byQuestion[i][field]++;
      byQuestion[i].respondents++;
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
  // Zones keep their configured order — KEPZ, CEPZ, DEPZ — with Unspecified
  // last, because the reader is comparing three known places, not ranking them.
  result.zones = zoneOrder.map(function (k) {
    const scored = scoreFeedback(byZone[k], kpi);
    scored.sessions = Object.keys(byZone[k].sessionsSeen || {}).length;
    return scored;
  });
  result.trainers = trainerOrder.map(function (k) { return scoreFeedback(byTrainer[k], kpi); })
                                .sort(byRespondents);
  // Quarters read left to right in time, never by size — a trend is the whole
  // point of the grouping, and sorting it by volume destroys one.
  result.quarters = quarterOrder.slice().sort(byQuarterKey).map(function (k) {
    const scored = scoreFeedback(byQuarter[k], kpi);
    scored.key = k;
    scored.sessions = Object.keys(byQuarter[k].sessionsSeen || {}).length;
    return scored;
  });
  // Questions keep their form order — Q1 to Q7 is how the survey reads.
  result.questions = byQuestion.map(function (q) { return scoreFeedback(q, kpi); });

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


/** Shown for a response whose quarter nothing could establish. */
const NO_QUARTER = '(no quarter)';


/** Quarter keys in time order, with '(no quarter)' last rather than first. */
function byQuarterKey(a, b) {
  const av = a === NO_QUARTER ? 1 : 0;
  const bv = b === NO_QUARTER ? 1 : 0;
  if (av !== bv) return av - bv;
  return a < b ? -1 : a > b ? 1 : 0;
}


/**
 * KPI 2 month by month, shaped exactly like getKpiComparison's result.
 *
 * The Comparison screen used to call KPI 1's endpoint whatever the "Which KPI"
 * dropdown said, so picking Training Satisfaction re-rendered ticket figures
 * under a training heading. Rather than fork the screen, both engines now
 * return the same shape and describe their own columns in it — `measures` names
 * the count columns, `sectionLabel` names the breakdown, `volumeKey` says which
 * measure the trend chart should draw as bars. A KPI 3 that fills this in gets
 * the whole screen for free.
 *
 * @param {string[]} months  'YYYY-MM'
 * @return {Object}
 */
function getKpi2Comparison(months) {
  const kpi = CONFIG.KPI.FEEDBACK;
  const list = (months || []).slice().sort();

  const result = {
    kpi: 'KPI2',
    name: kpi.name || 'SAP User Training Satisfaction & Feedback',
    months: list,
    sections: [],
    bySection: {},
    totals: {},
    target: kpi.target,
    unit: '%',
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

  const seen = {};

  list.forEach(function (month) {
    const k = getKpi2(month);
    if (!k.hasData) return;

    result.totals[month] = comparisonEntry(k.total);

    k.modules.forEach(function (m) {
      if (!seen[m.name]) { seen[m.name] = true; result.sections.push(m.name); }
      (result.bySection[m.name] = result.bySection[m.name] || {})[month] = comparisonEntry(m);
    });
  });

  result.sections.sort();
  return result;
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
    UPDATED:      at('Uploaded At'),
    ZONE:         at('Zone')
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
  const rows = sheet.getRange(2, 1, lastRow - 1, CONFIG.TRAINING_COLUMNS.length)
                    .getValues();

  const months = {};
  rows.forEach(function (r) {
    if (!String(r[COL2.RESPONSE_ID] || '').trim()) return;

    const month = monthKey(r[COL2.MONTH]) || monthKey(r[COL2.SESSION_DATE]);
    if (!month) return;

    // A month the file's own name contradicts is not a month anything was
    // trained in — it is a mangled date. The Comparison screen builds its
    // pickers from this list, and offering 'January 1974' invites a comparison
    // of a period the dashboard itself does not believe happened.
    const named = quarterFromFileName(r[COL2.SOURCE]);
    if (named && monthsOfQuarter(named, 'FEEDBACK').indexOf(month) === -1) return;

    months[month] = true;
  });

  return Object.keys(months).sort().reverse();
}


/**
 * Which quarters have training feedback loaded?
 *
 * KPI 2 reports by quarter, not by month: a module is trained once or twice a
 * quarter, so a month-by-month reading is mostly empty cells and a rate over
 * a handful of responses. The picker offers what the data actually has.
 *
 * @return {Object[]} { key: '2026-Q1', label: 'Quarter 1 (2026)', months: [...] }
 *                    newest first
 */
function listFeedbackQuarters() {
  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const COL2 = trainingColumns();
  const rows = sheet.getRange(2, 1, lastRow - 1, CONFIG.TRAINING_COLUMNS.length)
                    .getValues();

  const seen = {};
  const order = [];

  rows.forEach(function (r) {
    if (!String(r[COL2.RESPONSE_ID] || '').trim()) return;

    const month = monthKey(r[COL2.MONTH]) || monthKey(r[COL2.SESSION_DATE]);
    // Same resolution as getKpi2, or the picker offers a quarter the figures
    // do not have — and lands on an empty screen when it is chosen.
    const key = quarterFromFileName(r[COL2.SOURCE]) || quarterOf(month, 'FEEDBACK');
    if (!key) return;

    if (!seen[key]) { seen[key] = {}; order.push(key); }
    if (month) seen[key][month] = true;
  });

  return order.sort().reverse().map(function (key) {
    const covers = monthsOfQuarter(key, 'FEEDBACK');
    // Only the months that actually have training, not all three — the
    // picker's tooltip should say what is in the quarter, not what could be.
    //
    // And only the ones that fall INSIDE it. A file named Q1-2026 whose dates
    // Excel turned into 1974 belongs in Q1 2026 on the trainer's say-so, but
    // 'January 1974' has no business appearing under the label; the UI shows
    // the quarter's own three months when nothing credible survives.
    const months = Object.keys(seen[key]).sort().filter(function (m) {
      return covers.indexOf(m) !== -1;
    });

    return { key: key, label: quarterLabel(key), months: months, covers: covers };
  });
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

  Logger.log('');
  Logger.log('  by zone:');
  k.zones.forEach(function (z) {
    Logger.log('    %s — %s sessions, %s attendees, %s%% (%s)',
               z.name, z.sessions, z.respondents, z.rate, z.band);
  });

  if (k.unknownAnswers.length) {
    Logger.log('');
    Logger.log('  UNRECOGNISED ANSWERS — add these to CONFIG.FEEDBACK_ANSWERS:');
    k.unknownAnswers.forEach(function (u) {
      Logger.log('    "%s" x%s', u.answer, u.count);
    });
  }
}
