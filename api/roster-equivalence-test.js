/**
 * roster-equivalence-test.js - attribution must match Config.gs exactly.
 * ===========================================================================
 *
 *     cd api
 *     node roster-equivalence-test.js
 *
 * Needs nothing switched on - no server, no database. It is name matching.
 *
 * WHAT IS AT STAKE. sectionFor decides which section a ticket counts
 * towards. Get it wrong for one person and their work moves to another
 * section's KPI, or lands in '(unassigned)', and every figure on the page
 * is off in a way that looks like a data problem rather than a code one.
 *
 * So the port is not trusted to agree with Config.gs - it is made to
 * prove it, over every name on the chart in seven spellings each, across
 * the August 2026 section split, and against a few hundred names that are
 * not on it at all.
 *
 * NO NAMES IN THIS FILE. They are lifted from src/Config.gs at run time,
 * the same way import-roster.js does it, so this test carries none of its
 * own and prints one only when something disagrees.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const port = require('./roster');

const CONFIG_GS = path.join(__dirname, '..', 'src', 'Config.gs');
const source = fs.readFileSync(CONFIG_GS, 'utf8');

const LIFT = ['matchPerson', 'rosterIndex', 'sectionFor', 'rosterOrderFor'];


/** One object literal out of Config.gs, by key. Brace-counted, not matched. */
function liftObject(key) {
  const start = source.indexOf('\n  ' + key + ': {');
  if (start === -1) return null;
  const open = source.indexOf('{', start);
  let depth = 0, inString = null, line = false, block = false;

  for (let i = open; i < source.length; i++) {
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
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const sandbox = {};
      vm.createContext(sandbox);
      return vm.runInContext('(' + source.slice(open, i + 1) + ')', sandbox);
    }
  }
  return null;
}

function liftConst(name) {
  const hit = source.match(new RegExp('\\n  ' + name + ":\\s*'([^']*)'"));
  return hit ? hit[1] : null;
}

const ROSTER = liftObject('ROSTER');
const FORMER = liftObject('FORMER') || {};
const PRE_SPLIT = liftObject('PRE_SPLIT_SECTION');
const ERA = liftConst('SECTION_ERA_START');

if (!ROSTER || !PRE_SPLIT || !ERA) {
  console.error('\n  Could not read ROSTER, PRE_SPLIT_SECTION or ' +
                'SECTION_ERA_START from src/Config.gs.\n');
  process.exit(1);
}


/**
 * The four functions, in a sandbox with the globals they read.
 *
 * TAKES THE ROSTER, rather than always using the real one, because two of
 * the guards in rosterIndex cannot be reached with the chart as it stands
 * today - nobody on it shares a bare name, and the one person who has left
 * is not also listed as present. Both survived a deliberate break until
 * this test started building rosters that do contain those situations.
 *
 * ROSTER_INDEX is memoised inside Config.gs, so each scenario gets its own
 * sandbox. Reusing one would hand the second scenario the first's answer.
 */
function loadOriginal(roster, former) {
  let code =
    'const CONFIG = { ROSTER: ' + JSON.stringify(roster) +
    ', FORMER: ' + JSON.stringify(former) +
    ', PRE_SPLIT_SECTION: ' + JSON.stringify(PRE_SPLIT) +
    ', SECTION_ERA_START: ' + JSON.stringify(ERA) + ' };\n' +
    'let ROSTER_INDEX = null;\n';

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
                    Array: Array, Number: Number, JSON: JSON };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.module.exports;
}

/*
  The port is given the same roster, in the shape the TABLE holds it -
  which is also a check on import-roster.js, since that derives its rows
  exactly this way.
*/
function portRows(roster, former) {
  const rows = [];
  Object.keys(roster).forEach(function (section) {
    (roster[section] || []).forEach(function (person) {
      rows.push({ person_key: port.matchPerson(person), section: section,
                  is_former: false });
    });
  });
  Object.keys(former).forEach(function (person) {
    rows.push({ person_key: port.matchPerson(person), section: former[person],
                is_former: true });
  });
  return rows;
}

