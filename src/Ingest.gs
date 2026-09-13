/**
 * Ingest.gs — receives parsed ticket rows from the browser and stores them.
 *
 * THE DIVISION OF LABOUR
 * The browser does the heavy lifting: it reads the .xlsx with SheetJS, works out
 * which report each file is, normalises every row, and merges the five files
 * into one deduplicated set. Only clean, uniform rows reach this file.
 *
 * Why that way round? Parsing a 20,000-row spreadsheet on the server would run
 * straight into the 6-minute execution ceiling. In the browser it takes about
 * two seconds and costs Google nothing.
 *
 * THE UPLOAD IS THREE CALLS
 *   1. beginUpload()        -> opens a log entry, returns an upload ID
 *   2. appendTicketBatch()  -> called once per chunk of rows, appends to the sheet
 *   3. finishUpload()       -> deduplicates, sorts, closes the log entry
 *
 * Splitting it up keeps every individual call well inside the time limit, and
 * lets the page show real progress instead of freezing.
 */


/**
 * Column positions, worked out once from CONFIG.TICKET_COLUMNS.
 *
 * Rows travel as plain arrays rather than objects — for 20,000 rows, repeating
 * 29 key names on every row would multiply the payload for no benefit. The cost
 * is that we address fields by number, so these constants keep it readable.
 */
const COL = (function () {
  const index = {};
  CONFIG.TICKET_COLUMNS.forEach(function (name, i) { index[name] = i; });
  return {
    TICKET_ID:   index['Ticket ID'],
    SERVICE:     index['Service'],
    PART:        index['Part'],
    REQUEST_DATE:index['Request Date'],
    COMPLETION:  index['Completion Date'],
    DELAY_DAYS:  index['Delay Days'],
    IN_CHARGE:   index['Current Activity In Charge'],
    DEPARTMENT:  index['Department'],
    IN_OVERALL:  index['In Overall Report'],
    IN_DEPT:     index['In Dept Report'],
    SOURCE:      index['Source Files'],
    UPDATED:     index['Last Updated'],
    WIDTH:       CONFIG.TICKET_COLUMNS.length
  };
})();


/**
 * Opens an upload and returns its ID.
 *
 * @param {Object} meta  { fileNames, reportTypes, departments, totalRows,
 *                         dateFrom, dateTo }
 * @return {Object} { uploadId, startedAt }
 */
function beginUpload(meta) {
  const sheet = sheetFor(CONFIG.SHEETS.UPLOADS);

  // Seconds are not unique enough. Two uploads started in the same second used
  // to share an ID, and deleting one then found two matching log rows and
  // removed a single one — so the row appeared to survive being deleted. The
  // suffix makes the ID the unique key that deleteUpload assumes it is.
  const uploadId = 'UPL-' +
    Utilities.formatDate(new Date(), CONFIG_TZ(), 'yyyyMMdd-HHmmss') + '-' +
    Utilities.getUuid().slice(0, 4);

  const row = sheet.getLastRow() + 1;

  // Force the two date columns to plain text BEFORE writing. Left alone, Sheets
  // parses '2026-08-01' into a Date and hands it back as
  // 'Sat Aug 01 2026 00:00:00 GMT+0600 (Bangladesh Standard Time)'.
  sheet.getRange(row, 10, 1, 2).setNumberFormat('@');

  sheet.getRange(row, 1, 1, CONFIG.UPLOAD_COLUMNS.length).setValues([[
    uploadId,
    new Date(),
    Session.getActiveUser().getEmail() || 'unknown',
    (meta.fileNames || []).join(' | '),
    (meta.reportTypes || []).join(' | '),
    (meta.departments || []).join(' | '),
    meta.totalRows || 0,
    0,                       // rows added    — filled in by finishUpload
    0,                       // rows updated  — filled in by finishUpload
    meta.dateFrom || '',
    meta.dateTo || '',
    'in progress'
  ]]);

  return { uploadId: uploadId, startedAt: new Date().toISOString() };
}


