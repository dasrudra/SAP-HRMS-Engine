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
const PAGE_FILE = process.env.EAS_PAGE ||
                  path.join(__dirname, 'harness', 'page.html');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const APP = read('App.html');
const INDEX = read('Index.html');
const PORTAL = read('Portal.html');
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
//
// Read off every markup file Index.html pulls in, not just Index.html itself.
// The portal's ids live in Portal.html, so scanning one file would report
// every one of them as missing - and, worse, would stop reporting a genuinely
// missing id the day somebody moved it into a second file.
const markupIds = {};
[INDEX, PORTAL].forEach(function (text) {
  (text.match(/\bid="([A-Za-z0-9_-]+)"/g) || []).forEach(function (hit) {
    markupIds[hit.slice(4, -1)] = true;
  });
});

// Created by script rather than written in the markup; listed so the check can
// stay strict about everything else.
const MADE_AT_RUNTIME = {
  // Drawn by App.html into the empty-state of the modules panel, then bound a
  // few lines later - see the "rebuild from modules" button.
  rebuildFromModules: true,

  // The Minutes bar. renderMinBar() writes the whole strip into #mnBar on
  // every draw, because what is in it depends on the meeting: the date and
  // time are disabled for a section that is not yours, and Save, Delete and
  // Mark final each appear only for somebody entitled to press them. Writing
  // the controls into Portal.html and then hiding most of them for most
  // people would put the permission rule in two places.
  mnDate: true,
  mnTime: true,
  mnSave: true
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
  'window', 'document', 'console', 'localStorage', 'sessionStorage', 'Chart',
  // Base64 both ways. btoa is how an attachment's bytes become something
  // google.script.run will carry; atob is in the harness stub that puts
  // the pieces back together.
  'btoa', 'atob', 'Uint8Array'
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

/*
  AND EVERY SERVER FUNCTION IT ASKS FOR EXISTS ON THE SERVER.

  The two halves of this app are in different files and nothing links
  them: a call goes out as a STRING, through google.script.run, and a
  name that is spelt wrong fails at the moment somebody presses the
  button - silently, in a failure handler, with the square going back to
  what it was and a message that says the server refused. Which is
  exactly what a real refusal looks like.
*/
{
  const serverFiles = fs.readdirSync(SRC).filter((f) => /\.gs$/.test(f));
  const onServer = new Set();
  serverFiles.forEach(function (f) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    let hit;
    const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    while ((hit = re.exec(text)) !== null) onServer.add(hit[1]);
  });

  const asked = new Set();
  let call;
  const callRe = /callServer\(\s*'([A-Za-z_$][\w$]*)'/g;
  while ((call = callRe.exec(APP_JS)) !== null) asked.add(call[1]);
  /*
    The handler chain sits between google.script.run and the endpoint, so
    the endpoint is not the FIRST name after it - it is whichever name in
    the chain is not a handler. Taking the first one found nothing but
    withFailureHandler, and a misspelt endpoint three lines below it went
    straight past this check.
  */
  const NOT_AN_ENDPOINT =
    /^(with(Success|Failure)Handler|then|catch|finally|bind|call|apply)$/;
  /*
    WALK THE CHAIN, balancing the brackets.

    The endpoint is not the first name after google.script.run - the
    handlers come first, and their arguments are whole functions with
    their own brackets and semicolons in them. Reading forward to the
    first name, or to the first semicolon, found withFailureHandler and
    then whatever happened to be inside it, so a misspelt endpoint three
    lines below went straight past. This steps along the chain properly:
    name, skip its arguments, name, until one is not a handler.
  */
  const chainEndpoint = function (text, from) {
    let k = from;
    for (;;) {
      while (k < text.length && /\s/.test(text.charAt(k))) k++;
      if (text.charAt(k) !== '.') return '';
      k++;
      const start = k;
      while (k < text.length && /[\w$]/.test(text.charAt(k))) k++;
      const name = text.slice(start, k);
      while (k < text.length && /\s/.test(text.charAt(k))) k++;
      if (text.charAt(k) !== '(') return '';
      if (!NOT_AN_ENDPOINT.test(name)) return name;
      let depth = 0;
      for (; k < text.length; k++) {
        if (text.charAt(k) === '(') depth++;
        else if (text.charAt(k) === ')') { depth--; if (!depth) { k++; break; } }
      }
    }
  };

  let at = APP_JS.indexOf('google.script.run');
  while (at !== -1) {
    const name = chainEndpoint(APP_JS, at + 'google.script.run'.length);
    if (name) asked.add(name);
    at = APP_JS.indexOf('google.script.run', at + 1);
  }

  const missing = Array.from(asked).filter((n) => !onServer.has(n)).sort();
  check('every server function the page calls is defined in a .gs file',
    missing.length === 0,
    missing.length ? 'no such function: ' + missing.join(', ')
                   : asked.size + ' endpoints, all of them real');
}

/*
  THE SCREEN SOMEBODY WAS LAST ON travels from one file to the other, and
  neither end can see the other. It used to be read from the address bar
  through getLocation, which inside the Blogger embed took twelve seconds
  - long enough that the page gave up, drew Home, and corrected itself
  afterwards. The fix is only a fix if both halves are wired up.
*/
check('the bootstrap carries the screen this person was last on',
  /lastView:\s*lastViewOf\(/.test(CODE_GS) &&
  /function lastViewOf/.test(CODE_GS) && /function rememberView/.test(CODE_GS));
check('and the page restores from it rather than waiting for the address bar',
  /boot\.lastView/.test(APP) && /state\.lastView\s*\?/.test(APP) &&
  /rememberView\(name\)/.test(APP));


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
//
// The backup FILE is listed separately from the backup FOLDER, because for
// two renames it was not. The folder was built from CONFIG and asserted here;
// the file beside it was written out by hand as 'EAS KPI backup <date>' and
// nothing looked, so this block passed while the name it was guarding was
// still in the project. A whitelist only guards the lines on it.
[['Setup.gs', SETUP, /SpreadsheetApp\.create\(CONFIG\.APP_NAME\)/],
 ['Backup.gs', BACKUP, /CONFIG\.APP_NAME \+ ' - Backups'/],
 ['Backup.gs', BACKUP, /CONFIG\.APP_NAME \+ ' backup '/],
 ['Messenger.gs', MESSENGER, /subject: CONFIG\.APP_NAME/]].forEach(function (row) {
  check(row[0] + ' takes the name from CONFIG rather than repeating it',
    row[2].test(row[1]), 'one rename, one line');
});

// AND THE SWEEP, which does not need to be told where to look. Every name
// this system has been released under, hunted across the whole of src/. The
// one allowed hit is the sentence in Config.gs that records the renames -
// recognised by being inside that comment, not by trusting the file.
//
// 'EAS KPI Engine' is matched in full. 'EAS KPI' on its own is a legitimate
// phrase here - it is the EAS team's own KPI standard, the label on the KPI 1
// toggle and the title of the policy PDFs - and sweeping for it would fail on
// correct code.
const OLD_NAMES = ['EAS KPI Engine', 'Enterprise Application Services Dashboard'];
const stale = [];
fs.readdirSync(SRC).filter((f) => /\.(gs|html)$/.test(f)).forEach(function (f) {
  const text = fs.readFileSync(path.join(SRC, f), 'utf8');
  OLD_NAMES.forEach(function (old) {
    text.split('\n').forEach(function (line, i) {
      if (line.indexOf(old) === -1) return;
      if (f === 'Config.gs' && /It has been renamed twice/.test(line)) return;
      stale.push(f + ':' + (i + 1));
    });
  });
});
check('and no file still carries a name the system used to have',
  stale.length === 0, stale.join(', ') || 'swept src/ for every former name');

// AND THE THINGS THAT ARE NOT THIS SYSTEM KEEP THEIR OWN NAMES.
// A find-and-replace over the old name would have taken these with it: the
// department the dashboard reports ON, the section in the ticket data, and
// the policy's own wording. None of them is the dashboard.
// The org chart moved off Summary and onto the portal, so the second half of
// this looks at Portal.html now. The assertion itself has not changed: the
// DEPARTMENT is called Enterprise Application Services whatever the software
// in front of it is called this month, and a find-and-replace over the old
// product name must not take it along.
check('the department keeps its name when the system is renamed',
  /name: 'Enterprise Application Services'/.test(CONFIG_SRC) &&
  /<strong>Enterprise Application Services<\/strong>/.test(PORTAL),
  'the team is not this software');
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
// off the directories rather than a list, so a new file cannot slip past.
//
// THE SUITES ARE SCANNED TOO, which they were not until an em dash written
// straight into a comparison turned up in two of them. A test file is read,
// edited and pasted exactly like a source file, and the character that breaks
// a paste does not care which folder it is in. Both strays were comparing
// against a dash the page renders from &mdash; - '\u2014' says the same thing
// and survives a trip through anything.
const asciiScan = [[SRC, /\.(gs|html)$/], [__dirname, /-test\.js$/]];
const bad = [];
asciiScan.forEach(function (where) {
  fs.readdirSync(where[0]).filter((f) => where[1].test(f)).forEach(function (f) {
    const hits = fs.readFileSync(path.join(where[0], f), 'utf8').match(/[^\x00-\x7F]/g);
    if (!hits) return;
    const kinds = hits.filter((c, i, a) => a.indexOf(c) === i)
      .map((c) => 'U+' + c.charCodeAt(0).toString(16).toUpperCase());
    bad.push(f + ' (' + hits.length + ': ' + kinds.join(' ') + ')');
  });
});
check('every source file and every suite is plain ASCII',
  bad.length === 0, bad.join('; ') || 'all clean');

// ---------------------------------------------------------------------------
// nobody's real mobile number is in the repository
// ---------------------------------------------------------------------------
// THIS IS NOT HYPOTHETICAL. tests/team-test.js was committed to a PUBLIC
// repository carrying eight colleagues' real mobile numbers, real employee
// IDs and real office extensions, pasted out of the spreadsheet to make the
// fixture realistic. The email addresses in that same fixture had been
// changed to @x.test, which is what made it look handled.
//
// The whole reason the directory is read from a TEAM tab instead of being
// written into Config.gs is to keep exactly this data out of the repository.
// A fixture is not an exception to that; it is just a less obvious copy.
//
// The rule is a convention rather than a cleverness: every Bangladeshi
// mobile number anywhere in this project must be in the reserved test block
// 0170000xxxx. A real one cannot be, so a real one fails here. Fixtures need
// the SHAPE of a phone number - present, absent, eleven digits - and never
// the value.
const PHONE_OK = /^0170000\d{4}$/;
const phoneScan = [[SRC, /\.(gs|html)$/], [__dirname, /-test\.js$/],
                   [path.join(__dirname, 'harness'), /\.js$/]];
const leaked = [];
phoneScan.forEach(function (where) {
  if (!fs.existsSync(where[0])) return;
  fs.readdirSync(where[0]).filter((f) => where[1].test(f)).forEach(function (f) {
    const text = fs.readFileSync(path.join(where[0], f), 'utf8');
    (text.match(/\b01[3-9]\d{8}\b/g) || []).forEach(function (n) {
      if (!PHONE_OK.test(n)) leaked.push(f + ': ' + n.slice(0, 5) + 'xxxxxx');
    });
  });
});
// ---------------------------------------------------------------------------
// the ASSEMBLED page is plain ASCII too
// ---------------------------------------------------------------------------
// THE SOURCE BEING ASCII IS NOT ENOUGH, which is the whole reason this is a
// second check rather than a wider glob on the first one. Config.gs writes
// the agreement's en dash and >= sign as escapes, correctly - and then
// JSON.stringify turns them back into real characters on the way into the
// page. The page carries no charset of its own, so those bytes were read
// back as Latin-1 and the SLA sheet rendered "P1 a..." and "a.. 99.5%".
//
// Every file in src/ passed the check above while that was on screen. This
// one looks at what actually gets served.
if (fs.existsSync(PAGE_FILE)) {
  const built = fs.readFileSync(PAGE_FILE, 'utf8');
  const strays = built.match(/[^\x00-\x7F]/g) || [];
  const kinds = strays.filter((c, i, a) => a.indexOf(c) === i)
    .map((c) => 'U+' + c.charCodeAt(0).toString(16).toUpperCase());
  check('the assembled page is plain ASCII, so no charset has to save it',
    strays.length === 0,
    strays.length ? strays.length + ' stray byte(s): ' + kinds.join(' ')
                  : 'every non-ASCII character is written as an escape');
}

check('no real mobile number is written into the source or the fixtures',
  leaked.length === 0,
  leaked.length ? leaked.filter((v, i, a) => a.indexOf(v) === i).join('; ')
                : 'every number is in the reserved 0170000xxxx test block');

// ---------------------------------------------------------------------------
// NO `font:` SHORTHAND ENDING IN `inherit`
// ---------------------------------------------------------------------------
// `inherit` is a legal value for the WHOLE font property - `font: inherit`
// is fine, and several rules here use it. It is NOT a legal font-family
// INSIDE the shorthand, so `font: 600 13px/1 inherit` is invalid and the
// browser throws the entire declaration away: no weight, no size, no
// line-height, no family.
//
// Seven rules were written that way, all on buttons, and every one of them
// was dead. The four hero pills were set in no weight at all, and the KPI
// Engine button - a <button>, which does not inherit type - fell back to the
// UA default of 13.3px ARIAL beside three links in the page's own 14px.
// Nothing failed. The test next door compared the underline, the height and
// the background of that very pair and passed, because the padding happened
// to round both boxes to the same height.
//
// A declaration that silently does nothing is the worst kind to carry: it
// reads as intent, it survives review, and it cannot be seen without
// measuring what the browser ended up with. Hence a check on the source.
const fontShorthand = [];
[[SRC, /\.html$/]].forEach(function (where) {
  if (!fs.existsSync(where[0])) return;
  fs.readdirSync(where[0]).filter((f) => where[1].test(f)).forEach(function (f) {
    fs.readFileSync(path.join(where[0], f), 'utf8')
      .split('\n').forEach(function (line, i) {
        // Something has to stand BETWEEN the colon and `inherit` - that is
        // what makes `inherit` a family rather than the whole value. A bare
        // `font: inherit` is legal and several rules here rely on it, so the
        // \S is the entire difference between the two and not a tidiness.
        if (/^[^*]*\bfont:\s*[^;{]*\S\s+inherit\s*;/.test(line)) {
          fontShorthand.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 44));
        }
      });
  });
});
// ---------------------------------------------------------------------------
// NO REAL EMPLOYEE ID IN THE SOURCE OR THE FIXTURES
// ---------------------------------------------------------------------------
// The companion to the mobile-number rule above, and written after the same
// mistake was made a second time: a photo-matching fixture went in carrying
// five colleagues' real employee IDs beside their real names, into a public
// repository, because real values make a fixture feel more convincing. They
// do not make it a better test - the matcher cannot tell a real ID from an
// invented one - they only publish something that was not ours to publish.
//
// Names are a different matter and are not covered here: CONFIG.ROSTER has
// to name all thirty-seven people for the KPI scoring to work at all. It is
// the ID, the mobile number and the address that turn a name into a record.
//
// The rule, like the phone one, is a convention rather than a cleverness:
// every employee ID anywhere in this project lives in a reserved block -
// 200000xx, 2090xxxx or 2099xxxx. A real one cannot, so a real one fails.
//
// Dates are skipped. Upload IDs read 'UPL-20261028-102822-8817', and the
// date inside one is eight digits beginning 20 like everything else here.
// No employee ID on this team parses as a date: their fifth and sixth
// digits run to 74, 86, 99 and are not months.
const ID_OK = /^20(0000\d{2}|9[09]\d{4})$/;
const looksLikeDate = function (digits) {
  const month = Number(digits.slice(4, 6)), day = Number(digits.slice(6, 8));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
};
const realIds = [];
[[SRC, /\.(gs|html)$/], [__dirname, /-test\.js$/],
 [path.join(__dirname, 'harness'), /\.js$/]].forEach(function (where) {
  if (!fs.existsSync(where[0])) return;
  fs.readdirSync(where[0]).filter((f) => where[1].test(f)).forEach(function (f) {
    const text = fs.readFileSync(path.join(where[0], f), 'utf8');
    (text.match(/\b20\d{6}\b/g) || []).forEach(function (n) {
      if (ID_OK.test(n) || looksLikeDate(n)) return;
      realIds.push(f + ': ' + n.slice(0, 4) + 'xxxx');
    });
  });
});
check('no employee ID outside the reserved test blocks is written anywhere',
  realIds.length === 0,
  realIds.length ? realIds.filter((v, i, a) => a.indexOf(v) === i).join('; ')
                 : 'every ID is in 200000xx, 2090xxxx or 2099xxxx');

// ---------------------------------------------------------------------------
// EVERY TOOL MEANT TO BE RUN FROM THE EDITOR CAN BE
// ---------------------------------------------------------------------------
// The Run button calls a function with NOTHING. Pick it from the dropdown,
// press Run, and that is the whole interface - there is no box to type an
// argument into. So a diagnostic whose only input is a parameter cannot be
// run by the person it was written for.
//
// This has now happened twice. importTeamPhotos took the Drive folder as
// its only argument and answered "That does not look like a Drive folder
// link or id: null" from the one screen that could not give it one.
// explainModule, which says why a ticket is filed where it is, needed the
// module name - so the '(unassigned)' row on the By module table could be
// seen by anybody and explained by nobody.
//
// The list is written out rather than inferred. "Is this meant to be run
// from the editor?" is a judgement, not a pattern: grantMaster takes an
// employee ID because the ID IS the input, and wrapping it in a
// zero-argument version would mean inventing a default employee.
const EDITOR_TOOLS = [
  'setupTeamTab', 'checkTeamTab',
  'importTeamPhotos', 'reimportTeamPhotos', 'shareTeamPhotos',
  'checkTeamPhotos', 'installPhotoSync', 'removePhotoSync',
  'listPersonModules', 'explainUnassigned',
  'setupLearnTab', 'scanLearnFolder', 'shareLearnFiles',
  'checkLearnFolder', 'installLearnSync', 'removeLearnSync',
  'setupKnowledgeTab', 'shareKnowledgeFolder', 'checkKnowledgeFolder',
  'cleanKnowledgeParts'
];
const unrunnable = [], absent = [];
const gsText = fs.readdirSync(SRC).filter((f) => /\.gs$/.test(f))
  .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n');
EDITOR_TOOLS.forEach(function (name) {
  const hit = new RegExp('^function ' + name + '\\(([^)]*)\\)', 'm').exec(gsText);
  if (!hit) { absent.push(name); return; }
  const params = hit[1].trim();
  if (!params) return;
  // A parameter is fine as long as the function copes without it. What is
  // not fine is a parameter the body cannot do without - which, from here,
  // is any that is not read through a default, a fallback or a guard.
  const body = gsText.slice(hit.index);
  const first = params.split(',')[0].trim();
  //
  // The first alternative was `teamPhotoFolder(first)` by name, written when
  // that was the only resolver there was. Learn.gs added learnFolder(), which
  // does exactly the same job - take the argument if there is one, otherwise
  // read the script property - and the named test reported scanLearnFolder as
  // unrunnable although it runs perfectly well from the Run button. The rule
  // being checked is "the argument is handed to something that supplies a
  // default", so it matches any ...Folder() resolver rather than one.
  const copes = new RegExp(
    '(\\w*Folder\\(' + first + '\\)|' + first + '\\s*\\|\\||' +
    'String\\(' + first + '\\s*\\|\\||if\\s*\\(\\s*!?' + first + '\\b|' +
    first + '\\s*&&|\\b' + first + '\\s*\\?)'
  ).test(body.slice(0, 1400));
  if (!copes) unrunnable.push(name + '(' + params + ')');
});
// ---------------------------------------------------------------------------
// NO WIDTH SPECIFIER IN A Logger FORMAT STRING
// ---------------------------------------------------------------------------
// Apps Script's documentation points Logger.log at Java's String.format,
// which understands %-32s and %7s. In practice only a bare %s is
// substituted, and the difference is not a cosmetic one: the specifier
// prints LITERALLY and the arguments shift along behind it, so every column
// lands under the wrong heading. The whole of explainModule came out as
//
//     %-32s %6s   Utpal Biswas
//         %6s  1.0nothing - unassigned
//
// which is how a diagnostic written to answer a question ends up being the
// question. Thirteen call sites were written this way - the module summary,
// the per-person breakdown, the account list, the setup check - and every
// one of them had been printing nonsense for as long as it had existed,
// because nobody compares a log against what it was meant to say.
//
// padTo() does the padding now and the format strings carry plain %s.
const padded = [];
fs.readdirSync(SRC).filter((f) => /\.gs$/.test(f)).forEach(function (f) {
  fs.readFileSync(path.join(SRC, f), 'utf8').split('\n').forEach(function (line, i) {
    if (!/Logger\.log\s*\(/.test(line)) return;
    if (!/%-?\d+[sdf]/.test(line)) return;
    padded.push(f + ':' + (i + 1) + ' ' + line.trim().slice(0, 44));
  });
});
check('no Logger format string uses a width the Logger cannot apply',
  padded.length === 0,
  padded.length ? padded.join(' | ')
                : 'every column is padded by padTo, which the Logger cannot ignore');

check('every editor tool can be run from the Run button, which passes nothing',
  unrunnable.length === 0 && absent.length === 0,
  absent.length ? 'missing: ' + absent.join(', ')
    : unrunnable.length ? unrunnable.join('; ') + ' - needs a zero-argument form'
    : EDITOR_TOOLS.length + ' tools, all runnable from the dropdown');

check('no font shorthand names `inherit` as the family, which kills the rule',
  fontShorthand.length === 0,
  fontShorthand.length ? fontShorthand.join(' | ')
                       : 'the longhands apply; the shorthand would not have');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
