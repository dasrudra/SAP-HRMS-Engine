/**
 * THE UPLOADS SCREEN, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node uploads-ui-test.js
 *
 * upload-parse-test.js proves the parsing is identical to App.html's. This
 * proves the other half: that a real .xlsx, dropped on the real page, goes
 * all the way through SheetJS, the parse, the batch endpoints and the history
 * table, and that what comes out the far end is in PostgreSQL.
 *
 * WHY THIS NEEDS A BROWSER AND CANNOT BE FAKED.
 * Three things in the chain exist nowhere else: FileReader, SheetJS reading
 * the zip a real Excel file is, and the drop event itself. A test that handed
 * the parser a grid would skip all three - and the one option that matters
 * most in this whole screen, `cellDates: true`, lives exactly there. Dropping
 * it turns every session date into the number 46162, which upload-parse.js
 * refuses, and KPI 2 goes blank. No amount of unit testing reaches it.
 *
 * THE .xlsx IS BUILT IN THE PAGE, by the page's own copy of SheetJS. So the
 * file this test drops is a real workbook written by the same library that
 * then reads it back, which is what the real files are: written by Excel,
 * read by SheetJS.
 *
 * ON SIGNING IN. The test mints its own token rather than typing a password,
 * because this is the uploads screen and not the sign-in screen. The token is
 * signed by auth.js the same way /api/login signs one, so every endpoint
 * behind requireAuth and requireAdmin is reached exactly as a person reaches
 * it - the role is read out of the signature, not out of the page.
 *
 * EVERY ROW IT MAKES IS NAMED 'TEST-UI-...' and swept at both ends.
 */
require('dotenv').config();
const path = require('path');
const db = require('./db');
const { signToken } = require('./auth');
const browser = require('../tests/harness/browser');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PAGE = BASE + '/uploads.html';

let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name); return; }
  failed++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : '   ' + detail));
}


// The seven questions, worded as the real forms word them - a distinctive
// phrase buried in a sentence, which is the whole reason the parse matches on
// phrases instead of on exact headings.
const Q = [
  'How would you rate the overall training session?',
  'Was the content relevant and useful for your job?',
  'How would you rate the knowledge and expertise of the trainer?',
  'Could the trainer explain concepts clearly?',
  'Were the training materials helpful?',
  'Do you feel more confident using the system now?',
  'Was the duration and pace appropriate?'
];

const TICKET_FILE = 'TEST-UI_Overall KPI-1_ITSM.xlsx';
const SECTION_FILE = 'TEST-UI_Sales Applications_ITSM.xlsx';
const FEEDBACK_FILE = 'TEST-UI Trainee Feedback Q1-2026 Inventory - Qadir.xlsx';


async function sweep() {
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-UI-%'");
  await db.query("DELETE FROM training WHERE response_id LIKE 'TEST-UI%'");
  await db.query("DELETE FROM upload_run WHERE file_names LIKE '%TEST-UI%'" +
                 " OR uploaded_by LIKE 'TEST-UI%'");
}


