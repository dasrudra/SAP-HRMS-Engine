/**
 * import-tickets.js - the TICKETS tab into PostgreSQL.
 * ===========================================================================
 *
 *     cd api
 *     node import-tickets.js
 *
 * That is the whole procedure. Export the TICKETS tab from the spreadsheet
 * as CSV into ..\data\TICKETS.csv, run this, read the numbers it prints.
 *
 *     File -> Download -> Comma Separated Values (.csv)
 *
 * SAFE TO RUN AGAIN, AND IT DOES NOT CLEAR THE TABLE FIRST - unlike
 * import-objectives.js, which does. The difference matters. The objectives
 * are a fixed list of 115 rows that is re-exported whole; tickets arrive in
 * overlapping exports that each carry part of the picture, and the merge
 * below is how two partial views of the same ticket become one row. Clearing
 * first would throw away whichever half was not in today's file.
 *
 * WHY THE TICKETS TAB AND NOT THE ITSM .xlsx FILES
 *
 * The Apps Script system has the BROWSER parse the five exports, work out
 * which report each one is, normalise every row and merge them - because
 * "parsing a 20,000-row spreadsheet on the server would run straight into
 * the 6-minute execution ceiling". By the time rows reach the TICKETS tab
 * that work is done. This reads the finished article.
 *
 * Replacing the browser-side parse is the Uploads screen, whose server side
 * is now ported - see api/uploads.js. Until the screen itself exists the
 * Apps Script side keeps doing the merging, exactly as it does today, and
 * this carries the result across.
 *
 * THE MERGE ITSELF IS NOT IN THIS FILE ANY MORE. It is in ticket-merge.js,
 * because the Uploads screen reaches the same table by a different road and
 * the two have to produce the same rows - not similar rows. Two copies of
 * twenty-four near-identical CASE expressions would agree on the day they
 * were written and drift the first time one of them was corrected.
 *
 * NO REAL DATA IS IN THIS FILE. It reads the CSV, which .gitignore keeps
 * out of the repository.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('./db');
const merge = require('./ticket-merge');

const DATA = path.join(__dirname, '..', 'data');

/*
  Normally data\TICKETS.csv, which is the whole procedure. A path may be
  given instead:

      node import-tickets.js C:\somewhere\else.csv

  That exists so import-tickets-test.js can point THIS file at a CSV it
  wrote in a temporary folder, rather than copying the script somewhere
  and running the copy. The first version of the test did copy it, and
  symlinked node_modules next to the copy so the requires would resolve -
  which fails on Windows with EPERM unless you are an administrator or
  have Developer Mode on. A test that needs administrator rights is a test
  that does not get run.

  Running the real file in place is also the better test: a copy can drift
  from the thing it is standing in for.
*/
const TICKETS_CSV = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(DATA, 'TICKETS.csv');


/*
  The 29 headers of the TICKETS tab, the column each loads into and how it
  is read, are all in ticket-merge.js. They live there rather than here
  because the Uploads screen needs exactly the same list and exactly the
  same merge.

  MATCHED BY HEADER NAME, NOT BY POSITION, and that part is this file's own
  decision rather than the module's. The tab's order is checked and
  reported, but a column that has moved still lands in the right place -
  which is the opposite of how the Uploads path works, and deliberately so.
  There, rows travel as bare arrays from the browser and position is all
  there is. Here the header row is right in front of us, so using it costs
  nothing and means a reordered export is a warning rather than silently
  scrambled data.
*/
const COLUMNS = merge.COLUMNS;


// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

/** The same parser import-objectives.js uses. Quotes, escapes, BOM, blanks. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }

    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  return rows.filter(function (r) {
    return r.some(function (c) { return String(c).trim() !== ''; });
  });
}


// ---------------------------------------------------------------------------
// Reading one cell
// ---------------------------------------------------------------------------
/*
  isBlank, truthy, stripNul, readDate and readNumber are in ticket-merge.js.

  Every one of them is part of what "the same export produces the same rows"
  means, and each exists because of something that went wrong: isBlank trims
  because a Completion Date of one space was being treated as a completion,
  and stripNul exists because a NUL byte in a real ITSM export stopped the
  first import after 25,808 rows.

  Aliased rather than called through the module everywhere below, so that
  the body of this file reads as it always did.
*/
const isBlank    = merge.isBlank;
const truthy     = merge.truthy;
const stripNul   = merge.stripNul;
const readDate   = merge.readDate;
const readNumber = merge.readNumber;


