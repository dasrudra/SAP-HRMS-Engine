// Downloading one upload's tickets back out as CSV.
//
// WHAT CHANGED AND WHY IT NEEDS TESTING
// It used to be one call that read every row of TICKETS, built one string and
// returned the lot. Eleven megabytes through google.script.run with the page
// saying nothing, and a call that gets closer to its own limits every month.
// It is sliced now - and a sliced reader has one classic failure, which is
// that the slices do not quite meet. A row read twice, or not at all, is a
// CSV that is subtly wrong and looks completely normal.
//
// So the assertions that matter here are not about speed. They are:
//   every matching row appears, exactly once
//   the header appears once, on the first slice only
//   rows belonging to other uploads never appear
//   the slices reassemble into the same file the old call would have made
//
//   node tests/upload-csv-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a spreadsheet with two uploads' worth of tickets in it
// ---------------------------------------------------------------------------
// Deliberately interleaved. Rows from the two uploads alternate, so a slice
// boundary lands in the middle of both and an off-by-one shows up as a
// missing or doubled row rather than as a clean break nobody notices.
function build(ticketCount) {
  const box = {
    console, Object, String, Number, Array, Math, JSON, RegExp, Date,
    isFinite, Boolean, Error, parseInt, parseFloat
  };
  box.globalThis = box;
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), box);
  const CONFIG = vm.runInContext('CONFIG', box);

  const width = CONFIG.TICKET_COLUMNS.length;
  const sourceAt = CONFIG.TICKET_COLUMNS.indexOf('Source Files');
  const idAt = CONFIG.TICKET_COLUMNS.indexOf('Ticket ID');

  const tickets = [];
  for (let i = 0; i < ticketCount; i++) {
    const row = new Array(width).fill('');
    row[idAt] = 'T' + (1000 + i);
    row[sourceAt] = (i % 2 === 0) ? '7-26_Overall KPI-1_ITSM.xlsx'
                                  : 'somebody-elses-export.xlsx';
    tickets.push(row);
  }

  const uploads = [
    ['UPL-20261028-102822-8817', '', '', '7-26_Overall KPI-1_ITSM.xlsx', '', '', '', '', '', ''],
    ['UPL-20260101-090000-0001', '', '',
     'a.xlsx | b.xlsx | c:d*e.xlsx', '', '', '', '', '', '']
  ];

  const sheet = (rows, w) => ({
    getLastRow: () => rows.length + 1,
    getRange: (r, c, n, ww) => ({
      getValues: () => {
        const got = [];
        for (let i = 0; i < n; i++) got.push((rows[r - 2 + i] || new Array(ww).fill('')).slice(c - 1, c - 1 + ww));
        return got;
      }
    })
  });

  box.CONFIG = CONFIG;
  box.requireSignedIn = () => {};
  box.requireAdmin = () => {};
  box.LockService = { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) };
  box.SpreadsheetApp = {};
  box.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null }) };
  box.Utilities = { formatDate: () => '' };

  vm.runInContext(fs.readFileSync(path.join(SRC, 'Ingest.gs'), 'utf8'), box);

  // AFTER the file, not before. Ingest.gs declares its own sheetFor, and a
  // function declaration in a script lands on the global object - so a stub
  // set first is simply replaced by the real one, which then goes looking
  // for a spreadsheet that is not there.
  box.sheetFor = (name) =>
    name === CONFIG.SHEETS.UPLOADS ? sheet(uploads, 10) : sheet(tickets, width);

  return { box, CONFIG, tickets, width };
}

const { box, CONFIG } = build(9500);
const run = (expr) => vm.runInContext(expr, box);

