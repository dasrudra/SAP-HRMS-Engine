/**
 * import-tickets-test.js - the merge rules that make two exports one row.
 * ===========================================================================
 *
 *     cd api
 *     node import-tickets-test.js
 *
 * NEEDS THE DATABASE, NOT THE SERVER. It writes its own CSV into a
 * temporary directory, runs import-tickets.js against it, and reads the
 * table back.
 *
 * WHY THIS IS WORTH A TEST OF ITS OWN
 *
 * The merge is where two partial views of the same ticket become one, and
 * every one of its rules exists because getting it wrong lost a figure:
 *
 *   - a blank incoming value must never overwrite a real one, or a partial
 *     export erases what a fuller one supplied
 *   - a Completion Date of ' ' is NOT a completion date. Ingest.gs: "one
 *     ticket silently becomes incomplete. With a KPI whose whole margin is
 *     one ticket, that is not a rounding detail"
 *   - the two report flags are OR'd, because which reports a ticket
 *     appeared in decides whether EAS is scored on it
 *   - Source Files accumulates, so the audit trail shows every file
 *   - a row with no Last Updated must not win on recency it has not claimed
 *
 * EVERY TICKET ID IT WRITES STARTS 'TEST-IMP-'. It deletes those at the
 * start as well as the end, so a run that dies halfway does not poison the
 * next one, and it never touches a real ticket.
 */

require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('./db');

const HEADERS = [
  'Ticket ID', 'Affiliate', 'Service', 'Part', 'Process', 'Category',
  'Sub Category', 'Title', 'Details', 'Request Date', 'Requestor',
  'Current Activity', 'Current Activity Date', 'Current Activity In Charge',
  'Due date', 'Completion Date', 'Lead-time', 'Delay Days', 'Status',
  'CTS Number', 'Remarks', 'Acceptance M/H (Level1)',
  'Processing M/H (Level1)', 'Man*Hour', 'Department', 'In Overall Report',
  'In Dept Report', 'Source Files', 'Last Updated'
];

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** One CSV from a list of {header: value} objects. */
function makeCsv(records) {
  const lines = [HEADERS.map(csvCell).join(',')];
  records.forEach(function (rec) {
    lines.push(HEADERS.map(function (h) { return csvCell(rec[h]); }).join(','));
  });
  return lines.join('\n') + '\n';
}


