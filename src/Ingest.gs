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
  const uploadId = 'UPL-' + Utilities.formatDate(new Date(), CONFIG_TZ(), 'yyyyMMdd-HHmmss');

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
 * Removes one upload and the tickets that came only from its files.
 *
 * Tickets merge across uploads, so a row can carry sources from several. Only
 * rows whose ENTIRE source list belongs to this upload are deleted; rows that
 * another upload also vouched for survive, with this upload's filenames pruned
 * from their source list. Deleting them outright would silently remove data the
 * user never asked to lose.
 *
 * The upload log row is marked deleted rather than removed — policy §5.4 wants
 * the evidence trail intact.
 *
 * @param {string} uploadId
 * @return {Object} { removed, kept, months }
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

    const tickets = sheetFor(CONFIG.SHEETS.TICKETS);
    const lastRow = tickets.getLastRow();
    let removed = 0;
    let kept = 0;

    if (lastRow > 1) {
      const rows = tickets.getRange(2, 1, lastRow - 1, COL.WIDTH).getValues();
      const survivors = [];

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
        }
        survivors.push(row);
        kept++;
      });

      tickets.getRange(2, 1, rows.length, COL.WIDTH).clearContent();
      if (survivors.length) {
        tickets.getRange(2, 1, survivors.length, COL.WIDTH).setValues(survivors);
      }
    }

    log.getRange(logIndex + 2, 12).setValue('deleted ' +
      Utilities.formatDate(new Date(), CONFIG_TZ(), 'yyyy-MM-dd HH:mm'));

    const months = (typeof recomputeKpiCache === 'function') ? recomputeKpiCache() : [];
    return { removed: removed, kept: kept, months: months };
  } finally {
    lock.releaseLock();
  }
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
