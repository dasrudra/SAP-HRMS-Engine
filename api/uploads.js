/**
 * uploads.js - receives parsed ticket rows from the browser and stores them.
 * ===========================================================================
 *
 * THE PORT OF Ingest.gs, and the thing that finally removes the step where
 * you export the TICKETS tab to a CSV and run import-tickets.js in a
 * terminal. Once the Uploads screen calls this, the five ITSM exports go
 * straight into PostgreSQL.
 *
 *
 * THE DIVISION OF LABOUR IS UNCHANGED
 *
 * The browser still does the heavy lifting: it reads the .xlsx with SheetJS,
 * works out which report each file is, normalises every row and merges the
 * five files into one deduplicated set. Only clean, uniform rows reach here.
 *
 * Apps Script did it that way because "parsing a 20,000-row spreadsheet on
 * the server would run straight into the 6-minute execution ceiling". That
 * ceiling is gone, so it is worth saying why the division stays: the parsing
 * is already written, already tested against five real report shapes, and
 * moving it server-side would be a rewrite of the one part of the upload
 * that has never caused trouble. It also keeps a 20MB .xlsx off the network.
 *
 *
 * THE UPLOAD IS STILL THREE CALLS
 *
 *   1. beginUpload()        opens a log row, returns an upload ID
 *   2. appendTicketBatch()  once per chunk of rows
 *   3. finishUpload()       closes the log row
 *
 * The original split it to stay inside the six-minute limit. It stays split
 * for two reasons that still apply: 26,000 rows is roughly 20MB of JSON and
 * Express refuses a body over 100KB by default, and the page shows real
 * progress instead of freezing.
 *
 *
 * WHAT IS DIFFERENT, AND WHY
 *
 *   compactTickets() HAS NO PORT.
 *       appendTicketBatch in Ingest.gs appends blindly, duplicates and all,
 *       because "looking up 20,000 existing IDs on every one of 20 batches
 *       would mean reading the whole sheet 20 times". finishUpload then read
 *       the entire tab, merged in JavaScript and rewrote it.
 *
 *       A primary key does that per row, indexed, as part of the insert. So
 *       the merge happens on the way in - see ticket-merge.js - and there is
 *       nothing left to compact afterwards. The dangerous part of the
 *       original goes with it: rewrite() exists because an earlier version
 *       "destroyed twenty thousand tickets" by clearing before writing.
 *       Nothing here ever clears the table.
 *
 *   recomputeAfterUpload() HAS NO PORT.
 *       It rebuilt the KPI_MONTHLY cache. There is no cache: scoring all
 *       26,000 tickets across eleven months measures 200ms, so KPI 1 is
 *       computed on the way out instead. Nothing to rebuild, nothing to go
 *       stale, and no second call that can be interrupted.
 *
 *   uploadStamp() HAS NO PORT.
 *       It re-derived the upload's start time by parsing it back out of the
 *       upload ID string, because appendTicketBatch had no cheap way to ask
 *       the log. Here it is one indexed lookup of upload_run.uploaded_at,
 *       which is exact, has no timezone arithmetic in it, and cannot drift
 *       from what the log row says. It also closes a hole: the original
 *       returned `new Date()` for an ID it did not recognise, so rows could
 *       be appended against an upload that was never opened. That is now an
 *       error.
 *
 *
 * NO REAL DATA IS IN THIS FILE.
 */

const crypto = require('crypto');
const db = require('./db');
const merge = require('./ticket-merge');

const TZ = 'Asia/Dhaka';                       // appsscript.json

/*
  How many TICKETS rows one download slice reads. Ingest.gs, same number:

    "Four thousand rows of 29 columns is about a second on this data and
     well under every limit there is, so the ceiling moves with the sheet
     rather than being a number that works until it does not."
*/
const UPLOAD_CSV_CHUNK = 4000;

/** What an upload's log row says before finishUpload closes it. */
const IN_PROGRESS = 'in progress';
const COMPLETE = 'complete';


// ---------------------------------------------------------------------------
// Names and lists
// ---------------------------------------------------------------------------

/** 'yyyyMMdd-HHmmss' in the dashboard's own timezone, as Utilities.formatDate. */
function stamp(when) {
  const d = when || new Date();
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).forEach(function (part) { p[part.type] = part.value; });

  const hh = p.hour === '24' ? '00' : p.hour;
  return p.year + p.month + p.day + '-' + hh + p.minute + p.second;
}