/**
 * Appends one chunk of rows to TICKETS.
 *
 * Deliberately dumb — it appends without checking for duplicates. Looking up
 * 20,000 existing IDs on every one of 20 batches would mean reading the whole
 * sheet 20 times. Instead we append fast and clean up once, in finishUpload().
 *
 * @param {string}   uploadId
 * @param {Array[]}  rows  arrays in CONFIG.TICKET_COLUMNS order
 * @return {Object} { appended, totalRows }
 */
function appendTicketBatch(uploadId, rows) {
  if (!rows || !rows.length) return { appended: 0, totalRows: 0 };

  // A lock stops two uploads interleaving their writes and corrupting the
  // sheet. Only one execution can hold it at a time; the rest queue.
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const sheet = sheetFor(CONFIG.SHEETS.TICKETS);
    const stamp = new Date();

    const clean = rows.map(function (row) {
      const out = row.slice(0, COL.WIDTH);
      while (out.length < COL.WIDTH) out.push('');   // pad short rows
      out[COL.UPDATED] = stamp;
      return out;
    });

    sheet.getRange(sheet.getLastRow() + 1, 1, clean.length, COL.WIDTH)
         .setValues(clean);

    return { appended: clean.length, totalRows: sheet.getLastRow() - 1 };
  } finally {
    lock.releaseLock();      // finally, so a crash cannot leave it locked
  }
}


/**
 * Appends a batch of TRAINING FEEDBACK rows.
 *
 * The KPI 2 twin of appendTicketBatch. Kept separate rather than parameterised
 * because the two write different sheets with different widths and different
 * merge keys, and a single function juggling both would be the kind of code
 * where a KPI 1 change quietly breaks KPI 2.
 *
 * The merge key is Response ID — the source filename plus the form's own row
 * number — so re-uploading the same file updates its rows instead of doubling
 * the respondent count.
 *
 * @param {string}    uploadId
 * @param {Array[]}   rows      shaped as CONFIG.TRAINING_COLUMNS
 * @return {Object} { appended, totalRows }
 */
function appendFeedbackBatch(uploadId, rows) {
  if (!rows || !rows.length) return { appended: 0, totalRows: 0 };

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    ensureTrainingHeaders();

    const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
    const width = CONFIG.TRAINING_COLUMNS.length;
    const stamp = new Date();
    const updatedAt = CONFIG.TRAINING_COLUMNS.indexOf('Uploaded At');
    const monthAt = CONFIG.TRAINING_COLUMNS.indexOf('Month');

    const clean = rows.map(function (row) {
      const out = row.slice(0, width);
      while (out.length < width) out.push('');
      out[updatedAt] = stamp;
      return out;
    });

    const first = sheet.getLastRow() + 1;

    // Month must be plain text before it is written. Left alone, Sheets parses
    // '2026-05' into a Date and every later lookup by month string misses —
    // the same trap KPI 1's cache hit.
    sheet.getRange(first, monthAt + 1, clean.length, 1).setNumberFormat('@');
    sheet.getRange(first, 1, clean.length, width).setValues(clean);

    return { appended: clean.length, totalRows: sheet.getLastRow() - 1 };
  } finally {
    lock.releaseLock();
  }
}


/**
 * Deduplicates the TRAINING tab on Response ID, newest write winning.
 *
 * @return {Object} { kept, merged }
 */
function compactFeedback() {
  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const lastRow = sheet.getLastRow();
  const width = CONFIG.TRAINING_COLUMNS.length;
  if (lastRow < 2) return { kept: 0, merged: 0 };

  const rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const byId = {};
  const order = [];

  rows.forEach(function (row) {
    const id = String(row[0] || '').trim();
    if (!id) return;
    if (!byId[id]) order.push(id);
    byId[id] = row;            // a later upload of the same response wins
  });

  const kept = order.map(function (id) { return byId[id]; });
  const merged = rows.length - kept.length;

  if (kept.length) {
    sheet.getRange(2, CONFIG.TRAINING_COLUMNS.indexOf('Month') + 1, kept.length, 1)
         .setNumberFormat('@');
  }
  rewrite(sheet, kept, rows.length, width);

  return { kept: kept.length, merged: merged };
}


