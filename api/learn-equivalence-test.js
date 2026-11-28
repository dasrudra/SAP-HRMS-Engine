/**
 * learn-equivalence-test.js - the library's classification must match Learn.gs.
 * ===========================================================================
 *
 *     cd api
 *     node learn-equivalence-test.js
 *
 * Needs nothing switched on - no server, no database, no Google. It is
 * string parsing, which is exactly why it can be proved rather than
 * sampled.
 *
 * WHAT IS AT STAKE. The Learnings library has no form to fill in: a
 * document's type, module, business and title are read off its filename and
 * the folder it sits in. Get that wrong and an SOP lands under the wrong
 * module, or appears twice under two titles, or loses the [SOP] badge and
 * drops out of the filter somebody is looking at. Nobody would see a stack
 * trace - they would see a document that is not there.
 *
 * So the port is not trusted to agree with Learn.gs. It is made to prove
 * it, over every type word in every bracket style, every business prefix
 * against the separators and the near-misses, every module folder in the
 * spellings people actually use, and a few hundred names built to break it.
 *
 * NOTHING IS RETYPED HERE. Both halves are lifted at run time - the
 * functions out of src/Learn.gs, the lists out of src/Config.gs - so this
 * file carries no copy of either to drift from.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const port = require('./learn-scan');

const LEARN_GS = path.join(__dirname, '..', 'src', 'Learn.gs');
const CONFIG_GS = path.join(__dirname, '..', 'src', 'Config.gs');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  if (failures.length < 12) {
    failures.push(name + (detail === undefined ? '' : '   ' + detail));
  }
}

function heading(text) {
  console.log('');
  console.log('  ' + text);
}


/**
 * CONFIG.LEARN, lifted out of Config.gs.
 *
 * Read rather than retyped, the same way roster-equivalence-test lifts the
 * roster: a copy here would agree with itself for ever and prove nothing
 * about the file the live system actually runs.
 */
function liftLearnConfig() {
  const source = fs.readFileSync(CONFIG_GS, 'utf8');
  const at = source.indexOf('\n  LEARN: {');
  if (at === -1) {
    console.error('\n  Could not find CONFIG.LEARN in src/Config.gs\n');
    process.exit(1);
  }

  // Balance the braces from the opening one, so the block ends where it ends.
  const open = source.indexOf('{', at);
  let depth = 0;
  let close = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close === -1) {
    console.error('\n  CONFIG.LEARN in src/Config.gs does not close.\n');
    process.exit(1);
  }

  const sandbox = { Object: Object, String: String, Array: Array,
                    Number: Number, JSON: JSON };
  vm.createContext(sandbox);
  return vm.runInContext('(' + source.slice(open, close + 1) + ')', sandbox);
}