/*
  FOUR ROSTERS, NOT ONE. The first is the real chart; the other three are
  made up entirely, with invented names, and each exists to reach a branch
  the real one cannot:

    shared bare name   two different people whose names are the same once
                       the honorific is dropped.

                       THIS SCENARIO CANNOT ACTUALLY REACH THE GUARD, and
                       nor can any other. A bare form is only recorded
                       when it differs from the key - when the key starts
                       'md' - and it is that key with those two characters
                       removed. Two distinct keys sharing a bare form
                       would mean k1.slice(2) === k2.slice(2) with both
                       starting 'md', which means k1 === k2: one person.
                       Brute-forced over the honorific spellings and the
                       awkward names, and nothing collides.

                       So CONFIG.ROSTER's clash map is dead code, two
                       deliberate breaks of it survive every test here,
                       and that is a fact about Config.gs rather than a
                       hole in this file. The scenario stays because it
                       exercises the surrounding path and would catch the
                       day somebody changes how stripping works.

    leaver who is also present   the same person in ROSTER and in FORMER.
                       Config.gs adds the leavers SECOND, "so that if a
                       name somehow appears in both, the person who is
                       still here wins". On the real chart the one leaver
                       is not also listed as present, so the order was
                       free to be wrong.

    empty              no chart at all, which is what a fresh database
                       looks like before import-roster.js has been run.
*/
const SCENARIOS = [
  { name: 'the real chart', roster: ROSTER, former: FORMER },
  { name: 'a shared bare name',
    roster: { 'Alpha Section': ['Md. Example Person'],
              'Beta Section':  ['Example Person'] },
    former: {} },
  { name: 'a leaver who is also on the chart',
    roster: { 'Alpha Section': ['Sample Name'] },
    former: { 'Sample Name': 'Beta Section' } },
  { name: 'an empty chart', roster: {}, former: {} }
];

SCENARIOS.forEach(function (s) {
  s.original = loadOriginal(s.roster, s.former);
  s.index = port.buildIndex(portRows(s.roster, s.former));
  s.sections = {};
  Object.keys(s.roster).forEach(function (name) {
    s.sections[name] = (s.roster[name] || []).map(port.matchPerson);
  });
  s.names = [];
  Object.keys(s.roster).forEach(function (name) {
    (s.roster[name] || []).forEach(function (p) { s.names.push(p); });
  });
  Object.keys(s.former).forEach(function (p) { s.names.push(p); });
});

// The real chart, for the checks that only make sense against it.
const real = SCENARIOS[0];
const original = real.original;
const index = real.index;
const sections = real.sections;


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
    shown.push('  ' + what + '\n      Config.gs: ' + left +
               '\n      port:      ' + right);
  }
}


// ---------------------------------------------------------------------------
console.log('');
console.log('  Lifted ' + LIFT.length + ' functions and the org chart from ' +
            'src/Config.gs');
console.log('  ' + real.names.length + ' people across ' +
            Object.keys(ROSTER).length + ' sections, era starts ' + ERA);
console.log('  ' + SCENARIOS.length + ' charts compared: ' +
            SCENARIOS.map(function (s) { return s.name; }).join(', '));
console.log('');


// ---------------------------------------------------------------------------
// matchPerson, over every name on the chart written seven ways
// ---------------------------------------------------------------------------
/*
  THE SEVEN SPELLINGS ARE NOT INVENTED. Config.gs records the real cases
  behind each one: the honorific run straight into the first name with no
  space, and the ITSM spelling it out in full where the org chart
  abbreviates it. These are transformations the exports actually apply.
*/
function spellings(name) {
  const out = [name, name.toLowerCase(), name.toUpperCase(),
               name.replace(/\./g, ''), name.replace(/\./g, '. '),
               '  ' + name + '  ', name.replace(/\s+/g, '  ')];

  // The honorific written each of the four ways, and dropped entirely.
  ['Md.', 'Md', 'Mohammad', 'Muhammad', 'Mohd', ''].forEach(function (h) {
    const swapped = name.replace(/^(Mohammad|Muhammad|Mohd|Md)\.?\s*/i,
                                 h ? h + ' ' : '');
    if (swapped !== name) out.push(swapped);
  });
  return out;
}

const everyName = [];
Object.keys(ROSTER).forEach(function (s) {
  (ROSTER[s] || []).forEach(function (p) { everyName.push(p); });
});
Object.keys(FORMER).forEach(function (p) { everyName.push(p); });