/**
 * Closes a training feedback upload.
 *
 * Separate from finishUpload because there is no KPI cache to rebuild —
 * KPI 2 scores live off the TRAINING tab, so the work here is deduplicate,
 * close the log row, and report.
 *
 * @param {string} uploadId
 * @return {Object} summary
 */
function finishFeedbackUpload(uploadId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);

  try {
    const result = compactFeedback();

    const log = sheetFor(CONFIG.SHEETS.UPLOADS);
    const lastRow = log.getLastRow();
    if (lastRow > 1) {
      const ids = log.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i][0]) === uploadId) {
          // This upload's own stored rows, not the whole tab's. Writing
          // compactFeedback().kept here made a 15-response file report 30
          // stored as soon as a second file existed.
          const mine = countFeedbackOf(String(log.getRange(i + 2, 4).getValue() || ''));
          log.getRange(i + 2, 8, 1, 2).setValues([[mine, result.merged]]);
          log.getRange(i + 2, 12).setValue('complete');
          break;
        }
      }
    }

    result.months = typeof listFeedbackMonths === 'function' ? listFeedbackMonths() : [];
    return result;
  } finally {
    lock.releaseLock();
  }
}


/**
 * Adds any TRAINING header the layout has gained but the sheet has not.
 *
 * TRAINING_COLUMNS grows over time — 'Zone' arrived when the feedback form
 * started asking for it. Rows are addressed by position, so a new column
 * appended at the end costs the stored data nothing; only the header row on
 * the sheet needs catching up, and only so a human reading it sees the right
 * label. Idempotent, and cheap enough to run before every write.
 */
function ensureTrainingHeaders() {
  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const want = CONFIG.TRAINING_COLUMNS;

  if (sheet.getMaxColumns() < want.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(),
                             want.length - sheet.getMaxColumns());
  }

  const have = sheet.getRange(1, 1, 1, want.length).getValues()[0];
  let gap = false;
  for (let i = 0; i < want.length; i++) {
    if (String(have[i] || '').trim() !== want[i]) { gap = true; break; }
  }
  if (gap) sheet.getRange(1, 1, 1, want.length).setValues([want]);
}


/**
 * Training responses whose upload is no longer in the history.
 *
 * These exist because deleteUpload used to remove the log row and the tickets
 * and leave the TRAINING tab untouched, so every feedback upload deleted
 * before that was fixed left its responses behind — invisible in the upload
 * history and still counted by KPI 2. That cannot happen again, but the rows
 * already orphaned are still there and only a sweep like this will find them.
 *
 * Read-only. Nothing is removed until purgeOrphanedFeedback is called.
 *
 * @return {Object} { orphans, kept, files }
 */
function auditFeedback() {
  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { orphans: 0, kept: 0, files: [] };

  const known = knownUploadFiles();
  const COL2 = trainingColumns();
  const rows = sheet.getRange(2, 1, lastRow - 1, CONFIG.TRAINING_COLUMNS.length).getValues();

  const byFile = {};
  const order = [];
  let orphans = 0;
  let kept = 0;

  rows.forEach(function (row) {
    if (!String(row[COL2.RESPONSE_ID] || '').trim()) return;

    const source = sourceOf(row, COL2);
    if (source && known[source]) { kept++; return; }

    orphans++;
    const name = source || '(no source file recorded)';
    if (!byFile[name]) { byFile[name] = 0; order.push(name); }
    byFile[name]++;
  });

  return {
    orphans: orphans,
    kept: kept,
    files: order.map(function (name) {
      return { fileName: name, rows: byFile[name] };
    }).sort(function (a, b) { return b.rows - a.rows; })
  };
}


/**
 * Removes the responses auditFeedback found.
 *
 * @return {Object} { removed, kept, files }
 */
function purgeOrphanedFeedback() {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);

  try {
    const audit = auditFeedback();
    if (!audit.orphans) return { removed: 0, kept: audit.kept, files: [] };

    const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
    const width = CONFIG.TRAINING_COLUMNS.length;
    const lastRow = sheet.getLastRow();
    const known = knownUploadFiles();
    const COL2 = trainingColumns();

    const rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();
    const survivors = rows.filter(function (row) {
      if (!String(row[COL2.RESPONSE_ID] || '').trim()) return false;
      const source = sourceOf(row, COL2);
      return source && known[source];
    });

    if (survivors.length) {
      sheet.getRange(2, COL2.MONTH + 1, survivors.length, 1).setNumberFormat('@');
    }
    rewrite(sheet, survivors, rows.length, width);

    return { removed: audit.orphans, kept: survivors.length, files: audit.files };
  } finally {
    lock.releaseLock();
  }
}