// ---------------------------------------------------------------------------
async function main() {
  console.log('');

  if (!fs.existsSync(TICKETS_CSV)) {
    console.error('  Could not find ' + TICKETS_CSV);
    console.error('');
    console.error('  Export the TICKETS tab from the spreadsheet:');
    console.error('    File -> Download -> Comma Separated Values (.csv)');
    console.error('  and save it as data\\TICKETS.csv next to the api folder.');
    console.error('');
    console.error('  Or give this a path:  node import-tickets.js <file.csv>');
    console.error('');
    process.exit(1);
  }

  const rows = parseCsv(fs.readFileSync(TICKETS_CSV, 'utf8'));
  if (rows.length < 2) {
    console.error('  TICKETS.csv has no rows under its header.');
    process.exit(1);
  }

  // Header check. A missing column is fatal; an extra or reordered one is
  // reported and then ignored, because the load is by name.
  const header = rows[0].map(function (h) { return String(h).trim(); });
  const at = {};
  const missing = [];
  COLUMNS.forEach(function (c) {
    const i = header.indexOf(c[0]);
    if (i === -1) missing.push(c[0]);
    at[c[1]] = i;
  });

  if (missing.length) {
    console.error('  TICKETS.csv is missing ' + missing.length + ' column(s):');
    missing.forEach(function (m) { console.error('    ' + m); });
    console.error('');
    console.error('  Expected the ' + COLUMNS.length +
                  ' headers of the TICKETS tab, spelled as they are there.');
    process.exit(1);
  }

  const extra = header.filter(function (h) {
    return h && !COLUMNS.some(function (c) { return c[0] === h; });
  });
  if (extra.length) {
    console.log('  Ignoring ' + extra.length + ' column(s) this port does not ' +
                'use: ' + extra.join(', '));
  }

  const problems = [];
  const values = [];
  let skipped = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const id = stripNul(
      String(row[at.ticket_id] === undefined ? '' : row[at.ticket_id]).trim());
    if (!id) { skipped++; continue; }

    const where = 'row ' + (r + 1) + ' (' + id + ')';
    const one = COLUMNS.map(function (c) {
      const raw = row[at[c[1]]];
      if (c[1] === 'ticket_id') return id;
      switch (c[2]) {
        case 'ts':   return readDate(raw, problems, where + ' ' + c[0]);
        case 'num':  return readNumber(raw, problems, where + ' ' + c[0]);
        case 'bool': return truthy(raw);
        default:     return isBlank(raw) ? '' : stripNul(String(raw).trim());
      }
    });

    // Last Updated decides which of two rows for one ticket wins, so a row
    // without one must not be able to claim it is newer than anything.
    // Ingest.gs stampOf treats an unreadable stamp as the oldest possible
    // moment; 'epoch' is that, and it keeps the column NOT NULL.
    const updatedAt = COLUMNS.findIndex(function (c) {
      return c[1] === 'last_updated';
    });
    if (one[updatedAt] === null) one[updatedAt] = new Date(0).toISOString();

    values.push(one);
  }

  console.log('  TICKETS.csv   ' + (rows.length - 1) + ' row(s) under the header');
  if (skipped) {
    console.log('                ' + skipped + ' with no Ticket ID, not loaded');
  }
  if (merge.nulCount()) {
    console.log('                ' + merge.nulCount() + ' cell(s) contained a NUL ' +
                'byte, which PostgreSQL cannot store - removed');
  }
  if (problems.length) {
    console.log('');
    console.log('  ' + problems.length + ' cell(s) could not be read and were ' +
                'loaded as empty:');
    problems.slice(0, 20).forEach(function (p) { console.log('    ' + p); });
    if (problems.length > 20) {
      console.log('    ... and ' + (problems.length - 20) + ' more');
    }
  }

  const sql = merge.MERGE_SQL;
  const client = await db.pool.connect();
  let inserted = 0, updated = 0;

  /*
    ONE TRANSACTION FOR THE WHOLE FILE, so a failure half way leaves the
    table exactly as it was rather than half updated. That is why the
    message below can say "nothing was imported" and mean it.

    It also means 25,000 rows is 25,000 statements before anything is
    visible, which looks like a hang. The progress line is there so it
    does not - and so that a run which does stop tells you how far it got.
  */
  const EVERY = 2000;
  let done = 0;

  try {
    await client.query('BEGIN');
    for (const one of values) {
      try {
        const got = await client.query(sql, one);
        if (got.rows[0] && got.rows[0].inserted) inserted++; else updated++;
      } catch (err) {
        // Name the ticket. Without this a single bad cell in 25,000 rows
        // is an error message with no row number in it, and the only way
        // to find it is to bisect the file by hand.
        err.message = 'ticket ' + one[0] + ': ' + err.message;
        throw err;
      }
      done++;
      if (done % EVERY === 0) {
        process.stdout.write('  ' + done + ' of ' + values.length + '...\r');
      }
    }
    await client.query('COMMIT');
    if (values.length >= EVERY) process.stdout.write('                              \r');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('');
    console.error('  Nothing was imported (stopped after ' + done + ' row(s)):');
    console.error('  ' + err.message);
    console.error('');
    process.exit(1);
  } finally {
    client.release();
  }

  const total = await db.query('SELECT count(*)::int AS n FROM ticket');
  const span = await db.query(
    `SELECT to_char(min(request_date) AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') AS a,
            to_char(max(request_date) AT TIME ZONE 'Asia/Dhaka', 'YYYY-MM') AS b,
            count(*) FILTER (WHERE completion_date IS NULL)::int AS open
       FROM ticket`);

  console.log('');
  console.log('  ' + inserted + ' added, ' + updated + ' merged into rows ' +
              'already there');
  console.log('  ' + total[0].n + ' tickets in the table, ' + span[0].open +
              ' of them still open');
  if (span[0].a) {
    console.log('  covering ' + span[0].a + ' to ' + span[0].b);
  }
  console.log('');
  process.exit(0);
}

main().catch(function (err) {
  console.error('');
  console.error('  Failed: ' + err.message);
  console.error('');
  process.exit(1);
});
