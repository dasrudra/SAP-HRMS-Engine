/**
 * kpi2-equivalence-test.js - KPI 2 must answer what Kpi2.gs answers.
 * ===========================================================================
 *
 *     cd api
 *     node kpi2-equivalence-test.js
 *
 * Needs nothing switched on. No database, no server - it is arithmetic and
 * string matching, run twice.
 *
 *
 * HOW IT WORKS, AND WHY IT IS NOT A LIST OF EXPECTED ANSWERS
 *
 * The real functions are lifted out of src/Config.gs, src/Kpi.gs and
 * src/Kpi2.gs at run time and executed in a sandbox beside the port. Nothing
 * here says what the right answer is; both sides are asked and the answers
 * are compared. So the test cannot drift from the system it is checking, and
 * a fixture written from a misreading of the original cannot make a wrong
 * port look right.
 *
 *
 * WHAT IS AT STAKE
 *
 * KPI 2 turns 4,669 free-text answers into one percentage. Three things
 * decide that number, and all three fail quietly:
 *
 *   normaliseAnswer   the forms carry a Bangla gloss in brackets, and the
 *                     bracket style changed between batches. Strip it wrong
 *                     and 'Excellent [gloss]' stops being 'Excellent' - it
 *                     becomes UNKNOWN, which counts in the denominator and
 *                     not the numerator, so the rate drops and nothing looks
 *                     broken.
 *
 *   moduleFor         decides which row of the Department Summary a session
 *                     lands in. 'CO' firing inside 'Accounting' moves a
 *                     whole training course between modules, and the table
 *                     still adds up.
 *
 *   scoreFeedback     the denominator. A skipped question counts or it does
 *                     not; an unrecognised wording counts against or is
 *                     dropped. Each is one line and each moves the figure
 *                     that gets reported.
 *
 * NO REAL DATA IS IN THIS FILE. The answer map and the module table are
 * lifted from src/Config.gs; the inputs are generated from them.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const port = require('./kpi2');

const SRC = path.join(__dirname, '..', 'src');
const configSrc = fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8');
const kpiSrc = fs.readFileSync(path.join(SRC, 'Kpi.gs'), 'utf8');
const kpi2Src = fs.readFileSync(path.join(SRC, 'Kpi2.gs'), 'utf8');

let pass = 0, fail = 0, compared = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

/** Counts a comparison, and reports only the first few failures of a kind. */
function same(label, a, b, context) {
  compared++;
  if (a === b) return true;
  fail++;
  console.log('  FAIL ' + label + '   ' + JSON.stringify(context) +
              '\n         original: ' + JSON.stringify(a) +
              '\n         port:     ' + JSON.stringify(b));
  return false;
}


/** One object or array literal out of Config.gs, by key. Brace-counted. */
function liftLiteral(key, open, close) {
  const start = configSrc.indexOf('\n  ' + key + ': ' + open);
  if (start === -1) return null;
  const from = configSrc.indexOf(open, start);
  let depth = 0, inString = null, line = false, block = false;

  for (let i = from; i < configSrc.length; i++) {
    const ch = configSrc[i], next = configSrc[i + 1];
    if (line) { if (ch === '\n') line = false; continue; }
    if (block) { if (ch === '*' && next === '/') { block = false; i++; } continue; }
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '/' && next === '/') { line = true; i++; continue; }
    if (ch === '/' && next === '*') { block = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) {
      const sandbox = {};
      vm.createContext(sandbox);
      return vm.runInContext('(' + configSrc.slice(from, i + 1) + ')', sandbox);
    }
  }
  return null;
}

