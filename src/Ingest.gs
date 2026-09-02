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
  const uploadId = 'UPL-' + Utilities.formatDate(new Date(), CONFIG_TZ(), 'yyyyMMdd-HHmmss');

  sheet.appendRow([
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
  ]);

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
 * Closes the upload: deduplicates, sorts, updates the log, refreshes the cache.
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

    // Kpi.gs may not exist yet. Apps Script shares one global namespace across
    // files, so this is how you ask "has that file been added?" without an
    // error taking down the whole upload.
    if (typeof recomputeKpiCache === 'function') {
      result.months = recomputeKpiCache();
    }

    return result;
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

  // Clear the old block, write the new one. Clearing first matters — the
  // deduplicated set is shorter, and stale rows would otherwise survive
  // underneath it.
  sheet.getRange(2, 1, before, COL.WIDTH).clearContent();
  if (merged.length) {
    sheet.getRange(2, 1, merged.length, COL.WIDTH).setValues(merged);
  }

  return { before: before, kept: merged.length, merged: before - merged.length };
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

    const have = out[i];
    const isEmpty = (have === '' || have === null || have === undefined);
    if (isEmpty && incoming[i] !== '' && incoming[i] !== null && incoming[i] !== undefined) {
      out[i] = incoming[i];
    }
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
      dateFrom:   String(r[9]),
      dateTo:     String(r[10]),
      notes:      String(r[11])
    };
  }).reverse();
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
  if (!CONFIG.SPREADSHEET_ID) {
    throw new Error('CONFIG.SPREADSHEET_ID is not set. Run setupDatabase() first.');
  }
  const sheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID).getSheetByName(tabName);
  if (!sheet) throw new Error('Missing tab: ' + tabName + '. Run setupDatabase() again.');
  return sheet;
}

/** Sheets can hand back true, 'TRUE' or 'true' for the same cell. */
function truthy(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

/** The script's timezone, for stamping upload IDs. */
function CONFIG_TZ() {
  return Session.getScriptTimeZone() || 'Asia/Dhaka';
}
