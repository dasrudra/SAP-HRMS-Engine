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
const AUTH = read('Auth.gs');
const CODE_GS = read('Code.gs');
const CONFIG_SRC = read('Config.gs');
const SETUP = read('Setup.gs');
const BACKUP = read('Backup.gs');
const MESSENGER = read('Messenger.gs');

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
  /chosenSection[\s\S]{0,260}base\.filter[\s\S]{0,160}p\.department === chosenSection/.test(APP),
  'the Section column, nothing derived');

// And the other one does the opposite, on purpose. An affiliate is a fact
// about a TICKET - nobody belongs to KSL - so it cannot narrow a list of
// people; it can only re-add up their figures from that affiliate's tickets,
// which is a server call because the monthly cache has no affiliate in it.
check('choosing an affiliate re-adds the figures up from the tickets instead',
  /callServer\('getPeopleByAffiliate'/.test(APP) &&
  /state\.affiliate\)\s*\n?\s*\?\s*state\.affiliate\.people\s*:\s*k\.people/.test(APP),
  'the two filters mean different things and are built differently');
check('and the server scores it with the same function as everything else',
  /function readPeopleByAffiliate[\s\S]{0,3000}scoreRows\(byPerson\[name\], kpi\)/.test(KPI),
  'a filtered row cannot drift away from the unfiltered one it came out of');
check('and no module membership is derived for anybody any more',
  !/assignPersonModules/.test(KPI) && !/peopleByModule/.test(KPI),
  'a person who works across two modules has no one true module');
check('nor does the rebuild write a person-and-module cross-tab',
  !/'PERSON_MODULE'/.test(KPI),
  'about a hundred rows a month that nothing read'); 

