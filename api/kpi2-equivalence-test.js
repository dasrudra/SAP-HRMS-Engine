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
const codeSrc = fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8');

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
const ZONES = liftLiteral('ZONES', '[', ']');
const PLANT_ZONES = liftLiteral('PLANT_ZONES', '{', '}') || {};
const COUNT_NON_RESPONSES =
  /\n  COUNT_NON_RESPONSES:\s*(true|false)/.exec(configSrc)[1] === 'true';
const ZONE_UNSPECIFIED =
  /\n  ZONE_UNSPECIFIED:\s*'([^']*)'/.exec(configSrc)[1];

/*
  THE TRAINER FALLBACK LIST IS LIFTED AND NEVER WRITTEN DOWN.

  CONFIG.TRAINER_MODULES is three colleagues' names. It is read out of
  src/Config.gs here, at run time, and passed to both sides as an argument -
  so this file, like api/kpi2.js, contains none of it. Same arrangement as
  roster-equivalence-test.js, and the same reason: the repository is public.
*/
const TRAINER_MODULES = liftLiteral('TRAINER_MODULES', '[', ']') || [];

if (!FEEDBACK_ANSWERS || !TRAINING_MODULES || !ZONES) {
  console.error('\n  Could not lift the answer map, the module table or the zones.\n');
  process.exit(1);
}
if (!TRAINER_MODULES.length) {
  console.error('\n  CONFIG.TRAINER_MODULES is empty or could not be read.\n');
  process.exit(1);
}