async function main() {
  /*
    THE REAL import-tickets.js, RUN IN PLACE, pointed at a CSV in a
    temporary folder. So the real data\TICKETS.csv is never read, never
    written and never at risk from a test run - and what is tested is the
    file that ships rather than a copy that can drift from it.

    The first version copied the script into a temporary tree and
    symlinked node_modules beside it so the requires would resolve. That
    fails on Windows with

        EPERM: operation not permitted, symlink ...

    because creating a symlink there needs administrator rights or
    Developer Mode. Giving the importer an optional path argument removed
    the need for any of it.
  */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvl-import-'));
  const csvPath = path.join(tmp, 'TICKETS.csv');
  const script = path.join(__dirname, 'import-tickets.js');

  function runImport(records) {
    fs.writeFileSync(csvPath, makeCsv(records));
    return execFileSync(process.execPath, [script, csvPath],
                        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async function wipe() {
    await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-IMP-%'");
    // A blank id is not a real ticket and only this test can produce one -
    // swept so a failing run cannot leave a phantom row behind.
    await db.query("DELETE FROM ticket WHERE btrim(ticket_id) = ''");
  }
  async function one(id) {
    const rows = await db.query('SELECT * FROM ticket WHERE ticket_id = $1', [id]);
    return rows[0];
  }

  await wipe();
  console.log('');

  // =======================================================================
  console.log('  A first export');
  // =======================================================================
  let out = runImport([
    { 'Ticket ID': 'TEST-IMP-1', 'Affiliate': 'KSL', 'Service': 'SAP',
      'Part': 'MM', 'Request Date': '2026-08-03 09:15',
      'Current Activity In Charge': 'A Person',
      'Completion Date': '2026-08-05 17:00', 'Delay Days': '0',
      'Department': 'Functional', 'In Overall Report': 'TRUE',
      'In Dept Report': 'FALSE', 'Source Files': 'overall.xlsx',
      'Last Updated': '2026-09-01 10:00' },
    { 'Ticket ID': 'TEST-IMP-2', 'Affiliate': 'YAL',
      'Request Date': '2026-08-10 11:00',
      'Current Activity In Charge': 'B Person',
      'Completion Date': '   ', 'Delay Days': '',
      'In Overall Report': 'TRUE', 'In Dept Report': 'FALSE',
      'Source Files': 'overall.xlsx', 'Last Updated': '2026-09-01 10:00' }
  ]);
  check('it says what it added', /2 added, 0 merged/.test(out),
        out.split('\n').filter(Boolean).slice(-3).join(' | '));

  let t1 = await one('TEST-IMP-1');
  check('the fields land in the right columns',
        t1.affiliate === 'KSL' && t1.service === 'SAP' && t1.part === 'MM' &&
        t1.in_charge === 'A Person' && t1.department === 'Functional',
        JSON.stringify({ a: t1.affiliate, s: t1.service, p: t1.part }));
  check('a real completion date is kept',
        t1.completion_date !== null);
  check('TRUE and FALSE become booleans',
        t1.in_overall === true && t1.in_dept === false);
  check('delay 0 is zero, not null', Number(t1.delay_days) === 0);

  /*
    THE WHITESPACE COMPLETION DATE. In the spreadsheet this is a cell
    holding one space, which reads as "completed" to anything testing for
    '' and makes a ticket vanish from the open count. Here it has to be
    NULL, which is the same answer isCompleted reaches, one step earlier.
  */
  const t2 = await one('TEST-IMP-2');
  check('A COMPLETION DATE OF ONE SPACE IS NOT A COMPLETION DATE',
        t2.completion_date === null,
        'the ticket would silently count as completed');
  /*
    AND IT IS NOT REPORTED AS A BROKEN CELL EITHER, which is a second claim
    and needs its own check. Drop the trim from isBlank and the space is no
    longer "blank", so it reaches new Date('   '), fails, and still ends up
    null - by the error path. The stored value is identical; the difference
    is a "cannot read the date" line against every whitespace cell in the
    export, and those are common. A warning printed for normal data is a
    warning people learn to scroll past.
  */
  check('and is not reported as an unreadable cell',
        !/cannot read the date/.test(out),
        out.split('\n').filter(function (l) {
          return /cannot read/.test(l); }).join(' | '));
  check('and an empty Delay Days is null, not zero',
        t2.delay_days === null, String(t2.delay_days));

  // =======================================================================
  console.log('');
  console.log('  A second, overlapping export');
  // =======================================================================
  /*
    The department file for the same month. It carries the completion date
    the overall report was missing, says nothing about Service, and arrives
    stamped later.
  */
  out = runImport([
    { 'Ticket ID': 'TEST-IMP-1', 'Affiliate': 'KSL', 'Service': '',
      'Part': 'MM', 'Request Date': '2026-08-03 09:15',
      'Current Activity In Charge': 'A Person',
      'Completion Date': '2026-08-04 12:00', 'Delay Days': '2',
      'Department': 'Functional', 'In Overall Report': 'FALSE',
      'In Dept Report': 'TRUE', 'Source Files': 'functional.xlsx',
      'Last Updated': '2026-09-02 10:00' },
    { 'Ticket ID': 'TEST-IMP-2', 'Affiliate': 'YAL',
      'Request Date': '2026-08-10 11:00',
      'Current Activity In Charge': 'B Person',
      'Completion Date': '2026-08-12 09:00', 'Delay Days': '0',
      'In Overall Report': 'FALSE', 'In Dept Report': 'TRUE',
      'Source Files': 'functional.xlsx', 'Last Updated': '2026-09-02 10:00' }
  ]);
  check('nothing is added the second time', /0 added, 2 merged/.test(out),
        out.split('\n').filter(Boolean).slice(-3).join(' | '));

  t1 = await one('TEST-IMP-1');
  check('A BLANK VALUE DOES NOT ERASE A REAL ONE',
        t1.service === 'SAP',
        'got ' + JSON.stringify(t1.service) +
        ' - a partial export wiped what a fuller one supplied');
  check('but a newer non-blank value does replace',
        Number(t1.delay_days) === 2, String(t1.delay_days));
  check('THE TWO REPORT FLAGS ARE OR\'d, NOT OVERWRITTEN',
        t1.in_overall === true && t1.in_dept === true,
        'overall=' + t1.in_overall + ' dept=' + t1.in_dept +
        ' - which reports a ticket is in decides whether EAS is scored on it');
  check('SOURCE FILES ACCUMULATES, in the order first seen',
        t1.source_files === 'overall.xlsx | functional.xlsx',
        JSON.stringify(t1.source_files));

  const t2b = await one('TEST-IMP-2');
  check('the open ticket now has its completion date',
        t2b.completion_date !== null);

  // Running the same file again must change nothing at all.
  const before = await db.query(
    "SELECT * FROM ticket WHERE ticket_id LIKE 'TEST-IMP-%' ORDER BY ticket_id");
  runImport([
    { 'Ticket ID': 'TEST-IMP-1', 'Affiliate': 'KSL', 'Service': '',
      'Part': 'MM', 'Request Date': '2026-08-03 09:15',
      'Current Activity In Charge': 'A Person',
      'Completion Date': '2026-08-04 12:00', 'Delay Days': '2',
      'Department': 'Functional', 'In Overall Report': 'FALSE',
      'In Dept Report': 'TRUE', 'Source Files': 'functional.xlsx',
      'Last Updated': '2026-09-02 10:00' }
  ]);
  const after = await one('TEST-IMP-1');
  check('importing the same file twice changes nothing',
        JSON.stringify(after) === JSON.stringify(before.find(function (r) {
          return r.ticket_id === 'TEST-IMP-1';
        })),
        'source files: ' + after.source_files);
  check('and does not duplicate the source file name',
        after.source_files === 'overall.xlsx | functional.xlsx',
        after.source_files);

  // =======================================================================
  console.log('');
  console.log('  An older export arriving late');
  // =======================================================================
  /*
    Re-exporting last month's file after this month's should not undo this
    month's corrections. The stamp decides, not the arrival order.
  */
  runImport([
    { 'Ticket ID': 'TEST-IMP-1', 'Affiliate': 'WRONG', 'Service': 'WRONG',
      'Part': 'WRONG', 'Request Date': '2026-08-03 09:15',
      'Current Activity In Charge': 'A Person',
      'Completion Date': '2026-08-04 12:00', 'Delay Days': '99',
      'Department': 'Functional', 'In Overall Report': 'TRUE',
      'In Dept Report': 'FALSE', 'Source Files': 'stale.xlsx',
      'Last Updated': '2026-01-01 10:00' }
  ]);
  t1 = await one('TEST-IMP-1');
  check('AN OLDER ROW DOES NOT OVERWRITE A NEWER ONE',
        t1.affiliate === 'KSL' && Number(t1.delay_days) === 2,
        'affiliate=' + t1.affiliate + ' delay=' + t1.delay_days);
  check('though its flags still count - it WAS in that report',
        t1.in_overall === true && t1.in_dept === true);
  check('and its filename still joins the audit trail',
        t1.source_files === 'overall.xlsx | functional.xlsx | stale.xlsx',
        t1.source_files);

  /*
    A row with no Last Updated must not be able to claim it is newer than
    anything. Ingest.gs stampOf: an unreadable stamp "sorts it oldest - the
    safe answer, since it cannot then overwrite anything on a recency claim
    it has not made".
  */
  runImport([
    { 'Ticket ID': 'TEST-IMP-1', 'Affiliate': 'ALSO WRONG',
      'Request Date': '2026-08-03 09:15', 'Delay Days': '77',
      'Source Files': 'nostamp.xlsx', 'Last Updated': '' }
  ]);
  t1 = await one('TEST-IMP-1');
  check('A ROW WITH NO Last Updated COUNTS AS OLDEST',
        t1.affiliate === 'KSL' && Number(t1.delay_days) === 2,
        'affiliate=' + t1.affiliate + ' delay=' + t1.delay_days);

  // =======================================================================
  console.log('');
  console.log('  Filling a gap');
  // =======================================================================
  // An older row may still fill a column that is empty - "blank OR newer".
  runImport([
    { 'Ticket ID': 'TEST-IMP-2', 'Affiliate': 'YAL', 'Remarks': 'Called back',
      'Request Date': '2026-08-10 11:00', 'Last Updated': '2026-01-01 10:00' }
  ]);
  const t2c = await one('TEST-IMP-2');
  check('an OLDER row still fills a column that was empty',
        t2c.remarks === 'Called back', JSON.stringify(t2c.remarks));
  check('without disturbing the newer values beside it',
        t2c.completion_date !== null);

  // =======================================================================
  console.log('');
  console.log('  Bad input');
  // =======================================================================
  out = runImport([
    { 'Ticket ID': '   ', 'Affiliate': 'NOBODY' },
    { 'Ticket ID': 'TEST-IMP-3', 'Request Date': 'not a date',
      'Delay Days': 'abc', 'Last Updated': '2026-09-03 10:00' }
  ]);
  check('a row with no Ticket ID is skipped and counted',
        /1 with no Ticket ID/.test(out), out.split('\n')[2]);
  /*
    SAYING IT WAS SKIPPED AND ACTUALLY SKIPPING IT ARE TWO CLAIMS. Remove
    the `continue` and the count still prints, while the row goes in under
    a primary key of '' - which a text column accepts quite happily. Then
    every future ID-less row merges into that same phantom ticket.
  */
  const blank = await db.query("SELECT count(*)::int AS n FROM ticket WHERE btrim(ticket_id) = ''");
  check('and really is not in the table under a blank id',
        blank[0].n === 0, blank[0].n + ' row(s) with no ticket id');
  check('an unreadable date is reported, not silently emptied',
        /cannot read the date/.test(out) && /cannot read the number/.test(out),
        out.split('\n').filter(function (l) {
          return /cannot read/.test(l); }).join(' | '));
  const t3 = await one('TEST-IMP-3');
  check('and the row still loads, with those cells empty',
        Boolean(t3) && t3.request_date === null && t3.delay_days === null);

  /*
    A NUL BYTE IN A FREE-TEXT CELL. Real ITSM exports contain these - the
    first import of the live file stopped on

        invalid byte sequence for encoding "UTF8": 0x00

    after 25,808 rows. U+0000 is valid UTF-8 and valid in a JavaScript
    string, so it travels the whole way from the export into a parameter
    before PostgreSQL refuses it: a text value cannot hold one, at all.
    A spreadsheet never complains, which is why they went unnoticed.
  */
  out = runImport([
    { 'Ticket ID': 'TEST-IMP-4',
      'Title': 'Printer\u0000 jammed', 'Remarks': 'two\u0000 of them\u0000',
      'Request Date': '2026-08-20 09:00', 'Last Updated': '2026-09-04 10:00' }
  ]);
  const t4 = await one('TEST-IMP-4');
  check('A NUL BYTE DOES NOT STOP THE IMPORT',
        Boolean(t4), 'PostgreSQL cannot store one, so it has to go');
  check('and the rest of the text survives it',
        t4 && t4.title === 'Printer jammed' && t4.remarks === 'two of them',
        JSON.stringify(t4 && { t: t4.title, r: t4.remarks }));
  check('and the removal is reported, not silent',
        /2 cell\(s\) contained a NUL byte/.test(out),
        out.split('\n').filter(function (l) {
          return /NUL/.test(l); }).join(' | '));

  // A NUL in the id itself still has to leave a usable key.
  runImport([
    { 'Ticket ID': 'TEST-IMP-\u00005', 'Request Date': '2026-08-21 09:00',
      'Last Updated': '2026-09-04 10:00' }
  ]);
  check('a NUL in the Ticket ID is stripped too',
        Boolean(await one('TEST-IMP-5')));

  // A missing column is fatal, because loading by name cannot guess.
  fs.writeFileSync(csvPath, 'Ticket ID,Affiliate\nTEST-IMP-9,KSL\n');
  let died = '';
  try {
    execFileSync(process.execPath, [script, csvPath],
                 { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { died = String(e.stderr || ''); }
  check('a CSV missing columns is refused, and says which',
        /missing 27 column\(s\)/.test(died), died.split('\n')[0]);
  check('and nothing from it was loaded',
        (await one('TEST-IMP-9')) === undefined);

  // =======================================================================
  await wipe();
  fs.rmSync(tmp, { recursive: true, force: true });
  await db.pool.end();

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});