/** Every filename any surviving upload claims. */
function knownUploadFiles() {
  const log = sheetFor(CONFIG.SHEETS.UPLOADS);
  const lastRow = log.getLastRow();
  const known = {};
  if (lastRow < 2) return known;

  log.getRange(2, 4, lastRow - 1, 1).getValues().forEach(function (row) {
    String(row[0] || '').split(' | ').forEach(function (name) {
      const trimmed = name.trim();
      if (trimmed) known[trimmed] = true;
    });
  });
  return known;
}


/**
 * Which file did this response arrive in?
 *
 * Source File when it is filled in; otherwise the Response ID, which is
 * 'filename#rownumber' and so still identifies the file for rows written
 * before Source File was populated.
 */
function sourceOf(row, COL2) {
  const source = String(row[COL2.SOURCE] || '').trim();
  if (source) return source;

  const id = String(row[COL2.RESPONSE_ID] || '').trim();
  const hash = id.lastIndexOf('#');
  return hash > 0 ? id.slice(0, hash) : '';
}


/**
 * How many stored responses came from these files?
 *
 * @param {string} fileList  the log row's ' | '-joined filenames
 * @return {number}
 */
function countFeedbackOf(fileList) {
  const files = {};
  fileList.split(' | ').forEach(function (name) {
    const trimmed = name.trim();
    if (trimmed) files[trimmed] = true;
  });

  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const COL2 = trainingColumns();
  const names = Object.keys(files);
  const rows = sheet.getRange(2, 1, lastRow - 1, CONFIG.TRAINING_COLUMNS.length).getValues();

  let mine = 0;
  rows.forEach(function (row) {
    const source = String(row[COL2.SOURCE] || '').trim();
    if (source && files[source]) { mine++; return; }

    const id = String(row[COL2.RESPONSE_ID] || '').trim();
    for (let i = 0; i < names.length; i++) {
      if (id.indexOf(names[i] + '#') === 0) { mine++; return; }
    }
  });

  return mine;
}


/**
 * Closes the upload: deduplicates, sorts, updates the log.
 *
 * DOES NOT RECOMPUTE. That is a separate call now — see recomputeAfterUpload.
 * Consolidating twenty-eight thousand tickets and then re-scoring all of them
 * in one server call ran past the six-minute ceiling and the run was killed
 * mid-write. Two calls means two budgets, and each is comfortably inside one.
 *
 * @param {string} uploadId
 * @return {Object} summary
 */
function finishUpload(uploadId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);

  try {
    const result = compactTickets();

    // Close out the log row.
    const log = sheetFor(CONFIG.SHEETS.UPLOADS);
    const lastRow = log.getLastRow();
    if (lastRow > 1) {
      const ids = log.getRange(2, 1, lastRow - 1, 1).getValues();
      for (let i = ids.length - 1; i >= 0; i--) {
        if (String(ids[i][0]) === uploadId) {
          log.getRange(i + 2, 8, 1, 2).setValues([[result.kept, result.merged]]);
          log.getRange(i + 2, 12).setValue('complete');
          break;
        }
      }
    }

    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}


/**
 * Rebuilds the KPI 1 cache. Called straight after finishUpload.
 *
 * Split out so the consolidate and the re-score cannot share one six-minute
 * budget. If this one is interrupted the tickets are already safely stored —
 * only the cache is stale, and pressing Refresh rebuilds it.
 *
 * @return {Object} { months }
 */
function recomputeAfterUpload() {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);

  try {
    // Kpi.gs may not exist yet. Apps Script shares one global namespace across
    // files, so this is how you ask "has that file been added?" without an
    // error taking down the whole upload.
    const months = (typeof recomputeKpiCache === 'function') ? recomputeKpiCache() : [];
    return { months: months };
  } finally {
    lock.releaseLock();
  }
}