async function main() {
  if (!browser.ready) {
    console.log('');
    console.log('  SKIPPED - no browser to drive.');
    console.log('  ' + browser.skipReason());
    console.log('');
    process.exit(0);
  }

  // Is the server up? Said plainly, because "net::ERR_CONNECTION_REFUSED"
  // from inside Chromium is not a useful way to learn that npm start is not
  // running.
  try {
    const res = await fetch(BASE + '/api/health');
    if (!res.ok) throw new Error('health check answered ' + res.status);
  } catch (err) {
    console.log('');
    console.log('  The API is not answering on ' + BASE + '.');
    console.log('  Start it in Terminal 3 with:  npm start');
    console.log('  (' + err.message + ')');
    console.log('');
    process.exit(1);
  }

  await sweep();

  const token = signToken('TEST-UI-admin', 'MASTER');

  const b = await browser.launch();
  const context = await b.newContext();
  const p = await context.newPage();

  /*
    TWO DIFFERENT THINGS, COLLECTED SEPARATELY.

    A thrown exception is the page's own fault and is never acceptable. A
    request that failed is often somebody else's - the CDN, blocked here -
    and Chromium reports it as a console error whose TEXT does not contain
    the URL ("Failed to load resource: the server responded with a status
    of 404"). Filtering those by message text filters nothing, so the URLs
    are taken from the response events instead, where they exist.
  */
  const thrown = [];
  const badRequests = [];
  p.on('pageerror', function (err) { thrown.push(String(err.message || err)); });
  p.on('console', function (m) {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      thrown.push(m.text());
    }
  });
  p.on('response', function (r) {
    if (r.status() >= 400) badRequests.push(r.status() + ' ' + r.url());
  });
  p.on('requestfailed', function (r) {
    badRequests.push('could not be reached: ' + r.url());
  });

  // The token has to be in sessionStorage BEFORE the page's DOMContentLoaded
  // reads it, so it is planted on the origin first and the page loaded after.
  await p.goto(BASE + '/uploads.html');
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); }, token);
  await p.goto(PAGE);

  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });

  const sheets = await provideSheetJs(p);
  console.log('');
  console.log('  Reading .xlsx with ' + (sheets.real
    ? 'the real SheetJS, loaded from the CDN'
    : 'A STAND-IN, because the CDN is unreachable from here'));
  if (!sheets.real) {
    console.log('  The stand-in reproduces the one behaviour that matters: it');
    console.log('  hands back a Date when cellDates is asked for and an Excel');
    console.log('  serial number when it is not. Everything after the read -');
    console.log('  the parse, the batches, the table - is the real thing.');
  }


  // =======================================================================
  console.log('');
  console.log('  The screen itself');
  // =======================================================================
  check('the page is served, and the sign-in card is out of the way',
        await p.isHidden('#signinCard'));
  check('the heading is the one the old screen had',
        (await p.textContent('.page-head h1')).trim() === 'Data Uploads');
  check('the design system loaded, so this is not an unstyled page',
        await p.evaluate(function () {
          const v = getComputedStyle(document.documentElement)
            .getPropertyValue('--navy-900').trim();
          return v !== '';
        }));
  check('the dropzone is there for an admin',
        await p.isVisible('#dropzone'));
  check('and the viewer notice is not',
        await p.isHidden('#uploadReadOnly'));
  check('the history table has the nine columns it always had',
        await p.evaluate(function () {
          return document.querySelectorAll('#uploadTable thead th').length;
        }) === 9);

  const boot = await p.evaluate(function () {
    return fetch('/api/uploads/boot',
                 { headers: { Authorization: 'Bearer ' +
                              sessionStorage.getItem('easToken') } })
      .then(function (r) { return r.json(); });
  });
  check('the boot call sent 29 ticket columns',
        boot.ticketColumns.length === 29, String(boot.ticketColumns.length));
  check('and 19 training columns',
        boot.trainingColumns.length === 19, String(boot.trainingColumns.length));
  check('and the module patterns the filename is read with',
        boot.trainingModules.length > 0 && Array.isArray(boot.trainingModules[0].match));
  check('and the section patterns',
        boot.departments.some(function (d) { return d.match === 'sales'; }));
  check('THE COLUMN LISTS COME FROM THE SERVER, not from a copy in the page',
        await p.evaluate(function () {
          // The page holds no column list of its own. If it did, this would
          // be the drift that files every value one column to the left.
          return document.documentElement.innerHTML.indexOf('Ticket ID') === -1;
        }));


  // =======================================================================
  console.log('');
  console.log('  Dropping two ITSM exports at once');
  // =======================================================================
  /*
    THE SAME TICKET IN BOTH FILES, described differently.

    TEST-UI-1 is in the overall export with a blank Title, and in the Sales
    export with one. One row has to come out, counting in both reports, with
    the title filled in and both filenames on it. That is the merge, and it
    is the thing that goes wrong silently.
  */
  const ticketStatus = await dropAndWait(p, [
    { name: TICKET_FILE, sheet: [
      ['Ticket ID', 'Request Date', 'Title', 'Details', 'Part', 'Status',
       'Completion Date', 'Delay Days', 'Current Activity In Charge'],
      ['TEST-UI-1', '2026-07-01 09:15:00', '', 'from the overall export',
       'MM', 'Completed', '2026-07-01 11:00:00', 0, 'Nobody Real'],
      ['TEST-UI-2', '2026-07-02 10:00:00', 'Only in the overall export', '',
       'SD', 'Pending', '', 2, 'Nobody Real'],
      // A TRAILING BLANK ROW, which real exports carry. `blankrows: false`
      // drops it on the way in; without that it is counted as a row read and
      // the summary says one more than the file has.
      ['', '', '', '', '', '', '', '', '']
    ] },
    { name: SECTION_FILE, sheet: [
      ['Ticket ID', 'Request Date', 'Title', 'Man*Hour', 'Delay Days',
       'Part', 'Status'],
      ['TEST-UI-1', '2026-07-01 09:15:00', 'Cannot post invoice', 1.5, 0,
       'MM', 'Completed'],
      ['TEST-UI-3', '2026-07-03 08:00:00', 'Only in the section export', 2, 1,
       'MM', 'Completed']
    ] }
  ], /Done\./);

  check('the upload finished and said so', /Done\./.test(ticketStatus), ticketStatus);

  /*
    CELLDATES IS NOT OPTIONAL, and this is where that is nailed down.

    Without it a date cell comes back as 46162 - the number of days since
    1900 - which upload-parse.js refuses, so every session date goes blank
    and KPI 2 goes blank with it. The option is one word in uploads.html and
    nothing on screen would ever say it had been dropped.
  */
  const readWith = await p.evaluate(function () { return window.__readOptions; });
  check('EVERY WORKBOOK WAS READ WITH cellDates, so a date cell is a Date',
        readWith.length === 2 &&
        readWith.every(function (o) { return o.cellDates === true; }),
        JSON.stringify(readWith));
  check('and with header:1, so columns are mapped by NAME and never by index',
        await p.evaluate(function () {
          // sheet_to_json is called once per file, straight after each read.
          return document.documentElement.innerHTML.indexOf('header: 1') !== -1;
        }));
  check('it reported the merge: four rows in, three tickets out',
        /3 tickets stored/.test(ticketStatus), ticketStatus);
  check('the per-file summary named both files and what each was',
        /OVERALL/.test(ticketStatus) && /INDIVIDUAL/.test(ticketStatus),
        ticketStatus);
  check('and read the section out of the filename',
        /Sales Applications/.test(ticketStatus), ticketStatus);
  /*
    THE SUMMARY COUNTS ROWS THAT BECAME TICKETS, not rows in the sheet.

    A trailing blank row is dropped twice over - by `blankrows: false` on the
    way in, and again by the no-Ticket-ID rule - so removing the first of
    those changes no stored row and no number here. That is why the option
    cannot be caught by any assertion in this suite, and it is kept
    regardless: a real .xlsx can carry tens of thousands of phantom trailing
    rows, and parsing them all to throw them away is a cost, not a bug.
  */
  check('the summary counts the rows that became tickets',
        new RegExp(TICKET_FILE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                   ' \u2014 OVERALL \u00b7 2 rows').test(ticketStatus),
        ticketStatus);
  /*
    AND THE SERVER SAW EACH TICKET ONCE.

    mergeFiles exists so the two files are collapsed in the browser before
    anything is sent. Without it the upload still ends up correct - the
    server's own merge catches the duplicate - so the only sign is that the
    finish reports a row it had to merge. That is the difference between an
    optimisation that works and one that has quietly stopped running.
  */
  check('the browser merged the files, so the server merged nothing',
        !/merged into rows/.test(ticketStatus), ticketStatus);

  const t1 = (await db.query(
    'SELECT * FROM ticket WHERE ticket_id = $1', ['TEST-UI-1']))[0];
  check('THE TICKET IS IN POSTGRESQL', Boolean(t1));
  check('the blank title was filled in from the other export',
        t1 && t1.title === 'Cannot post invoice', t1 && t1.title);
  // in_overall / in_dept, not in_overall_report / in_dept_report. The HEADING
  // in the spreadsheet was 'In Overall Report'; the column is the short name.
  check('it counts in BOTH reports',
        t1 && t1.in_overall === true && t1.in_dept === true,
        t1 && (t1.in_overall + '/' + t1.in_dept));
  check('both filenames are on it',
        t1 && t1.source_files === TICKET_FILE + ' | ' + SECTION_FILE,
        t1 && t1.source_files);
  check('the section export is believed about which section owns it',
        t1 && t1.department === 'Sales Applications', t1 && t1.department);
  /*
    TEN PAST NINE IN DHAKA IS TEN PAST NINE.

    The cell says '2026-07-01 09:15:00' with no timezone on it, which means
    Dhaka, which is 03:15 UTC. A server reading it as its own local time puts
    a late-evening ticket in the wrong month, and the month is what KPI 1
    groups by.
  */
  check('A NAIVE REQUEST DATE WAS READ AS DHAKA, NOT AS THE SERVER',
        t1 && new Date(t1.request_date).toISOString() === '2026-07-01T03:15:00.000Z',
        t1 && String(t1.request_date));
  check('a number cell arrived as a number, not as text',
        t1 && Number(t1.delay_days) === 0, t1 && String(t1.delay_days));

  const three = (await db.query(
    "SELECT count(*)::int AS n FROM ticket WHERE ticket_id LIKE 'TEST-UI-%'"))[0].n;
  check('three tickets exist, not four', three === 3, String(three));

  const rows = await p.evaluate(function () {
    return Array.prototype.slice.call(
      document.querySelectorAll('#uploadTable tbody tr')).map(function (tr) {
        return { files: tr.dataset.files, types: tr.dataset.types,
                 range: tr.dataset.range, rows: tr.dataset.rows,
                 cells: Array.prototype.slice.call(tr.cells).map(function (td) {
                   return td.textContent.trim();
                 }) };
      });
  });
  const ticketRow = rows.filter(function (r) {
    return r.files.indexOf('TEST-UI_Overall') !== -1;
  })[0];
  check('THE UPLOAD IS IN THE HISTORY TABLE', Boolean(ticketRow));
  /*
    THE FILES CELL SUMMARISES. One name and a count, not the whole list -
    a forty-three file upload printed every name and made a row a thousand
    pixels tall. So the SECOND name must not be in the cell; checking only
    that the first one is there passes on a cell holding all of them.
  */
  check('the Files cell names the first file and counts the rest',
        ticketRow && /TEST-UI_Overall KPI-1_ITSM\.xlsx/.test(ticketRow.cells[2]) &&
        /\+1 more/.test(ticketRow.cells[2]), ticketRow && ticketRow.cells[2]);
  check('and does NOT list the second one',
        ticketRow && ticketRow.cells[2].indexOf(SECTION_FILE) === -1,
        ticketRow && ticketRow.cells[2]);
  check('the whole list is still on the row, for the delete dialog',
        ticketRow && ticketRow.files === TICKET_FILE + ' | ' + SECTION_FILE,
        ticketRow && ticketRow.files);
  check('the Type cell says both kinds rather than repeating one',
        ticketRow && /OVERALL/.test(ticketRow.cells[3]) &&
        /INDIVIDUAL/.test(ticketRow.cells[3]), ticketRow && ticketRow.cells[3]);
  check('the Rows and Stored columns are 4 in, 3 kept',
        ticketRow && ticketRow.cells[5] === '4' && ticketRow.cells[6] === '3',
        ticketRow && (ticketRow.cells[5] + '/' + ticketRow.cells[6]));
  check('the Range column is the dates the tickets actually cover',
        ticketRow && ticketRow.cells[7] === '2026-07-01 \u2192 2026-07-03',
        ticketRow && ticketRow.cells[7]);
  check('and it carries the row buttons, not a deleted pill',
        ticketRow && /Open Dashboard/.test(ticketRow.cells[8]),
        ticketRow && ticketRow.cells[8]);


  // =======================================================================
  console.log('');
  console.log('  An export bigger than one batch');
  // =======================================================================
  /*
    THE SLICES HAVE TO MEET.

    Rows go up in batches of 400, and a batched sender has one classic
    failure: the slices do not quite join. A row sent twice or not at all is
    an upload that looks completely normal and is quietly short. Every
    fixture above is three rows, so the loop ran once and the boundary was
    never crossed - a mutation that sent only the first batch passed
    everything.

    900 rows: two full batches and a short one, so both boundaries are real.
  */
  const BULK = 900;
  const bulkSheet = [['Ticket ID', 'Request Date', 'Title', 'Part', 'Status',
                      'Delay Days']];
  for (let i = 0; i < BULK; i++) {
    bulkSheet.push(['TEST-UI-B' + (10000 + i),
                    '2026-08-' + String((i % 28) + 1).padStart(2, '0') + ' 09:00:00',
                    'Bulk ticket ' + i, 'MM',
                    i % 3 === 0 ? 'Completed' : 'Pending', i % 5]);
  }

  const bulkStatus = await dropAndWait(p, [
    { name: 'TEST-UI_Bulk KPI-1_ITSM.xlsx', sheet: bulkSheet }
  ], /Done\./, 180000);

  check('the bulk upload finished', /Done\./.test(bulkStatus), bulkStatus);
  check('it reported all ' + BULK + ' stored',
        new RegExp(BULK.toLocaleString('en-US') + ' tickets stored').test(bulkStatus),
        bulkStatus);

  const bulkCount = (await db.query(
    "SELECT count(*)::int AS n FROM ticket WHERE ticket_id LIKE 'TEST-UI-B%'"))[0].n;
  check('EVERY ROW OF A THREE-BATCH UPLOAD IS IN THE DATABASE, ONCE EACH',
        bulkCount === BULK, bulkCount + ' of ' + BULK);
  /*
    AND THE EDGES, NAMED. 400 and 401 straddle the first boundary, 800 and
    801 the second. If a slice is off by one these are the rows that go
    missing, and a bare count would have found it - but would not have said
    where.
  */
  const edges = ['TEST-UI-B10399', 'TEST-UI-B10400', 'TEST-UI-B10401',
                 'TEST-UI-B10799', 'TEST-UI-B10800', 'TEST-UI-B10801'];
  const missing = [];
  for (let i = 0; i < edges.length; i++) {
    const got = await db.query('SELECT 1 FROM ticket WHERE ticket_id = $1', [edges[i]]);
    if (got.length !== 1) missing.push(edges[i]);
  }
  check('the rows either side of each batch boundary are all there',
        missing.length === 0, missing.join(', '));

  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-UI-B%'");
  await db.query("DELETE FROM upload_run WHERE file_names LIKE '%TEST-UI_Bulk%'");


  // =======================================================================
  console.log('');
  console.log('  Dropping a training feedback export');
  // =======================================================================
  /*
    THE EXCEL-MANGLED DATE, END TO END.

    Response 1 types a date Excel turned into 1984. Response 2 types one that
    agrees with the submission. The first must be filed under its submission
    date and reported as corrected; the second must be left alone. This is
    the bug that put a June 2026 session in the 1984 quarter, and it is only
    visible as a KPI 2 screen with a month missing from it.

    The date cells are real Date objects here, which is what Microsoft Forms
    writes and what makes `cellDates: true` load-bearing.
  */
  const fbStatus = await dropAndWait(p, [
    { name: FEEDBACK_FILE, sheet: [
      ['ID', 'Completion time', 'Employee ID', 'Employee Name', 'Plant',
       'Zone', 'Date & Time of the session'].concat(Q),
      ['1', new Date(Date.UTC(2026, 1, 20, 6, 0, 0)), '20000011', 'Nobody Real',
       'KEPZ', 'KEPZ', new Date(Date.UTC(1984, 5, 15, 6, 0, 0)),
       'Excellent', 'Relevant and useful', 'Excellent', 'Very clear',
       'Very helpful', 'Much more confident', 'Just right'],
      ['2', new Date(Date.UTC(2026, 1, 20, 6, 0, 0)), '20000012', 'Nobody Else',
       'KEPZ', 'DEPZ', new Date(Date.UTC(2026, 1, 19, 6, 0, 0)),
       'Good', 'Relevant', 'Good', 'Clear', 'Helpful', 'More confident',
       'Appropriate'],
      // Answered nothing: not a respondent, and must not become a row.
      ['3', new Date(Date.UTC(2026, 1, 20, 6, 0, 0)), '20000013', 'Nobody Third',
       'KEPZ', '', new Date(Date.UTC(2026, 1, 19, 6, 0, 0)),
       '', '', '', '', '', '', '']
    ] }
  ], /Done\./);

  check('the feedback upload finished', /Done\./.test(fbStatus), fbStatus);
  check('two responses were stored, not three',
        /2 feedback responses stored for KPI 2/.test(fbStatus), fbStatus);
  check('and it SAID that a typed date had to be overruled',
        /1 response had its typed session date replaced/.test(fbStatus), fbStatus);
  check('the module was read out of the filename',
        /MM/.test(fbStatus), fbStatus);

  const r1 = (await db.query('SELECT * FROM training WHERE response_id = $1',
                             [FEEDBACK_FILE + '#1']))[0];
  const r2 = (await db.query('SELECT * FROM training WHERE response_id = $1',
                             [FEEDBACK_FILE + '#2']))[0];
  check('THE RESPONSES ARE IN POSTGRESQL', Boolean(r1) && Boolean(r2));
  check('A SESSION EXCEL DATED TO 1984 LANDED IN THE MONTH IT WAS SUBMITTED',
        r1 && r1.month === '2026-02', r1 && r1.month);
  check('and the one whose date was believable kept its own',
        r2 && r2.month === '2026-02', r2 && r2.month);
  check('the answers are stored as the words the attendee chose',
        r1 && r1.q1_overall === 'Excellent' &&
        r1 && r1.q6_confidence === 'Much more confident',
        r1 && r1.q1_overall);
  check('THE MODULE CELL IS BLANK, because the form had no Module column',
        r1 && r1.module === '', r1 && JSON.stringify(r1.module));
  check('the zone the form asked for is stored',
        r1 && r1.zone === 'KEPZ' && r2 && r2.zone === 'DEPZ',
        r1 && r1.zone);
  check('the source file is stored, so the response can find its upload',
        r1 && r1.source_file === FEEDBACK_FILE, r1 && r1.source_file);
  check('the respondent who answered nothing is not in the table',
        (await db.query('SELECT 1 FROM training WHERE response_id = $1',
                        [FEEDBACK_FILE + '#3'])).length === 0);

  const fbRows = await historyRows(p);
  const fbRow = fbRows.filter(function (r) {
    return r.files.indexOf('Trainee Feedback') !== -1;
  })[0];
  check('the feedback upload is in the history', Boolean(fbRow));
  /*
    THE RANGE COLUMN SAYS THE QUARTER, IN WORDS.

    Not "2026 appears somewhere in it" - that passes on the raw date range
    too, which is the very thing this column exists to avoid showing. The
    cell has to read 'Quarter 1 (2026)', the same words KPI 2's own picker
    uses, and must not read like a pair of dates.
  */
  check('THE RANGE COLUMN SAYS THE QUARTER THE FILENAME NAMES, in words',
        fbRow && fbRow.cells[7] === 'Quarter 1 (2026)', fbRow && fbRow.cells[7]);
  check('and not the session dates Excel mangled',
        fbRow && !/1984/.test(fbRow.cells[7]) && !/-\d\d-/.test(fbRow.cells[7]),
        fbRow && fbRow.cells[7]);
  /*
    THE RAW RANGE IS STILL STORED, though, and is on the row. The column is
    a better label, not a replacement for the fact - the delete dialog shows
    the real dates and so does the tooltip.
  */
  check('the real session dates are still recorded against the upload',
        fbRow && /^2026-02-\d\d \u2192 2026-02-\d\d$/.test(fbRow.range),
        fbRow && fbRow.range);
  check('and the Section column holds the module it was placed in',
        fbRow && fbRow.cells[4] === 'MM', fbRow && fbRow.cells[4]);

  /*
    A FEEDBACK FILE THE FILENAME CANNOT PLACE.

    It lands in the '(unassigned)' module, where it is invisible unless the
    upload says so - which is why uploadFeedback collects the names and
    reports them. Every other fixture here has a module in its name, so a
    mutation that stopped reporting them passed.
  */
  const unplaced = await dropAndWait(p, [
    { name: 'TEST-UI nothing in this name.xlsx', sheet: [
      ['ID', 'Completion time', 'Employee ID', 'Zone',
       'Date & Time of the session'].concat(Q),
      ['1', new Date(Date.UTC(2026, 1, 20, 6, 0, 0)), '20000014', 'KEPZ',
       new Date(Date.UTC(2026, 1, 19, 6, 0, 0)),
       'Good', 'Relevant', 'Good', 'Clear', 'Helpful', 'More confident',
       'Appropriate']
    ] }
  ], /Done\./);
  check('A FILE WITH NO MODULE IN ITS NAME IS REPORTED, not quietly filed',
        /1 file could not be placed in a module/.test(unplaced) &&
        /nothing in this name\.xlsx/.test(unplaced), unplaced);
  check('and the upload log says Unrecognised module rather than guessing',
        (await db.query("SELECT departments FROM upload_run" +
                        " WHERE file_names LIKE '%nothing in this name%'"))[0]
          .departments === 'Unrecognised module');
  await db.query("DELETE FROM training WHERE response_id LIKE 'TEST-UI nothing%'");
  await db.query("DELETE FROM upload_run WHERE file_names LIKE '%nothing in this name%'");


  // =======================================================================
  console.log('');
  console.log('  Re-dropping the same feedback file, corrected');
  // =======================================================================
  await dropAndWait(p, [
    { name: FEEDBACK_FILE, sheet: [
      ['ID', 'Completion time', 'Employee ID', 'Employee Name', 'Plant',
       'Zone', 'Date & Time of the session'].concat(Q),
      ['1', new Date(Date.UTC(2026, 1, 20, 6, 0, 0)), '20000011', 'Nobody Real',
       'KEPZ', 'KEPZ', new Date(Date.UTC(2026, 1, 19, 6, 0, 0)),
       'Average', 'Relevant', 'Good', 'Clear', 'Helpful', 'More confident',
       'Appropriate']
    ] }
  ], /Done\./);

  const r1b = (await db.query('SELECT * FROM training WHERE response_id = $1',
                              [FEEDBACK_FILE + '#1']))[0];
  check('THE CORRECTED ANSWER REPLACED THE OLD ONE',
        r1b && r1b.q1_overall === 'Average', r1b && r1b.q1_overall);
  check('and the response was not duplicated',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-UI%'"))[0].n === 2,
        String((await db.query("SELECT count(*)::int AS n FROM training" +
                               " WHERE response_id LIKE 'TEST-UI%'"))[0].n));


  // =======================================================================
  console.log('');
  console.log('  Downloading one upload back out');
  // =======================================================================
  const csv = await p.evaluate(async function (file) {
    const token = sessionStorage.getItem('easToken');
    const history = await fetch('/api/uploads',
      { headers: { Authorization: 'Bearer ' + token } }).then(function (r) { return r.json(); });
    const mine = history.uploads.filter(function (h) {
      return h.fileName.indexOf(file) !== -1;
    })[0];
    if (!mine) return { error: 'no upload found for ' + file };

    const parts = [];
    let start = 1;
    let name = '';
    for (let guard = 0; guard < 50; guard++) {
      const chunk = await fetch('/api/uploads/csv?uploadId=' +
        encodeURIComponent(mine.uploadId) + '&startRow=' + start,
        { headers: { Authorization: 'Bearer ' + token } })
        .then(function (r) { return r.json(); });
      if (chunk.fileName) name = chunk.fileName;
      if (chunk.csv) parts.push(chunk.csv);
      if (chunk.done) break;
      start = chunk.nextRow;
    }
    return { name: name, text: parts.join('\n') };
  }, 'TEST-UI_Overall');

  check('the download assembled without an error', !csv.error, csv.error);
  const lines = String(csv.text || '').split('\n').filter(Boolean);
  check('it is named after the upload',
        /\.csv$/.test(csv.name || ''), csv.name);
  check('the header row appears exactly once',
        lines.filter(function (l) { return /^"?Ticket ID/.test(l); }).length === 1,
        String(lines.length) + ' lines');
  check('every ticket of that upload is in it, once each',
        ['TEST-UI-1', 'TEST-UI-2', 'TEST-UI-3'].every(function (id) {
          return lines.filter(function (l) { return l.indexOf(id) !== -1; }).length === 1;
        }), lines.join(' / ').slice(0, 160));


  // =======================================================================
  console.log('');
  console.log('  Deleting an upload, through the dialog');
  // =======================================================================
  const before = (await db.query(
    "SELECT count(*)::int AS n FROM training WHERE response_id LIKE 'TEST-UI%'"))[0].n;
  check('two responses are there to be deleted', before === 2, String(before));

  // The SECOND feedback upload - the corrected re-drop - names the same file,
  // so deleting it removes the responses. That is the behaviour the old
  // system got wrong: the history row went and the responses stayed.
  /*
    THE UPLOAD IS IDENTIFIED BY ITS ID, NOT BY ITS FILENAME.

    Two uploads name this file - the first drop and the corrected re-drop -
    so "the row whose files mention Trainee Feedback" is two rows, and
    asserting afterwards that no such row is left was asserting something
    false. The id is what the button carries and what the server is sent;
    it is what the check should be about too.
  */
  const clicked = await p.evaluate(function (file) {
    const rows = Array.prototype.slice.call(
      document.querySelectorAll('#uploadTable tbody tr'));
    const row = rows.filter(function (tr) {
      return tr.dataset.files.indexOf(file) !== -1;
    })[0];
    if (!row) return null;
    const button = row.querySelector('[data-delete]');
    if (!button) return null;
    const id = button.dataset.delete;
    button.click();
    return id;
  }, 'Trainee Feedback');
  check('the Delete button on the feedback row was clickable', Boolean(clicked));

  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 10000 });
  const dialog = await p.textContent('#modal');
  check('the dialog names what it is about to remove',
        /training responses/.test(dialog), dialog.slice(0, 200));
  check('and says KPI 2 corrects itself', /KPI 2 is scored live/.test(dialog));
  check('and that it cannot be undone', /cannot be undone/.test(dialog));
  check('Cancel holds the focus, not Delete - Enter must not destroy anything',
        await p.evaluate(function () {
          return document.activeElement &&
                 document.activeElement.id === 'modalCancel';
        }));

  /*
    AND SAYING NO MEANS NO.

    Every run of this suite clicked Confirm, so the Cancel path was never
    taken - a mutation that deleted regardless of the answer passed
    everything. Escape first, because that is the key people actually
    press, and it has to mean the same thing as the button.
  */
  await p.keyboard.press('Escape');
  await closedDialog(p);
  check('ESCAPE CLOSES THE DIALOG AND DELETES NOTHING',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-UI%'"))[0].n === 2,
        String((await db.query("SELECT count(*)::int AS n FROM training" +
                               " WHERE response_id LIKE 'TEST-UI%'"))[0].n));
  check('and the row is still there to try again',
        await p.evaluate(function (id) {
          return document.querySelectorAll('[data-delete="' + id + '"]').length === 1;
        }, clicked));

  await p.evaluate(function (id) {
    document.querySelector('[data-delete="' + id + '"]').click();
  }, clicked);
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 10000 });
  await p.click('#modalCancel');
  await closedDialog(p);
  check('and so does the Cancel button',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-UI%'"))[0].n === 2);

  await p.evaluate(function (id) {
    document.querySelector('[data-delete="' + id + '"]').click();
  }, clicked);
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 10000 });
  await p.click('#modalConfirm');
  const delStatus = await waitForStatus(p, /Deleted /, 60000);
  check('the delete reported what went',
        /2 responses removed/.test(delStatus), delStatus);

  const after = (await db.query(
    "SELECT count(*)::int AS n FROM training WHERE response_id LIKE 'TEST-UI%'"))[0].n;
  check('DELETING THE UPLOAD TOOK ITS RESPONSES WITH IT', after === 0,
        String(after));
  check('and the tickets from the other upload are untouched',
        (await db.query("SELECT count(*)::int AS n FROM ticket" +
                        " WHERE ticket_id LIKE 'TEST-UI-%'"))[0].n === 3);
  /*
    THE ROW IS GONE. Whether it went at once or after the history was
    re-read, this suite cannot say: the page removes it itself and then
    re-reads, and by the time the status box can be read the re-read may
    already have finished. So a mutation that drops the immediate removal
    survives. It is kept because the reason for it is sound - "the answer to
    did that work should not depend on a second round trip that might itself
    be slow" - and because a delete can take minutes. What is asserted here
    is the outcome, which is what matters if the two ever disagree.
  */
  check('the row is gone from the table on screen',
        await p.evaluate(function (id) {
          return document.querySelectorAll('[data-delete="' + id + '"]').length === 0;
        }, clicked));
  check('and gone from the history the server serves, not only from the page',
        (await db.query('SELECT 1 FROM upload_run WHERE upload_id = $1',
                        [clicked])).length === 0);
  // The OTHER feedback upload named the same file and is still there, which
  // is why the check above is about an id.
  check('the earlier upload of the same file is untouched',
        (await db.query("SELECT count(*)::int AS n FROM upload_run" +
                        " WHERE file_names LIKE '%Trainee Feedback%'"))[0].n === 1,
        String((await db.query("SELECT count(*)::int AS n FROM upload_run" +
                               " WHERE file_names LIKE '%Trainee Feedback%'"))[0].n));


  // =======================================================================
  console.log('');
  console.log('  A filename with HTML in it');
  // =======================================================================
  /*
    THE FILENAME IS UNTRUSTED TEXT, and it goes into innerHTML.

    Whoever exports the file names it, and Windows allows & and < in a
    filename. Every cell in this table is built as an HTML string, so an
    unescaped name is script injection with extra steps - and no fixture
    here had a special character in it, so dropping escapeHtml entirely
    changed nothing and passed.
  */
  const NASTY = "TEST-UI <b>bold</b> & 'quoted' KPI-1_ITSM.xlsx";
  await dropAndWait(p, [
    { name: NASTY, sheet: [
      ['Ticket ID', 'Request Date', 'Title', 'Part', 'Status'],
      ['TEST-UI-X1', '2026-09-01 09:00:00', 'a <script>alert(1)</script> title',
       'MM', 'Completed']
    ] }
  ], /Done\./);

  const nastyCell = await p.evaluate(function (name) {
    const row = Array.prototype.slice.call(
      document.querySelectorAll('#uploadTable tbody tr'))
      .filter(function (tr) { return tr.dataset.files === name; })[0];
    if (!row) return null;
    return { text: row.cells[2].textContent,
             // A <b> is legitimate here - summariseFiles uses one. A SECOND
             // one would be the filename's own, rendered as markup.
             bolds: row.cells[2].querySelectorAll('b').length,
             scripts: document.querySelectorAll('#uploadTable script').length };
  }, NASTY);

  check('the upload with an HTML filename is in the table', Boolean(nastyCell));
  check('THE TAGS IN THE FILENAME ARE SHOWN AS TEXT, not rendered',
        nastyCell && nastyCell.text.indexOf('<b>bold</b>') !== -1,
        nastyCell && nastyCell.text);
  check('so no extra element was created from it',
        nastyCell && nastyCell.bolds === 1, nastyCell && String(nastyCell.bolds));
  check('and nothing injected a script tag into the table',
        nastyCell && nastyCell.scripts === 0);

  await db.query("DELETE FROM ticket WHERE ticket_id = 'TEST-UI-X1'");
  await db.query("DELETE FROM upload_run WHERE file_names LIKE '%bold%'");


  // =======================================================================
  console.log('');
  console.log('  Responses left behind by a delete that happened long ago');
  // =======================================================================
  /*
    THE ORPHAN NOTICE HAD NO UI TEST AT ALL, which a mutation found: making
    the purge button appear for viewers changed nothing, because no run ever
    drew the notice.

    An orphan is a training response whose upload is no longer in the
    history - the wreckage of the old delete, which removed the log row and
    the tickets and left the TRAINING tab alone. They cannot be seen in the
    history, and KPI 2 counts them regardless. Written straight into the
    table here, because that is exactly how they got there.
  */
  await db.query(
    `INSERT INTO training (response_id, month, source_file, q1_overall,
                           uploaded_at, zone)
     VALUES ('TEST-UI-orphan.xlsx#1', '2026-03', 'TEST-UI-orphan.xlsx',
             'Good', now(), 'KEPZ')`);

  await p.reload();
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await provideSheetJs(p);

  const notice = await p.evaluate(function () {
    const box = document.getElementById('uploadOrphans');
    return { shown: !box.hidden, text: box.textContent,
             buttons: box.querySelectorAll('[data-purge]').length };
  });
  check('THE ORPHAN IS NOTICED, and the screen says so', notice.shown);
  check('it says how many and that KPI 2 is still counting them',
        /1 training response left over from a deleted upload/.test(notice.text) &&
        /still being counted in KPI 2/.test(notice.text),
        notice.text.slice(0, 140));
  check('and that there is no way to see where it came from',
        /no way to see where it came from/.test(notice.text),
        notice.text.slice(0, 200));
  check('and that this is old wreckage, not something still happening',
        /that is fixed, but what was already orphaned is still here/
          .test(notice.text));
  check('an admin is offered the button that clears them',
        notice.buttons === 1, String(notice.buttons));

  const viewerNotice = await (async function () {
    const v = await context.newPage();
    await v.goto(BASE + '/uploads.html');
    await v.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                     signToken('TEST-UI-viewer', 'USER'));
    await v.goto(PAGE);
    await v.waitForSelector('#page:not([hidden])', { timeout: 20000 });
    const out = await v.evaluate(function () {
      const box = document.getElementById('uploadOrphans');
      return { shown: !box.hidden, text: box.textContent,
               buttons: box.querySelectorAll('[data-purge]').length };
    });
    await v.close();
    return out;
  }());
  /*
    THE WARNING IS WORTH SHOWING EVERYBODY - the figure on their screen is
    wrong too. The BUTTON is not, because removing responses changes KPI 2
    for everyone.
  */
  check('A VIEWER IS WARNED TOO, because the wrong figure is on their screen',
        viewerNotice.shown && /left over from a deleted upload/.test(viewerNotice.text));
  check('but is not given the button',
        viewerNotice.buttons === 0, String(viewerNotice.buttons));
  check('and is told why',
        /clearing these needs the admin login/.test(viewerNotice.text),
        viewerNotice.text.slice(-120));

  // A response that is NOT an orphan, which must survive the purge.
  const liveUpload = await p.evaluate(function () {
    return fetch('/api/uploads/begin', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sessionStorage.getItem('easToken'),
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileNames: ['TEST-UI-kept.xlsx'],
                             reportTypes: ['FEEDBACK'],
                             departments: ['MM'], totalRows: 1 })
    }).then(function (r) { return r.json(); }).then(function (d) { return d.uploadId; });
  });
  await db.query(
    `INSERT INTO training (response_id, month, source_file, q1_overall,
                           uploaded_at, zone)
     VALUES ('TEST-UI-kept.xlsx#1', '2026-03', 'TEST-UI-kept.xlsx',
             'Good', now(), 'KEPZ')`);
  check('an upload was opened for the response that must survive',
        Boolean(liveUpload));

  await p.click('[data-purge]');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 10000 });
  const purgeDialog = await p.textContent('#modal');
  check('the purge dialog promises to touch only the orphans',
        /no longer in the history/.test(purgeDialog) &&
        /is kept, untouched/.test(purgeDialog), purgeDialog.slice(0, 200));

  await p.click('#modalCancel');
  check('CANCELLING THE PURGE REMOVES NOTHING',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-UI-%'"))[0].n === 2,
        String((await db.query("SELECT count(*)::int AS n FROM training" +
                               " WHERE response_id LIKE 'TEST-UI-%'"))[0].n));

  await p.click('[data-purge]');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 10000 });
  await p.click('#modalConfirm');
  const purged = await waitForStatus(p, /Removed /, 60000);
  check('the purge reported what it removed and what it kept',
        /Removed 1 orphaned response/.test(purged) && /1 kept/.test(purged),
        purged);
  check('THE ORPHAN IS GONE',
        (await db.query("SELECT 1 FROM training" +
                        " WHERE response_id = 'TEST-UI-orphan.xlsx#1'")).length === 0);
  check('AND THE ONE WHOSE UPLOAD IS STILL IN THE HISTORY SURVIVED',
        (await db.query("SELECT 1 FROM training" +
                        " WHERE response_id = 'TEST-UI-kept.xlsx#1'")).length === 1);
  check('and the notice is gone from the screen',
        await p.isHidden('#uploadOrphans'));

  await callApi(p, 'POST', '/api/uploads/delete', { uploadId: liveUpload });


  // =======================================================================
  console.log('');
  console.log('  Refusals, and the things that must not happen');
  // =======================================================================
  const notXlsx = await p.evaluate(async function () {
    const input = document.getElementById('fileInput');
    const dt = new DataTransfer();
    dt.items.add(new File(['a,b\n1,2'], 'TEST-UI.csv', { type: 'text/csv' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(function (r) { setTimeout(r, 300); });
    return document.getElementById('uploadStatus').textContent;
  });
  check('a .csv is refused by name, not quietly ignored',
        /No \.xlsx files in that selection/.test(notXlsx), notXlsx);

  const noTicketId = await dropAndRead(p, [
    { name: 'TEST-UI_not an export.xlsx', sheet: [
      ['Something', 'Else'], ['a', 'b']
    ] }
  ], /failed|no "Ticket ID"/i);
  check('a sheet that is not an export is refused, and says which file',
        /TEST-UI_not an export\.xlsx/.test(noTicketId) &&
        /Ticket ID/.test(noTicketId), noTicketId);
  check('and nothing was logged for it',
        (await db.query("SELECT count(*)::int AS n FROM upload_run" +
                        " WHERE file_names LIKE '%not an export%'"))[0].n === 0);

  const thinFeedback = await dropAndRead(p, [
    { name: 'TEST-UI thin feedback.xlsx', sheet: [
      ['ID', 'Completion time'].concat(Q.slice(0, 3)),
      ['1', new Date(Date.UTC(2026, 1, 20)), 'Good', 'Good', 'Good']
    ] }
  ], /failed/i);
  check('a feedback form with only three questions recognised is refused',
        /Ticket ID/.test(thinFeedback) || /questions were recognised/.test(thinFeedback),
        thinFeedback);


  // =======================================================================
  console.log('');
  console.log('  A viewer sees the same screen with the buttons gone');
  // =======================================================================
  const viewer = await context.newPage();
  await viewer.goto(BASE + '/uploads.html');
  await viewer.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                        signToken('TEST-UI-viewer', 'USER'));
  await viewer.goto(PAGE);
  await viewer.waitForSelector('#page:not([hidden])', { timeout: 20000 });

  check('a viewer gets the history table',
        await viewer.isVisible('#uploadTable'));
  check('and is TOLD why there is no dropzone, rather than just not seeing one',
        await viewer.isVisible('#uploadReadOnly'));
  check('the dropzone card is hidden',
        await viewer.isHidden('[data-admin-only]'));
  check('Download is still offered - reading an upload back changes nothing',
        await viewer.evaluate(function () {
          return document.querySelectorAll('[data-download]').length > 0;
        }));
  check('DELETE IS NOT',
        await viewer.evaluate(function () {
          return document.querySelectorAll('[data-delete]').length === 0;
        }));
  /*
    AND THE SERVER REFUSES IT ANYWAY, which is the half that matters. A
    hidden button is tidiness; this is the guard.
  */
  const refused = await viewer.evaluate(function () {
    return fetch('/api/uploads/begin', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + sessionStorage.getItem('easToken'),
                 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileNames: ['TEST-UI-sneaky.xlsx'], totalRows: 1 })
    }).then(function (r) { return r.status; });
  });
  check('a viewer calling the upload endpoint directly is refused with 403',
        refused === 403, String(refused));
  check('and nothing was logged',
        (await db.query("SELECT count(*)::int AS n FROM upload_run" +
                        " WHERE file_names LIKE '%sneaky%'"))[0].n === 0);


  // =======================================================================
  console.log('');
  console.log('  When the screen cannot be opened at all');
  // =======================================================================
  /*
    A BAD TOKEN AND A BROKEN SERVER LOOK NOTHING ALIKE, and the page has to
    say which. A blank sign-in card in front of somebody whose password is
    perfectly good is how an outage turns into "my account stopped working".
  */
  const expired = await context.newPage();
  await expired.goto(BASE + '/uploads.html');
  await expired.evaluate(function () {
    sessionStorage.setItem('easToken', 'not.a.real.token');
  });
  await expired.goto(PAGE);
  await expired.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  check('AN EXPIRED TOKEN SENDS YOU BACK TO THE SIGN-IN CARD',
        await expired.isVisible('#signinCard') && await expired.isHidden('#page'));
  check('and says the session ended, rather than saying nothing',
        /session has ended/i.test(await expired.textContent('#signinWhy')),
        await expired.textContent('#signinWhy'));

  // Now a server that answers, but not with the screen.
  await expired.route('**/api/uploads/boot', function (route) {
    route.fulfill({ status: 500, contentType: 'application/json',
                    body: JSON.stringify({ ok: false,
                                           error: 'could not open the uploads screen' }) });
  });
  await expired.evaluate(function (t) { sessionStorage.setItem('easToken', t); }, token);
  await expired.goto(PAGE);
  await expired.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  const whyDown = await expired.textContent('#signinWhy');
  check('A SERVER THAT CANNOT ANSWER SAYS SO, rather than asking for the password again',
        /Could not open the screen/.test(whyDown) &&
        /could not open the uploads screen/.test(whyDown), whyDown);
  check('and it is not mistaken for an expired session',
        !/session has ended/i.test(whyDown), whyDown);
  await expired.close();


  // =======================================================================
  console.log('');
  console.log('  Which dashboard a row points at');
  // =======================================================================
  /*
    The computation behind Open Dashboard, which the screens it opens do not
    exist for yet. Tested now because it is the part that was wrong twice:
    it sent every mixed drop to KPI 2, and it opened a January-to-September
    export on January.
  */
  const where = await p.evaluate(function () {
    const f = window.__uploadsScreen.dashboardFor;
    const row = function (types, range, files) {
      return { dataset: { types: types, range: range, files: files || '' } };
    };
    return {
      oneMonth: f(row('OVERALL', '2026-07-01 \u2192 2026-07-31')),
      manyMonths: f(row('OVERALL', '2026-01-01 \u2192 2026-09-30')),
      mixed: f(row('FEEDBACK|OVERALL|INDIVIDUAL', '2026-07-01 \u2192 2026-07-31')),
      mostlyFeedback: f(row('FEEDBACK|FEEDBACK|OVERALL',
                            '1984-06-15 \u2192 2026-07-04', 'Q1-2026 x.xlsx')),
      noRange: f(row('OVERALL', ' \u2192 ')),
      nothing: f(null)
    };
  });
  check('a one-month ticket upload opens KPI 1 on that month',
        where.oneMonth.view === 'kpi1' && where.oneMonth.period === 'July 2026',
        JSON.stringify(where.oneMonth));
  check('AN UPLOAD SPANNING NINE MONTHS OPENS ON ALL MONTHS, not on January',
        where.manyMonths.period === 'All months',
        JSON.stringify(where.manyMonths));
  check('a mixed drop goes where MOST of it belongs, and ties go to tickets',
        where.mixed.view === 'kpi1', JSON.stringify(where.mixed));
  check('MOSTLY-FEEDBACK GOES TO KPI 2, ON THE QUARTER THE FILENAME NAMES',
        where.mostlyFeedback.view === 'kpi2' &&
        /2026/.test(where.mostlyFeedback.period) &&
        !/1984/.test(where.mostlyFeedback.period),
        JSON.stringify(where.mostlyFeedback));
  check('an upload with no dates at all opens on all months',
        where.noRange.period === 'All months', JSON.stringify(where.noRange));
  check('and no row at all does not throw',
        where.nothing.view === 'kpi1', JSON.stringify(where.nothing));

  const quarters = await p.evaluate(function () {
    const q = window.__uploadsScreen.quartersInText;
    return { ahead: q('Q1-2026 Feedback.xlsx'), behind: q('2026-Q1 Feedback.xlsx'),
             twoDigit: q('Q1-26.xlsx'), faq: q('FAQ1-2026.xlsx'),
             two: q('Q1-2026 and Q2-2026.xlsx'), none: q('nothing here.xlsx'),
             silly: q('Q1-1899.xlsx') };
  });
  check('a quarter is found whichever side of the year it sits',
        JSON.stringify(quarters.ahead) === '["2026-Q1"]' &&
        JSON.stringify(quarters.behind) === '["2026-Q1"]',
        JSON.stringify(quarters));
  check('a two-digit year becomes 20xx',
        JSON.stringify(quarters.twoDigit) === '["2026-Q1"]');
  check('FAQ1-2026 IS NOT A QUARTER',
        JSON.stringify(quarters.faq) === '[]', JSON.stringify(quarters.faq));
  check('two quarters in one name are both found, in order',
        JSON.stringify(quarters.two) === '["2026-Q1","2026-Q2"]',
        JSON.stringify(quarters.two));
  check('an implausible year is refused rather than guessed',
        JSON.stringify(quarters.silly) === '[]');


  // =======================================================================
  console.log('');
  console.log('  Nothing on fire in the console');
  // =======================================================================
  /*
    A screen that works and logs an exception on every render is a screen
    that is about to stop working. The CDN is allowed to be noisy; the page
    is not.
  */
  check('the page threw nothing', thrown.length === 0, thrown.slice(0, 3).join(' | '));

  /*
    AND IT ASKED FOR NOTHING IT DOES NOT GET.

    cdnjs is the one allowed exception, and only because this sandbox has no
    route to it - on a machine with internet that request succeeds. The 403s
    are the viewer deliberately being refused. Anything else here is a file
    the page expects and the server does not serve, which is how a screen
    quietly loses a stylesheet.
  */
  const unexpected = badRequests.filter(function (r) {
    return !/cdnjs\.cloudflare\.com/.test(r) && !/^403 /.test(r);
  });
  check('every file the page asked for was served', unexpected.length === 0,
        unexpected.slice(0, 4).join(' | '));

  await viewer.close();
  await p.close();
  await context.close();
  await b.close();

  await sweep();
  check('no test tickets are left behind',
        (await db.query("SELECT count(*)::int AS n FROM ticket" +
                        " WHERE ticket_id LIKE 'TEST-UI-%'"))[0].n === 0);
  check('no test responses are left behind',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-UI%'"))[0].n === 0);
  check('no test uploads are left behind',
        (await db.query("SELECT count(*)::int AS n FROM upload_run" +
                        " WHERE uploaded_by LIKE 'TEST-UI%'"))[0].n === 0);

  console.log('');
  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  console.log('');
  process.exit(failed ? 1 : 0);
}


