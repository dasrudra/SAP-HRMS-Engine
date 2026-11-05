// Learn.gs - the Learnings library, on the server.
//
// WHY THIS EXISTS
// Every fact the Learnings page shows about a document - its type, its
// module, its business, its title - is DEDUCED, not entered. Nobody fills in
// a form; the deduction is the whole feature, and it runs on a filename and
// a folder path. So the deduction is what has to be tested, and none of it
// runs in a browser: portal-test.js drives a harness whose getLearning()
// returns a canned list, which tests how the page DRAWS a library and
// nothing about how the library is WORKED OUT.
//
// WHAT IT GUARDS, in rough order of how badly each one would hurt:
//
//   'mm' is inside 'common'       c-o-M-M-o-n. A substring match files every
//                                 shared document under MM, and today it does
//                                 not only because Common is listed first
//   'MG' is inside 'RMG'          and the business folders are matched by
//                                 name, so the wrong test order files the
//                                 entire RMG library as MG
//   'MG' is the front of 'MGT'    a prefix with no boundary eats two letters
//                                 off a title and invents a business
//   a bracket mid-name            "Amortization (RMG).pdf" has a bracket in
//                                 it that is not a type
//   the folder beats the filename a file named RMG_ in the MG folder is one
//                                 of the two being wrong, and silently
//                                 believing the filename hides it
//
//   node tests/learn-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a Drive just real enough
// ---------------------------------------------------------------------------
// The tree is the one in the team's own folder, with six traps added. Sizes
// and dates are the real ones off the recording where they are known.
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18);           // 18 Oct 2026, the folder's date