/** The five functions, lifted out of Learn.gs and given that CONFIG. */
function liftLearnFunctions(learnConfig) {
  const source = fs.readFileSync(LEARN_GS, 'utf8');
  const LIFT = ['learnFlat', 'learnTitle', 'learnModule', 'learnBusiness',
                'parseLearnName'];

  let code = 'const CONFIG = { LEARN: ' + JSON.stringify(learnConfig) + ' };\n';

  LIFT.forEach(function (name) {
    const re = new RegExp('\\nfunction ' + name +
                          '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
    const found = source.match(re);
    if (!found) {
      console.error('\n  Could not find ' + name + ' in src/Learn.gs\n');
      process.exit(1);
    }
    code += found[0] + '\n';
  });

  code += 'module.exports = { ' + LIFT.join(', ') + ' };';

  const sandbox = { module: { exports: {} }, Object: Object, String: String,
                    Array: Array, Number: Number, JSON: JSON,
                    RegExp: RegExp };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}


/**
 * Every filename worth trying, built rather than listed.
 *
 * The point of generating them is coverage of the SEAMS - a bracket word
 * against every bracket style, a business prefix against every separator
 * and against the words that merely start with one - rather than a handful
 * of real names that all happen to be well formed.
 */
function corpus(learnConfig) {
  const names = [];

  const typeWords = learnConfig.TYPES.map(function (t) { return t.match; })
    .concat(['SOP', 'User Guideline', 'Policy', 'Training', 'Manual',
             'Presentation', 'user  guideline', 'USERGUIDELINE', 'S.O.P',
             'Checklist', 'Draft', '', '   ', 'Guideline v2']);
  const brackets = [['[', ']'], ['(', ')']];
  const bizWords = learnConfig.BUSINESS.concat(['rmg', 'mg', 'MGT', 'RMGX',
                                                'MG', 'Mg']);
  const seps = ['_', ' ', '-', '  ', '_ ', ''];
  const subjects = ['SAP_S4HANA_MM Process', 'Monthly Close',
                    'Goods   Receipt', '_leading underscore',
                    'trailing underscore_', 'a', '', '-dash-',
                    'Amortization (RMG)', 'FI/CO rules'];
  const exts = ['.pdf', '.PDF', '.docx', '.mp4', '.pptx', '.xlsx', '.txt',
                '', '.verylongext', '.7z'];

  // Typed, with a business, over every separator.
  typeWords.forEach(function (word) {
    brackets.forEach(function (pair) {
      bizWords.forEach(function (biz) {
        seps.forEach(function (sep) {
          names.push(pair[0] + word + pair[1] + ' ' + biz + sep +
                     'SAP_S4HANA_MM Process.pdf');
        });
      });
    });
  });

  // Untyped, and the brackets that are not at the front.
  subjects.forEach(function (subject) {
    exts.forEach(function (ext) {
      names.push(subject + ext);
      names.push('[SOP] ' + subject + ext);
      names.push(subject + ' [SOP]' + ext);
      names.push('  [SOP]   ' + subject + ext);
    });
  });

  // The shapes that have broken something before, and the empty cases.
  ['', ' ', '.pdf', '[]', '[].pdf', '()x.pdf', '[' + 'x'.repeat(41) + '] A.pdf',
   '[SOP].pdf', '[SOP] .pdf', 'RMG.pdf', 'RMG_.pdf', 'RMG_ .pdf',
   '[sop][policy] RMG_Two brackets.pdf', '[SOP] RMG_MG_Both.pdf',
   'MG-Hyphen separated.pdf', 'MG Space separated.pdf',
   'MGT Report.pdf', 'RMGX Report.pdf', '___.pdf', '---.pdf',
   '[Training] MG_Session   1.mp4'].forEach(function (n) { names.push(n); });

  return names;
}


function main() {
  const learnConfig = liftLearnConfig();
  const gs = liftLearnFunctions(learnConfig);

  console.log('');
  console.log('  Lifted from src/Learn.gs: learnFlat, learnTitle, ' +
              'learnModule, learnBusiness, parseLearnName');
  console.log('  Lifted from src/Config.gs: ' + learnConfig.TYPES.length +
              ' types, ' + learnConfig.MODULES.length + ' modules, ' +
              learnConfig.BUSINESS.length + ' businesses');

  /*
    THE LISTS THE TWO SIDES READ MUST BE THE SAME LISTS. Everything below
    compares behaviour, and identical behaviour over different data would
    prove nothing - so this comes first.
  */
  heading('The classification lists');
  const content = require('./content');
  check('the type list is the one in Config.gs',
        JSON.stringify(content.LEARN_TYPES) ===
        JSON.stringify(learnConfig.TYPES),
        JSON.stringify(content.LEARN_TYPES));
  check('the module list is too',
        JSON.stringify(content.LEARN_MODULES) ===
        JSON.stringify(learnConfig.MODULES),
        JSON.stringify(content.LEARN_MODULES));
  check('and the businesses',
        JSON.stringify(content.LEARN_BUSINESS) ===
        JSON.stringify(learnConfig.BUSINESS),
        JSON.stringify(content.LEARN_BUSINESS));
  check('and the fallback type a nameless document gets',
        content.LEARN_FALLBACK_TYPE === learnConfig.FALLBACK_TYPE,
        JSON.stringify(content.LEARN_FALLBACK_TYPE));
  console.log('  ' + pass + ' of 4 so far');

  heading('parseLearnName, over every generated filename');
  const names = corpus(learnConfig);
  let first = null;
  names.forEach(function (name) {
    const a = gs.parseLearnName(name);
    const b = port.parseLearnName(name);
    const same = a.type === b.type && a.typed === b.typed &&
                 a.title === b.title && a.biz === b.biz && a.ext === b.ext;
    if (!same && !first) {
      first = { name: name, gs: a, port: b };
    }
    check('parseLearnName ' + JSON.stringify(name), same,
          JSON.stringify({ gs: a, port: b }));
  });
  console.log('  ' + names.length + ' filenames compared field by field');
  if (first) {
    console.log('  first disagreement: ' + JSON.stringify(first, null, 2));
  }

  heading('learnTitle, learnFlat');
  const scraps = names.concat(['', '  ', '_', '__ __', 'a_b_c', ' - x - ',
                               'FI-CO', 'MM  Module', null, undefined, 0,
                               'Already A Title']);
  scraps.forEach(function (s) {
    check('learnTitle ' + JSON.stringify(s),
          gs.learnTitle(s) === port.learnTitle(s),
          JSON.stringify([gs.learnTitle(s), port.learnTitle(s)]));
    check('learnFlat ' + JSON.stringify(s),
          gs.learnFlat(s) === port.learnFlat(s),
          JSON.stringify([gs.learnFlat(s), port.learnFlat(s)]));
  });
  console.log('  ' + scraps.length + ' strings through both');

  heading('learnModule, over the folder names people actually use');
  const folders = [];
  learnConfig.MODULES.forEach(function (m) {
    [m.match, m.name, m.name + ' Module', m.name.toUpperCase(),
     m.name.toLowerCase(), '1. ' + m.name, '02 ' + m.name + ' Module',
     m.name.replace(/-/g, ' '), m.name.replace(/-/g, ''),
     ' ' + m.name + ' '].forEach(function (f) { folders.push(f); });
  });
  /*
    AND THE ONES THAT MUST NOT MATCH. 'Common' contains m-m, which is the
    trap Learn.gs names: a substring test files Common as MM, and only the
    order of the list hides it. Anchoring at the start is what makes these
    answer the same both sides.
  */
  ['Common', 'common', '_Archive', 'Archive', 'Old', 'Nonsense', '',
   '123', 'Summary', 'Minutes', 'Miscellaneous', 'FICO', 'FI CO Module',
   'SDLC', 'PPT Templates'].forEach(function (f) { folders.push(f); });

  folders.forEach(function (f) {
    const a = gs.learnModule(f);
    const b = port.learnModule(f);
    const same = (a === null && b === null) ||
                 Boolean(a && b && a.name === b.name && a.accent === b.accent);
    check('learnModule ' + JSON.stringify(f), same,
          JSON.stringify([a, b]));
  });
  console.log('  ' + folders.length + ' folder names compared');
  /*
    Said out loud as well as compared, because both sides agreeing on a
    wrong answer is the one thing an equivalence test cannot see.
  */
  check('COMMON IS COMMON AND NOT MM, which a substring test gets wrong',
        port.learnModule('Common').name === 'Common' &&
        gs.learnModule('Common').name === 'Common');
  check('and a numbered folder is still its module',
        port.learnModule('2. MM Module').name === 'MM');
  check('and the archive folder is not a module at all',
        port.learnModule('_Archive') === null &&
        gs.learnModule('_Archive') === null);

  heading('learnBusiness');
  const bizFolders = ['RMG', 'MG', 'rmg', 'mg', ' RMG ', 'R.M.G', 'RMGX',
                      'MGT', '', 'Common', 'MG Module', 'M G'];
  bizFolders.forEach(function (f) {
    check('learnBusiness ' + JSON.stringify(f),
          gs.learnBusiness(f) === port.learnBusiness(f),
          JSON.stringify([gs.learnBusiness(f), port.learnBusiness(f)]));
  });
  console.log('  ' + bizFolders.length + ' folder names compared');

  heading('The two traps Learn.gs warns about, stated as answers');
  check('a bracket that is not at the front is left alone - "Amortization ' +
        '(RMG).pdf" is not a document of type RMG',
        port.parseLearnName('Amortization (RMG).pdf').type === 'Document' &&
        port.parseLearnName('Amortization (RMG).pdf').title ===
          'Amortization (RMG)');
  check('AND A BUSINESS PREFIX NEEDS A SEPARATOR AFTER IT - "MGT Report" ' +
        'keeps all three letters',
        port.parseLearnName('MGT Report.pdf').biz === '' &&
        port.parseLearnName('MGT Report.pdf').title === 'MGT Report');
  check('while "MG_Something" does not',
        port.parseLearnName('MG_Something.pdf').biz === 'MG' &&
        port.parseLearnName('MG_Something.pdf').title === 'Something');
  check('an unrecognised bracket still comes off the title, so there are ' +
        'not two titles for one kind of thing',
        port.parseLearnName('[Checklist] Monthly Close.xlsx').title ===
          'Monthly Close' &&
        port.parseLearnName('[Checklist] Monthly Close.xlsx').type ===
          'Document');
  check('and a file with nothing left is called Document rather than ' +
        'drawn with no title',
        port.parseLearnName('[SOP] .pdf').title === 'Document');

  console.log('');
  if (fail) {
    console.log('  ' + pass + ' comparisons, ' + fail + ' DISAGREED');
    console.log('');
    failures.forEach(function (line) { console.log('    - ' + line); });
    console.log('');
    process.exit(1);
  }
  console.log('  ' + pass + ' comparisons, all identical to src/Learn.gs');
  console.log('');
  process.exit(0);
}

main();