/**
 * 'UPL-20260916-103455-a1b2'.
 *
 * THE RANDOM SUFFIX IS NOT DECORATION. Ingest.gs:
 *
 *   "Seconds are not unique enough. Two uploads started in the same second
 *    used to share an ID, and deleting one then found two matching log rows
 *    and removed a single one - so the row appeared to survive being
 *    deleted."
 *
 * EIGHT CHARACTERS HERE, WHERE THE ORIGINAL USED FOUR, and that is the one
 * deliberate difference. Four hex characters is 65,536 values, and 65,536
 * is a much smaller number than it looks: drawing 200 of them collides
 * about a quarter of the time. That is not arithmetic on paper - a test
 * that generates 200 IDs and checks they differ failed on its first run,
 * with 199 unique.
 *
 * In the sheet a repeat produced two log rows with one ID, which is the bug
 * quoted above. Here upload_id is the PRIMARY KEY, so the database refuses
 * the second one and the upload fails to start - better, and still a
 * failure nobody could explain. Eight characters is four billion values,
 * which puts a repeat in 200 at about one run in two hundred thousand.
 *
 * Nothing reads the suffix. uploadCsvName only parses the date out of the
 * front, so the longer ID costs nothing anywhere.
 */
function newUploadId(when) {
  return 'UPL-' + stamp(when) + '-' +
         crypto.randomUUID().replace(/-/g, '').slice(0, 8);
}


/** ['a.xlsx', 'b.xlsx'] -> 'a.xlsx | b.xlsx'. The sheet's own shape. */
function joinList(list) {
  return (list || [])
    .map(function (s) { return String(s === null || s === undefined ? '' : s).trim(); })
    .filter(function (s) { return s !== ''; })
    .join(' | ');
}


/**
 * 'a.xlsx | b.xlsx' -> ['a.xlsx', 'b.xlsx'].
 *
 * Blanks dropped, because a list that ends in ' | ' would otherwise produce
 * an empty name - and an empty name matched against ticket.source_files
 * would match rows that have no sources at all.
 */
function splitList(text) {
  return String(text === null || text === undefined ? '' : text)
    .split(' | ')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ''; });
}


/**
 * A date cell as 'YYYY-MM-DD', or null for anything blank or unreadable.
 *
 * The browser works these out from the rows it parsed and sends them as
 * text. Null rather than '' because the column is a date: a date column
 * holding the empty string is not a thing PostgreSQL will accept, and
 * pretending otherwise would turn a missing range into an error message
 * about syntax.
 */
function readDay(value) {
  if (merge.isBlank(value)) return null;
  const text = String(value).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}


// ---------------------------------------------------------------------------
// 1. Opening an upload
// ---------------------------------------------------------------------------

/**
 * Opens an upload and returns its ID.
 *
 * @param {Object} meta { who, fileNames, reportTypes, departments,
 *                        totalRows, dateFrom, dateTo }
 *     `who` comes from the signed token and never from the browser - see the
 *     note on upload_run.uploaded_by in db/15-uploads.sql.
 * @return {Promise<{uploadId: string, startedAt: string}>}
 */
async function beginUpload(meta) {
  const m = meta || {};
  const uploadId = newUploadId();

  const rows = await db.query(
    `INSERT INTO upload_run (upload_id, uploaded_by, file_names, report_types,
                             departments, rows_in_file, date_from, date_to, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING upload_id, uploaded_at`,
    [uploadId,
     String(m.who || 'unknown').trim() || 'unknown',
     joinList(m.fileNames),
     joinList(m.reportTypes),
     joinList(m.departments),
     Number(m.totalRows) || 0,
     readDay(m.dateFrom),
     readDay(m.dateTo),
     IN_PROGRESS]);

  return {
    uploadId: rows[0].upload_id,
    startedAt: new Date(rows[0].uploaded_at).toISOString()
  };
}


// ---------------------------------------------------------------------------
// 2. One chunk of rows
// ---------------------------------------------------------------------------