/**
 * Collapses duplicate Ticket IDs into one row each, then sorts by request date.
 *
 * Duplicates are expected, not exceptional. Your five files overlap by design —
 * the Service/Part export and the department exports describe many of the same
 * tickets, and re-uploading an overlapping date range is normal practice.
 *
 * The merge is FIELD BY FIELD, not row replacing row. That matters: the
 * Service/Part export leaves Process, Details, Current Activity, Lead-time and
 * Status blank, while the department exports fill them in and add the three
 * man-hour columns. Replacing whole rows would throw away whichever arrived
 * first. Merging keeps everything.
 *
 * @return {Object} { before, kept, merged }
 */
function compactTickets() {
  const sheet = sheetFor(CONFIG.SHEETS.TICKETS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 3) {
    return { before: Math.max(0, lastRow - 1), kept: Math.max(0, lastRow - 1), merged: 0 };
  }

  // One read for the whole sheet. Reading row by row would be hundreds of
  // times slower — each call crosses from the script to Google's servers.
  const rows = sheet.getRange(2, 1, lastRow - 1, COL.WIDTH).getValues();
  const before = rows.length;

  const byId = {};
  const order = [];

  rows.forEach(function (row) {
    const id = String(row[COL.TICKET_ID] || '').trim();
    if (!id) return;

    if (!byId[id]) {
      byId[id] = row;
      order.push(id);
      return;
    }
    byId[id] = mergeRows(byId[id], row);
  });

  const merged = order.map(function (id) { return byId[id]; });

  merged.sort(function (a, b) {
    const x = String(a[COL.REQUEST_DATE] || '');
    const y = String(b[COL.REQUEST_DATE] || '');
    return x < y ? -1 : (x > y ? 1 : 0);
  });

  rewrite(sheet, merged, before, COL.WIDTH);

  return { before: before, kept: merged.length, merged: before - merged.length };
}


/**
 * Replaces a sheet's rows with a shorter set, WITHOUT a window where the data
 * does not exist.
 *
 * This used to clear the whole block and then write the survivors back. That
 * ordering destroyed twenty thousand tickets: an upload of six section exports
 * on top of the existing data pushed the run past the six-minute ceiling, Apps
 * Script killed it, and what survived was the clear and not the write. "Upload
 * failed: Exceeded maximum execution time" and an empty TICKETS tab are the
 * same event.
 *
 * Writing first is safe in a way clearing first can never be. The survivors
 * always fit inside the block they came from, so they are written over the top
 * of it; only the tail below them is stale, and that is cleared afterwards.
 * Interrupted at any point the sheet still holds every surviving row — at
 * worst with some leftover duplicates below, which the next compaction
 * removes. Losing a few minutes of work beats losing the database.
 *
 * @param {Sheet}   sheet
 * @param {Array[]} survivors  never longer than `before`
 * @param {number}  before     how many rows were there
 * @param {number}  width
 */
function rewrite(sheet, survivors, before, width) {
  if (survivors.length) {
    sheet.getRange(2, 1, survivors.length, width).setValues(survivors);
  }

  // Commit the survivors before touching anything else, so a kill here cannot
  // take them with it.
  SpreadsheetApp.flush();

  const tail = before - survivors.length;
  if (tail > 0) {
    sheet.getRange(2 + survivors.length, 1, tail, width).clearContent();
  }
}


/**
 * Merges two rows describing the same ticket.
 *
 * Rules:
 *   - a non-empty value beats an empty one
 *   - when both are non-empty the existing value stands (first write wins,
 *     so a re-upload cannot quietly rewrite history)
 *   - the two "In ... Report" flags are OR'd, since a ticket can legitimately
 *     appear in both the overall export and a department export
 *   - Source Files accumulates, so the audit trail shows every file that
 *     contributed
 *
 * @param {Array} existing
 * @param {Array} incoming
 * @return {Array}
 */