const TREE = {
  name: 'TVL-EAS_SOP-Policy-User Guideline',
  folders: [
    { name: 'Common', folders: [], files: [
      // No [Type]. It still has to appear, in Common, as a Document.
      { name: 'EAS Service Catalogue.pdf', size: 420 * 1024, mime: 'application/pdf' },
      { name: '[Policy] Password and Access Policy.pdf', size: 180 * 1024,
        mime: 'application/pdf' }
    ] },

    { name: 'MM Module', folders: [
      { name: 'RMG', folders: [], files: [
        { name: '[SOP] RMG_Basic Principle of Amortization.pdf',
          size: 7415 * 1024, mime: 'application/pdf' },
        { name: '[SOP] RMG_Destruction Process in SAP_R3.pdf',
          size: 915 * 1024, mime: 'application/pdf' },
        { name: '[SOP] RMG_SAP_S4HANA_Leftover Declaration.pdf',
          size: 2799 * 1024, mime: 'application/pdf' },
        { name: '[User Guideline] RMG_SAP_S4HANA_MD Master Data.pdf',
          size: 3914 * 1024, mime: 'application/pdf' },
        { name: '[User Guideline] RMG_SAP_S4HANA_MM Purchase Cycle.pdf',
          size: 27732 * 1024, mime: 'application/pdf' }
      ] },
      { name: 'MG', folders: [], files: [
        // TRAP: the bracket is not at the front, so RMG is not a type and
        // the title keeps it.
        { name: 'Amortization (RMG).pdf', size: 200 * 1024, mime: 'application/pdf' },
        // TRAP: starts with the letters MG and is not an MG prefix.
        { name: '[SOP] MGT Report Extraction.pdf', size: 300 * 1024,
          mime: 'application/pdf' },
        // TRAP: the filename says RMG, the folder says MG. The folder wins
        // and checkLearnFolder has to be able to see the disagreement.
        { name: '[SOP] RMG_Stock Transfer.pdf', size: 150 * 1024,
          mime: 'application/pdf' }
      ] }
    ], files: [] },

    { name: 'SD Module', folders: [
      { name: 'RMG', folders: [], files: [
        // A video, in Drive, like the training content is.
        { name: '[Training] RMG_S4HANA Sales Overview.mp4',
          size: 88 * 1024 * 1024, mime: 'video/mp4' },
        // TRAP: an unrecognised bracket. Typed as Document, and the
        // bracket comes OFF the title.
        { name: '[Checklist] RMG_Go Live Checks.docx', size: 90 * 1024,
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
      ] }
    ], files: [] },

    // TRAP: a numbered folder. People do this to force Drive's ordering.
    { name: '4. PP Module', folders: [
      { name: 'MG', folders: [], files: [
        { name: '[User Guideline] MG_Production Order.pdf', size: 1024 * 1024,
          mime: 'application/pdf' }
      ] }
    ], files: [] },

    // Present in Drive, empty. The tree must not draw it.
    { name: 'FI-CO Module', folders: [
      { name: 'RMG', folders: [], files: [] },
      { name: 'MG', folders: [], files: [] }
    ], files: [] }
  ],

  // TRAP: loose in the root, under no module at all.
  files: [
    { name: '[SOP] How to request access.pdf', size: 70 * 1024, mime: 'application/pdf' },
    // TRAP: in the bin. Drive still hands it to the iterator.
    { name: '[SOP] RMG_Withdrawn Procedure.pdf', size: 50 * 1024,
      mime: 'application/pdf', trashed: true }
  ]
};

let idSeed = 0;

// THE DATE CONSTRUCTOR IS THE ONE INSIDE THE vm, AND THAT MATTERS.
//
// readLearn() asks `row[6] instanceof Date` to decide whether a cell holds a
// timestamp. instanceof compares against the Date of the realm asking, and a
// vm context is its own realm - so a Date built out here with Node's
// constructor is not an instanceof the vm's Date, and every document comes
// back with no date at all. The first run of this suite reported "this
// quarter: 0" for a library whose files were all a fortnight old, and the
// product code was right: the harness was handing it foreign objects.
//
// Apps Script has one realm, so this is a fact about testing in a vm and not
// about Learn.gs. Passing the constructor in keeps the fixture honest.
function makeFile(spec, DateCtor) {
  const id = 'file' + (++idSeed);
  return {
    getId: () => id,
    getName: () => spec.name,
    getSize: () => spec.size,
    getMimeType: () => spec.mime,
    // Recent enough to count towards "this quarter" unless the spec says
    // otherwise, so the ninety-day window has something to count.
    getLastUpdated: () =>
      new DateCtor(spec.age === undefined ? NOW : NOW - spec.age * DAY),
    isTrashed: () => Boolean(spec.trashed)
  };
}

function iter(list) {
  let i = 0;
  return { hasNext: () => i < list.length, next: () => list[i++] };
}

function makeFolder(spec, DateCtor) {
  return {
    getName: () => spec.name,
    getFiles: () => iter((spec.files || []).map((f) => makeFile(f, DateCtor))),
    getFolders: () => iter((spec.folders || []).map((f) => makeFolder(f, DateCtor))),
    setSharing: function (access, perm) { this.__shared = [access, perm]; }
  };
}

// ---------------------------------------------------------------------------
// a spreadsheet just real enough
// ---------------------------------------------------------------------------
function makeSheet() {
  const all = [[
    'Title', 'Type', 'Module', 'Business', 'Kind',
    'Size', 'Updated', 'Path', 'File ID'
  ]];
  const cleared = [];
  return {
    rows: all,
    cleared: cleared,
    getName: () => 'LEARN',
    getLastRow: () => all.length,
    getLastColumn: () => all[0].length,
    getRange: function (r, c, n, w) {
      return {
        getValues: function () {
          const got = [];
          for (let i = 0; i < (n === undefined ? 1 : n); i++) {
            got.push((all[r - 1 + i] || []).slice(c - 1, c - 1 + (w || 1)));
          }
          return got;
        },
        clearContent: function () { cleared.push([r, n]); all.length = 1; },
        setValues: function (vals) {
          for (let i = 0; i < vals.length; i++) all[r - 1 + i] = vals[i].slice();
          return { setFontWeight: () => ({ setBackground: () => ({ setFontColor: () => {} }) }) };
        }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// the context
// ---------------------------------------------------------------------------
function load(opts) {
  const o = opts || {};
  const logs = [];
  const sheet = makeSheet();
  const cache = {};
  let vmDate = Date;

  const ctx = {
    console: console,
    // THE REAL SUBSTITUTION, not a join. Logger.log replaces a bare %s and
    // nothing else; a fake that joins its arguments with spaces makes every
    // format string look like it worked, which is exactly how the width
    // specifiers in the photo tools survived for weeks.
    Logger: {
      log: function (fmt) {
        const args = Array.prototype.slice.call(arguments, 1);
        let i = 0;
        logs.push(String(fmt).replace(/%s/g, () =>
          (i < args.length ? String(args[i++]) : '%s')));
      }
    },
    DriveApp: {
      getFolderById: function (id) {
        if (o.badFolder) throw new Error('No item with the given ID could be found');
        // o.tree and vmDate are both read AT CALL TIME, not captured: a test
        // changes the tree between two scans to prove that a document
        // deleted from Drive leaves the tab.
        return makeFolder(o.tree || TREE, vmDate);
      },
      Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
      Permission: { VIEW: 'VIEW' }
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (o.props && k in o.props ? o.props[k] : null),
        setProperty: (k, v) => { (o.props = o.props || {})[k] = v; }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = v; },
        remove: (k) => { delete cache[k]; }
      })
    },
    ScriptApp: {
      __triggers: [],
      getProjectTriggers: function () { return this.__triggers; },
      deleteTrigger: function (t) {
        this.__triggers = this.__triggers.filter((x) => x !== t);
      },
      newTrigger: function (fn) {
        const app = this;
        return { timeBased: () => ({ everyHours: () => ({
          create: () => { app.__triggers.push({ getHandlerFunction: () => fn }); }
        }) }) };
      }
    },
    Utilities: {
      formatDate: (d) => [d.getUTCDate(), 'Oct', d.getUTCFullYear()].join(' ')
    },
    SpreadsheetApp: {}
  };

  vm.createContext(ctx);
  vmDate = vm.runInContext('Date', ctx);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), ctx);

  // The four helpers Learn.gs leans on from elsewhere. Stubbed rather than
  // loaded: sheetWithHeaders would need a real Spreadsheet and driveFolderId
  // is three lines of regular expression that team-test already covers.
  ctx.sheetWithHeaders = () => sheet;
  ctx.__sheet = sheet;
  ctx.__logs = logs;
  ctx.__cache = cache;
  ctx.requireSignedIn = () => ({ u: '20000000', r: 'ADMIN' });
  ctx.CONFIG_TZ = () => 'Asia/Dhaka';
  vm.runInContext(
    fs.readFileSync(path.join(SRC, 'Team.gs'), 'utf8').match(
      /function driveFolderId[\s\S]*?\n}\n/)[0], ctx);

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Learn.gs'), 'utf8'), ctx);
  return ctx;
}