// ---------------------------------------------------------------------------
// SheetJS, or something that behaves like it where it cannot be fetched
// ---------------------------------------------------------------------------
/**
 * Makes sure the page has an XLSX to read with, and records how it is called.
 *
 * ON HIS MACHINE this does almost nothing: the CDN answers, the real library
 * is there, and all that is added is a wrapper that remembers the options it
 * was read with. In a sandbox with no route to cdnjs, a stand-in takes its
 * place.
 *
 * THE STAND-IN IS NOT A SHORTCUT, and it is worth being precise about what it
 * does and does not cover.
 *
 * It does NOT test that SheetJS can unzip an .xlsx. That is SheetJS's job,
 * it is pinned to one version, and no test here would improve it.
 *
 * It DOES test the one thing about reading a workbook that is ours: that
 * `cellDates: true` is asked for. The stand-in behaves exactly as the real
 * library does about that option - a date cell comes back as a Date when it
 * is set, and as the Excel serial number when it is not. So the comment in
 * uploads.html about 46162 is not a story about something that used to
 * happen; drop the option and this suite fails, in either mode.
 *
 * Everything downstream - FileReader, gridToFile, the parse, the batching,
 * the endpoints, PostgreSQL, the history table - is the real thing either
 * way.
 */
async function provideSheetJs(p) {
  const real = await p.evaluate(function () { return typeof XLSX !== 'undefined'; });

  await p.evaluate(function (haveReal) {
    /** Days since 1899-12-30, which is what an Excel date cell really holds. */
    function serial(d) {
      return Math.round((d.getTime() / 86400000) + 25569);
    }

    if (!haveReal) {
      window.XLSX = {
        read: function (bytes, opts) {
          const text = new TextDecoder().decode(bytes);
          const grid = JSON.parse(text).map(function (row) {
            return row.map(function (cell) {
              if (!cell || typeof cell !== 'object' || !cell.__date) return cell;
              // THE WHOLE POINT OF THE STAND-IN.
              return (opts && opts.cellDates)
                ? new Date(cell.__date)
                : serial(new Date(cell.__date));
            });
          });
          return { SheetNames: ['Sheet1'], Sheets: { Sheet1: { __grid: grid } } };
        },
        write: function (book) {
          const grid = book.Sheets[book.SheetNames[0]].__grid;
          const text = JSON.stringify(grid, function (key, value) {
            // Date has its own toJSON, so `value` is already a string here -
            // the raw object is still on `this`.
            return this[key] instanceof Date
              ? { __date: this[key].toISOString() } : value;
          });
          return new TextEncoder().encode(text);
        },
        utils: {
          aoa_to_sheet: function (grid) { return { __grid: grid }; },
          book_new: function () { return { SheetNames: [], Sheets: {} }; },
          book_append_sheet: function (book, sheet, name) {
            book.SheetNames.push(name);
            book.Sheets[name] = sheet;
          },
          sheet_to_json: function (sheet, o) {
            let grid = sheet.__grid.map(function (r) { return r.slice(); });
            if (o && o.defval !== undefined) {
              grid = grid.map(function (r) {
                return r.map(function (c) {
                  return (c === null || c === undefined) ? o.defval : c;
                });
              });
            }
            if (o && o.blankrows === false) {
              grid = grid.filter(function (r) {
                return r.some(function (c) {
                  return String(c === null || c === undefined ? '' : c).trim() !== '';
                });
              });
            }
            return grid;
          }
        }
      };
    }

    // Remember how the page asks for a workbook, in both modes.
    const inner = window.XLSX.read;
    window.__readOptions = [];
    window.XLSX.read = function (bytes, opts) {
      window.__readOptions.push(opts || {});
      return inner.call(window.XLSX, bytes, opts);
    };
  }, real);

  return { real: real };
}