everyName.forEach(function (name) {
  spellings(name).forEach(function (variant) {
    compare('matchPerson(a chart name, variant)',
            function () { return original.matchPerson(variant); },
            function () { return port.matchPerson(variant); });
  });
});

/*
  AND NAMES THAT ARE NOT PEOPLE. matchPerson strips everything but letters,
  so these are the shapes that could produce an empty key, a key that is
  only the honorific, or a word that merely starts with one.
*/
const ODD = ['', ' ', '   ', '.', '...', '-', '123', 'A', 'Md', 'Md.',
             'Md. ', 'MD', 'mohammad', 'Mdhuri Sharma', 'Mohandas',
             'Mohd', 'Muhammadu Buhari', 'X Y', "O'Brien", 'Jean-Luc',
             'Ann  Marie', '\tTabbed\t', 'Name (Contractor)', '2 Fast',
             null, undefined, 0, false, {}, []];
ODD.forEach(function (odd) {
  compare('matchPerson(' + JSON.stringify(String(odd)) + ')',
          function () { return original.matchPerson(odd); },
          function () { return port.matchPerson(odd); });
});


// ---------------------------------------------------------------------------
// The index itself
// ---------------------------------------------------------------------------
SCENARIOS.forEach(function (s) {
  /*
    THE THREE MAPS rosterIndex BUILDS, NOT THE WHOLE OBJECT.

    The port's index also carries `module`, which Config.gs keeps in a
    separate personModuleIndex(). Comparing the objects whole made this
    fail the moment that was added, while every lookup through it still
    agreed - the comparison was over-specified, asserting a shape rather
    than an answer.

    The module map has its own comparison, in module-equivalence-test.js,
    against the function that actually holds it over there.
  */
  const threeMaps = function (i) {
    return { full: i.full, bare: i.bare, clash: i.clash };
  };

  compare('rosterIndex() [' + s.name + ']',
          function () { return threeMaps(s.original.rosterIndex()); },
          function () { return threeMaps(s.index); });

  /*
    AND sectionFor THROUGH THAT INDEX, for every name in that scenario and
    the spellings around it. The index being equal is not quite the same
    claim as the lookups through it agreeing - full, bare and clash are
    read in a particular order, and only this notices if that order moves.
  */
  s.names.forEach(function (name) {
    spellings(name).concat([name.replace(/^Md\.?\s*/i, '')]).forEach(
      function (variant) {
        ['2026-07', '2026-09', null].forEach(function (month) {
          compare('sectionFor [' + s.name + '] (' + month + ')',
                  function () { return s.original.sectionFor(variant, month, 'F'); },
                  function () { return port.sectionFor(s.index, variant, month, 'F'); });
        });
      });
  });
});


// ---------------------------------------------------------------------------
// sectionFor - every name, every spelling, across the era boundary
// ---------------------------------------------------------------------------
/*
  THE MONTHS STRADDLE THE SPLIT ON PURPOSE. Before 2026-08 there were two
  sections, not four, and a ticket from March scored against today's shape
  would be filed under a section that did not exist. The month either side
  of the boundary, and the boundary itself, are the three that matter.
*/
const MONTHS = [null, undefined, '', '2026-07', '2026-08', '2026-09',
                '2025-01', '2026-12', '2027-06', 'rubbish', '2026-7'];
const FALLBACKS = ['', 'Functional', 'Technical', '  spaced  ', null, undefined];

everyName.forEach(function (name) {
  spellings(name).forEach(function (variant) {
    MONTHS.forEach(function (month) {
      compare('sectionFor(chart name, ' + month + ')',
              function () { return original.sectionFor(variant, month, ''); },
              function () { return port.sectionFor(index, variant, month, ''); });
    });
  });
});

// The fallback path: somebody not on the chart at all.
const STRANGERS = ['Nobody At All', 'A N Other', 'Contractor One', '',
                   '   ', 'Md. Nobody', 'Mohd Stranger', '12345'];