/** The original functions, running against the original's own CONFIG. */
function loadOriginal() {
  let code = 'let ANSWER_TIERS = null;\n';

  ['normaliseAnswer', 'answerTiers', 'answerTier', 'moduleFor',
   'moduleForResponse', 'matchZone', 'zoneFor',
   'quarterKeyFrom', 'quarterFromFileName',
   'bandFor', 'achievementFor', 'headroomFor'].forEach(function (n) {
    code += liftFunction(configSrc, n, 'src/Config.gs') + '\n';
  });

  code += liftFunction(codeSrc, 'monthKey', 'src/Code.gs') + '\n';

  code += liftFunction(kpiSrc, 'round2', 'src/Kpi.gs') + '\n';
  code += liftFunction(kpi2Src, 'scoreFeedback', 'src/Kpi2.gs') + '\n';
  code += liftFunction(kpi2Src, 'byRespondents', 'src/Kpi2.gs') + '\n';

  code += 'module.exports = { normaliseAnswer, answerTier, moduleFor, ' +
          'moduleForResponse, matchZone, zoneFor, monthKey, ' +
          'quarterKeyFrom, quarterFromFileName, ' +
          'scoreFeedback, byRespondents };';

  const sandbox = {
    module: { exports: {} },
    CONFIG: {
      FEEDBACK_ANSWERS: FEEDBACK_ANSWERS,
      TRAINING_MODULES: TRAINING_MODULES,
      TRAINER_MODULES: TRAINER_MODULES,
      ZONES: ZONES,
      ZONE_UNSPECIFIED: ZONE_UNSPECIFIED,
      PLANT_ZONES: PLANT_ZONES,
      COUNT_NON_RESPONSES: COUNT_NON_RESPONSES
    },
    Object: Object, String: String, Array: Array, Number: Number,
    Math: Math, JSON: JSON, RegExp: RegExp, isNaN: isNaN,
    isFinite: isFinite, Date: Date
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
  /*
    THE TRAINING COLUMN ORDER, which matters because feedback rows still
    arrive from the browser as plain arrays. One column out of place and
    every value after it lands in the wrong field - silently, because they
    are nearly all text.
  */
  const TRAINING_COLUMNS = liftLiteral('TRAINING_COLUMNS', '[', ']');
  check('the training columns are the ones in Config.gs, in order',
        JSON.stringify(port.TRAINING_HEADERS) === JSON.stringify(TRAINING_COLUMNS),
        'port has ' + port.TRAINING_HEADERS.length + ', Config.gs has ' +
        (TRAINING_COLUMNS || []).length);
  check('each heading has a database column of its own',
        port.TRAINING_NAMES.length === port.TRAINING_HEADERS.length &&
        new Set(port.TRAINING_NAMES).size === port.TRAINING_NAMES.length);
  check('Zone is still last, as the sheet has it',
        port.TRAINING_HEADERS[port.TRAINING_HEADERS.length - 1] === 'Zone');

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
  console.log('  moduleForResponse - the trainer fallback, and its order');
  // =======================================================================
  check('the zone list is the one in Config.gs',
        JSON.stringify(port.ZONES) === JSON.stringify(ZONES));
  check('and the name for a session with no zone',
        port.ZONE_UNSPECIFIED === ZONE_UNSPECIFIED, port.ZONE_UNSPECIFIED);
  check('the plant lookup matches, empty or not',
        JSON.stringify(port.PLANT_ZONES) === JSON.stringify(PLANT_ZONES));
  check('and the port holds no trainer names of its own',
        port.NO_TRAINERS.length === 0);

  /*
    THE ORDER IS THE RULE: what the respondent answered beats the filename,
    and the filename beats the trainer's usual module. Config.gs is explicit
    that taking the trainer first would file one trainer's E-Accounting
    sessions under her usual module and move a whole course between rows.

    So every combination is tried: a module answered or not, crossed with a
    filename that names a module, names only a trainer, names both, or names
    neither.
  */
  const answeredValues = ['', '   ', 'MM', 'PP', null, undefined];
  const fileShapes = [''];
  TRAINING_MODULES.slice(0, 3).forEach(function (m) {
    fileShapes.push('Trainee Feedback- ' + m.match[0] + '.xlsx');
  });
  TRAINER_MODULES.forEach(function (t) {
    fileShapes.push('Trainee Feedback-' + t.match + '.xlsx');
    fileShapes.push('Feedback ' + t.match + ' Q1-2026.xlsx');
    // Names a module AND a trainer. The filename must win.
    fileShapes.push('Trainee Feedback- e-accounting_' + t.match + '.xlsx');
    fileShapes.push('Feedback ' + t.match + 'x.xlsx');   // no word boundary
  });
  fileShapes.push('Feedback Session.xlsx', 'Overall.xlsx', 'Q3-2026.xlsx');

  let responseFails = 0;
  answeredValues.forEach(function (a) {
    fileShapes.forEach(function (f) {
      [f, f.toUpperCase()].forEach(function (file) {
        if (!same('moduleForResponse',
                  original.moduleForResponse(a, file),
                  port.moduleForResponse(a, file, TRAINER_MODULES),
                  { answered: a, file: file })) {
          responseFails++;
        }
      });
    });
  });
  check('every response lands in the same module', responseFails === 0,
        responseFails + ' differed');

  check('what the respondent answered always wins',
        port.moduleForResponse('MM', 'Trainee Feedback- pp.xlsx',
                               TRAINER_MODULES) === 'MM');
  check('AND A FILENAME THAT NAMES A MODULE BEATS THE TRAINER',
        port.moduleForResponse('', 'Trainee Feedback- e-accounting_' +
                               TRAINER_MODULES[0].match + '.xlsx',
                               TRAINER_MODULES) === 'E-Accounting');
  check('with no trainer list at all, a trainer-only file is unassigned',
        port.moduleForResponse('', 'Feedback ' + TRAINER_MODULES[0].match +
                               '.xlsx') === '');


  // =======================================================================
  console.log('');
  console.log('  zoneFor - said, then looked up, then guessed');
  // =======================================================================
  const zoneTexts = [''];
  ZONES.forEach(function (z) {
    zoneTexts.push(z.name, z.name.toLowerCase());
    z.match.forEach(function (m) {
      zoneTexts.push(m, m.toUpperCase(), 'Feedback ' + m + ' Q1.xlsx',
                     m + 'ONE', 'x' + m);     // the boundary cases
    });
  });
  zoneTexts.push('Unspecified', 'Somewhere else', 'DEPZONE', null, undefined);

  let zoneFails = 0;
  zoneTexts.forEach(function (t) {
    if (!same('matchZone', original.matchZone(t), port.matchZone(t), { text: t })) {
      zoneFails++;
    }
  });
  check('every text reads the same zone', zoneFails === 0, zoneFails + ' differed');
  check('DEPZONE is not DEPZ', port.matchZone('DEPZONE') === '');

  /*
    THE EXACT-NAME SHORTCUT, ISOLATED. Removing it changes nothing against
    the real zone list, because every zone happens to carry its own name in
    its match list - mutation testing proved that. So it is tested against a
    zone whose name is NOT in its patterns, which is the only arrangement
    where the branch does any work and is a perfectly legal one to add.
  */
  const oddZone = [{ key: 'X', name: 'Alpha Zone', match: ['zzz'] }];
  check('a zone name matches outright even when its patterns do not',
        port.matchZone('Alpha Zone', oddZone) === 'Alpha Zone' &&
        port.matchZone('alpha zone', oddZone) === 'Alpha Zone');
  check('and its patterns still work alongside',
        port.matchZone('Feedback zzz.xlsx', oddZone) === 'Alpha Zone');
  check('while something unrelated still matches nothing',
        port.matchZone('Feedback yyy.xlsx', oddZone) === '');

  let zoneForFails = 0;
  zoneTexts.slice(0, 20).forEach(function (file) {
    ['', 'P1', null].forEach(function (plant) {
      zoneTexts.slice(0, 8).forEach(function (answered) {
        if (!same('zoneFor', original.zoneFor(file, plant, answered),
                  port.zoneFor(file, plant, answered),
                  { file: file, plant: plant, answered: answered })) {
          zoneForFails++;
        }
      });
    });
  });
  check('every combination resolves to the same zone', zoneForFails === 0,
        zoneForFails + ' differed');
  check('nothing at all is Unspecified, not blank',
        port.zoneFor('', '', '') === ZONE_UNSPECIFIED);


  // =======================================================================
  console.log('');
  console.log('  The period - monthKey and the quarter in a filename');
  // =======================================================================
  const monthInputs = [
    '2026-08-20', '2026-08-20 19:59:35', '2026-08', '2026/08/20', '20-08-2026',
    '', '   ', 'August 2026', null, undefined, 0,
    new Date('2026-08-20T10:00:00Z'), new Date('2026-01-01T00:00:00Z'),
    /*
      A MONTH THAT IS NOT AT THE START. monthKey anchors its match with ^,
      and mutation testing showed nothing noticed when the anchor was
      removed - because every input above begins with the date. These do
      not, and the Month column of a real export is a free-text cell that
      can hold any of them.
    */
    'Training 2026-08-20', 'x2026-08', 'Session on 2026-08-20 at KEPZ',
    'FY2026-08'
  ];
  let monthFails = 0;
  monthInputs.forEach(function (v) {
    if (!same('monthKey', original.monthKey(v), port.monthKey(v),
              { value: String(v) })) {
      monthFails++;
    }
  });
  check('every date shape gives the same month', monthFails === 0,
        monthFails + ' differed');

  /*
    THE FILENAME BEATS THE SESSION DATE, and this is why it has to be read
    exactly right: "a file named Q1-2026 whose dates Excel turned into
    January 1974 belongs in Q1 2026, and filtering by month would drop it".
  */
  const quarterNames = [];
  [1, 2, 3, 4].forEach(function (q) {
    ['2026', '26'].forEach(function (y) {
      ['-', '_', '.', ' ', '/'].forEach(function (sep) {
        quarterNames.push('Feedback Q' + q + sep + y + '.xlsx');
        quarterNames.push('Feedback ' + y + sep + 'Q' + q + '.xlsx');
        quarterNames.push('q' + q + sep + y);
        quarterNames.push(y + sep + 'q' + q);
      });
      quarterNames.push('Feedback ' + y + 'Q' + q + '.xlsx');
    });
  });
  // The ones that must NOT fire, and the years that are not plausible years.
  ['FAQ1-2026.xlsx', 'Feedback Q5-2026.xlsx', 'Feedback Q0-2026.xlsx',
   'Feedback Q1-1874.xlsx', 'Feedback Q1-2126.xlsx', 'Feedback Q12026.xlsx',
   'Overall.xlsx', '', null, undefined].forEach(function (n) {
    quarterNames.push(n);
  });

  let quarterFails = 0;
  quarterNames.forEach(function (n) {
    if (!same('quarterFromFileName', original.quarterFromFileName(n),
              port.quarterFromFileName(n), { file: n })) {
      quarterFails++;
    }
  });
  check('every filename gives the same quarter', quarterFails === 0,
        quarterFails + ' differed');
  check('FAQ1-2026 is not Q1', port.quarterFromFileName('FAQ1-2026.xlsx') === '');
  check('a two-digit year becomes 20xx',
        port.quarterFromFileName('Feedback Q1-26.xlsx') === '2026-Q1');
  check('an implausible year is refused rather than guessed',
        port.quarterFromFileName('Feedback Q1-1874.xlsx') === '');


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
