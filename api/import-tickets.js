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
 * Replacing the browser-side parse is the Uploads screen, which is a
 * separate job and is listed as outstanding in PORT-INVENTORY.md. Until
 * then the Apps Script side keeps doing the merging, exactly as it does
 * today, and this carries the result across.
 *
 * NO REAL DATA IS IN THIS FILE. It reads the CSV, which .gitignore keeps
 * out of the repository.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('./db');

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
  The 25 headers of the TICKETS tab, in order, each with the column it
  loads into and how it is read.

  MATCHED BY HEADER NAME, NOT BY POSITION. The tab's order is checked and
  reported, but a column that has moved still lands in the right place -
  which is the opposite of how the Apps Script side works, and deliberately
  so. There, rows travel as bare arrays between the browser and the server
  and position is all there is. Here the header row is right in front of
  us, so using it costs nothing and means a reordered export is a warning
  rather than silently scrambled data.
*/
const COLUMNS = [
  ['Ticket ID',                  'ticket_id',             'text'],
  ['Affiliate',                  'affiliate',             'text'],
  ['Service',                    'service',               'text'],
  ['Part',                       'part',                  'text'],
  ['Process',                    'process',               'text'],
  ['Category',                   'category',              'text'],
  ['Sub Category',               'sub_category',          'text'],
  ['Title',                      'title',                 'text'],
  ['Details',                    'details',               'text'],
  ['Request Date',               'request_date',          'ts'],
  ['Requestor',                  'requestor',             'text'],
  ['Current Activity',           'current_activity',      'text'],
  ['Current Activity Date',      'current_activity_date', 'ts'],
  ['Current Activity In Charge', 'in_charge',             'text'],
  ['Due date',                   'due_date',              'ts'],
  ['Completion Date',            'completion_date',       'ts'],
  ['Lead-time',                  'lead_time',             'num'],
  ['Delay Days',                 'delay_days',            'num'],
  ['Status',                     'status',                'text'],
  ['CTS Number',                 'cts_number',            'text'],
  ['Remarks',                    'remarks',               'text'],
  ['Acceptance M/H (Level1)',    'acceptance_mh',         'num'],
  ['Processing M/H (Level1)',    'processing_mh',         'num'],
  ['Man*Hour',                   'man_hour',              'num'],
  ['Department',                 'department',            'text'],
  ['In Overall Report',          'in_overall',            'bool'],
  ['In Dept Report',             'in_dept',               'bool'],
  ['Source Files',               'source_files',          'text'],
  ['Last Updated',               'last_updated',          'ts']
];

// These three are merged by their own rules, not by "blank or newer".
const SPECIAL = ['in_overall', 'in_dept', 'source_files'];


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

