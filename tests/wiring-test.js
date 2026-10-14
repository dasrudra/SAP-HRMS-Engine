// Does the client half hold together?
//
// WHY THIS EXISTS
// Apps Script serves these files as one page. A typo in an element id, or a
// stray bracket in App.html, does not fail a build or a lint - it fails at
// 8am in front of whoever opened the dashboard, and the symptom is a blank
// panel rather than an error anybody reads.
//
// This is not a substitute for driving the real interface in a browser. It is
// the part of that which costs nothing to run and needs no dependencies: the
// script parses, and every id and class it reaches for actually exists.
//
// HOW TO RUN
//   node tests/wiring-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const APP = read('App.html');
const INDEX = read('Index.html');
const STYLES = read('Styles.html');
const REPORT = read('Report.html');
const KPI = read('Kpi.gs');

// ---------------------------------------------------------------------------
// it parses
// ---------------------------------------------------------------------------
// Scriptlets are server-side and are not JavaScript; the harness that runs the
// real page resolves them. Here they are blanked, because the question is only
// whether the surrounding script is syntactically whole.
function scriptOf(html, label) {
  const bodies = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let hit;
  while ((hit = re.exec(html)) !== null) bodies.push(hit[1]);
  return bodies.join('\n;\n').replace(/<\?[\s\S]*?\?>/g, '""');
}

[['App.html', APP], ['Report.html', REPORT], ['Index.html', INDEX]]
  .forEach(function (pair) {
    let error = '';
    try { new vm.Script(scriptOf(pair[1]), { filename: pair[0] }); }
    catch (e) { error = String(e.message); }
    check(pair[0] + ' parses as JavaScript', error === '', error);
  });

// ---------------------------------------------------------------------------
// every id the script reaches for exists in the markup
// ---------------------------------------------------------------------------
// Ids built at runtime are skipped - a concatenation cannot be checked here,
// and the ones that matter are the literals.
const markupIds = {};
(INDEX.match(/\bid="([A-Za-z0-9_-]+)"/g) || []).forEach(function (hit) {
  markupIds[hit.slice(4, -1)] = true;
});

// Created by script rather than written in the markup; listed so the check can
// stay strict about everything else.
const MADE_AT_RUNTIME = {
  // Drawn by App.html into the empty-state of the modules panel, then bound a
  // few lines later - see the "rebuild from modules" button.
  rebuildFromModules: true
};

const wanted = {};
// The closing [,)] is what keeps a concatenation out: getElementById('cmpM' +
// n + 'Label') names no element called cmpM, and flagging it would train
// whoever runs this to ignore the result.
const idRe = /(?:getElementById|getValue|setValue|setText|bind|fillSelect|setCount)\(\s*'([A-Za-z0-9_-]+)'\s*[,)]/g;
let m;
while ((m = idRe.exec(APP)) !== null) wanted[m[1]] = true;

const missing = Object.keys(wanted)
  .filter((id) => !markupIds[id] && !MADE_AT_RUNTIME[id])
  .sort();
check('every element id App.html names is in Index.html',
  missing.length === 0, missing.join(', ') || 'none missing');

// ---------------------------------------------------------------------------
// the By individuals module filter, end to end through the client
// ---------------------------------------------------------------------------
// The server half is proved in module-people-test.js. This is the wiring that
// connects it to a dropdown.
// By position rather than by a character window: the comment explaining why
// this filter slices is longer than any window worth guessing at, and the
// claim being made is about order, not about proximity.
const at = (id) => INDEX.indexOf('id="' + id + '"');
check('the filter exists in the markup, between the individual filter and the search',
  at('fAllPerson') > 0 && at('fAllSection') > at('fAllPerson') &&
  at('fAllName') > at('fAllSection'),
  ['fAllPerson', 'fAllSection', 'fAllName'].map((i) => i + '@' + at(i)).join(' '));
check('it is filled from the sections of the people in the table',
  /fillSelect\('fAllSection'/.test(APP) &&
  /k\.people[\s\S]{0,300}row\.department[\s\S]{0,300}fillSelect\('fAllSection'/.test(APP),
  'a section nobody worked in would be a choice that empties the table');
const pendingCalls = APP.match(/applyPendingTo\(\[[\s\S]*?\]\)/g) || [];
check('choosing one re-renders and is remembered',
  /bind\('fAllSection',\s*'change'/.test(APP) &&
  pendingCalls.some((call) => call.indexOf("'fAllSection'") !== -1),
  'change handler + restored in ' + pendingCalls.length + ' applyPendingTo call(s)');
check('Reset clears it with the others',
  /fAllReset[\s\S]{0,400}setValue\('fAllSection',\s*''\)/.test(APP));
// A filter on WHO is listed, not on what the figures mean: the rows stay
// k.people and are narrowed by the section already beside each name, so a
// figure never changes meaning depending on which filter happens to be on.
check('choosing a section narrows the people, and leaves their figures alone',
  /chosenSection[\s\S]{0,200}k\.people\.filter[\s\S]{0,140}p\.department === chosenSection/.test(APP),
  'the Section column, nothing derived');
check('and no module membership is derived for anybody any more',
  !/assignPersonModules/.test(KPI) && !/peopleByModule/.test(KPI),
  'a person who works across two modules has no one true module');
check('nor does the rebuild write a person-and-module cross-tab',
  !/'PERSON_MODULE'/.test(KPI),
  'about a hundred rows a month that nothing read'); 

// The note is the honesty half. Without it the table looks identical whether
// it is showing everyone's totals or one module's slice.
check('a note says whose list it is, and that the figures did not move',
  /id="kpi1AllPeopleNote"/.test(INDEX) &&
  /kpi1AllPeopleNote/.test(APP) &&
  /The people in/.test(APP) && /reads the same here/.test(APP),
  'shown only while a section is chosen');
check('and where somebody\'s work falls is still answerable, from the editor',
  /function listPersonModules/.test(KPI) && /sheetFor\(CONFIG\.SHEETS\.TICKETS\)/.test(KPI),
  'listPersonModules() reads the tickets, not a cached cross-tab');
check('and the stylesheet draws it',
  /\.filter-note\s*\{/.test(STYLES));
check('a dropdown that cannot be used yet is still drawn as disabled',
  /\.table-filter \.select:disabled/.test(STYLES),
  'the section filter needs no rebuild, so nothing uses this state now');

// ---------------------------------------------------------------------------
// the whole project is still plain ASCII
// ---------------------------------------------------------------------------
// A single stray byte in a paste has taken this project down before. Checked
// off the directory rather than a list, so a new file cannot slip past.
const bad = fs.readdirSync(SRC)
  .filter((f) => /\.(gs|html)$/.test(f))
  .map(function (f) {
    const hits = fs.readFileSync(path.join(SRC, f), 'utf8').match(/[^\x00-\x7F]/g);
    if (!hits) return null;
    const kinds = hits.filter((c, i, a) => a.indexOf(c) === i)
      .map((c) => 'U+' + c.charCodeAt(0).toString(16).toUpperCase());
    return f + ' (' + hits.length + ': ' + kinds.join(' ') + ')';
  })
  .filter(Boolean);
check('every source file is plain ASCII', bad.length === 0, bad.join('; ') || 'all clean');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