/**
 * Merges one chunk of rows into `ticket`.
 *
 * NOT "dumb" THE WAY THE ORIGINAL WAS. appendTicketBatch in Ingest.gs
 * appended without checking for duplicates and left the cleaning up to
 * finishUpload, because a sheet has no index to look an ID up in. Here every
 * row goes through the same ON CONFLICT merge the CSV importer uses, so by
 * the time this returns the table is already correct.
 *
 * EVERY ROW IS STAMPED WITH THE UPLOAD'S START TIME, not this batch's, and
 * not whatever the browser put in the Last Updated cell. Ingest.gs:
 *
 *   "An upload arrives in batches 500 seconds apart, and mergeRows decides
 *    which of two rows for the same ticket is newer by comparing these - so
 *    two files of the same upload have to carry the same stamp, or the last
 *    batch to land would outrank the first for no reason."
 *
 * ONE TRANSACTION PER BATCH. A batch either lands whole or not at all, so a
 * dropped connection half way through cannot leave the counters in the log
 * row describing rows that are not there.
 *
 * @param {string} uploadId
 * @param {Array[]} rows  arrays in ticket-merge COLUMNS order
 * @return {Promise<{appended, inserted, updated, totalRows, problems}>}
 */
async function appendTicketBatch(uploadId, rows) {
  const batch = rows || [];
  const id = String(uploadId || '').trim();

  if (!id) throw new Error('No upload ID.');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    /*
      FOR UPDATE, so two batches of the same upload cannot both read the
      counters, both add their own total, and both write back - which would
      lose one of them. The lock is held for the length of this batch only.
    */
    const open = (await client.query(
      `SELECT uploaded_at, notes FROM upload_run WHERE upload_id = $1 FOR UPDATE`,
      [id])).rows[0];

    if (!open) {
      throw new Error('Upload ' + id + ' was never opened.');
    }

    if (!batch.length) {
      await client.query('COMMIT');
      const total = (await db.query('SELECT count(*)::int AS n FROM ticket'))[0].n;
      return { appended: 0, inserted: 0, updated: 0, totalRows: total,
               nulCells: 0, problems: [] };
    }

    const lastUpdated = new Date(open.uploaded_at).toISOString();
    const problems = [];
    let inserted = 0;
    let updated = 0;

    /*
      NUL BYTES ARE STRIPPED, AND SAYING SO IS PART OF THE DEAL. The rule in
      ticket-merge.js is "we quietly removed characters from your tickets is
      not something to do silently", and the CSV importer prints a count at
      the end of its run. This path had no end-of-run to print at, so the
      count was being lost - the one caller that is a person watching a
      progress bar was the one caller not being told.

      Counted as a difference rather than read directly, because the module
      counts for the life of the process and this is one batch of one upload.
    */
    const nulBefore = merge.nulCount();

    for (let i = 0; i < batch.length; i++) {
      const values = merge.valuesFromCells(batch[i], {
        lastUpdated: lastUpdated,
        problems: problems,
        where: 'row ' + (i + 1)
      });

      // A row with no ticket ID has nothing to merge on. The sheet version
      // dropped these during compaction; here there is no later pass to drop
      // them in, and a blank primary key would be refused by the database
      // with an error naming a constraint rather than a row.
      if (merge.isBlank(values[merge.AT.ticket_id])) {
        problems.push('row ' + (i + 1) + ': no Ticket ID, skipped');
        continue;
      }

      const got = await client.query(merge.MERGE_SQL, values);
      if (got.rows[0] && got.rows[0].inserted) inserted++;
      else updated++;
    }

    await client.query(
      `UPDATE upload_run
          SET rows_added   = rows_added   + $2,
              rows_updated = rows_updated + $3
        WHERE upload_id = $1`,
      [id, inserted, updated]);

    const total = (await client.query('SELECT count(*)::int AS n FROM ticket'))
      .rows[0].n;

    await client.query('COMMIT');

    const nulCells = merge.nulCount() - nulBefore;
    if (nulCells) {
      problems.push(nulCells + ' cell(s) contained a NUL byte, which ' +
                    'PostgreSQL cannot store - removed');
    }

    return {
      appended: inserted + updated,
      inserted: inserted,
      updated: updated,
      totalRows: total,
      nulCells: nulCells,
      problems: problems
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* connection is gone */ }
    throw err;
  } finally {
    client.release();
  }
}


// ---------------------------------------------------------------------------
// 3. Closing it
// ---------------------------------------------------------------------------

/**
 * Closes the log row and reports what the upload did.
 *
 * There is no consolidation to do - see the note at the top of this file -
 * so this is bookkeeping, and that is the point: the expensive, interruptible
 * step the original had here is gone.
 *
 * SAFE TO CALL TWICE. A browser that retries after a timeout must not end up
 * with two different answers, so this reads the counters rather than adding
 * to them.
 *
 * @return {Promise<{uploadId, rowsInFile, added, updated, total, notes}>}
 */
