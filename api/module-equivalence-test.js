/**
 * module-equivalence-test.js - module attribution must match Config.gs.
 * ===========================================================================
 *
 *     cd api
 *     node module-equivalence-test.js
 *
 * Needs nothing switched on. It is pattern matching and a lookup.
 *
 * WHAT IS AT STAKE. moduleForTicket decides which row of the By module
 * table a ticket lands in. Get one pattern wrong and a thousand tickets
 * move between modules, or pool in '(unassigned)' - and the table still
 * adds up, so nothing looks broken.
 *
 * The ordering rules are where the risk is, and neither is obvious:
 *
 *   CODES BEFORE WORDS, whatever their length. A code is what the ITSM
 *   writes in a Part cell on purpose; a word is a guess at what a prose
 *   Part might mean. A guess must never beat a deliberate label.
 *
 *   LONGEST FIRST WITHIN EACH KIND, so 'fi/tr' is not claimed by the
 *   shorter 'fi'. Config.gs: FI, TR and FI/TR are ONE module, and
 *   splitting them "made two rows out of one team's work, the smaller of
 *   which read as a rounding error".
 *
 * NO NAMES IN THIS FILE. The chart and the module exceptions are lifted
 * from src/Config.gs at run time, as roster-equivalence-test.js does it.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const port = require('./modules');
const rosterPort = require('./roster');

const CONFIG_GS = path.join(__dirname, '..', 'src', 'Config.gs');
const source = fs.readFileSync(CONFIG_GS, 'utf8');

const LIFT = ['moduleForTicket', 'moduleFromPart', 'moduleForPerson',
              'ticketModulePatterns', 'personModuleIndex',
              'matchPerson', 'rosterIndex', 'sectionFor'];


/** One object or array literal out of Config.gs, by key. Brace-counted. */
function liftLiteral(key, open, close) {
  const start = source.indexOf('\n  ' + key + ': ' + open);
  if (start === -1) return null;
  const from = source.indexOf(open, start);
  let depth = 0, inString = null, line = false, block = false;

  for (let i = from; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
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
      return vm.runInContext('(' + source.slice(from, i + 1) + ')', sandbox);
    }
  }
  return null;
}

function liftConst(name) {
  const hit = source.match(new RegExp('\\n  ' + name + ":\\s*'([^']*)'"));
  return hit ? hit[1] : null;
}

const ROSTER = liftLiteral('ROSTER', '{', '}');
const FORMER = liftLiteral('FORMER', '{', '}') || {};
const PERSON_MODULES = liftLiteral('PERSON_MODULES', '{', '}') || {};
const SECTION_MODULES = liftLiteral('SECTION_MODULES', '{', '}');
const TICKET_MODULES = liftLiteral('TICKET_MODULES', '[', ']');
const PRE_SPLIT = liftLiteral('PRE_SPLIT_SECTION', '{', '}');
const ERA = liftConst('SECTION_ERA_START');

if (!ROSTER || !SECTION_MODULES || !TICKET_MODULES || !PRE_SPLIT || !ERA) {
  console.error('\n  Could not read the module config out of src/Config.gs.\n');
  process.exit(1);
}

/*
  THE PORT'S OWN COPIES MUST MATCH, and that is checked rather than
  assumed. TICKET_MODULES and SECTION_MODULES are not personal data, so
  the port keeps them in code like the original does - which means two
  copies, and two copies drift. If somebody adds a Part spelling to
  Config.gs and not to modules.js, every other comparison below would
  still pass, because both sides would be asked only about patterns they
  share.
*/
let drift = 0;
function sameConfig(what, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  drift++;
  console.error('  ' + what + ' has drifted from src/Config.gs');
  console.error('      Config.gs: ' + JSON.stringify(a));
  console.error('      modules.js: ' + JSON.stringify(b));
}
sameConfig('TICKET_MODULES', TICKET_MODULES, port.TICKET_MODULES);
sameConfig('SECTION_MODULES', SECTION_MODULES, port.SECTION_MODULES);
if (drift) {
  console.error('');
  console.error('  Bring modules.js back into line before trusting anything ' +
                'below.');
  console.error('');
  process.exit(1);
}