// ---------------------------------------------------------------------------
// driving the dropzone
// ---------------------------------------------------------------------------
/**
 * Builds real .xlsx files in the page and drops them on the dropzone.
 *
 * WRITTEN BY SHEETJS, READ BY SHEETJS. The page's own copy of the library
 * writes the workbook, so what lands on the dropzone is a real zip with real
 * sheet XML in it, not a shortcut. Date objects survive the round trip as
 * date cells, which is the whole point: that is what Microsoft Forms writes
 * and what `cellDates: true` exists for.
 *
 * The drop goes through the file input rather than a synthetic DragEvent.
 * Chromium will not let a page construct a drop with real files in it, and
 * the input is the same code path - handleFiles() is reached either way.
 */
async function dropFiles(p, files) {
  await p.evaluate(function (specs) {
    const dt = new DataTransfer();
    specs.forEach(function (spec) {
      // Dates arrive from Node as ISO strings. Put them back.
      const grid = spec.sheet.map(function (row) {
        return row.map(function (cell) {
          return (typeof cell === 'string' &&
                  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(cell))
            ? new Date(cell) : cell;
        });
      });
      const sheet = XLSX.utils.aoa_to_sheet(grid, { cellDates: true });
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
      const bytes = XLSX.write(book, { type: 'array', bookType: 'xlsx' });
      dt.items.add(new File([bytes], spec.name,
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    });

    const input = document.getElementById('fileInput');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, files);
}


/**
 * Clears the status box, drops the files, and waits for the screen to settle.
 *
 * BOTH HALVES OF THE WAIT ARE NECESSARY.
 *
 * Clearing first, because the box still holds the last upload's "Done." and
 * waiting for /Done./ would match it instantly - the suite then read the
 * database before the new drop had been processed at all, and passed or
 * failed on timing. It passed the first time and failed the second.
 *
 * Waiting for busy to go false second, because the page writes "Done." and
 * THEN re-reads the history table. Waiting only for the words means looking
 * at the table one round trip too early.
 */
async function dropAndWait(p, files, want, ms) {
  const limit = ms || 60000;
  await p.evaluate(function () {
    const box = document.getElementById('uploadStatus');
    if (box) { box.textContent = ''; box.hidden = true; }
  });
  await dropFiles(p, files);
  const said = await waitForStatus(p, want, limit);
  await p.waitForFunction(function () {
    return window.__uploadsScreen && window.__uploadsScreen.busy() === false;
  }, null, { timeout: limit });
  return said;
}


/** The same, for a drop that is expected to be refused. */
async function dropAndRead(p, files, want) {
  try { return await dropAndWait(p, files, want); }
  catch (e) { return (await p.textContent('#uploadStatus')) || ''; }
}


/** Waits for the status box to say something matching. */
async function waitForStatus(p, pattern, ms) {
  const source = pattern.source;
  const flags = pattern.flags;
  await p.waitForFunction(function (arg) {
    const box = document.getElementById('uploadStatus');
    if (!box || box.hidden) return false;
    return new RegExp(arg.source, arg.flags).test(box.textContent);
  }, { source: source, flags: flags }, { timeout: ms });
  return (await p.textContent('#uploadStatus')).trim();
}


/**
 * Waits for the dialog to be shut.
 *
 * NOT waitForSelector('#modalBackdrop[hidden]'), which waits for an element
 * to be VISIBLE by default - and an element with the hidden attribute never
 * is, so that wait can only ever time out. It looked like Escape had failed
 * to close the dialog; Escape had closed it.
 */
async function closedDialog(p) {
  await p.waitForFunction(function () {
    const box = document.getElementById('modalBackdrop');
    return Boolean(box && box.hidden);
  }, null, { timeout: 10000 });
}


/** One API call made from inside the page, with the page's own token. */
async function callApi(p, method, path, body) {
  return p.evaluate(function (arg) {
    const opts = { method: arg.method,
                   headers: { Authorization: 'Bearer ' +
                              sessionStorage.getItem('easToken') } };
    if (arg.body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(arg.body);
    }
    return fetch(arg.path, opts).then(function (r) { return r.json(); });
  }, { method: method, path: path, body: body });
}


async function historyRows(p) {
  return p.evaluate(function () {
    return Array.prototype.slice.call(
      document.querySelectorAll('#uploadTable tbody tr')).map(function (tr) {
        return { files: tr.dataset.files, range: tr.dataset.range,
                 types: tr.dataset.types, rows: tr.dataset.rows,
                 cells: Array.prototype.slice.call(tr.cells).map(function (td) {
                   return td.textContent.trim();
                 }) };
      });
  });
}


main().catch(function (err) {
  console.error('');
  console.error('  The suite itself broke: ' + (err && err.stack || err));
  console.error('');
  process.exit(1);
});