async function finishUpload(uploadId) {
  const id = String(uploadId || '').trim();
  if (!id) throw new Error('No upload ID.');

  const rows = await db.query(
    `UPDATE upload_run SET notes = $2 WHERE upload_id = $1
     RETURNING upload_id, rows_in_file, rows_added, rows_updated, notes`,
    [id, COMPLETE]);

  if (!rows.length) throw new Error('Upload ' + id + ' not found.');

  const total = (await db.query('SELECT count(*)::int AS n FROM ticket'))[0].n;

  return {
    uploadId:   rows[0].upload_id,
    rowsInFile: rows[0].rows_in_file,
    added:      rows[0].rows_added,
    updated:    rows[0].rows_updated,
    total:      total,
    notes:      rows[0].notes
  };
}


// ---------------------------------------------------------------------------
// The history screen
// ---------------------------------------------------------------------------

/**
 * Rows for the upload history table, newest first.
 *
 * THE KEY NAMES ARE THE ORIGINAL'S, including rowsKept and rowsMerged, which
 * read oddly beside columns headed "Rows Added" and "Rows Updated". They are
 * what App.html asks for, and renaming them here would mean the page needed
 * changing on the same day as the server. What they CONTAIN has changed, and
 * for the better - see the note on rows_added in db/15-uploads.sql.
 */
async function uploadHistory() {
  const rows = await db.query(
    `SELECT upload_id, uploaded_at, uploaded_by, file_names, report_types,
            departments, rows_in_file, rows_added, rows_updated,
            coalesce(to_char(date_from, 'YYYY-MM-DD'), '') AS date_from,
            coalesce(to_char(date_to,   'YYYY-MM-DD'), '') AS date_to,
            notes
       FROM upload_run
      ORDER BY uploaded_at DESC, upload_id DESC`);

  return rows.map(function (r) {
    return {
      uploadId:   r.upload_id,
      uploadedAt: new Date(r.uploaded_at).toISOString(),
      uploadedBy: r.uploaded_by,
      fileName:   r.file_names,
      reportType: r.report_types,
      department: r.departments,
      rowsInFile: r.rows_in_file,
      rowsKept:   r.rows_added,
      rowsMerged: r.rows_updated,
      dateFrom:   r.date_from,
      dateTo:     r.date_to,
      notes:      r.notes
    };
  });
}


// ---------------------------------------------------------------------------
// Undoing one
// ---------------------------------------------------------------------------

/**
 * Removes one upload and the rows that came only from its files.
 *
 * THE RULE, WHICH IS THE WHOLE DIFFICULTY. Ingest.gs:
 *
 *   "Data merges across uploads, so a ticket can carry sources from several.
 *    Only rows whose ENTIRE source list belongs to this upload are deleted;
 *    rows that another upload also vouched for survive, with this upload's
 *    filenames pruned from their source list. Deleting them outright would
 *    silently remove data the user never asked to lose."
 *
 * TWO STATEMENTS, AND THE ORDER IS NOT INTERCHANGEABLE. The delete has to
 * run first: it is defined as "no source outside this upload", and pruning
 * first would remove the very names that test looks at, leaving every row
 * looking like somebody else's.
 *
 * ONE TRANSACTION. A delete that removed the tickets and then failed to
 * remove the log row would leave an upload in the history offering to delete
 * rows that are already gone.
 *
 * A ticket with NO sources at all is never touched by either statement.
 * Ingest.gs guards the same case with `sources.length &&`, and the reason is
 * that an empty list belongs to nobody - deleting on "none of its sources
 * are outside this upload" would be true of it, vacuously, and it would be
 * removed by every delete anyone ever ran.
 *
 * @return {Promise<{removed, pruned, kept, files, uploadId}>}
 */