// REMOVED ON REQUEST. The table used to carry an amber line saying what the
// filters had done to the figures. It was right about the arithmetic and it
// was in the way: the person reading this screen is the person who set the
// filter, and they do not need telling twice. Checked as gone rather than
// just deleted, so it cannot creep back in with a later paste.
check('the filter note is gone from the table, and from the stylesheet',
  !/kpi1AllPeopleNote/.test(INDEX) && !/kpi1AllPeopleNote/.test(APP) &&
  !/\.filter-note\s*\{/.test(STYLES),
  'the dropdowns say what is on; the table does not repeat it');
check('and where somebody\'s work falls is still answerable, from the editor',
  /function listPersonModules/.test(KPI) && /sheetFor\(CONFIG\.SHEETS\.TICKETS\)/.test(KPI),
  'listPersonModules() reads the tickets, not a cached cross-tab');
check('a dropdown that cannot be used yet is still drawn as disabled',
  /\.table-filter \.select:disabled/.test(STYLES),
  'the section filter needs no rebuild, so nothing uses this state now');

// ---------------------------------------------------------------------------
// nothing is defined twice
// ---------------------------------------------------------------------------
// getKpi1 and readKpi1 each existed TWICE in Kpi.gs - 195 duplicated lines,
// byte for byte identical, from a bad paste. Nothing misbehaved, because the
// later declaration wins and both said the same thing. That is exactly what
// makes it worth catching: the day somebody fixes one copy, the fix is in the
// half that does not run, and the bug they were chasing is still there.
// AND IT HAPPENED AGAIN, IN App.html, WHERE THIS DID NOT LOOK.
// A new showSignIn() was added beside one that already existed. The later
// declaration won, the Back button was bound to the wrong one, and it took
// the click event as its argument and printed "[object PointerEvent]" above
// the username box on the sign-in card. This check was already written and
// scanned only .gs files - the 300KB of JavaScript in App.html, which is
// where a name is most likely to be taken already, was never looked at.
//
// In the .gs files every function is at the left margin. In App.html they
// live inside one IIFE and sit at two spaces; anything deeper is a helper
// nested in another function, where two of the same name are in different
// scopes and cannot collide.
const DOUBLE = [];
const scan = function (file, text, pattern) {
  const seen = {};
  (text.match(pattern) || []).forEach(function (hit) {
    const name = hit.replace(/^\s*function\s+/, '');
    seen[name] = (seen[name] || 0) + 1;
  });
  Object.keys(seen).forEach(function (name) {
    if (seen[name] > 1) DOUBLE.push(file + ': ' + name + ' x' + seen[name]);
  });
};

fs.readdirSync(SRC).filter((f) => /\.gs$/.test(f)).forEach(function (file) {
  scan(file, fs.readFileSync(path.join(SRC, file), 'utf8'),
       /^function\s+[A-Za-z_$][\w$]*/gm);
});
[['App.html', APP], ['Report.html', REPORT]].forEach(function (pair) {
  scan(pair[0], pair[1], /^  function\s+[A-Za-z_$][\w$]*/gm);
});
check('no function is declared twice in the same file',
  DOUBLE.length === 0, DOUBLE.join('; ') || 'every declaration is the only one');


// ---------------------------------------------------------------------------
// every function the page calls actually exists
// ---------------------------------------------------------------------------
// Twice in one week a function was called that had never been written -
// openMessenger, lost in a rewrite, and toast, which was invented at a call
// site and never defined at all. Both are invisible until the exact line
// runs: toast() sat on the SUCCESS path of deleting a conversation, which no
// test had ever taken, so the server deleted the row, the page threw, and the
// row stayed on screen looking like a failure.
//
// A parser would be the thorough answer. This is the cheap one: collect what
// is defined, collect what is called, subtract the things a browser provides.
// It cannot see a typo'd METHOD name - only bare calls - which is most of
// what has actually gone wrong here.
// EVERY script block, not the first one. Taking only the first found an
// empty block, extracted nothing, and the check passed on a list of nought -
// which is how a test that cannot fail looks from the outside.
const APP_JS = (APP.match(/<script[^>]*>[\s\S]*?<\/script>/g) || [])
  .map(function (block) { return block.replace(/<\/?script[^>]*>/g, ''); })
  .join('\n');

// Comments out first. Prose mentions functions by name - "installBackupTrigger()
// has not been run", "requireMaster(token) guards it" - and every one of those
// reads as a call to a regex. The ":" guard keeps https:// out of it.
const CODE = APP_JS
  // Comments first: prose names functions - "run installBackupTrigger()" -
  // and every one of those reads as a call. The ":" guard spares https://.
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/([^:])\/\/[^\n]*/g, '$1')
  // Then strings, which are full of things shaped like calls and are not:
  // 'var(--text-dim)', ':not(#setupCard)', ' unique tickets ('.
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
  .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  // And regex literals, for the same reason: /train(ee|ing)/ is not a call to
  // train. Only where one can legally start, so division survives.
  .replace(/([=(,:[!&|?{};]|\breturn)(\s*)\/(?![*\/])(?:[^\/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+\/[gimsuy]*/g,
           '$1$2/RE/');

const defined = new Set();
let hit;

// Parameters count as defined: resolve and reject are not globals, they are
// arguments, and a check that does not know that reports them as missing.
const params = /(?:function\s*[\w$]*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>)/g;
while ((hit = params.exec(CODE))) {
  (hit[1] || hit[2] || '').split(',').forEach(function (raw) {
    const name = raw.trim().replace(/[^\w$].*$/, '');
    if (name) defined.add(name);
  });
}
const declare = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
while ((hit = declare.exec(CODE))) defined.add(hit[1]);
// const x = function () {} / const x = (a) => / const x = a =>
const assigned = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:function\b|\(?[\w$,\s]*\)?\s*=>)/g;
while ((hit = assigned.exec(CODE))) defined.add(hit[1]);

// Anything a browser, the language, or the Apps Script client already gives us.
const PROVIDED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function',
  'do', 'else', 'new', 'delete', 'void', 'in', 'of', 'await', 'yield', 'case',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Date', 'Math', 'JSON',
  'RegExp', 'Error', 'Promise', 'Set', 'Map', 'parseInt', 'parseFloat',
  'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'escape',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'alert',
  'confirm', 'prompt', 'fetch', 'Blob', 'URL', 'FileReader', 'FormData',
  'Image', 'Intl', 'URLSearchParams', 'requestAnimationFrame', 'google',
  'window', 'document', 'console', 'localStorage', 'sessionStorage', 'Chart'
]);

const called = new Set();
// A bare name followed by "(" that is NOT preceded by a dot, and not a
// property key or a declaration of its own.
const call = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
while ((hit = call.exec(CODE))) called.add(hit[2]);

const neverWritten = Array.from(called)
  .filter((n) => !defined.has(n) && !PROVIDED.has(n))
  // Not a call: these read as one to a regex and are not.
  .filter((n) => !/^(?:[A-Z][\w$]*)$/.test(n) || defined.has(n))
  .sort();

check('every function the page calls is defined somewhere in it',
  neverWritten.length === 0,
  neverWritten.length ? 'never defined: ' + neverWritten.join(', ')
                      : defined.size + ' functions, all of them real');


// ---------------------------------------------------------------------------
// nothing restores a button to the label it was given while working
// ---------------------------------------------------------------------------
// Every "do something" button on this dashboard follows the same shape: keep
// the label, swap it for Working/Sending/Creating, put the first one back when
// the server answers. The sign-up button got that in the wrong order - it
// captured the label one line AFTER overwriting it - so anybody who hit a
// validation message was left looking at a button that said "Creating..."
// forever. It had re-enabled; it just never stopped saying otherwise.
//
// Checked over the whole file rather than that one button, because the pattern
// is written out by hand in a dozen places and the mistake is invisible when
// you are looking straight at it.
const BUSY = /(Creating|Sending|Signing in|Saving|Working|Rebuilding|Uploading)\\u2026/;
const lines = APP.split('\n');
const wrongOrder = [];
lines.forEach(function (line, i) {
  const captured = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(\w+)\s*(?:\?\s*)?\2?\.?textContent/);
  if (!captured) return;
  const button = captured[2];
  // Did the same button get a working-label in the dozen lines above this?
  for (let back = Math.max(0, i - 12); back < i; back++) {
    if (new RegExp(button + '\\.textContent\\s*=').test(lines[back]) &&
        BUSY.test(lines[back])) {
      wrongOrder.push('line ' + (i + 1) + ': ' + line.trim().slice(0, 56));
      return;
    }
  }
});
check('no button captures its label after overwriting it',
  wrongOrder.length === 0,
  wrongOrder.join('; ') || 'every one reads the label first');