function mergeRows(existing, incoming) {
  const out = existing.slice();

  for (let i = 0; i < COL.WIDTH; i++) {
    if (i === COL.IN_OVERALL || i === COL.IN_DEPT || i === COL.SOURCE) continue;
    if (isBlank(out[i]) && !isBlank(incoming[i])) out[i] = incoming[i];
  }

  out[COL.IN_OVERALL] = truthy(existing[COL.IN_OVERALL]) || truthy(incoming[COL.IN_OVERALL]);
  out[COL.IN_DEPT]    = truthy(existing[COL.IN_DEPT])    || truthy(incoming[COL.IN_DEPT]);

  const sources = String(existing[COL.SOURCE] || '').split(' | ')
    .concat(String(incoming[COL.SOURCE] || '').split(' | '))
    .filter(function (s) { return s.trim() !== ''; });
  out[COL.SOURCE] = sources.filter(function (s, i) {
    return sources.indexOf(s) === i;            // unique, order preserved
  }).join(' | ');

  return out;
}


/**
 * Rows for the upload history table, newest first.
 *
 * @return {Object[]}
 */
function getUploadHistory() {
  const sheet = sheetFor(CONFIG.SHEETS.UPLOADS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const rows = sheet.getRange(2, 1, lastRow - 1, CONFIG.UPLOAD_COLUMNS.length).getValues();

  return rows.map(function (r) {
    return {
      uploadId:   String(r[0]),
      uploadedAt: r[1] instanceof Date ? r[1].toISOString() : String(r[1]),
      uploadedBy: String(r[2]),
      fileName:   String(r[3]),
      reportType: String(r[4]),
      department: String(r[5]),
      rowsInFile: Number(r[6]) || 0,
      rowsKept:   Number(r[7]) || 0,
      rowsMerged: Number(r[8]) || 0,
      dateFrom:   dayString(r[9]),
      dateTo:     dayString(r[10]),
      notes:      String(r[11])
    };
  }).reverse();
}


/**
 * Renders a cell as 'YYYY-MM-DD' whether it came back as text or a Date.
 *
 * Rows written before the text-format fix are still sitting in the sheet as
 * real Dates, so reading has to cope with both.
 *
 * @param {*} value
 * @return {string}
 */
function dayString(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) {
    return Utilities.formatDate(value, CONFIG_TZ(), 'yyyy-MM-dd');
  }
  return String(value).trim().slice(0, 10);
}


/**
 * Removes one upload and the rows that came only from its files.
 *
 * Data merges across uploads, so a ticket can carry sources from several. Only
 * rows whose ENTIRE source list belongs to this upload are deleted; rows that
 * another upload also vouched for survive, with this upload's filenames pruned
 * from their source list. Deleting them outright would silently remove data the
 * user never asked to lose.
 *
 * DELETES FROM BOTH SHEETS
 * This used to touch TICKETS only, so deleting a training-feedback upload took
 * the row out of the history and left every response of it on the TRAINING tab —
 * KPI 2 went on reporting data the user believed they had deleted. An upload is
 * now removed from whichever sheet it actually landed in.
 *
 * DOES NOT REWRITE A SHEET IT DID NOT CHANGE
 * The old version cleared and rewrote all ~20,000 ticket rows on every delete,
 * even when it removed nothing — several minutes of work for a feedback upload
 * that owns no tickets at all. Past the execution limit the run was killed with
 * its writes still buffered, so the log row came back and the browser never got
 * a reply: the delete looked like it had done nothing, and had to be repeated.
 * Each sheet is now touched only if this upload actually owns rows on it, and
 * the KPI 1 cache is rebuilt only when tickets really changed.
 *
 * @param {string} uploadId
 * @return {Object} { removed, kept, feedbackRemoved, feedbackKept, months, sheets }
 */