async function deleteUpload(uploadId) {
  const id = String(uploadId || '').trim();
  if (!id) throw new Error('No upload ID.');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const log = (await client.query(
      'SELECT upload_id, file_names FROM upload_run WHERE upload_id = $1 FOR UPDATE',
      [id])).rows[0];

    if (!log) throw new Error('Upload ' + id + ' not found.');

    const files = splitList(log.file_names);

    let removed = 0;
    let pruned = 0;

    if (files.length) {
      const gone = await client.query(
        `DELETE FROM ticket
          WHERE btrim(source_files) <> ''
            AND NOT EXISTS (
                  SELECT 1
                    FROM unnest(string_to_array(source_files, ' | ')) AS s
                   WHERE btrim(s) <> '' AND NOT (btrim(s) = ANY($1::text[]))
                )`,
        [files]);
      removed = gone.rowCount;

      const trimmed = await client.query(
        `UPDATE ticket
            SET source_files = coalesce((
                  SELECT string_agg(btrim(s), ' | ' ORDER BY n)
                    FROM unnest(string_to_array(source_files, ' | '))
                         WITH ORDINALITY AS t(s, n)
                   WHERE btrim(s) <> '' AND NOT (btrim(s) = ANY($1::text[]))
                ), '')
          WHERE EXISTS (
                  SELECT 1
                    FROM unnest(string_to_array(source_files, ' | ')) AS s
                   WHERE btrim(s) = ANY($1::text[])
                )`,
        [files]);
      pruned = trimmed.rowCount;
    }

    // The log row goes outright. Ingest.gs: "Leaving a 'deleted' marker
    // behind just accumulates dead rows in the history the user has to read
    // past."
    await client.query('DELETE FROM upload_run WHERE upload_id = $1', [id]);

    const kept = (await client.query('SELECT count(*)::int AS n FROM ticket'))
      .rows[0].n;

    await client.query('COMMIT');

    return { uploadId: id, removed: removed, pruned: pruned, kept: kept,
             files: files };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* connection is gone */ }
    throw err;
  } finally {
    client.release();
  }
}


// ---------------------------------------------------------------------------
// Downloading one again
// ---------------------------------------------------------------------------

/**
 * A download name built from the files the upload actually contained.
 *
 * Ingest.gs, unchanged, including why:
 *
 *   "It used to be the upload ID - 'UPL-20261028-102822-8817.csv' - which is
 *    the right name for a row in a log and the wrong one for something
 *    landing in somebody's Downloads folder beside four other exports."
 */
function uploadCsvName(uploadId, files) {
  const clean = (files || [])
    .map(function (f) { return String(f || '').replace(/\.[^.]+$/, '').trim(); })
    .filter(Boolean);

  let base = clean[0] || uploadId;
  if (clean.length > 1) base += ' and ' + (clean.length - 1) + ' more';

  // Windows refuses these outright and the rest make a mess of a shell, so
  // they go. The date is appended because the same export gets re-uploaded
  // monthly and two files of the same name in one folder helps nobody.
  base = base.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

  const when = String(uploadId).match(/^UPL-(\d{4})(\d{2})(\d{2})/);
  const day = when ? ' ' + when[1] + '-' + when[2] + '-' + when[3] : '';

  return (base + day).slice(0, 120) + '.csv';
}


/**
 * Escapes one value for CSV.
 *
 * Ingest.gs: "Ticket titles contain commas, quotes and newlines routinely,
 * so this is not optional - without it a single title splits into several
 * columns."
 *
 * Everything arriving here is already a string, because the SELECT renders
 * each column - see csvSelectList. The original had to cope with Dates and
 * booleans in the same function, which is where its date formatting lived.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}


/**
 * Every column, rendered as the text the CSV should carry.
 *
 * DONE IN SQL, NOT IN JAVASCRIPT, and the timestamps are why. Reading a
 * timestamptz into Node gives a Date, and turning it back into
 * '2026-08-03 09:15:00' means formatting it in Asia/Dhaka by hand, in a
 * process whose own timezone is whatever the machine happens to be set to.
 * `AT TIME ZONE 'Asia/Dhaka'` says it once, in the one place that cannot be
 * wrong about it, and what comes back is already the string.
 *
 * Booleans come out as TRUE and FALSE, which is what the ITSM exports use
 * and what truthy() reads back, so a downloaded file can be fed straight
 * into import-tickets.js.
 */
function csvSelectList() {
  return merge.COLUMNS.map(function (c) {
    const col = c[1];
    const kind = c[2];

    if (kind === 'ts') {
      return "coalesce(to_char(" + col + " AT TIME ZONE '" + TZ +
             "', 'YYYY-MM-DD HH24:MI:SS'), '') AS " + col;
    }
    if (kind === 'bool') {
      return "CASE WHEN " + col + " THEN 'TRUE' ELSE 'FALSE' END AS " + col;
    }
    if (kind === 'num') {
      return 'coalesce(' + col + "::text, '') AS " + col;
    }
    return 'coalesce(' + col + ", '') AS " + col;
  }).join(',\n       ');
}


