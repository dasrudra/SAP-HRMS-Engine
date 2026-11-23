/**
 * uploads-test.js - the Uploads screen's server side.
 * ===========================================================================
 *
 *     cd api
 *     node uploads-test.js
 *
 * NEEDS THE DATABASE, NOT THE SERVER.
 *
 *
 * WHAT IS WORTH TESTING HERE, AND WHY
 *
 * Two things, and they are not the same thing.
 *
 * The first is the merge, and it is tested here as well as in
 * import-tickets-test.js on purpose. Both files reach `ticket` through
 * ticket-merge.js now, and the whole point of that module is that the same
 * export produces the same rows whichever way it arrives. A test of the
 * merge that only ever runs down one of the two paths would not notice the
 * day the other one stopped using it.
 *
 * The second is the delete, which is the only destructive thing on the
 * screen. "Only rows whose ENTIRE source list belongs to this upload are
 * deleted" is one condition with two ways to be wrong, and both of them are
 * silent: too greedy and it removes tickets another upload also vouched for,
 * too timid and a bad upload cannot be undone.
 *
 *
 * EVERY TICKET IT WRITES STARTS 'TEST-UPL-' and every upload it opens names
 * files starting 'TEST-UPL-'. Both are swept at the start of a run as well
 * as at the end, so a run that dies halfway does not poison the next one,
 * and nothing it does can touch a real ticket or a real upload.
 *
 * The two uploads it opens are dated in 2099 - the reserved year the KPI
 * fixtures use - so that a test row can never be the newest real upload on
 * the history screen.
 */

require('dotenv').config();

const db = require('./db');
const merge = require('./ticket-merge');
const uploads = require('./uploads');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

/**
 * Threw, AND said the right thing.
 *
 * "it threw" is a weaker claim than it looks. Mutation testing showed why:
 * deleting the guard that refuses an unopened upload still threw - a
 * TypeError one line later, reading a property of undefined - and a test
 * that only asked "did it throw" passed. The message is also load-bearing
 * rather than cosmetic: server.js decides between 400 and 500 by matching
 * on it, so a changed message quietly turns a caller's mistake into a
 * server error.
 */
async function threwSaying(fn, pattern) {
  try { await fn(); return false; } catch (e) { return pattern.test(e.message); }
}

/** A 29-cell row from an object keyed by spreadsheet heading. */
function cells(o) {
  return merge.HEADERS.map(function (h) {
    return o[h] === undefined ? '' : o[h];
  });
}

const A = 'TEST-UPL-a.xlsx';
const B = 'TEST-UPL-b.xlsx';