/** The eight functions, in a sandbox with the globals they read. */
function loadOriginal() {
  let code =
    'const CONFIG = { ROSTER: ' + JSON.stringify(ROSTER) +
    ', FORMER: ' + JSON.stringify(FORMER) +
    ', PERSON_MODULES: ' + JSON.stringify(PERSON_MODULES) +
    ', SECTION_MODULES: ' + JSON.stringify(SECTION_MODULES) +
    ', TICKET_MODULES: ' + JSON.stringify(TICKET_MODULES) +
    ', PRE_SPLIT_SECTION: ' + JSON.stringify(PRE_SPLIT) +
    ', SECTION_ERA_START: ' + JSON.stringify(ERA) + ' };\n' +
    'let ROSTER_INDEX = null;\n' +
    'let PERSON_MODULE_INDEX = null;\n' +
    'let TICKET_MODULE_PATTERNS = null;\n';

  LIFT.forEach(function (name) {
    const re = new RegExp('\\nfunction ' + name +
                          '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
    const found = source.match(re);
    if (!found) {
      console.error('\n  Could not find ' + name + ' in src/Config.gs\n');
      process.exit(1);
    }
    code += found[0] + '\n';
  });

  code += 'module.exports = { ' + LIFT.join(', ') + ' };';

  const sandbox = { module: { exports: {} }, Object: Object, String: String,
                    Array: Array, Number: Number, JSON: JSON, RegExp: RegExp };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}

const original = loadOriginal();

// The port's index, built the way the roster table holds it.
const rows = [];
Object.keys(ROSTER).forEach(function (section) {
  (ROSTER[section] || []).forEach(function (person) {
    rows.push({ person_key: rosterPort.matchPerson(person), section: section,
                is_former: false,
                module: PERSON_MODULES[person] || null });
  });
});
Object.keys(FORMER).forEach(function (person) {
  rows.push({ person_key: rosterPort.matchPerson(person),
              section: FORMER[person], is_former: true,
              module: PERSON_MODULES[person] || null });
});
const index = rosterPort.buildIndex(rows);


let comparisons = 0, mismatches = 0;
const shown = [];

function compare(what, run, mine) {
  comparisons++;
  let a, b;
  try { a = { value: run() }; } catch (e) { a = { threw: e.message }; }
  try { b = { value: mine() }; } catch (e) { b = { threw: e.message }; }
  const left = JSON.stringify(a), right = JSON.stringify(b);
  if (left === right) return;
  mismatches++;
  if (shown.length < 12) {
    shown.push('  ' + what + '\n      Config.gs:  ' + left +
               '\n      modules.js: ' + right);
  }
}


// ---------------------------------------------------------------------------
console.log('');
console.log('  Lifted ' + LIFT.length + ' functions and the module config ' +
            'from src/Config.gs');
console.log('  ' + TICKET_MODULES.length + ' modules, ' +
            Object.keys(PERSON_MODULES).length + ' people with one of their ' +
            'own, ' + Object.keys(SECTION_MODULES).length + ' section defaults');
console.log('');


// ---------------------------------------------------------------------------
// moduleFromPart - every pattern, and the ways a Part is written
// ---------------------------------------------------------------------------
/*
  BUILT FROM THE PATTERNS THEMSELVES, so adding a module to Config.gs
  extends this test rather than leaving a gap in it. Each pattern is tried
  bare, inside a sentence, at either end, upper-cased, padded, and glued to
  a letter or digit on each side - which is the case the word boundary in
  the regex exists for.
*/
const SHAPES = [
  function (p) { return p; },
  function (p) { return p.toUpperCase(); },
  function (p) { return '  ' + p + '  '; },
  function (p) { return p + ' issue'; },
  function (p) { return 'urgent ' + p; },
  function (p) { return 'urgent ' + p + ' issue'; },
  function (p) { return p + '/other'; },
  function (p) { return 'other/' + p; },
  function (p) { return 'x' + p; },            // glued: must NOT match
  function (p) { return p + 'x'; },            // glued: must NOT match
  function (p) { return '1' + p + '2'; },      // glued to digits
  function (p) { return p + '-' + p; },
  function (p) { return p.split('').join(' '); }
];

const EVERY_PATTERN = [];
TICKET_MODULES.forEach(function (m) {
  (m.codes || m.match || []).forEach(function (p) { EVERY_PATTERN.push(p); });
  (m.words || []).forEach(function (p) { EVERY_PATTERN.push(p); });
});

EVERY_PATTERN.forEach(function (p) {
  SHAPES.forEach(function (shape, s) {
    const part = shape(p);
    compare('moduleFromPart(shape ' + s + ' of a pattern)',
            function () { return original.moduleFromPart(part); },
            function () { return port.moduleFromPart(part); });
  });
});

/*
  AND THE PARTS THAT ARE NOT MODULES. Config.gs names them: "Account,
  Monitoring, Groupware, PC/Monitor, Others, FRP, TexManager, WMIS" -
  letting those through "produced a table of fifteen rows, half of which no
  one reports against". Account IS a module here; the rest must not be.

  'Accounting' is the one that matters most: it contains 'co' and would be
  claimed by the CO module without the word boundary.
*/
const NOT_MODULES = [
  '', ' ', '   ', 'Monitoring', 'Groupware', 'PC/Monitor', 'Others', 'FRP',
  'TexManager', 'WMIS', 'Accounting', 'accounting', 'e-Accounting',
  'Security', 'Infrastructure', 'Packing Automation System', 'Account',
  'Business App', 'Information Security', 'eFeedback Management System',
  'Youngone SAP Document Management System', 'MD Office', 'co-ordination',
  'commodity', 'company', 'discount', 'md.', 'Md', 'TR Report',
  'FI Report', 'fi/tr', 'FI/TR', 'FITR', 'fi_tr', 'MM Purchase',
  'purchase order', 'production planning', 'export documentation',
  null, undefined, 0, false, {}, []
];
NOT_MODULES.forEach(function (part) {
  compare('moduleFromPart(' + JSON.stringify(String(part)) + ')',
          function () { return original.moduleFromPart(part); },
          function () { return port.moduleFromPart(part); });
});


// ---------------------------------------------------------------------------
// moduleForPerson - everybody on the chart, plus strangers
// ---------------------------------------------------------------------------
const everyName = [];
Object.keys(ROSTER).forEach(function (s) {
  (ROSTER[s] || []).forEach(function (p) { everyName.push(p); });
});
Object.keys(FORMER).forEach(function (p) { everyName.push(p); });

/*
  THE MONTH MUST NOT CHANGE THE ANSWER, and that is the point of including
  it. moduleForPerson reads the section at TODAY'S names however old the
  ticket - Config.gs: "'Functional Applications' covered three modules at
  once and cannot name just one." A port that passed the month through to
  sectionFor would return nothing for every pre-August ticket, because
  SECTION_MODULES has no entry for the pre-split names.
*/
const MONTHS = [null, undefined, '', '2019-01', '2026-07', '2026-08',
                '2026-09', '2099-12'];

everyName.forEach(function (name) {
  const variants = [name, name.toUpperCase(), name.replace(/\./g, ''),
                    '  ' + name + '  ',
                    name.replace(/^(Mohammad|Muhammad|Mohd|Md)\.?\s*/i, '')];
  variants.forEach(function (who) {
    MONTHS.forEach(function (month) {
      compare('moduleForPerson(a chart name, ' + month + ')',
              function () { return original.moduleForPerson(who, month); },
              function () { return port.moduleForPerson(index, who, month); });
    });
  });
});

['', '   ', 'Nobody At All', 'Md. Nobody', 'A N Other', '12345',
 null, undefined].forEach(function (who) {
  MONTHS.forEach(function (month) {
    compare('moduleForPerson(stranger, ' + month + ')',
            function () { return original.moduleForPerson(who, month); },
            function () { return port.moduleForPerson(index, who, month); });
  });
});


/*
  THE EXCEPTION INDEX ITSELF. Config.gs keeps it in personModuleIndex();
  the port carries it on the roster index as `module`, because that is
  already the one lookup built per run and loaded from the one table.
  Same keys, same values, different home - compared directly so the claim
  is made rather than inferred from the lookups above.
*/
/*
  COMPARED BY SORTED ENTRIES, NOT BY JSON OF THE OBJECT. The two build the
  same map in a different order - Config.gs walks PERSON_MODULES, the port
  walks the roster rows - and JSON.stringify preserves insertion order, so
  comparing the objects whole failed on a difference that is not one. A
  lookup map has no order; only index.module[key] is ever read.
*/
function sortedEntries(map) {
  return Object.keys(map || {}).sort().map(function (k) {
    return k + '=' + map[k];
  });
}

compare('personModuleIndex()',
        function () { return sortedEntries(original.personModuleIndex()); },
        function () { return sortedEntries(index.module); });


// ---------------------------------------------------------------------------
// moduleForTicket - the three sources, and the order between them
// ---------------------------------------------------------------------------
/*
  THE PART WINS OVER THE PERSON when it names a module, and the person
  wins over nothing. These pairs put a Part that says one module against a
  person who works another, which is the only way to see which rule fired.
*/
const PARTS = ['', '   ', 'MM', 'SD', 'PP', 'FI/TR', 'CO', 'MD', 'Account',
               'e-Accounting', 'Monitoring', 'Others', 'Accounting',
               'purchase', 'production', 'export', 'nonsense', null];

const PEOPLE = everyName.slice(0, 12).concat(['Nobody At All', '', null]);

PARTS.forEach(function (part) {
  PEOPLE.forEach(function (who) {
    ['2019-01', '2026-09', null].forEach(function (month) {
      compare('moduleForTicket(' + JSON.stringify(String(part)) + ', person, ' +
              month + ')',
              function () { return original.moduleForTicket(part, who, month); },
              function () { return port.moduleForTicket(index, part, who, month); });
    });
  });
});


// ---------------------------------------------------------------------------
// The compiled pattern list itself
// ---------------------------------------------------------------------------
/*
  Compared as names and order rather than as objects, because the compiled
  entries carry RegExp values that do not survive JSON. The ORDER is the
  behaviour: codes before words, longest first inside each.
*/
compare('ticketModulePatterns() order',
        function () {
          return original.ticketModulePatterns().map(function (p) {
            return p.kind + ':' + p.pattern + '->' + p.name;
          });
        },
        function () {
          return port.ticketModulePatterns().map(function (p) {
            return p.kind + ':' + p.pattern + '->' + p.name;
          });
        });


/*
  AND THE ESCAPING, WHICH THE REAL LIST CANNOT REACH.

  Not one of the twenty-four Part patterns in use contains a character the
  escape changes, so against the real list that line is a no-op and
  deleting it altered no answer - the break survived everything above.

  It matters the day somebody adds a Part spelling with a dot or a plus in
  it. Unescaped, 'c.o' stops being a literal: '.' matches any character, so
  it would claim 'cao' and 'c-o' as well. A whole module's tickets would
  quietly move rows.

  The compiled regex is compared by its SOURCE, because a RegExp does not
  survive JSON - and the source is exactly where the escaping shows.
*/
const SYNTHETIC = [
  { name: 'Dotted',   codes: ['c.o', 'f.i'] },
  { name: 'Plussed',  codes: ['fi+tr'], words: ['a*b'] },
  { name: 'Bracketed', codes: ['x(y)', 'p[q]', 'a|b', 'a$b', 'a^b'] }
];

compare('ticketModulePatterns(a list with regex metacharacters)',
        function () {
          // The original reads CONFIG.TICKET_MODULES and memoises, so it
          // gets its own sandbox with the synthetic list in place.
          const sandbox = { module: { exports: {} }, Object: Object,
                            String: String, Array: Array, Number: Number,
                            JSON: JSON, RegExp: RegExp };
          let code = 'const CONFIG = { TICKET_MODULES: ' +
                     JSON.stringify(SYNTHETIC) + ' };\n' +
                     'let TICKET_MODULE_PATTERNS = null;\n';
          const re = new RegExp('\\nfunction ticketModulePatterns' +
                                '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
          code += source.match(re)[0] + '\n';
          code += 'module.exports = { ticketModulePatterns };';
          vm.createContext(sandbox);
          vm.runInContext(code, sandbox);
          return sandbox.module.exports.ticketModulePatterns().map(function (p) {
            return p.kind + ':' + p.pattern + '->' + p.name + ' /' + p.re.source + '/';
          });
        },
        function () {
          return port.ticketModulePatterns(SYNTHETIC).map(function (p) {
            return p.kind + ':' + p.pattern + '->' + p.name + ' /' + p.re.source + '/';
          });
        });

// Passing a list must not disturb the real one, which is memoised.
compare('the real patterns are unchanged afterwards',
        function () {
          return original.ticketModulePatterns().map(function (p) {
            return p.kind + ':' + p.pattern + '->' + p.name;
          });
        },
        function () {
          return port.ticketModulePatterns().map(function (p) {
            return p.kind + ':' + p.pattern + '->' + p.name;
          });
        });


// ---------------------------------------------------------------------------
// And no colleague's name in this file
// ---------------------------------------------------------------------------
comparisons++;
if (fs.readFileSync(__filename, 'utf8') &&
    everyName.some(function (n) {
      return fs.readFileSync(__filename, 'utf8').indexOf(n) !== -1;
    })) {
  mismatches++;
  shown.push('  a name from the org chart appears in this test file.\n' +
             '      Say what the rule does, not who it was written for.');
}
comparisons++;
if (everyName.some(function (n) {
      return fs.readFileSync(path.join(__dirname, 'modules.js'), 'utf8')
               .indexOf(n) !== -1;
    })) {
  mismatches++;
  shown.push('  a name from the org chart appears in modules.js.');
}


// ---------------------------------------------------------------------------
console.log('');
if (mismatches) {
  console.log('  ' + mismatches + ' MISMATCH(ES) out of ' + comparisons +
              ' comparisons:');
  console.log('');
  shown.forEach(function (line) { console.log(line); });
  console.log('');
  console.log('  The port files tickets under different modules from ' +
              'src/Config.gs.');
  console.log('  Fix the port, not this.');
  process.exit(1);
}

console.log('  ' + comparisons + ' comparisons, all identical to src/Config.gs');
console.log('');