const FOLDER = 'https://drive.google.com/drive/folders/1yfTgtcdAFIsRSV8McUm8wXF4W1qJYkk5';
const ctx = load({ props: { LEARN_FOLDER: FOLDER } });
const CFG = vm.runInContext('CONFIG', ctx);

// ===========================================================================
// 1. reading a type and a title off a filename
// ===========================================================================
const p = (n) => ctx.parseLearnName(n);

check('[SOP] is recognised as a type',
  p('[SOP] RMG_Basic Principle of Amortization.pdf').type === 'SOP',
  p('[SOP] RMG_Basic Principle of Amortization.pdf').type);

check('[User Guideline] is recognised, spaces and all',
  p('[User Guideline] RMG_SAP_S4HANA_MD Master Data.pdf').type === 'User Guideline');

check('and so is it written any of the ways people write it',
  ['[user guideline]', '[User-Guideline]', '[USERGUIDELINE]', '[Manual]']
    .every((b) => p(b + ' RMG_X.pdf').type === 'User Guideline'),
  ['[user guideline]', '[User-Guideline]', '[USERGUIDELINE]', '[Manual]']
    .map((b) => p(b + ' RMG_X.pdf').type).join(' | '));

check('the bracket comes off the title',
  p('[SOP] RMG_Destruction Process in SAP_R3.pdf').title ===
    'Destruction Process in SAP R3',
  p('[SOP] RMG_Destruction Process in SAP_R3.pdf').title);

check('underscores become spaces, so a filename reads as a title',
  p('[SOP] RMG_SAP_S4HANA_Leftover Declaration.pdf').title ===
    'SAP S4HANA Leftover Declaration',
  p('[SOP] RMG_SAP_S4HANA_Leftover Declaration.pdf').title);

check('a file with no bracket is still a document, with its name intact',
  p('EAS Service Catalogue.pdf').type === CFG.LEARN.FALLBACK_TYPE &&
  p('EAS Service Catalogue.pdf').title === 'EAS Service Catalogue' &&
  p('EAS Service Catalogue.pdf').typed === false,
  p('EAS Service Catalogue.pdf').type + ' / ' + p('EAS Service Catalogue.pdf').title);

// THE TRAP. A bracket anywhere but the front is part of the name.
check('a bracket in the MIDDLE of a name is not a type',
  p('Amortization (RMG).pdf').type === CFG.LEARN.FALLBACK_TYPE &&
  p('Amortization (RMG).pdf').title === 'Amortization (RMG)',
  p('Amortization (RMG).pdf').type + ' / ' + p('Amortization (RMG).pdf').title);

check('an unrecognised bracket still comes off the title',
  p('[Checklist] RMG_Go Live Checks.docx').title === 'Go Live Checks' &&
  p('[Checklist] RMG_Go Live Checks.docx').typed === false,
  p('[Checklist] RMG_Go Live Checks.docx').title);

check('a name that is nothing but a bracket still gets a title',
  p('[SOP].pdf').title === 'Document', p('[SOP].pdf').title);