function deleteUpload(uploadId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(60000);

  try {
    const log = sheetFor(CONFIG.SHEETS.UPLOADS);
    const lastLogRow = log.getLastRow();
    if (lastLogRow < 2) throw new Error('No uploads recorded.');

    const logRows = log.getRange(2, 1, lastLogRow - 1, CONFIG.UPLOAD_COLUMNS.length).getValues();

    let logIndex = -1;
    for (let i = logRows.length - 1; i >= 0; i--) {
      if (String(logRows[i][0]) === uploadId) { logIndex = i; break; }
    }
    if (logIndex === -1) throw new Error('Upload ' + uploadId + ' not found.');

    // Which files did this upload contribute?
    const files = {};
    String(logRows[logIndex][3] || '').split(' | ').forEach(function (name) {
      const trimmed = name.trim();
      if (trimmed) files[trimmed] = true;
    });

    const tickets  = removeTicketsOf(files);
    const feedback = removeFeedbackOf(files);

    // Remove the log row outright. Leaving a "deleted" marker behind just
    // accumulates dead rows in the history the user has to read past.
    log.deleteRow(logIndex + 2);

    // Commit everything above BEFORE the expensive part. Apps Script buffers
    // sheet writes and discards the buffer if a run is killed, which is how a
    // deleted upload used to reappear. Flushed here, the deletion stands even
    // if the recompute below never finishes.
    SpreadsheetApp.flush();

    // Only tickets feed the KPI 1 cache, and only a real change can move it.
    let months = [];
    if (tickets.changed && typeof recomputeKpiCache === 'function') {
      months = recomputeKpiCache();
    }

    const sheets = [];
    if (tickets.changed)  sheets.push(CONFIG.SHEETS.TICKETS);
    if (feedback.changed) sheets.push(CONFIG.SHEETS.TRAINING);

    return {
      removed:         tickets.removed,
      kept:            tickets.kept,
      feedbackRemoved: feedback.removed,
      feedbackKept:    feedback.kept,
      months:          months,
      sheets:          sheets
    };
  } finally {
    lock.releaseLock();
  }
}


/**
 * Drops the tickets that belong only to the given files.
 *
 * @param {Object} files  filename -> true
 * @return {Object} { removed, kept, changed }
 */