/** One function, by name, out of a source file. */
function liftFunction(source, name, where) {
  const re = new RegExp('\\nfunction ' + name +
                        '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
  const found = source.match(re);
  if (!found) {
    console.error('\n  Could not find ' + name + ' in ' + where + '\n');
    process.exit(1);
  }
  return found[0];
}


const FEEDBACK_ANSWERS = liftLiteral('FEEDBACK_ANSWERS', '{', '}');
const TRAINING_MODULES = liftLiteral('TRAINING_MODULES', '[', ']');
const COUNT_NON_RESPONSES =
  /\n  COUNT_NON_RESPONSES:\s*(true|false)/.exec(configSrc)[1] === 'true';

if (!FEEDBACK_ANSWERS || !TRAINING_MODULES) {
  console.error('\n  Could not lift the answer map or the module table.\n');
  process.exit(1);
}


/** The original functions, running against the original's own CONFIG. */
function loadOriginal() {
  let code = 'let ANSWER_TIERS = null;\n';

  ['normaliseAnswer', 'answerTiers', 'answerTier', 'moduleFor',
   'bandFor', 'achievementFor', 'headroomFor'].forEach(function (n) {
    code += liftFunction(configSrc, n, 'src/Config.gs') + '\n';
  });

  code += liftFunction(kpiSrc, 'round2', 'src/Kpi.gs') + '\n';
  code += liftFunction(kpi2Src, 'scoreFeedback', 'src/Kpi2.gs') + '\n';
  code += liftFunction(kpi2Src, 'byRespondents', 'src/Kpi2.gs') + '\n';

  code += 'module.exports = { normaliseAnswer, answerTier, moduleFor, ' +
          'scoreFeedback, byRespondents };';

  const sandbox = {
    module: { exports: {} },
    CONFIG: {
      FEEDBACK_ANSWERS: FEEDBACK_ANSWERS,
      TRAINING_MODULES: TRAINING_MODULES,
      COUNT_NON_RESPONSES: COUNT_NON_RESPONSES
    },
    Object: Object, String: String, Array: Array, Number: Number,
    Math: Math, JSON: JSON, RegExp: RegExp, isNaN: isNaN
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}

const original = loadOriginal();


function main() {
  console.log('');

  // =======================================================================
  console.log('  The port carries the same constants as Config.gs');
  // =======================================================================
  check('the answer map is the one in Config.gs',
        JSON.stringify(port.FEEDBACK_ANSWERS) === JSON.stringify(FEEDBACK_ANSWERS));
  check('the module table is the one in Config.gs',
        JSON.stringify(port.TRAINING_MODULES) === JSON.stringify(TRAINING_MODULES));
  check('non-responses count, or do not, the same way',
        port.COUNT_NON_RESPONSES === COUNT_NON_RESPONSES,
        String(port.COUNT_NON_RESPONSES) + ' vs ' + String(COUNT_NON_RESPONSES));

  /*
    The standard is read out of the FEEDBACK block by text rather than
    lifted, because KPIS.FEEDBACK is nested two deep and the lifter works on
    top-level keys. Two numbers, checked where they are written.
  */
  const feedbackBlock = configSrc.slice(configSrc.indexOf('\n    FEEDBACK: {'),
                                        configSrc.indexOf('\n    INCIDENT: {'));
  check('the target is the one in the FEEDBACK block',
        Number(/target:\s*([\d.]+)/.exec(feedbackBlock)[1]) ===
        port.KPI_FEEDBACK.target, String(port.KPI_FEEDBACK.target));
  check('and so is the yellow floor',
        Number(/yellowFloor:\s*([\d.]+)/.exec(feedbackBlock)[1]) ===
        port.KPI_FEEDBACK.yellowFloor, String(port.KPI_FEEDBACK.yellowFloor));
  check('KPI 2 is still marked as NOT a policy KPI',
        /policy:\s*false/.test(feedbackBlock) && port.KPI_FEEDBACK.policy === false);
  check('the seven questions are the seven questions',
        port.QUESTION_LABELS.length === 7 &&
        kpi2Src.indexOf(port.QUESTION_LABELS[0]) !== -1 &&
        kpi2Src.indexOf(port.QUESTION_LABELS[6]) !== -1);


  // =======================================================================
  console.log('');
  console.log('  normaliseAnswer and answerTier, over every wording');
  // =======================================================================
  /*
    The real answers, plus wordings nobody anticipated - which must come back
    UNKNOWN from both sides rather than being quietly sorted somewhere.
  */
  const answers = [];
  port.TIER_ORDER.forEach(function (tier) {
    (FEEDBACK_ANSWERS[tier] || []).forEach(function (a) { answers.push(a); });
  });
  ['Very good indeed', 'Satisfactory', 'Terrible', 'Could be better', '',
   '   ', 'excellent!', 'Good.', 'yes', '???'].forEach(function (a) {
    answers.push(a);
  });

  /*
    THE BRACKETS ARE THE POINT. The gloss style varies between batches, and
    one respondent closed a round bracket with a square one - so a pairing
    rule would leave that answer unclassified, and an unclassified answer
    depresses the rate.
  */
  const glosses = [
    function (a) { return a; },
    function (a) { return a + ' [gloss]'; },
    function (a) { return a + ' (gloss)'; },
    function (a) { return a + ' [gloss)'; },      // mismatched, as seen
    function (a) { return a + ' (gloss]'; },      // mismatched the other way
    function (a) { return a + ' [one] [two]'; },
    function (a) { return '[lead] ' + a; },
    function (a) { return a + ' ['; },            // an orphan on its own
    function (a) { return a + ' )'; }
  ];

  const spacings = [
    function (a) { return a; },
    function (a) { return '  ' + a + '  '; },
    function (a) { return a.replace(/ /g, '   '); },
    function (a) { return '\t' + a + '\n'; }
  ];

  const cases = [
    function (a) { return a; },
    function (a) { return a.toLowerCase(); },
    function (a) { return a.toUpperCase(); }
  ];

  let normaliseFails = 0;
  let tierFails = 0;

  answers.forEach(function (base) {
    glosses.forEach(function (g) {
      spacings.forEach(function (s) {
        cases.forEach(function (c) {
          const input = c(s(g(base)));
          if (!same('normaliseAnswer', original.normaliseAnswer(input),
                    port.normaliseAnswer(input), { input: input })) {
            normaliseFails++;
          }
          if (!same('answerTier', original.answerTier(input),
                    port.answerTier(input), { input: input })) {
            tierFails++;
          }
        });
      });
    });
  });

  check('every wording normalises identically', normaliseFails === 0,
        normaliseFails + ' differed');
  check('and lands in the same tier', tierFails === 0, tierFails + ' differed');

  // null and undefined reach this from a blank spreadsheet cell.
  [null, undefined, 0, false].forEach(function (odd) {
    same('normaliseAnswer', original.normaliseAnswer(odd),
         port.normaliseAnswer(odd), { input: odd });
    same('answerTier', original.answerTier(odd), port.answerTier(odd),
         { input: odd });
  });
  check('a blank cell is NO_RESPONSE on both sides, not UNKNOWN',
        port.answerTier(null) === 'NO_RESPONSE' &&
        original.answerTier(null) === 'NO_RESPONSE');

  /*
    NO ANSWER MAY APPEAR IN TWO TIERS, and this is the assertion that makes
    the order of TIER_ORDER irrelevant rather than merely harmless today.

    Mutation testing reversed that order and changed no answer - which looks
    like a pointless constant until you notice WHY: the four lists do not
    overlap, so whichever is applied last cannot overwrite anything. The day
    somebody adds 'Helpful' to AVERAGE without removing it from POSITIVE,
    the order silently starts deciding a tier. This fails on that day.
  */
  const seen = {};
  const dupes = [];
  port.TIER_ORDER.forEach(function (tier) {
    (FEEDBACK_ANSWERS[tier] || []).forEach(function (a) {
      const key = port.normaliseAnswer(a);
      if (seen[key]) dupes.push(a + ' is in both ' + seen[key] + ' and ' + tier);
      seen[key] = tier;
    });
  });
  check('NO ANSWER IS LISTED IN TWO TIERS, so the order cannot decide one',
        dupes.length === 0, dupes.join('; '));


  // =======================================================================
  console.log('');
  console.log('  moduleFor, over every filename shape');
  // =======================================================================
  const codes = [];
  TRAINING_MODULES.forEach(function (m) {
    m.match.forEach(function (p) { codes.push(p); });
  });
  /*
    The words that must NOT match, and each is here because the boundary
    rule is the only thing stopping it: 'Accounting' contains co, 'Commodity'
    contains co, 'Transport' contains tr, 'Admin' contains md.
  */
  ['Accounting', 'Commodity', 'Transport', 'Admin', 'Summary', 'Feedback',
   'Overall', 'Training', 'xyz', ''].forEach(function (w) { codes.push(w); });

  /*
    FILENAMES CARRYING TWO CODES, which is the only situation where "first
    match wins" means anything at all. Mutation testing found this gap:
    reversing the whole module table changed no answer, because every
    generated filename matched at most one module. A real export named
    'FI_TR and MM Combined Session' has to land in FI/TR, and the only thing
    that decides it is the order of the table.
  */
  let moduleFails = 0;
  const pairs = [];
  TRAINING_MODULES.forEach(function (a) {
    TRAINING_MODULES.forEach(function (b) {
      if (a.key === b.key) return;
      pairs.push(a.match[0] + ' ' + b.match[0]);
      pairs.push(a.match[0] + '_' + b.match[0] + ' Feedback.xlsx');
      pairs.push('Training ' + a.match[0] + ' and ' + b.match[0] + ' Aug.xlsx');
    });
  });
  pairs.forEach(function (name) {
    [name, name.toUpperCase()].forEach(function (n) {
      if (!same('moduleFor (two codes)', original.moduleFor(n),
                port.moduleFor(n), { file: n })) {
        moduleFails++;
      }
    });
  });

  const templates = [
    function (c) { return c + '.xlsx'; },
    function (c) { return 'Feedback ' + c + '.xlsx'; },
    function (c) { return c + ' Feedback 2026.xlsx'; },
    function (c) { return 'Training_' + c + '_Aug.xlsx'; },
    function (c) { return 'Training-' + c + '-Aug.xlsx'; },
    function (c) { return 'x' + c + '.xlsx'; },          // no boundary before
    function (c) { return c + 'x.xlsx'; },               // none after
    function (c) { return 'Accounting ' + c + '.xlsx'; },
    function (c) { return '2026 ' + c; },
    function (c) { return c; }
  ];

  codes.forEach(function (c) {
    templates.forEach(function (t) {
      [t(c), t(c).toUpperCase(), t(c).toLowerCase()].forEach(function (name) {
        if (!same('moduleFor', original.moduleFor(name), port.moduleFor(name),
                  { file: name })) {
          moduleFails++;
        }
      });
    });
  });
  check('every filename lands in the same module', moduleFails === 0,
        moduleFails + ' differed');

  [null, undefined, 0].forEach(function (odd) {
    same('moduleFor', original.moduleFor(odd), port.moduleFor(odd), { file: odd });
  });

  // Worth stating outright, because it is the mistake the boundary prevents.
  check('CO does not fire inside Accounting',
        port.moduleFor('Accounting Feedback.xlsx') !== 'CO',
        port.moduleFor('Accounting Feedback.xlsx'));
  check('and E-Accounting is E-Accounting, not FI/TR',
        port.moduleFor('E-Accounting Feedback.xlsx') === 'E-Accounting');


  // =======================================================================
  console.log('');
  console.log('  scoreFeedback, over the counts that can occur');
  // =======================================================================
  /*
    The numbers are chosen around the places the answer changes: zero
    (NO DATA, which is not nought per cent), one, and the counts either side
    of the 81 and 90 thresholds. 1107 and 1120 are PP's real figures from the
    existing workbook, and 121, 6 and 4 are the workbook's own Average, Poor
    and Not Responded totals.
  */
  const positives   = [0, 1, 80, 81, 89, 90, 99, 100, 900, 1107];
  const averages    = [0, 1, 10, 121];
  const poors       = [0, 1, 6];
  const unknowns    = [0, 1, 4];
  const noResponses = [0, 1, 4, 13];

  const FIELDS = ['name', 'respondents', 'responses', 'positive', 'average',
                  'poor', 'noResponse', 'unknown', 'applicable', 'rate',
                  'achievement', 'band', 'headroom'];

  let scoreFails = 0;
  let cases2 = 0;

  positives.forEach(function (p) {
    averages.forEach(function (a) {
      poors.forEach(function (po) {
        unknowns.forEach(function (u) {
          noResponses.forEach(function (nr) {
            const bucket = { name: 'MM', respondents: p + a + po + u + nr,
                             positive: p, average: a, poor: po,
                             unknown: u, noResponse: nr };
            cases2++;
            const was = original.scoreFeedback(bucket, port.KPI_FEEDBACK);
            const now = port.scoreFeedback(bucket, port.KPI_FEEDBACK);
            FIELDS.forEach(function (f) {
              if (!same('scoreFeedback.' + f, was[f], now[f], bucket)) {
                scoreFails++;
              }
            });
          });
        });
      });
    });
  });

  check('every combination of counts scores identically', scoreFails === 0,
        scoreFails + ' field(s) differed across ' + cases2 + ' buckets');

  /*
    NO DATA IS NOT ZERO PER CENT, and it is the one case where a wrong port
    would look most reasonable: a module nobody was asked about scoring 0%
    red rather than being left out of the judgement.
  */
  const empty = { name: 'MM', respondents: 0, positive: 0, average: 0,
                  poor: 0, unknown: 0, noResponse: 0 };
  check('an empty bucket is NO DATA on both sides',
        original.scoreFeedback(empty, port.KPI_FEEDBACK).band === 'NO DATA' &&
        port.scoreFeedback(empty, port.KPI_FEEDBACK).band === 'NO DATA');
  check('and its achievement is 0, not a band score',
        port.scoreFeedback(empty, port.KPI_FEEDBACK).achievement === 0);

  /*
    An UNKNOWN answer counts in the denominator and never in the numerator.
    "An unrecognised wording depresses the rate and shows up on screen,
    rather than quietly inflating it."
  */
  const withUnknown = { name: 'MM', respondents: 10, positive: 90, average: 0,
                        poor: 0, unknown: 10, noResponse: 0 };
  const scored = port.scoreFeedback(withUnknown, port.KPI_FEEDBACK);
  check('AN UNKNOWN ANSWER LOWERS THE RATE RATHER THAN BEING DROPPED',
        scored.applicable === 100 && scored.rate === 90.00,
        scored.applicable + ' applicable, ' + scored.rate + '%');

  // Busiest module first, which is how the table is ordered.
  const order = [{ respondents: 3 }, { respondents: 40 }, { respondents: 7 }];
  check('byRespondents orders the same way as the original',
        JSON.stringify(order.slice().sort(port.byRespondents)) ===
        JSON.stringify(order.slice().sort(original.byRespondents)));


  console.log('');
  console.log('  ' + compared.toLocaleString('en-US') + ' comparisons');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('');
  process.exit(fail ? 1 : 0);
}


main();