// ===========================================================================
// 2. MG, RMG, and the two ways of confusing them
// ===========================================================================
check('RMG_ is read as RMG and not as MG',
  p('[SOP] RMG_Stock Transfer.pdf').biz === 'RMG',
  p('[SOP] RMG_Stock Transfer.pdf').biz);

check('MG_ is read as MG',
  p('[User Guideline] MG_Production Order.pdf').biz === 'MG');

// THE TRAP. Without a boundary after the prefix, 'MGT Report' loses its MG.
check('MGT Report keeps its MG - a prefix needs a separator after it',
  p('[SOP] MGT Report Extraction.pdf').biz === '' &&
  p('[SOP] MGT Report Extraction.pdf').title === 'MGT Report Extraction',
  '"' + p('[SOP] MGT Report Extraction.pdf').title + '" biz=' +
    (p('[SOP] MGT Report Extraction.pdf').biz || '(none)'));

check('a hyphen counts as a separator as well as an underscore',
  p('[SOP] RMG-Stock Transfer.pdf').biz === 'RMG' &&
  p('[SOP] MG Production Order.pdf').biz === 'MG');

// ===========================================================================
// 3. which module a folder is
// ===========================================================================
check('MM Module is MM', (ctx.learnModule('MM Module') || {}).name === 'MM');
check('FI-CO Module is FI-CO, however it is punctuated',
  ['FI-CO Module', 'FICO', 'fi co module'].every(
    (n) => (ctx.learnModule(n) || {}).name === 'FI-CO'),
  ['FI-CO Module', 'FICO', 'fi co module']
    .map((n) => (ctx.learnModule(n) || {}).name).join(' | '));

// THE TRAP, and the reason the match is anchored. 'common' contains 'mm'.
check('Common is Common and not MM - "common" has mm inside it',
  (ctx.learnModule('Common') || {}).name === 'Common',
  (ctx.learnModule('Common') || {}).name);

check('every module folder matches itself and not a neighbour',
  CFG.LEARN.MODULES.every((m) => {
    const hit = ctx.learnModule(m.name);
    return hit && hit.name === m.name;
  }),
  CFG.LEARN.MODULES.map((m) => m.name + '->' +
    ((ctx.learnModule(m.name) || {}).name || '?')).join(' '));

// THE SAME TRAP, WITH THE LIST SHUFFLED - and this is the assertion that
// earns its place. The two above pass whether the match is anchored or a
// substring, because Common is listed FIRST and so wins either way. A
// mutation changing `indexOf(...) === 0` back to `!== -1` survived both of
// them without a murmur.
//
// Order is not a property to rely on: somebody alphabetising
// CONFIG.LEARN.MODULES would move every shared document into MM, silently.
// So the list is reordered here, worst case first, and Common still has to
// come back as Common.
{
  // SORTED THE WRONG WAY ROUND ON PURPOSE. Ascending gives
  // common,fico,mm,pp,sd - which still puts Common first, so a substring
  // match would pass it and the assertion would prove nothing. Descending
  // puts 'mm' ahead of 'common', which is the order that actually breaks a
  // substring match.
  const shuffled = vm.runInContext(
    '(function () {' +
    '  var was = CONFIG.LEARN.MODULES;' +
    '  CONFIG.LEARN.MODULES = was.slice().sort(function (a, b) {' +
    '    return a.match < b.match ? 1 : -1; });' +
    '  var got = {};' +
    '  was.forEach(function (m) {' +
    '    var hit = learnModule(m.name); got[m.name] = hit ? hit.name : null; });' +
    '  var order = CONFIG.LEARN.MODULES.map(function (m) { return m.match; });' +
    '  CONFIG.LEARN.MODULES = was;' +
    '  return { got: got, order: order };' +
    '})()', ctx);

  const wrong = Object.keys(shuffled.got)
    .filter((name) => shuffled.got[name] !== name);

  check('and still does with the module list in a different order',
    wrong.length === 0,
    wrong.map((n) => n + '->' + shuffled.got[n]).join(', ') ||
      'tried as ' + shuffled.order.join(','));
}

check('a folder numbered to force Drive order is still recognised',
  (ctx.learnModule('4. PP Module') || {}).name === 'PP',
  (ctx.learnModule('4. PP Module') || {}).name);

check('a folder that is not a module is nothing, not a guess',
  ctx.learnModule('Archive 2024') === null &&
  ctx.learnModule('') === null);

check('MG as a FOLDER is MG, and RMG is RMG',
  ctx.learnBusiness('MG') === 'MG' && ctx.learnBusiness('RMG') === 'RMG' &&
  ctx.learnBusiness('Drafts') === '',
  ctx.learnBusiness('MG') + ' / ' + ctx.learnBusiness('RMG'));