// ---------------------------------------------------------------------------
// the file name
// ---------------------------------------------------------------------------
// It was the upload ID - 'UPL-20261028-102822-8817.csv' - which is the right
// name for a row in a log and the wrong one for a file landing in somebody's
// Downloads folder beside four other exports.
{
  const one = run("uploadCsvName('UPL-20261028-102822-8817', ['7-26_Overall KPI-1_ITSM.xlsx'])");
  check('the download is named after the file that was uploaded',
    one === '7-26_Overall KPI-1_ITSM 2026-10-28.csv', one);

  const many = run("uploadCsvName('UPL-20260101-090000-0001', ['a.xlsx','b.xlsx','c.xlsx'])");
  check('several files give the first one and a count, not a wall of names',
    many === 'a and 2 more 2026-01-01.csv', many);

  // Windows refuses these outright, so a name carrying one downloads as
  // nothing at all on half the machines in the office.
  const nasty = run("uploadCsvName('UPL-20260101-090000-0001', ['q1/q2: report*.xlsx'])");
  check('characters a filesystem will not accept are taken out',
    !/[\\/:*?"<>|]/.test(nasty), nasty);

  const none = run("uploadCsvName('UPL-20260101-090000-0001', [])");
  check('and an upload with no file names still gets a usable name',
    none.slice(-4) === '.csv' && none.indexOf('UPL-') === 0, none);
}

// ---------------------------------------------------------------------------
// the slices
// ---------------------------------------------------------------------------
const chunkSize = run('UPLOAD_CSV_CHUNK');
const UPLOAD = 'UPL-20261028-102822-8817';

const slices = [];
let at = 1, guard = 0;
for (;;) {
  const c = run("getUploadCsvChunk('t','" + UPLOAD + "'," + at + ")");
  slices.push(c);
  if (c.done) break;
  at = c.nextRow;
  if (++guard > 50) { check('the loop terminates', false, 'ran away'); break; }
}

check('it comes back in slices rather than one payload',
  slices.length === Math.ceil(9500 / chunkSize),
  slices.length + ' slices of ' + chunkSize + ' rows for 9500 tickets');

check('only the first slice carries the file name',
  slices[0].fileName !== '' &&
  slices.slice(1).every((c) => c.fileName === ''),
  'first "' + slices[0].fileName + '"');

check('and only the last one says it is done',
  slices[slices.length - 1].done === true &&
  slices.slice(0, -1).every((c) => c.done === false),
  slices.map((c) => c.done).join(','));

// THE ONE THAT MATTERS. Rebuild the file and count what is in it.
const text = slices.map((c) => c.csv).filter(Boolean).join('\n');
const lines = text.split('\n').filter((l) => l !== '');
const header = CONFIG.TICKET_COLUMNS.map((c) => '"' + c + '"').join(',');

check('the header is there exactly once',
  lines.filter((l) => l.indexOf(CONFIG.TICKET_COLUMNS[0]) === 0 ||
                      l === header).length === 1,
  lines[0].slice(0, 40));

// 9500 rows, every other one belongs to this upload.
check('every row of this upload is in the file, and exactly once',
  lines.length - 1 === 4750 &&
  new Set(lines.slice(1)).size === 4750,
  (lines.length - 1) + ' rows, ' + new Set(lines.slice(1)).size + ' of them distinct');

check('and no row from the other upload came with them',
  lines.slice(1).every((l) => l.indexOf('somebody-elses-export') === -1),
  'the filter is on Source Files, which can name several files per row');

// A slice boundary has to fall mid-upload for the test above to mean
// anything - if every slice happened to start on a clean break, an
// off-by-one would never show.
check('(fixture check) a slice boundary really does land mid-upload',
  9500 % chunkSize !== 0 && chunkSize < 9500,
  chunkSize + ' into 9500 leaves ' + (9500 % chunkSize));

// ---------------------------------------------------------------------------
// the edges
// ---------------------------------------------------------------------------
{
  // Fewer tickets than one slice: one call, done immediately, header present.
  const small = build(10);
  const only = vm.runInContext("getUploadCsvChunk('t','" + UPLOAD + "',1)", small.box);
  check('an upload smaller than one slice finishes in a single call',
    only.done === true && only.fileName !== '' &&
    only.csv.split('\n').length === 1 + 5,
    only.csv.split('\n').length + ' lines for 10 tickets, 5 of them this upload');

  // An empty TICKETS sheet must not throw or loop.
  const empty = build(0);
  const nothing = vm.runInContext("getUploadCsvChunk('t','" + UPLOAD + "',1)", empty.box);
  check('an empty sheet gives a header and stops',
    nothing.done === true && nothing.total === 0 &&
    nothing.csv.split('\n').length === 1,
    JSON.stringify(nothing.csv).slice(0, 40));

  let threw = '';
  try { vm.runInContext("getUploadCsvChunk('t','UPL-does-not-exist',1)", empty.box); }
  catch (e) { threw = e.message; }
  check('an upload ID that is not in the log is refused by name',
    /not found/i.test(threw), threw || 'it returned instead of throwing');
}

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