/**
 * Ingest.gs isBlank, and the trim is the whole point.
 *
 *   "Some Completion Date cells in the ITSM export contain a single space.
 *    Testing only for '' treats that space as a real value, so the merge
 *    keeps it and the genuine completion date from the other report never
 *    replaces it - one ticket silently becomes incomplete. With a KPI whose
 *    whole margin is one ticket, that is not a rounding detail."
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** Ingest.gs truthy. 'TRUE', 'true' and a real boolean; nothing else. */
function truthy(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

/**
 * A date cell as a timestamp, or null.
 *
 * NULL FOR ANYTHING BLANK-ISH, which is where isCompleted's whitespace rule
 * moves to in a typed column. A Completion Date of ' ' becomes NULL here,
 * so the ticket is open - the same answer the Apps Script side reaches, one
 * step earlier and without the column having to hold a space to prove it.
 *
 * Anything that is not blank and not a date it can read is reported rather
 * than quietly becoming null, because a column of dates that silently
 * emptied is how a KPI loses a month.
 */
function readDate(value, problems, where) {
  if (isBlank(value)) return null;
  const text = String(value).trim();
  const when = new Date(text);
  if (isNaN(when.getTime())) {
    problems.push(where + ': cannot read the date ' + JSON.stringify(text));
    return null;
  }
  return when.toISOString();
}

/** A number cell, or null. Blank is null, not zero. */
function readNumber(value, problems, where) {
  if (isBlank(value)) return null;
  const n = parseFloat(String(value).trim());
  if (isNaN(n)) {
    problems.push(where + ': cannot read the number ' + JSON.stringify(String(value)));
    return null;
  }
  return n;
}


// ---------------------------------------------------------------------------
// The merge, as one statement
// ---------------------------------------------------------------------------
/**
 * Ingest.gs mergeRows, written as ON CONFLICT DO UPDATE.
 *
 * The original reads the existing row, merges in JavaScript and writes the
 * result back. That is a read-modify-write, and two imports running together
 * would each start from the same copy. One statement cannot do that: the row
 * is read and written inside it, by the database.
 *
 * THREE RULES, AND THEY ARE NOT THE SAME RULE:
 *
 *   most columns   take the incoming value if the existing one is blank, OR
 *                  if the incoming row is newer. A blank incoming value
 *                  never overwrites anything - a partial export must not
 *                  erase what a fuller one supplied.
 *
 *   the two flags  are OR'd, always. "A ticket can legitimately appear in
 *                  both kinds of export", and which reports it appeared in
 *                  is the thing that decides whether EAS is scored on it.
 *
 *   Source Files   accumulates, unique, in the order first seen, "so the
 *                  audit trail shows every file that contributed".
 *
 * `newer` is decided on Last Updated, and a row with no readable stamp
 * counts as oldest - "the safe answer, since it cannot then overwrite
 * anything on a recency claim it has not made". coalesce to epoch does
 * that here.
 */
function buildMergeSql() {
  const names = COLUMNS.map(function (c) { return c[1]; });
  const placeholders = names.map(function (_, i) { return '$' + (i + 1); });

  // Written out by rule rather than by hand, because twenty-four
  // near-identical CASE expressions typed one after another is twenty-four
  // chances to paste the wrong column name into one of them - and that
  // mistake is invisible: the import succeeds and one field silently stops
  // updating.
  const sets = [];
  COLUMNS.forEach(function (c) {
    const col = c[1];
    const kind = c[2];
    if (col === 'ticket_id' || SPECIAL.indexOf(col) !== -1) return;

    // Blank means '' for text and NULL for everything typed.
    const incomingBlank = kind === 'text'
      ? "btrim(EXCLUDED." + col + ") = ''"
      : 'EXCLUDED.' + col + ' IS NULL';
    const existingBlank = kind === 'text'
      ? "btrim(ticket." + col + ") = ''"
      : 'ticket.' + col + ' IS NULL';

    sets.push(
      '  ' + col + ' = CASE' +
      ' WHEN ' + incomingBlank + ' THEN ticket.' + col +
      ' WHEN ' + existingBlank + ' OR EXCLUDED.last_updated >' +
      " coalesce(ticket.last_updated, 'epoch'::timestamptz)" +
      ' THEN EXCLUDED.' + col +
      ' ELSE ticket.' + col + ' END');
  });

  sets.push('  in_overall = ticket.in_overall OR EXCLUDED.in_overall');
  sets.push('  in_dept    = ticket.in_dept    OR EXCLUDED.in_dept');

  /*
    The union of two ' | ' separated lists, unique, order preserved. Done in
    SQL so that it happens inside the same statement as everything else -
    pulling the existing list into JavaScript to concatenate it would put
    the read back outside the write.

    WITH ORDINALITY is what keeps the order: without it the DISTINCT could
    hand the names back in any order it liked, and the audit trail would
    stop saying which file arrived first.
  */
  sets.push(
    "  source_files = (\n" +
    "    SELECT coalesce(string_agg(f, ' | ' ORDER BY n), '')\n" +
    "      FROM (SELECT DISTINCT ON (f) f, n FROM unnest(\n" +
    "              string_to_array(\n" +
    "                CASE WHEN btrim(ticket.source_files) = '' THEN EXCLUDED.source_files\n" +
    "                     WHEN btrim(EXCLUDED.source_files) = '' THEN ticket.source_files\n" +
    "                     ELSE ticket.source_files || ' | ' || EXCLUDED.source_files END,\n" +
    "                ' | ')\n" +
    "            ) WITH ORDINALITY AS t(f, n)\n" +
    "            WHERE btrim(f) <> ''\n" +
    "            ORDER BY f, n) AS u)");

  return 'INSERT INTO ticket (' + names.join(', ') + ')\n' +
         'VALUES (' + placeholders.join(', ') + ')\n' +
         'ON CONFLICT (ticket_id) DO UPDATE SET\n' +
         sets.join(',\n') + '\n' +
         'RETURNING (xmax = 0) AS inserted';
}


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
    const id = String(row[at.ticket_id] === undefined ? '' : row[at.ticket_id]).trim();
    if (!id) { skipped++; continue; }

    const where = 'row ' + (r + 1) + ' (' + id + ')';
    const one = COLUMNS.map(function (c) {
      const raw = row[at[c[1]]];
      if (c[1] === 'ticket_id') return id;
      switch (c[2]) {
        case 'ts':   return readDate(raw, problems, where + ' ' + c[0]);
        case 'num':  return readNumber(raw, problems, where + ' ' + c[0]);
        case 'bool': return truthy(raw);
        default:     return isBlank(raw) ? '' : String(raw).trim();
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
  if (problems.length) {
    console.log('');
    console.log('  ' + problems.length + ' cell(s) could not be read and were ' +
                'loaded as empty:');
    problems.slice(0, 20).forEach(function (p) { console.log('    ' + p); });
    if (problems.length > 20) {
      console.log('    ... and ' + (problems.length - 20) + ' more');
    }
  }

  const sql = buildMergeSql();
  const client = await db.pool.connect();
  let inserted = 0, updated = 0;

  try {
    await client.query('BEGIN');
    for (const one of values) {
      const got = await client.query(sql, one);
      if (got.rows[0] && got.rows[0].inserted) inserted++; else updated++;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('');
    console.error('  Nothing was imported: ' + err.message);
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