// ---------------------------------------------------------------------------
// the name box on the card where somebody sets their password
// ---------------------------------------------------------------------------
// CHECKED HERE because no browser suite reaches that card: it only appears
// for somebody signing up or coming back from a reset, neither of which the
// harness can be in the middle of. The server half is covered properly in
// reset-journey-test - registerAccount stores the name, tidies it, and keeps
// the old one when the box is left empty. What is left is the wire between
// them, and dropping the argument is a silent change: registerAccount simply
// receives undefined and every new account goes in nameless.
check('the setup card asks for a name, an email, an ID and a password',
  /id="setupName"/.test(INDEX) && /id="setupEmail"/.test(INDEX) &&
  /id="setupId"/.test(INDEX) && /id="setupPass"/.test(INDEX),
  'the four things a login is made of');
check('and no longer asks for the password twice',
  !/id="setupConfirm"/.test(INDEX) && !/setupConfirm/.test(APP),
  'the eye button catches the same typo and costs one field, not two');

// TWO DOORS, TWO ARGUMENT LISTS, AND THEY ARE NOT THE SAME SHAPE.
// createAccount takes no token - there is nobody to have one yet - and
// registerAccount takes one FIRST, because the token is what says whose
// password is being set. An argument in the wrong slot here would store a
// password as somebody's name, which nothing downstream would question.
check('signing up sends id, name, email, password - and no token',
  /\?\s*\[pendingSetupToken,\s*getValue\('setupId'\)[\s\S]{0,260}:\s*\[getValue\('setupId'\)\.trim\(\),\s*getValue\('setupName'\)\.trim\(\),\s*\n?\s*getValue\('setupEmail'\)\.trim\(\),\s*getValue\('setupPass'\)\]/.test(APP),
  'createAccount(employeeId, fullName, email, password)');
check('and a reset sends the token first, then id, password, name, email',
  /\[pendingSetupToken,\s*getValue\('setupId'\)\.trim\(\),\s*\n?\s*getValue\('setupPass'\),\s*getValue\('setupName'\)\.trim\(\),\s*\n?\s*getValue\('setupEmail'\)\.trim\(\)\]/.test(APP),
  'registerAccount(setupToken, employeeId, password, fullName, email)');
check('and which of the two is chosen by whether a token is held',
  /\[pendingSetupToken \? 'registerAccount' : 'createAccount'\]/.test(APP),
  'a token means the account exists already');

// The retired shared login. It opened the card that created an account, its
// password was in this repository, and it is now refused whatever is typed.
check('the shared starting login is gone from the sign-in card',
  !/starting login your team gave you/.test(INDEX),
  'people create their own login directly now');
check('and login() refuses it even if a row for it is still on the sheet',
  /if \(name === BOOTSTRAP_USER\) return unknown\(\);/.test(AUTH),
  'down the same path as any employee ID nobody has used, so it cannot be ' +
  'told apart from one');
check('while the door everybody comes in by has a switch on it',
  /function masterSetSignups/.test(AUTH) && /function signupsOpen/.test(AUTH) &&
  /id="signupToggle"/.test(INDEX),
  'master only, and manual - a rule would shut it on a mistyped ID');

// The panel asks for a name only while the account has none. Hiding it on the
// signed-OUT page would be wrong in the other direction: there is no account
// there to have read one from.
check('the panel hides its name box only for somebody signed in with one',
  /nameWrap\.hidden = msgrSignedIn && msgrNameOnAccount/.test(APP),
  'on the sign-in page there is no account to take a name from');


// ---------------------------------------------------------------------------
// KPI 1's two standards reach every call that scores against a target
// ---------------------------------------------------------------------------
// Three server calls judge KPI 1's counts against a target, and all three
// read the SAME stored numbers. One of them left on the policy's target while
// the other two moved would put the same section, in the same month, in two
// different bands on two screens - which has happened here before and is
// written up at length in Kpi.gs.
// EVERY call site, not just one of them. There are two that reach the
// comparison screen, and an assertion satisfied by either would pass with the
// other one left scoring against the policy - which is the whole defect.
[["callServer('getKpi1'", 'the page itself'],
 ["callServer('getPeopleByAffiliate'", 'the affiliate slice'],
 ['callServer(comparisonEndpoint(', 'the comparison screen']].forEach(function (pair) {
  const sites = APP.split(pair[0]).slice(1);
  const carried = sites.filter(function (after) {
    return /^[^;]*currentStandard\(\)/.test(after);
  });
  check(pair[1] + ' is read against the chosen standard, at every call',
    sites.length > 0 && carried.length === sites.length,
    carried.length + ' of ' + sites.length + ' call site(s)');
});

check('and the choice survives a reload like every other filter',
  /TRACKED_CONTROLS[\s\S]{0,400}'fKpi1Standard'/.test(APP),
  'a standard that reset on refresh would be read as the other one');

// Both targets are printed on the toggle, and both come from the server's own
// definitions - a figure typed into the markup could disagree with the figure
// the server actually scored against, and nothing would ever catch it.
check('the toggle takes its wording and its targets from CONFIG',
  /kpi\.standardLabel/.test(APP) && /String\(kpi\.target\)/.test(APP) &&
  !/>\s*99\.5\s*%\s*</.test(INDEX),
  'nothing about the two standards is typed into the page');


// ---------------------------------------------------------------------------
// the system has one name, written down once
// ---------------------------------------------------------------------------
// It has been renamed twice. Each time, the name was in half a dozen files -
// the sidebar, both sign-in cards, the browser tab, the report heading, the
// email subject, the spreadsheet a fresh install creates, the backup folder -
// and a rename that reaches five of them leaves the sixth saying the old one
// to the only people who ever see it.
const NAME = /APP_NAME:\s*'([^']+)'/.exec(CONFIG_SRC)[1];