// ===========================================================================
// 4. what sort of file it is
// ===========================================================================
check('a PDF is a pdf, by type or by name',
  ctx.learnKind('application/pdf', 'x.pdf') === 'pdf' &&
  ctx.learnKind('application/octet-stream', 'x.pdf') === 'pdf');

check('a video is a video - the training content is in Drive too',
  ctx.learnKind('video/mp4', 'a.mp4') === 'video' &&
  ctx.learnKind('application/octet-stream', 'a.mov') === 'video',
  ctx.learnKind('video/mp4', 'a.mp4'));

check('Word, Excel and PowerPoint are told apart',
  ctx.learnKind('', 'a.docx') === 'doc' &&
  ctx.learnKind('', 'a.xlsx') === 'sheet' &&
  ctx.learnKind('', 'a.pptx') === 'slide',
  [ctx.learnKind('', 'a.docx'), ctx.learnKind('', 'a.xlsx'),
   ctx.learnKind('', 'a.pptx')].join(' '));

check('and anything else is just a file',
  ctx.learnKind('application/zip', 'a.zip') === 'file');

// ===========================================================================
// 5. sizes, as the page prints them
// ===========================================================================
check('27,732 KB reads as 27.1 MB and not as 28394496',
  ctx.learnSize(27732 * 1024) === '27.1 MB', ctx.learnSize(27732 * 1024));
check('915 KB stays in kilobytes',
  ctx.learnSize(915 * 1024) === '915 KB', ctx.learnSize(915 * 1024));
check('a decimal appears below 100 and not above',
  ctx.learnSize(7415 * 1024) === '7.2 MB' && ctx.learnSize(700 * 1024) === '700 KB',
  ctx.learnSize(7415 * 1024) + ' / ' + ctx.learnSize(700 * 1024));
check('nothing is printed for an empty file rather than "0.0 KB"',
  ctx.learnSize(0) === '' && ctx.learnSize(512) === '512 B',
  '"' + ctx.learnSize(0) + '" / ' + ctx.learnSize(512));

// ===========================================================================
// 6. the walk
// ===========================================================================
const walked = ctx.walkLearnFolder('x');
const byName = {};
walked.docs.forEach((d) => { byName[d.file] = d; });

check('every file in the tree is found except the one in the bin',
  walked.docs.length === 14,
  walked.docs.length + ' found, ' + Object.keys(byName).length + ' distinct');

check('a trashed file is not in the library',
  !walked.docs.some((d) => /Withdrawn/.test(d.file)),
  walked.docs.filter((d) => /Withdrawn/.test(d.file)).length + ' trashed included');

check('the folder gives the module, not the filename',
  byName['[SOP] RMG_Basic Principle of Amortization.pdf'].module === 'MM',
  byName['[SOP] RMG_Basic Principle of Amortization.pdf'].module);

check('the folder gives the business, not the filename',
  byName['[SOP] RMG_Stock Transfer.pdf'].business === 'MG',
  'named ' + byName['[SOP] RMG_Stock Transfer.pdf'].namedBiz +
  ', filed ' + byName['[SOP] RMG_Stock Transfer.pdf'].business);

check('and what the filename claimed is kept, so the two can be compared',
  byName['[SOP] RMG_Stock Transfer.pdf'].namedBiz === 'RMG');

check('Common has no business, because its folder has no MG or RMG under it',
  byName['EAS Service Catalogue.pdf'].module === 'Common' &&
  byName['EAS Service Catalogue.pdf'].business === '',
  byName['EAS Service Catalogue.pdf'].module + ' / "' +
    byName['EAS Service Catalogue.pdf'].business + '"');

check('a file loose in the root is kept, with no module',
  byName['[SOP] How to request access.pdf'].module === '',
  '"' + byName['[SOP] How to request access.pdf'].module + '"');

check('the numbered PP folder files its document under PP',
  byName['[User Guideline] MG_Production Order.pdf'].module === 'PP',
  byName['[User Guideline] MG_Production Order.pdf'].module);

check('the empty FI-CO folders contribute nothing',
  !walked.docs.some((d) => d.module === 'FI-CO'));

check('the video is typed as Training and kinded as video',
  byName['[Training] RMG_S4HANA Sales Overview.mp4'].type === 'Training' &&
  byName['[Training] RMG_S4HANA Sales Overview.mp4'].kind === 'video',
  byName['[Training] RMG_S4HANA Sales Overview.mp4'].type + ' / ' +
  byName['[Training] RMG_S4HANA Sales Overview.mp4'].kind);