async function main() {
  console.log('');

  // =======================================================================
  console.log('  Names and lists');
  // =======================================================================
  /*
    Dhaka is UTC+6. An upload opened at 02:30 local is 20:30 the previous
    day in UTC, and an ID stamped from UTC would carry yesterday's date -
    which is the date the history screen shows and the date somebody looks
    for when asked "when did that go in".
  */
  check('the ID is stamped in Dhaka, not UTC',
        uploads.stamp(new Date('2026-11-21T20:30:00Z')) === '20261122-023000',
        uploads.stamp(new Date('2026-11-21T20:30:00Z')));
  check('midnight is 000000, not 240000',
        uploads.stamp(new Date('2026-11-21T18:00:00Z')) === '20261122-000000');

  const id1 = uploads.newUploadId();
  check('an upload ID has the shape the sheet used, with a longer suffix',
        /^UPL-\d{8}-\d{6}-[0-9a-f]{8}$/.test(id1), id1);
  /*
    "Seconds are not unique enough. Two uploads started in the same second
     used to share an ID, and deleting one then found two matching log rows
     and removed a single one."

    THIS CHECK FAILED ON ITS FIRST RUN, at 199 of 200, which is why the
    suffix is eight characters and not the original's four. 65,536 values
    collide about a quarter of the time over 200 draws; four billion put
    that at roughly one run in two hundred thousand, so this is bounded
    rather than hoped for.
  */
  const many = [];
  for (let i = 0; i < 200; i++) many.push(uploads.newUploadId());
  check('200 IDs made in the same second are all different',
        new Set(many).size === 200, String(new Set(many).size));

  check('a list joins with the sheet\'s own separator',
        uploads.joinList(['a.xlsx', 'b.xlsx']) === 'a.xlsx | b.xlsx');
  check('blanks are dropped on the way in',
        uploads.joinList(['a.xlsx', '', '  ', null, 'b.xlsx']) ===
        'a.xlsx | b.xlsx');
  check('names are trimmed',
        uploads.joinList(['  a.xlsx  ']) === 'a.xlsx');
  check('nothing joins to nothing',
        uploads.joinList([]) === '' && uploads.joinList(undefined) === '');

  check('a list splits back',
        JSON.stringify(uploads.splitList('a.xlsx | b.xlsx')) ===
        JSON.stringify(['a.xlsx', 'b.xlsx']));
  /*
    A trailing separator would otherwise produce an empty name, and an empty
    name matched against ticket.source_files matches every row that has no
    sources at all - which the delete would then remove.
  */
  check('an empty name never comes out of a split',
        JSON.stringify(uploads.splitList('a.xlsx |  | b.xlsx | ')) ===
        JSON.stringify(['a.xlsx', 'b.xlsx']));
  check('an empty string splits to nothing',
        uploads.splitList('').length === 0 &&
        uploads.splitList(null).length === 0 &&
        uploads.splitList(undefined).length === 0);
  check('join and split are inverses',
        JSON.stringify(uploads.splitList(uploads.joinList(['x', 'y', 'z']))) ===
        JSON.stringify(['x', 'y', 'z']));

  check('a plain day is read', uploads.readDay('2026-08-01') === '2026-08-01');
  check('a day with a time after it keeps the day',
        uploads.readDay('2026-08-01 10:30:00') === '2026-08-01');
  check('blank is null, not the empty string',
        uploads.readDay('') === null && uploads.readDay('   ') === null &&
        uploads.readDay(null) === null);
  check('an unpadded date is refused rather than guessed at',
        uploads.readDay('2026-8-1') === null);
  check('nonsense is null', uploads.readDay('last Tuesday') === null);


  // =======================================================================
  console.log('');
  console.log('  ticket-merge, which both upload paths now share');
  // =======================================================================
  check('the merge is an upsert on the ticket ID',
        /ON CONFLICT \(ticket_id\) DO UPDATE/.test(merge.MERGE_SQL));
  check('and it reports whether it inserted or updated',
        /RETURNING \(xmax = 0\) AS inserted/.test(merge.MERGE_SQL));
  check('the two report flags are OR\'d, never replaced',
        /in_overall = ticket\.in_overall OR EXCLUDED\.in_overall/.test(merge.MERGE_SQL));
  check('ticket_id is not in the SET list',
        /ticket_id = CASE/.test(merge.MERGE_SQL) === false);
  check('every column is named once in the insert list',
        merge.NAMES.length === 29 && new Set(merge.NAMES).size === 29);

  const v = merge.valuesFromCells(cells({ 'Ticket ID': 'X', 'Delay Days': '5' }),
                                  { lastUpdated: '2099-01-01T00:00:00.000Z' });
  check('a row of cells becomes one value per column', v.length === 29);
  check('Last Updated is replaced by the upload stamp',
        v[merge.AT.last_updated] === '2099-01-01T00:00:00.000Z');
  check('a number cell is a number', v[merge.AT.delay_days] === 5);
  /*
    "Some Completion Date cells in the ITSM export contain a single space ...
     one ticket silently becomes incomplete. With a KPI whose whole margin is
     one ticket, that is not a rounding detail."
  */
  check('a Completion Date of one space is not a completion date',
        merge.valuesFromCells(cells({ 'Ticket ID': 'X', 'Completion Date': ' ' }))
          [merge.AT.completion_date] === null);
  check('a blank Delay Days is null and not zero',
        merge.valuesFromCells(cells({ 'Ticket ID': 'X' }))
          [merge.AT.delay_days] === null);
  check('TRUE in any case is true, and nothing else is',
        merge.truthy('TRUE') && merge.truthy('true') && merge.truthy(true) &&
        !merge.truthy('yes') && !merge.truthy('1') && !merge.truthy(''));


  // =======================================================================
  console.log('');
  console.log('  A timestamp with no timezone on it means Dhaka');
  // =======================================================================
  /*
    The ITSM exports write '2026-08-20 10:00'. That is ten in the morning in
    the office, and nothing in the text says so - so `new Date` reads it in
    the timezone of the PROCESS. On the Windows machine in Dhaka that is
    right by accident. On a server it would not be, and almost every Linux
    server is set to UTC.

    Six hours is invisible in the middle of a month and decisive at the end
    of one: a ticket raised at 20:00 on 31 August becomes 02:00 on 1
    September, and a monthly KPI scores it in the wrong month.
  */
  check('ten in the morning is ten in the morning in Dhaka',
        merge.readDate('2026-08-20 10:00') === '2026-08-20T04:00:00.000Z',
        merge.readDate('2026-08-20 10:00'));
  check('SO A TICKET AT 20:00 ON 31 AUGUST STAYS IN AUGUST',
        merge.readDate('2026-08-31 20:00') === '2026-08-31T14:00:00.000Z',
        merge.readDate('2026-08-31 20:00'));
  check('seconds are read when they are there',
        merge.readDate('2026-08-20 10:00:30') === '2026-08-20T04:00:30.000Z');
  check('a T between the date and the time is the same thing',
        merge.readDate('2026-08-20T10:00') === merge.readDate('2026-08-20 10:00'));
  /*
    ISO says a bare date is UTC midnight, which is six in the morning in the
    office - a day that starts at breakfast.
  */
  check('a bare date is midnight in Dhaka, not midnight in London',
        merge.readDate('2026-08-20') === '2026-08-19T18:00:00.000Z',
        merge.readDate('2026-08-20'));
  check('a timestamp that names its zone is believed',
        merge.readDate('2026-08-20T10:00:00Z') === '2026-08-20T10:00:00.000Z');
  check('including an offset that happens to be Dhaka\'s',
        merge.readDate('2026-08-20T10:00:00+06:00') === '2026-08-20T04:00:00.000Z');
  check('and something unreadable is still reported, not guessed at',
        merge.readDate('the third of never', [], 'x') === null);

  /*
    THE POINT OF ALL OF THAT, CHECKED THE ONLY WAY THAT PROVES IT: run the
    same function in child processes whose clocks are set differently. If
    the answers match, the result does not depend on where the server is.
  */
  const { execFileSync } = require('child_process');
  const mergePath = require('path').join(__dirname, 'ticket-merge');
  function readUnder(tz, text) {
    return execFileSync(process.execPath, ['-e',
      'process.stdout.write(String(require(' + JSON.stringify(mergePath) +
      ').readDate(' + JSON.stringify(text) + ')))'],
      { encoding: 'utf8',
        env: Object.assign({}, process.env, { TZ: tz }) });
  }
  const utc   = readUnder('UTC', '2026-08-31 20:00');
  const dhaka = readUnder('Asia/Dhaka', '2026-08-31 20:00');
  const ny    = readUnder('America/New_York', '2026-08-31 20:00');
  check('THE SAME EXPORT READ ON A UTC MACHINE AND A DHAKA ONE AGREES',
        utc === dhaka, utc + ' vs ' + dhaka);
  check('and on a machine in New York as well',
        ny === dhaka, ny + ' vs ' + dhaka);
  check('and all three are the Dhaka answer',
        dhaka === '2026-08-31T14:00:00.000Z', dhaka);


  // =======================================================================
  console.log('');
  console.log('  A real upload');
  // =======================================================================
  async function sweep() {
    await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-UPL-%'");
    await db.query("DELETE FROM upload_run WHERE file_names LIKE '%TEST-UPL-%'" +
                   " OR uploaded_by LIKE 'TEST-UPL%'");
  }
  await sweep();

  /**
   * Opens an upload and dates it, so that "newer" is a fact and not a race.
   * beginUpload stamps with now(), and two uploads opened a millisecond
   * apart would still be ordered correctly - but only by a margin nobody
   * should have to trust.
   */
  async function openUpload(files, at) {
    const out = await uploads.beginUpload({
      who: 'TEST-UPL-who', fileNames: files, reportTypes: ['Overall'],
      departments: ['Functional'], totalRows: 2,
      dateFrom: '2026-08-01', dateTo: '2026-08-31'
    });
    await db.query('UPDATE upload_run SET uploaded_at = $2 WHERE upload_id = $1',
                   [out.uploadId, at]);
    return out.uploadId;
  }

  const first = await openUpload([A], '2099-01-01T00:00:00Z');

  const opened = (await db.query(
    'SELECT * FROM upload_run WHERE upload_id = $1', [first]))[0];
  check('the log row exists', Boolean(opened));
  check('it is open, not complete', opened.notes === uploads.IN_PROGRESS);
  check('it records who, from the token and not the browser',
        opened.uploaded_by === 'TEST-UPL-who');
  check('it records the files as one list', opened.file_names === A);
  check('it records how many rows were promised', opened.rows_in_file === 2);
  check('the counters start at zero',
        opened.rows_added === 0 && opened.rows_updated === 0);
  check('the date range is a date, with no time and no timezone on it',
        (await db.query("SELECT to_char(date_from,'YYYY-MM-DD') AS d" +
                        ' FROM upload_run WHERE upload_id = $1', [first]))[0].d
        === '2026-08-01');

  const batch1 = await uploads.appendTicketBatch(first, [
    cells({ 'Ticket ID': 'TEST-UPL-1', 'Affiliate': 'KSL', 'Part': 'MM',
            'Request Date': '2026-08-03 09:15', 'Delay Days': '0',
            'In Overall Report': 'TRUE', 'In Dept Report': 'FALSE',
            'Source Files': A, 'Status': 'Open' }),
    cells({ 'Ticket ID': 'TEST-UPL-2', 'Affiliate': 'KSL', 'Part': 'SD',
            'Request Date': '2026-08-04 09:15',
            'In Overall Report': 'TRUE', 'Source Files': A })
  ]);

  check('both rows were new', batch1.inserted === 2 && batch1.updated === 0);
  check('appended counts them both', batch1.appended === 2);
  check('nothing was reported as unreadable', batch1.problems.length === 0);

  async function one(id) {
    return (await db.query('SELECT * FROM ticket WHERE ticket_id = $1', [id]))[0];
  }

  let t1 = await one('TEST-UPL-1');
  check('the ticket is there', Boolean(t1));
  check('its Part came through', t1 && t1.part === 'MM');
  check('a Delay Days of 0 is stored as 0, not as null',
        t1 && Number(t1.delay_days) === 0);
  /*
    "two files of the same upload have to carry the same stamp, or the last
     batch to land would outrank the first for no reason."
  */
  const t2 = await one('TEST-UPL-2');
  check('EVERY ROW OF THE UPLOAD CARRIES THE UPLOAD\'S OWN TIME',
        t1 && t2 &&
        new Date(t1.last_updated).getTime() === new Date(t2.last_updated).getTime());
  check('and that time is when the upload was opened, not when it landed',
        new Date(t1.last_updated).toISOString() === '2099-01-01T00:00:00.000Z',
        t1 && String(t1.last_updated));

  const counters = (await db.query(
    'SELECT rows_added, rows_updated FROM upload_run WHERE upload_id = $1',
    [first]))[0];
  check('the log row counted the two new rows',
        counters.rows_added === 2 && counters.rows_updated === 0);


  // =======================================================================
  console.log('');
  console.log('  The same tickets in a second, later upload');
  // =======================================================================
  const second = await openUpload([B], '2099-01-02T00:00:00Z');

  const batch2 = await uploads.appendTicketBatch(second, [
    // Ticket 1 again, now completed and late, from a different file. The
    // department export fills in what the overall export left blank.
    cells({ 'Ticket ID': 'TEST-UPL-1', 'Affiliate': 'KSL', 'Part': 'MM',
            'Request Date': '2026-08-03 09:15',
            'Completion Date': '2026-08-08 17:00', 'Delay Days': '5',
            'In Overall Report': 'FALSE', 'In Dept Report': 'TRUE',
            'Department': 'Functional', 'Source Files': B }),
    cells({ 'Ticket ID': 'TEST-UPL-3', 'Affiliate': 'KSL', 'Part': 'FICO',
            'Request Date': '2026-08-09 09:15', 'Source Files': B })
  ]);

  check('one was known and one was new',
        batch2.inserted === 1 && batch2.updated === 1,
        batch2.inserted + '/' + batch2.updated);

  t1 = await one('TEST-UPL-1');
  /*
    THE BUG THIS RULE EXISTS FOR. "Delay Days is 0 on an open ticket - not
    blank, zero - so 'the stored value stands' kept the 0 and threw away the
    5 that says the ticket finished five days late. The KPI then scored it
    as on time. Quietly, with no way to see it."
  */
  check('A LATER UPLOAD\'S 5 BEATS THE STORED 0',
        Number(t1.delay_days) === 5, String(t1 && t1.delay_days));
  check('and the completion date it brought is stored',
        t1.completion_date !== null);
  check('a value only the newer row had is filled in',
        t1.department === 'Functional');
  /*
    "A blank in the newer row never erases a known value - an overall export
     omits Status entirely, and a refresh of it should not wipe the Status a
     department export supplied."
  */
  check('A BLANK IN THE NEWER ROW DOES NOT ERASE WHAT WAS THERE',
        t1.status === 'Open', JSON.stringify(t1.status));
  check('the two report flags are OR\'d, not replaced',
        t1.in_overall === true && t1.in_dept === true);
  check('the source list accumulates both files',
        t1.source_files === A + ' | ' + B, t1.source_files);
  check('and the new upload re-stamped the row',
        new Date(t1.last_updated).toISOString() === '2099-01-02T00:00:00.000Z');

  // The same upload again, with the other file's partial view. Same stamp,
  // so this is the "two files of one upload complete each other" case.
  await uploads.appendTicketBatch(second, [
    cells({ 'Ticket ID': 'TEST-UPL-1', 'Title': 'A title from the other file',
            'Delay Days': '', 'Source Files': B })
  ]);
  t1 = await one('TEST-UPL-1');
  check('a second file of the same upload fills blanks in',
        t1.title === 'A title from the other file');
  check('without disturbing the delay days it did not carry',
        Number(t1.delay_days) === 5);
  check('and without listing the same file twice',
        t1.source_files === A + ' | ' + B, t1.source_files);


  // =======================================================================
  console.log('');
  console.log('  Rows and uploads that are not right');
  // =======================================================================
  const noId = await uploads.appendTicketBatch(second, [
    cells({ 'Ticket ID': '  ', 'Affiliate': 'KSL' }),
    cells({ 'Ticket ID': 'TEST-UPL-4', 'Affiliate': 'KSL' })
  ]);
  check('a row with no Ticket ID is skipped, not stored',
        noId.appended === 1, String(noId.appended));
  check('and it is reported rather than silently dropped',
        noId.problems.length === 1 && /no Ticket ID/.test(noId.problems[0]),
        JSON.stringify(noId.problems));
  check('no ticket with a blank ID was created',
        (await db.query("SELECT count(*)::int AS n FROM ticket" +
                        " WHERE btrim(ticket_id) = ''"))[0].n === 0);

  const unreadable = await uploads.appendTicketBatch(second, [
    cells({ 'Ticket ID': 'TEST-UPL-5', 'Request Date': 'the third of never' })
  ]);
  check('an unreadable date is reported, not swallowed',
        unreadable.problems.some(function (p) { return /cannot read the date/.test(p); }),
        JSON.stringify(unreadable.problems));
  check('and the row is still stored, with that field empty',
        (await one('TEST-UPL-5')).request_date === null);

  /*
    THE WHITESPACE RULE, END TO END. In the sheet this mattered because the
    cell kept the space and the merge then treated it as a real completion
    date - "one ticket silently becomes incomplete". Here it is defended
    three times over: isBlank trims, every text value is trimmed on the way
    in, and the SQL compares with btrim. Mutation testing could not tell
    those three apart, which is the honest reason this checks the OUTCOME in
    the database rather than any one of them.
  */
  await uploads.appendTicketBatch(second, [
    cells({ 'Ticket ID': 'TEST-UPL-6', 'Completion Date': ' ',
            'Status': '  ', 'Source Files': B })
  ]);
  const spaced = await one('TEST-UPL-6');
  check('A COMPLETION DATE OF ONE SPACE LEAVES THE TICKET OPEN',
        spaced.completion_date === null);
  check('and a status of two spaces is stored as empty, not as spaces',
        spaced.status === '', JSON.stringify(spaced.status));

  /*
    The original returned `new Date()` for an ID it did not recognise, so a
    batch could be appended against an upload that was never opened - rows in
    the table, nothing in the history, and no way to delete them again.
  */
  check('rows cannot be appended to an upload that was never opened',
        await threwSaying(function () {
          return uploads.appendTicketBatch('UPL-20990101-000000-zzzz', [
            cells({ 'Ticket ID': 'TEST-UPL-ghost' })
          ]);
        }, /was never opened/));
  check('and nothing was written by the attempt',
        (await one('TEST-UPL-ghost')) === undefined);
  check('an empty upload ID is refused',
        await threwSaying(function () {
          return uploads.appendTicketBatch('', [cells({ 'Ticket ID': 'TEST-UPL-x' })]);
        }, /No upload ID/));
  const empty = await uploads.appendTicketBatch(second, []);
  check('an empty batch is not an error', empty.appended === 0);


  // =======================================================================
  console.log('');
  console.log('  NUL bytes, which real exports contain');
  // =======================================================================
  /*
    "A PostgreSQL text value cannot contain one, at all, by design." The
    first real import stopped on exactly this after 25,808 rows. Stripping
    it is right; doing so without saying anything is not - and this path had
    no end-of-run to print a count at, so the count was being lost.
  */
  const withNul = await uploads.appendTicketBatch(second, [
    cells({ 'Ticket ID': 'TEST-UPL-nul', 'Title': 'before\u0000after',
            'Source Files': B })
  ]);
  check('the NUL cells are counted', withNul.nulCells === 1,
        String(withNul.nulCells));
  check('and reported rather than stripped in silence',
        withNul.problems.some(function (p) { return /NUL byte/.test(p); }),
        JSON.stringify(withNul.problems));
  check('the row is stored with the character removed and nothing else',
        (await one('TEST-UPL-nul')).title === 'beforeafter',
        JSON.stringify((await one('TEST-UPL-nul')).title));
  const noNul = await uploads.appendTicketBatch(second, [
    cells({ 'Ticket ID': 'TEST-UPL-nul2', 'Title': 'clean', 'Source Files': B })
  ]);
  check('a clean batch reports none',
        noNul.nulCells === 0 && noNul.problems.length === 0);


  // =======================================================================
  console.log('');
  console.log('  Downloading an upload again');
  // =======================================================================
  check('the download is named after the files, not the upload ID',
        uploads.uploadCsvName('UPL-20261028-102822-8817', ['Overall_Aug.xlsx'])
        === 'Overall_Aug 2026-10-28.csv',
        uploads.uploadCsvName('UPL-20261028-102822-8817', ['Overall_Aug.xlsx']));
  check('several files become "and N more"',
        uploads.uploadCsvName('UPL-20261028-102822-8817',
                              ['a.xlsx', 'b.xlsx', 'c.xlsx'])
        === 'a and 2 more 2026-10-28.csv');
  check('no files falls back to the upload ID',
        /^UPL-20261028-102822-8817 2026-10-28\.csv$/
          .test(uploads.uploadCsvName('UPL-20261028-102822-8817', [])));
  /*
    Windows refuses these outright and the rest make a mess of a shell. A
    file name is not a place to find out.
  */
  check('characters Windows will not accept are replaced',
        uploads.uploadCsvName('UPL-20261028-102822-8817',
                              ['a/b:c*d?e"f<g>h|i.xlsx'])
          .indexOf('/') === -1);
  check('and the name stays short enough to be a file name',
        uploads.uploadCsvName('UPL-20261028-102822-8817',
                              ['x'.repeat(400) + '.xlsx']).length <= 124);

  check('a plain value is not quoted', uploads.csvCell('KSL') === 'KSL');
  check('a comma forces quotes',
        uploads.csvCell('one, two') === '"one, two"');
  check('a quote is doubled',
        uploads.csvCell('say "hi"') === '"say ""hi"""');
  check('a newline forces quotes',
        uploads.csvCell('line\nline') === '"line\nline"');
  check('null and undefined are empty',
        uploads.csvCell(null) === '' && uploads.csvCell(undefined) === '');

  check('every column is rendered by the SELECT',
        merge.NAMES.every(function (n) {
          return new RegExp('AS ' + n + '\\b').test(uploads.csvSelectList());
        }));
  check('timestamps are rendered in Dhaka, by the database',
        /AT TIME ZONE 'Asia\/Dhaka'/.test(uploads.csvSelectList()));
  check('booleans come out as TRUE and FALSE, which truthy reads back',
        /THEN 'TRUE' ELSE 'FALSE'/.test(uploads.csvSelectList()) &&
        merge.truthy('TRUE') === true);

  const slice = await uploads.uploadCsvChunk(second, 1);
  const csvLines = slice.csv.split('\n');
  check('the first slice carries the header row',
        csvLines[0] === merge.HEADERS.join(','), csvLines[0].slice(0, 40));
  check('it offers a file name', /\.csv$/.test(slice.fileName), slice.fileName);
  check('the total counts only this upload\'s tickets',
        slice.total === (await db.query(
          "SELECT count(*)::int AS n FROM ticket" +
          " WHERE source_files LIKE '%' || $1 || '%'", [B]))[0].n,
        String(slice.total));
  check('one call was enough for a small upload', slice.done === true);
  check('and it emitted a line per ticket, under the header',
        csvLines.length === slice.total + 1,
        csvLines.length + ' lines for ' + slice.total + ' tickets');
  check('scanned reports how far it got', slice.scanned === slice.total);

  /*
    A title containing a comma is the case that breaks a CSV written without
    escaping, and ticket titles contain them routinely.
  */
  await uploads.appendTicketBatch(second, [
    cells({ 'Ticket ID': 'TEST-UPL-csv', 'Source Files': B,
            'Title': 'Adjust, then re-run the "month end" job',
            'Request Date': '2026-08-20 10:00', 'In Overall Report': 'TRUE' })
  ]);
  const quoted = await uploads.uploadCsvChunk(second, 1);
  check('a title with a comma and quotes survives as one field',
        quoted.csv.indexOf('"Adjust, then re-run the ""month end"" job"') !== -1);
  check('a true flag is written as TRUE',
        quoted.csv.split('\n').some(function (l) {
          return l.indexOf('TEST-UPL-csv') !== -1 && l.indexOf('TRUE') !== -1;
        }));
  check('a timestamp is written as a plain local datetime',
        /2026-08-20 10:00:00/.test(quoted.csv), 'request date not found');

  const second2 = await uploads.uploadCsvChunk(second, 2);
  check('a later slice has no header row',
        second2.csv.split('\n')[0] !== merge.HEADERS.join(','));
  check('and no file name, because the download already has one',
        second2.fileName === '');
  check('starting past the end is done, with nothing in it',
        (await uploads.uploadCsvChunk(second, 9999)).done === true);

  const otherUpload = await openUpload(['TEST-UPL-c.xlsx'], '2099-01-03T00:00:00Z');
  const none = await uploads.uploadCsvChunk(otherUpload, 1);
  check('AN UPLOAD DOWNLOADS ITS OWN ROWS AND NOBODY ELSE\'S',
        none.total === 0 && none.csv.split('\n').length === 1,
        String(none.total));
  await uploads.deleteUpload(otherUpload);

  check('downloading an upload that does not exist is an error',
        await threwSaying(function () {
          return uploads.uploadCsvChunk('UPL-nope', 1);
        }, /not found/));


  // =======================================================================
  console.log('');
  console.log('  The merge is defined once');
  // =======================================================================
  /*
    STRUCTURAL, AND IT EARNS ITS PLACE. ticket-merge.js exists so that the
    CSV importer and this screen cannot disagree about what merging two
    tickets means. Nothing stops somebody pasting the statement back into
    one of them, and the day that happens both suites still pass - the
    duplication is invisible until the copies drift.
  */
  const importer = require('fs')
    .readFileSync(require('path').join(__dirname, 'import-tickets.js'), 'utf8');
  check('IMPORT-TICKETS HAS NO MERGE OF ITS OWN',
        importer.indexOf('ON CONFLICT') === -1);
  check('it takes the merge from the shared module',
        /require\('\.\/ticket-merge'\)/.test(importer) &&
        /merge\.MERGE_SQL/.test(importer));
  check('and it does not keep its own copy of the column list',
        /^const COLUMNS = merge\.COLUMNS;$/m.test(importer));


  // =======================================================================
  console.log('');
  console.log('  Closing it, and the history');
  // =======================================================================
  const done = await uploads.finishUpload(first);
  check('finish reports the upload', done.uploadId === first);
  check('it reports what this upload did', done.added === 2 && done.updated === 0);
  check('the log row is closed', done.notes === uploads.COMPLETE);

  const again = await uploads.finishUpload(first);
  check('FINISHING TWICE GIVES THE SAME ANSWER',
        again.added === done.added && again.updated === done.updated &&
        again.notes === done.notes);

  check('finishing an upload that does not exist is an error',
        await threwSaying(function () { return uploads.finishUpload('UPL-nope'); }, /not found/));

  const history = await uploads.uploadHistory();
  const mine = history.filter(function (h) {
    return h.uploadId === first || h.uploadId === second;
  });
  check('both uploads are in the history', mine.length === 2);
  check('newest first', mine[0].uploadId === second);
  check('the history carries the file names', mine[1].fileName === A);
  check('and who uploaded them', mine[1].uploadedBy === 'TEST-UPL-who');
  check('and the date range as plain days',
        mine[1].dateFrom === '2026-08-01' && mine[1].dateTo === '2026-08-31');
  check('uploadedAt is an ISO timestamp',
        /^2099-01-01T/.test(mine[1].uploadedAt), mine[1].uploadedAt);
  check('the page\'s own key names are unchanged',
        ['uploadId', 'uploadedAt', 'uploadedBy', 'fileName', 'reportType',
         'department', 'rowsInFile', 'rowsKept', 'rowsMerged', 'dateFrom',
         'dateTo', 'notes'].every(function (k) {
          return Object.prototype.hasOwnProperty.call(mine[0], k);
        }));


  // =======================================================================
  console.log('');
  console.log('  Deleting an upload - the only destructive thing here');
  // =======================================================================
  /*
    Where the three tickets stand now:

      TEST-UPL-1   sources A | B   both uploads vouch for it
      TEST-UPL-2   sources A       only the first
      TEST-UPL-3   sources B       only the second
      TEST-UPL-4   no sources      belongs to nobody
      TEST-UPL-5   no sources      belongs to nobody
      TEST-UPL-6   sources B       only the second
      TEST-UPL-nul, TEST-UPL-nul2, TEST-UPL-csv   sources B

    Deleting the FIRST upload must remove TEST-UPL-2 and nothing else, and
    must prune A out of TEST-UPL-1 while leaving the row alone.
  */
  const before = (await db.query(
    "SELECT count(*)::int AS n FROM ticket WHERE ticket_id LIKE 'TEST-UPL-%'"))[0].n;

  const gone = await uploads.deleteUpload(first);

  check('it removed the one ticket that was only its own',
        gone.removed === 1, String(gone.removed));
  check('and pruned the one that was shared', gone.pruned === 1,
        String(gone.pruned));
  check('TEST-UPL-2 is gone', (await one('TEST-UPL-2')) === undefined);
  check('TEST-UPL-1 SURVIVED, because the other upload also vouched for it',
        Boolean(await one('TEST-UPL-1')));
  check('with the deleted upload\'s file pruned out of its sources',
        (await one('TEST-UPL-1')).source_files === B,
        (await one('TEST-UPL-1')).source_files);
  check('TEST-UPL-3 was never touched',
        (await one('TEST-UPL-3')).source_files === B);
  /*
    A ticket with no sources at all belongs to nobody. "No source outside
    this upload" is vacuously true of it, so a delete written without the
    guard would remove it - every time anyone deleted anything.
  */
  check('A TICKET WITH NO SOURCES IS NOT REMOVED BY ANY DELETE',
        Boolean(await one('TEST-UPL-4')) && Boolean(await one('TEST-UPL-5')));
  check('exactly one ticket went',
        (await db.query("SELECT count(*)::int AS n FROM ticket" +
                        " WHERE ticket_id LIKE 'TEST-UPL-%'"))[0].n === before - 1);

  check('the log row went with it',
        (await db.query('SELECT 1 FROM upload_run WHERE upload_id = $1',
                        [first])).length === 0);
  check('and it is out of the history',
        (await uploads.uploadHistory())
          .some(function (h) { return h.uploadId === first; }) === false);

  check('deleting an upload that does not exist is an error',
        await threwSaying(function () { return uploads.deleteUpload('UPL-nope'); }, /not found/));
  check('deleting with no ID at all is an error',
        await threwSaying(function () { return uploads.deleteUpload(''); }, /No upload ID/));

  /*
    AN UPLOAD THAT NAMED NO FILES MUST REMOVE NOTHING. Ingest.gs made the
    same point about a feedback-only upload: it "DOES NOT REWRITE A SHEET IT
    DID NOT CHANGE". Here the guard on files.length is an optimisation -
    with an empty list the SQL already matches nothing, which mutation
    testing confirmed by removing the guard and changing no outcome - so
    this checks the behaviour rather than the guard.
  */
  const nameless = await uploads.beginUpload({
    who: 'TEST-UPL-nofiles', fileNames: [], totalRows: 0
  });
  const standing = (await db.query(
    "SELECT count(*)::int AS n FROM ticket WHERE ticket_id LIKE 'TEST-UPL-%'"))[0].n;
  const nothing = await uploads.deleteUpload(nameless.uploadId);
  check('deleting an upload that named no files removes no tickets',
        nothing.removed === 0 && nothing.pruned === 0);
  check('and every ticket is still there',
        (await db.query("SELECT count(*)::int AS n FROM ticket" +
                        " WHERE ticket_id LIKE 'TEST-UPL-%'"))[0].n === standing);
  check('but its own log row is gone',
        (await db.query('SELECT 1 FROM upload_run WHERE upload_id = $1',
                        [nameless.uploadId])).length === 0);

  // Now the second upload, which owns what is left.
  const rest = await uploads.deleteUpload(second);
  check('deleting the second removes the rows it alone owned',
        rest.removed === 6, String(rest.removed));
  check('TEST-UPL-1 is gone now that nobody vouches for it',
        (await one('TEST-UPL-1')) === undefined);
  check('and the sourceless rows are STILL there',
        Boolean(await one('TEST-UPL-4')) && Boolean(await one('TEST-UPL-5')));


  // =======================================================================
  await sweep();
  const left = await db.query(
    "SELECT count(*)::int AS n FROM ticket WHERE ticket_id LIKE 'TEST-UPL-%'");
  check('no test tickets are left behind', left[0].n === 0);
  const logs = await db.query(
    "SELECT count(*)::int AS n FROM upload_run WHERE uploaded_by LIKE 'TEST-UPL%'");
  check('no test uploads are left behind', logs[0].n === 0);

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('');
  process.exit(fail ? 1 : 0);
}


main().catch(function (e) {
  console.error(e);
  process.exit(1);
});