/**
 * One slice of an upload's tickets, as CSV text.
 *
 * WHY IT IS CHUNKED. Ingest.gs, and it still applies: the old whole-file
 * version was "24,000 rows and about 11MB travelling through
 * google.script.run in one go, and the page gave no sign of life for the
 * whole of it". Sliced, "none of them is near any limit however big the
 * sheet gets, and the page can say how far it has got".
 *
 * WHAT CHANGED, AND IT IS WORTH KNOWING BEFORE READING THE NUMBERS. The
 * original sliced the whole TICKETS tab by row number and threw away the
 * rows that did not belong to the upload, because a sheet has no index to
 * ask. So its `total` was every ticket in the system and its progress was
 * "scanned 24,000 of 26,414" while the file being built held four hundred.
 *
 * Here the filtering is in the WHERE clause, so the slice is over the
 * upload's OWN rows. Same keys, same progress arithmetic, and the numbers
 * now describe the thing being downloaded.
 *
 * @param {string} uploadId
 * @param {number} startRow  1-based row of this upload's tickets to resume
 *                           at; 1 to start
 * @return {Promise<{csv, nextRow, done, scanned, total, fileName}>}
 */
async function uploadCsvChunk(uploadId, startRow) {
  const id = String(uploadId || '').trim();
  if (!id) throw new Error('No upload ID.');

  const log = (await db.query(
    'SELECT file_names FROM upload_run WHERE upload_id = $1', [id]))[0];
  if (!log) throw new Error('Upload ' + id + ' not found.');

  const files = splitList(log.file_names);

  // The caller counts from 1 and means "the first data row", which keeps
  // the arithmetic out of the page.
  const from = Math.max(1, Number(startRow) || 1);
  const first = from === 1;

  const lines = [];
  if (first) lines.push(merge.HEADERS.map(csvCell).join(','));

  // An upload that named no files owns no rows. Asking the database "which
  // tickets have a source in this empty list" would be a full scan to reach
  // the answer zero.
  if (!files.length) {
    return { csv: lines.join('\n'), nextRow: from, done: true, scanned: 0,
             total: 0, fileName: first ? uploadCsvName(id, files) : '' };
  }

  const belongs =
    `EXISTS (SELECT 1
               FROM unnest(string_to_array(source_files, ' | ')) AS s
              WHERE btrim(s) = ANY($1::text[]))`;

  const total = (await db.query(
    'SELECT count(*)::int AS n FROM ticket WHERE ' + belongs, [files]))[0].n;

  /*
    ORDERED BY request_date AND THEN BY ticket_id. The date is the order
    compactTickets left the sheet in, so a downloaded file looks the way it
    always did. The ticket ID is what makes the order TOTAL - without a
    tie-break, two rows sharing a request date could come back in either
    order on different calls, and a row would be sent twice or not at all
    across a page boundary.
  */
  const rows = await db.query(
    'SELECT ' + csvSelectList() +
    '\n  FROM ticket WHERE ' + belongs +
    '\n ORDER BY request_date NULLS LAST, ticket_id' +
    '\n LIMIT $2 OFFSET $3',
    [files, UPLOAD_CSV_CHUNK, from - 1]);

  rows.forEach(function (r) {
    lines.push(merge.NAMES.map(function (n) { return csvCell(r[n]); }).join(','));
  });

  const nextRow = from + rows.length;

  return {
    csv: lines.join('\n'),
    nextRow: nextRow,
    // rows.length < the chunk size means the table ran out, which is the
    // honest end condition even if `total` moved under us.
    done: rows.length < UPLOAD_CSV_CHUNK || nextRow > total,
    scanned: nextRow - 1,
    total: total,
    fileName: first ? uploadCsvName(id, files) : ''
  };
}


module.exports = {
  UPLOAD_CSV_CHUNK, IN_PROGRESS, COMPLETE,
  stamp, newUploadId, joinList, splitList, readDay,
  uploadCsvName, csvCell, csvSelectList, uploadCsvChunk,
  beginUpload, appendTicketBatch, finishUpload, uploadHistory, deleteUpload
};