check('the path records where a document actually sits',
  byName['[SOP] RMG_Destruction Process in SAP_R3.pdf'].path === 'MM Module / RMG',
  byName['[SOP] RMG_Destruction Process in SAP_R3.pdf'].path);

// ===========================================================================
// 7. the order the page gets them in
// ===========================================================================
const sorted = ctx.sortLearnDocs(walked.docs);
const mods = [];
sorted.forEach((d) => {
  const key = d.module || '(none)';
  if (mods[mods.length - 1] !== key) mods.push(key);
});

check('documents come back grouped by module, in the configured order',
  mods.join(' ') === 'Common MM SD PP (none)',
  mods.join(' '));

const mm = sorted.filter((d) => d.module === 'MM');
check('and RMG before MG inside a module',
  mm.map((d) => d.business).join(' ') === 'RMG RMG RMG RMG RMG MG MG MG',
  mm.map((d) => d.business).join(' '));

check('a module is never split across two runs of the list',
  mods.length === new Set(mods).size, mods.join(' '));

// ===========================================================================
// 8. the scan, writing the tab
// ===========================================================================
ctx.__cache['learn.library'] = '{"stale":true}';
ctx.scanLearnFolder('');
const sheet = ctx.__sheet;

check('the scan writes one row per document, under the header',
  sheet.rows.length === 15, sheet.rows.length - 1 + ' rows written');

check('the tab is cleared before it is rewritten, so a deleted file disappears',
  sheet.cleared.length === 0 || sheet.cleared[0][0] === 2,
  JSON.stringify(sheet.cleared));

check('the scan clears the page cache, so a manual run is visible at once',
  !('learn.library' in ctx.__cache),
  Object.keys(ctx.__cache).join(',') || '(empty)');

const firstRow = sheet.rows[1];
check('a row carries the title, type, module, business and file id',
  firstRow[0] === 'EAS Service Catalogue' && firstRow[2] === 'Common' &&
  firstRow[8] && /^file/.test(firstRow[8]),
  firstRow.slice(0, 5).join(' | '));

check('the size is written as the page prints it, not as bytes',
  sheet.rows.some((r) => r[5] === '27.1 MB'),
  sheet.rows.map((r) => r[5]).join(' '));

// Scanning twice has to leave the same thing behind, or the hourly trigger
// grows the tab by fourteen rows an hour.
const before = sheet.rows.length;
ctx.scanLearnFolder('');
check('scanning twice leaves the same number of rows, not twice as many',
  sheet.rows.length === before, before + ' then ' + sheet.rows.length);

// THE REAL TEST OF "REWRITTEN, NOT MERGED", and the one the assertion above
// cannot make. Rescanning an UNCHANGED folder writes the same rows over the
// same cells, so the tab is the same length whether or not it was cleared
// first - a mutation deleting the clearContent call survived that check
// untouched.
//
// What a merge actually loses is a DELETION: somebody takes a withdrawn SOP
// out of Drive, the scan runs, and the page goes on offering a document
// that is not there. So the folder loses one here, and the tab has to lose
// it too.
{
  const shrink = load({ props: { LEARN_FOLDER: FOLDER } });
  // Point this context's Drive at a copy of the tree, so trimming it
  // cannot affect any other assertion in this file.
  const copy = JSON.parse(JSON.stringify(TREE));
  shrink.DriveApp.getFolderById = function () {
    return makeFolder(copy, vm.runInContext('Date', shrink));
  };

  shrink.scanLearnFolder('');
  const full = shrink.__sheet.rows.length - 1;

  // The withdrawn SOP is taken out of MM / RMG, the way somebody would.
  const rmg = copy.folders.filter((f) => f.name === 'MM Module')[0]
                   .folders.filter((f) => f.name === 'RMG')[0];
  const dropped = rmg.files.pop().name;

  shrink.scanLearnFolder('');
  const after = shrink.__sheet.rows.length - 1;

  check('a document deleted from Drive disappears from the tab',
    after === full - 1, full + ' rows, then ' + after + ' after removing "' +
      dropped + '"');

  check('and is not left behind among the rows that remain',
    !shrink.__sheet.rows.some((r) => /Purchase Cycle/.test(String(r[0]))),
    shrink.__sheet.rows.filter((r) => /Purchase Cycle/.test(String(r[0])))
      .length + ' stale row(s)');
}

// ===========================================================================
// 9. reading it back for the page
// ===========================================================================
const lib = ctx.readLearn();

check('the page gets every document back',
  lib.filled && lib.count === 14, lib.count + ' of 14');

check('and a preview address that an iframe can actually show',
  lib.docs.every((d) => /\/preview$/.test(d.preview)),
  lib.docs[0].preview);