function removeTicketsOf(files) {
  const sheet = sheetFor(CONFIG.SHEETS.TICKETS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { removed: 0, kept: 0, changed: false };

  const rows = sheet.getRange(2, 1, lastRow - 1, COL.WIDTH).getValues();
  const survivors = [];
  let removed = 0;
  let pruned = 0;

  rows.forEach(function (row) {
    const sources = String(row[COL.SOURCE] || '').split(' | ')
      .map(function (s) { return s.trim(); })
      .filter(Boolean);

    const others = sources.filter(function (s) { return !files[s]; });

    if (sources.length && others.length === 0) {
      removed++;                       // came only from this upload
      return;
    }

    if (others.length !== sources.length) {
      row[COL.SOURCE] = others.join(' | ');
      pruned++;
    }
    survivors.push(row);
  });

  // Nothing of ours is here. Writing the sheet back unchanged would cost
  // minutes on twenty thousand rows and achieve precisely nothing.
  if (!removed && !pruned) {
    return { removed: 0, kept: survivors.length, changed: false };
  }

  rewrite(sheet, survivors, rows.length, COL.WIDTH);

  return { removed: removed, kept: survivors.length, changed: true };
}


/**
 * Drops the training responses that arrived in the given files.
 *
 * Simpler than the ticket case: a response belongs to exactly one file, so
 * there is no partial ownership to reason about. Matched on Source File, and
 * on the Response ID as a fallback — the ID is 'filename#rownumber', so a row
 * written before Source File was populated is still identifiable.
 *
 * @param {Object} files  filename -> true
 * @return {Object} { removed, kept, changed }
 */
function removeFeedbackOf(files) {
  const sheet = sheetFor(CONFIG.SHEETS.TRAINING);
  const lastRow = sheet.getLastRow();
  const width = CONFIG.TRAINING_COLUMNS.length;
  if (lastRow < 2) return { removed: 0, kept: 0, changed: false };

  const names = Object.keys(files);
  const COL2 = trainingColumns();
  const rows = sheet.getRange(2, 1, lastRow - 1, width).getValues();

  const survivors = [];
  let removed = 0;

  rows.forEach(function (row) {
    const source = String(row[COL2.SOURCE] || '').trim();
    const id = String(row[COL2.RESPONSE_ID] || '').trim();

    let mine = source && files[source];
    if (!mine && id) {
      for (let i = 0; i < names.length; i++) {
        if (id.indexOf(names[i] + '#') === 0) { mine = true; break; }
      }
    }

    if (mine) { removed++; return; }
    survivors.push(row);
  });

  if (!removed) return { removed: 0, kept: survivors.length, changed: false };

  if (survivors.length) {
    sheet.getRange(2, COL2.MONTH + 1, survivors.length, 1).setNumberFormat('@');
  }
  rewrite(sheet, survivors, rows.length, width);

  return { removed: removed, kept: survivors.length, changed: true };
}


/**
 * The stored tickets for one upload, as CSV text for download.
 *
 * @param {string} uploadId
 * @return {Object} { fileName, csv, rows }
 */
function getUploadCsv(uploadId) {
  const log = sheetFor(CONFIG.SHEETS.UPLOADS);
  const lastLogRow = log.getLastRow();
  if (lastLogRow < 2) throw new Error('No uploads recorded.');

  const logRows = log.getRange(2, 1, lastLogRow - 1, CONFIG.UPLOAD_COLUMNS.length).getValues();
  let match = null;
  for (let i = logRows.length - 1; i >= 0; i--) {
    if (String(logRows[i][0]) === uploadId) { match = logRows[i]; break; }
  }
  if (!match) throw new Error('Upload ' + uploadId + ' not found.');

  const files = {};
  String(match[3] || '').split(' | ').forEach(function (name) {
    const trimmed = name.trim();
    if (trimmed) files[trimmed] = true;
  });

  const tickets = sheetFor(CONFIG.SHEETS.TICKETS);
  const lastRow = tickets.getLastRow();

  const out = [CONFIG.TICKET_COLUMNS.map(csvCell).join(',')];
  let count = 0;

  if (lastRow > 1) {
    const rows = tickets.getRange(2, 1, lastRow - 1, COL.WIDTH).getValues();
    rows.forEach(function (row) {
      const sources = String(row[COL.SOURCE] || '').split(' | ');
      const belongs = sources.some(function (s) { return files[s.trim()]; });
      if (!belongs) return;
      out.push(row.map(csvCell).join(','));
      count++;
    });
  }

  return {
    fileName: uploadId + '.csv',
    csv: out.join('\n'),
    rows: count
  };
}


/**
 * Escapes one value for CSV.
 *
 * Ticket titles contain commas, quotes and newlines routinely, so this is not
 * optional — without it a single title splits into several columns.
 */
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = (value instanceof Date)
    ? Utilities.formatDate(value, CONFIG_TZ(), 'yyyy-MM-dd HH:mm:ss')
    : String(value);
  if (/[",\n\r]/.test(text)) {
    text = '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}


/**
 * Deletes every ticket. Upload history is kept as audit evidence.
 * Run by hand from the editor when you want a clean slate.
 */
function clearAllTickets() {
  const sheet = sheetFor(CONFIG.SHEETS.TICKETS);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, COL.WIDTH).clearContent();
  }
  Logger.log('Cleared %s ticket rows. Upload history left intact.', Math.max(0, lastRow - 1));
}


// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** @return {Sheet} */
function sheetFor(tabName) {
  const id = getSpreadsheetId();
  if (!id) {
    throw new Error('No spreadsheet connected. Run setupDatabase() first.');
  }
  const sheet = SpreadsheetApp.openById(id).getSheetByName(tabName);
  if (!sheet) throw new Error('Missing tab: ' + tabName + '. Run setupDatabase() again.');
  return sheet;
}

/** Sheets can hand back true, 'TRUE' or 'true' for the same cell. */
function truthy(value) {
  return value === true || String(value).toLowerCase() === 'true';
}


/**
 * Is this cell effectively empty?
 *
 * The trim matters. Some Completion Date cells in the ITSM export contain a
 * single space. Testing only for '' treats that space as a real value, so the
 * merge keeps it and the genuine completion date from the other report never
 * replaces it — one ticket silently becomes "incomplete". With a KPI whose
 * whole margin is one ticket, that is not a rounding detail.
 *
 * @param {*} value
 * @return {boolean}
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/** The script's timezone, for stamping upload IDs. */
function CONFIG_TZ() {
  return Session.getScriptTimeZone() || 'Asia/Dhaka';
}