STRANGERS.forEach(function (name) {
  MONTHS.forEach(function (month) {
    FALLBACKS.forEach(function (fallback) {
      compare('sectionFor(stranger, ' + month + ', ' +
              JSON.stringify(String(fallback)) + ')',
              function () { return original.sectionFor(name, month, fallback); },
              function () {
                return port.sectionFor(index, name, month, fallback);
              });
    });
  });
});


// ---------------------------------------------------------------------------
// rosterOrderFor - the loose section match
// ---------------------------------------------------------------------------
/*
  The TEAM tab and the roster spell sections differently, and the matcher
  strips the word 'Applications' and compares prefixes. These are the
  spellings the tab is known to use, plus the ones that would break a
  prefix comparison if it were done the other way round.
*/
const SECTION_NAMES = Object.keys(ROSTER).concat([
  'Sales and Customer Applications', 'Sales & Customer Applications',
  'Manufacturing Application', 'manufacturing', 'SUPPLY CHAIN',
  'Supply Chain', 'Financial', 'Finance', 'EAS', 'eas',
  'Applications', '', '   ', 'Nothing Like It', null, undefined
]);

SECTION_NAMES.forEach(function (name) {
  compare('rosterOrderFor(' + JSON.stringify(String(name)) + ')',
          function () { return original.rosterOrderFor(name); },
          function () { return port.rosterOrderFor(sections, name); });
});


// ---------------------------------------------------------------------------
// And no colleague's name in any file this port added
// ---------------------------------------------------------------------------
/*
  THIS GUARD EXISTS BECAUSE I TRIPPED OVER IT WRITING THESE FILES.

  Explaining why matchPerson folds four spellings of an honorific is much
  easier with the real examples, and Config.gs has them in its comments -
  so quoting those comments put ten colleagues' names into four new files
  without a moment's thought. The names are already in src/Config.gs and
  that repository is public, which is a separate matter and Rudra's call;
  adding more copies while porting is not.

  tests/wiring-test.js already refuses employee IDs, phone numbers, work
  emails and personal OneDrive paths anywhere in the project. Names are not
  on that list, because src/Config.gs needs them. This checks only the
  files the port has added, against the roster lifted at run time, so it
  carries no list of its own.
*/
const PORT_FILES = ['roster.js', 'import-roster.js', 'roster-equivalence-test.js',
                    'kpi.js', 'kpi-equivalence-test.js', 'import-tickets.js',
                    'import-tickets-test.js', 'content.js', 'content-test.js',
                    'messenger-read.js', 'messenger-write.js',
                    'messenger-test.js', 'messenger-write-test.js',
                    'server.js', 'objectives.js', 'objectives-read.js',
                    'objectives-write.js',
                    '../db/12-roster.sql', '../db/11-tickets.sql',
                    '../db/10-content.sql', '../db/08-messenger.sql'];

const leaks = [];
PORT_FILES.forEach(function (file) {
  const full = path.join(__dirname, file);
  if (!fs.existsSync(full)) return;
  const text = fs.readFileSync(full, 'utf8');
  everyName.forEach(function (name) {
    if (text.indexOf(name) !== -1) leaks.push(path.basename(file));
  });
});

comparisons++;
if (leaks.length) {
  mismatches++;
  const where = leaks.filter(function (f, i) { return leaks.indexOf(f) === i; });
  shown.push('  a name from the org chart appears in ' + where.length +
             ' file(s) the port added:\n      ' + where.join(', ') +
             '\n      Say what the rule does, not who it was written for.');
}


// ---------------------------------------------------------------------------
console.log('');
if (mismatches) {
  console.log('  ' + mismatches + ' MISMATCH(ES) out of ' + comparisons +
              ' comparisons:');
  console.log('');
  shown.forEach(function (line) { console.log(line); });
  console.log('');
  // The name-leak check is not an attribution difference, so saying so
  // would send the next reader looking in the wrong place.
  if (leaks.length) {
    console.log('  Remove the name(s). A comment can say what a rule does ' +
                'without naming');
    console.log('  the colleague it was written for.');
  }
  if (mismatches > (leaks.length ? 1 : 0)) {
    console.log('  The port attributes tickets differently from src/Config.gs.');
    console.log('  Fix the port, not this.');
  }
  process.exit(1);
}

console.log('  ' + comparisons + ' comparisons, all identical to src/Config.gs');
console.log('');