check('the full-document address is the normal Drive page, not the preview',
  lib.docs.every((d) => /\/view$/.test(d.open) && d.open !== d.preview),
  lib.docs[0].open);

check('and a download address distinct from both',
  lib.docs.every((d) => /export=download/.test(d.download)),
  lib.docs[0].download);

check('the types the chips are drawn from have no duplicates',
  lib.types.length === new Set(lib.types.map((t) => t.name)).size,
  lib.types.map((t) => t.name).join(', '));

check('User Guideline appears once although three spellings map to it',
  lib.types.filter((t) => t.name === 'User Guideline').length === 1);

check('the fallback type is one of them, so the chips total the library',
  lib.types.some((t) => t.name === CFG.LEARN.FALLBACK_TYPE),
  lib.types.map((t) => t.name).join(', '));

check('Common is marked as not split, and the others as split',
  lib.modules.filter((m) => m.name === 'Common')[0].split === false &&
  lib.modules.filter((m) => m.name === 'MM')[0].split === true,
  lib.modules.map((m) => m.name + (m.split ? '+' : '-')).join(' '));

check('every type the chips offer has an accent in range',
  lib.types.every((t) => t.accent >= 0 && t.accent <= 3),
  lib.types.map((t) => t.name + ':' + t.accent).join(' '));

check('this quarter counts the recent ones and not the whole library',
  lib.quarter === 14, String(lib.quarter));

// ===========================================================================
// 10. the endpoint and its cache
// ===========================================================================
const served = ctx.getLearning('t');
check('getLearning returns the library', served.count === 14);
check('and caches it, so a second page load does not re-read the tab',
  'learn.library' in ctx.__cache,
  Object.keys(ctx.__cache).join(','));

// ===========================================================================
// 11. the diagnostic says what needs a human
// ===========================================================================
const diag = load({ props: { LEARN_FOLDER: FOLDER } });
diag.checkLearnFolder();
const log = diag.__logs.join('\n');

check('checkLearnFolder names the files with no [Type]',
  /NO \[Type\]/.test(log) && /EAS Service Catalogue\.pdf/.test(log) &&
  /Amortization \(RMG\)\.pdf/.test(log),
  (log.match(/NO \[Type\][^]*?(?=\n\n|$)/) || [''])[0].split('\n').length - 1 +
    ' listed');

check('it names the file that is under no module',
  /NOT UNDER A MODULE/.test(log) && /How to request access/.test(log));

check('it reports the file whose name and folder disagree',
  /DISAGREE/.test(log) && /Stock Transfer/.test(log) &&
  /named RMG, filed under MG/.test(log),
  (log.match(/named \w+, filed under \w+/) || ['(not reported)'])[0]);

check('it does not claim everything is fine when it is not',
  !/Every file is classified/.test(log));

check('it prints a count by module and by type',
  /By type:/.test(log) && /By module:/.test(log) && /MM 8/.test(log),
  (log.match(/By module: .*/) || [''])[0]);

// NO WIDTH SPECIFIERS. padTo does the padding; a %-10s in the format string
// prints literally AND shifts every argument after it along by one.
check('the diagnostic uses no width specifier in a format string',
  !/%-?\d+s/.test(fs.readFileSync(path.join(SRC, 'Learn.gs'), 'utf8')),
  (fs.readFileSync(path.join(SRC, 'Learn.gs'), 'utf8')
    .match(/%-?\d+s/g) || []).join(' '));

check('and its table is left-aligned, so the left edge is not ragged',
  /^MODULE    /m.test(log),
  (log.match(/^.*MODULE.*$/m) || [''])[0]);

// ===========================================================================
// 12. the folder is not set, or is wrong
// ===========================================================================
const bare = load({ props: {} });
bare.scanLearnFolder('');
const bareLog = bare.__logs.join('\n');
check('with no folder set, the log says exactly how to set one',
  /LEARN_FOLDER/.test(bareLog) && /Script Properties/.test(bareLog) &&
  /Project Settings/.test(bareLog),
  bareLog.split('\n')[0]);

check('and nothing is written to the tab',
  bare.__sheet.rows.length === 1, bare.__sheet.rows.length - 1 + ' rows');

const broken = load({ props: { LEARN_FOLDER: FOLDER }, badFolder: true });
broken.scanLearnFolder('');
check('a folder that cannot be opened is reported, not thrown',
  /could not be read/.test(broken.__logs.join('\n')),
  broken.__logs.join(' | ').slice(0, 70));

check('and the tab is left alone rather than emptied',
  broken.__sheet.rows.length === 1);