check('the system names itself once, in Config.gs',
  Boolean(NAME), NAME);

// ONE DELIBERATE SECOND COPY. The emergency page in Code.gs is served when a
// file is missing from the project, so it cannot read a constant out of
// another file - that is the exact situation it exists for. It is checked
// rather than excused: a rename that forgets it fails here.
check('and the one page that cannot read CONFIG carries the same name',
  new RegExp("setTitle\\('" + NAME + "'\\)").test(CODE_GS),
  'the emergency page still works when Config.gs is the missing file');

// Everywhere else reads it.
[['Setup.gs', SETUP, /SpreadsheetApp\.create\(CONFIG\.APP_NAME\)/],
 ['Backup.gs', BACKUP, /CONFIG\.APP_NAME \+ ' - Backups'/],
 ['Messenger.gs', MESSENGER, /subject: CONFIG\.APP_NAME/]].forEach(function (row) {
  check(row[0] + ' takes the name from CONFIG rather than repeating it',
    row[2].test(row[1]), 'one rename, one line');
});

// AND THE THINGS THAT ARE NOT THIS SYSTEM KEEP THEIR OWN NAMES.
// A find-and-replace over the old name would have taken these with it: the
// department the dashboard reports ON, the section in the ticket data, and
// the policy's own wording. None of them is the dashboard.
check('the department keeps its name when the system is renamed',
  /name: 'Enterprise Application Services'/.test(CONFIG_SRC) &&
  /<h2 id="orgTitle">Enterprise Application Services<\/h2>/.test(INDEX),
  'the org chart is about the team, not about this software');
check('and the policy is still quoted as it is written',
  /section: '5\.3 Enterprise Application Services \(EAS\)'/.test(CONFIG_SRC),
  'a document says what it says');
check('while the EAS scope in the ticket data is untouched',
  /scopeType === 'EAS'/.test(KPI),
  'the EAS row on every KPI table is a section, not a product');


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