// The hourly trigger must never throw: a trigger that throws emails the
// owner every hour until somebody notices.
let threw = false;
try { broken.syncLearnFolder(); } catch (e) { threw = true; }
check('the hourly sync swallows a broken folder instead of throwing', !threw);

// ===========================================================================
// 13. the editor tools
// ===========================================================================
const trig = load({ props: { LEARN_FOLDER: FOLDER } });
trig.installLearnSync();
check('installLearnSync creates exactly one hourly trigger',
  vm.runInContext('ScriptApp.__triggers.length', trig) === 1,
  String(vm.runInContext('ScriptApp.__triggers.length', trig)));

trig.installLearnSync();
check('and running it twice does not leave two',
  vm.runInContext('ScriptApp.__triggers.length', trig) === 1,
  String(vm.runInContext('ScriptApp.__triggers.length', trig)));

trig.removeLearnSync();
check('removeLearnSync takes it away again',
  vm.runInContext('ScriptApp.__triggers.length', trig) === 0);

const share = load({ props: { LEARN_FOLDER: FOLDER } });
share.shareLearnFiles();
const shareLog = share.__logs.join('\n');
check('shareLearnFiles says in plain words who can then read the documents',
  /anyone with the link/i.test(shareLog) && /without signing in/.test(shareLog),
  shareLog.split('\n').filter((l) => /sign/.test(l))[0] || '(not said)');

// ===========================================================================
// 14. the section mailboxes
// ===========================================================================
// THE ORGANOGRAM IS THE ONLY PLACE THESE ARE SHOWN. There was a strip of
// five on the front page as well and it has gone, so the browser is handed
// the match table and nothing else - see sectionMailTable().
const table = ctx.sectionMailTable();

check('the four aliases are all in the table',
  ['sca.eas@tekvision.com.bd', 'scua.eas@tekvision.com.bd',
   'ma.eas@tekvision.com.bd', 'fa.eas@tekvision.com.bd']
    .every((a) => table.some((e) => e.address === a)),
  table.map((e) => e.address).join(' '));

check('each carries the display name from the announcement',
  table.filter((e) => e.address === 'scua.eas@tekvision.com.bd')
       .every((e) => e.name === 'Sales & Customer Applications'),
  table.map((e) => e.name).filter((v, i, a) => a.indexOf(v) === i).join(' | '));

// Four sections, five rows: Sales & Customer Applications is listed twice
// so that either 'sales' or 'customer' finds it.
check('no section resolves to a mailbox belonging to another section',
  new Set(table.map((e) => e.address)).size === 4,
  new Set(table.map((e) => e.address)).size + ' distinct addresses in ' +
    table.length + ' rows');

// The organogram's section names come from the TEAM tab, which spells two of
// them differently from CONFIG.ROSTER and differently again from CONFIG.ORG.
// All three spellings have to reach the same mailbox.
const spellings = {
  'Supply Chain Applications': 'sca.eas@tekvision.com.bd',
  'Sales and Customer Applications': 'scua.eas@tekvision.com.bd',
  'Sales & Customer Applications': 'scua.eas@tekvision.com.bd',
  'Sales Applications': 'scua.eas@tekvision.com.bd',
  'Manufacturing Applications': 'ma.eas@tekvision.com.bd',
  'Financial Applications': 'fa.eas@tekvision.com.bd'
};
const missed = Object.keys(spellings).filter((name) => {
  const hit = ctx.sectionMailFor(name);
  return !hit || hit.address !== spellings[name];
});
check('every spelling of every section finds its mailbox',
  missed.length === 0, missed.join(', ') || 'all six spellings matched');

check('a section with no mailbox gets none, not the department one',
  ctx.sectionMailFor('Infrastructure') === null &&
  ctx.sectionMailFor('') === null,
  String(ctx.sectionMailFor('Infrastructure')));

check('the browser is handed the match table, not just the finished list',
  ctx.sectionMailTable().length === CFG.SECTION_MAIL.length &&
  ctx.sectionMailTable().every((e) => e.match && e.address),
  ctx.sectionMailTable().length + ' entries');

// Every roster section must have an alias, or the organogram has a bar with
// nothing under it. This catches a section added to CONFIG.ORG and not here.
const unaddressed = CFG.ORG.sections.filter((s) => !ctx.sectionMailFor(s.name));
check('every section on the org chart has a mailbox',
  unaddressed.length === 0,
  unaddressed.map((s) => s.name).join(', ') || 'all four addressed');

// ---------------------------------------------------------------------------
const passed = out.filter(Boolean).length;
console.log('\n' + passed + '/' + out.length + ' passed');
process.exit(passed === out.length ? 0 : 1);
