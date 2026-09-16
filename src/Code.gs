/**
 * Code.gs — the entry point. This is what makes the project a website.
 *
 * THE ONE FUNCTION THAT MATTERS
 * `doGet` is a reserved name. When someone opens your /exec URL, Google calls
 * doGet() and serves whatever HTML it returns. Rename it and the site stops
 * existing. There is a matching `doPost` for form submissions; we do not need it,
 * because the browser talks to the server through google.script.run instead.
 */


/**
 * Serves the app.
 *
 * @param {Object} e  the request. e.parameter holds the query string as an
 *                    object, so /exec?view=kpi1&month=2026-08 arrives as
 *                    { view: 'kpi1', month: '2026-08' }.
 *
 *                    This is exactly the mechanism the existing Database Center
 *                    does not use, which is why pressing refresh there throws
 *                    you back to page one. We read it on the client instead
 *                    (see App.html) because that keeps the server stateless.
 */
function doGet(e) {
  const template = HtmlService.createTemplateFromFile('Index');

  // Anything assigned to `template` is readable inside Index.html as <?= ?>.
  template.appName = CONFIG.APP_NAME;
  template.appVersion = CONFIG.APP_VERSION;

  return template
    .evaluate()
    .setTitle(CONFIG.APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


/**
 * Pastes one HTML file into another.
 *
 * Apps Script has no way to <link> a stylesheet or <script src> a local file —
 * every project file is served from the same URL, so there are no separate
 * paths to point at. The convention is to inline them at render time:
 *
 *     <?!= include('Styles'); ?>
 *
 * The `<?!= ?>` tag means "output this without HTML-escaping it". Using the
 * escaping tag `<?= ?>` here would print your CSS as visible text on the page.
 *
 * @param {string} filename  project file name, without the .html
 * @return {string} the file's contents
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}


/**
 * Everything the page needs on first load, in ONE server call.
 *
 * Each google.script.run call costs a round trip to Google's servers —
 * typically 200-800ms. Three calls at startup is three waits. One call
 * returning one object is one wait. This is the single biggest thing you can
 * do for perceived speed in an Apps Script web app.
 *
 * @return {Object} config and current state for the client
 */
function getBootstrap() {
  const configured = Boolean(getSpreadsheetId());

  // One read of the Request Date column serves both the month picker and the
  // coverage line under KPI 1's title.
  const period = configured ? ticketPeriod() : { months: [], from: '', to: '' };

  return {
    ok: true,
    configured: configured,
    appName: CONFIG.APP_NAME,
    appVersion: CONFIG.APP_VERSION,
    departments: CONFIG.DEPARTMENTS,
    // The browser builds rows in exactly this order before uploading them.
    // Sending the list rather than duplicating it in App.html keeps one
    // source of truth — add a column to Config.gs and the client follows.
    ticketColumns: CONFIG.TICKET_COLUMNS,

    // KPI 2's equivalents. The browser parses feedback files itself, so it
    // needs both the column order to build rows in and the module patterns to
    // read a filename with.
    trainingColumns: CONFIG.TRAINING_COLUMNS,
    trainingModules: CONFIG.TRAINING_MODULES,
    trainerModules: CONFIG.TRAINER_MODULES,
    kpi: {
      resolution: CONFIG.KPI.RESOLUTION,
      feedback: CONFIG.KPI.FEEDBACK
    },
    // All four in display order. The screens iterate this rather than naming
    // KPIs individually, so adding a fifth is a Config.gs edit only.
    kpiList: CONFIG.KPI_ORDER.map(function (key) { return CONFIG.KPI[key]; }),
    // Months that actually have data, so the month picker only offers real
    // choices instead of a blank list of every month since January.
    availableMonths: period.months,

    // The exact first and last request date in the stored tickets, so KPI 1
    // can say what its figures actually cover. 'January – September' does not
    // distinguish a full September from the first four days of one.
    ticketFrom: period.from,
    ticketTo: period.to,

    // KPI 2 keeps its own month list: training runs on its own calendar and a
    // month with tickets need not have had a training session, or the reverse.
    feedbackMonths: (configured && typeof listFeedbackMonths === 'function')
      ? listFeedbackMonths() : [],

    // KPI 2's own period unit. Training runs a few times a quarter, so the
    // dashboard reports quarters and the month list is only kept for the
    // comparison screen and for working out which quarters exist.
    feedbackQuarters: (configured && typeof listFeedbackQuarters === 'function')
      ? listFeedbackQuarters() : [],

    // Responses left behind by an upload that has since been deleted. Sent on
    // every bootstrap so the page can offer to clear them without the user
    // having to know they exist — they are invisible in the upload history and
    // KPI 2 counts them regardless.
    orphanedFeedback: (configured && typeof auditFeedback === 'function')
      ? auditFeedback().orphans : 0,

    // The EAS organisation chart, people filled in from ROSTER. Settings draws
    // it; adding a joiner to ROSTER puts them on it.
    org: (typeof orgChart === 'function') ? orgChart() : null,

    // When KPI 1's precomputed figures were last worked out. Settings shows
    // it beside the Rebuild button so a permanent tool stops reading as an
    // outstanding task.
    kpiCache: (configured && typeof kpiCacheState === 'function')
      ? kpiCacheState() : { computedAt: '', months: 0 },

    stats: configured ? quickStats() : null
  };
}


/**
 * Which months have tickets loaded?
 * Reads one column rather than the whole sheet — much cheaper.
 *
 * @return {string[]} e.g. ['2026-08', '2026-07'] newest first
 */
function listAvailableMonths() {
  return ticketPeriod().months;
}


/**
 * What the stored tickets actually cover — the months, and the exact first and
 * last request date.
 *
 * WHY THE EXACT DATES AND NOT JUST THE MONTHS
 * 'January 2026 – September 2026' does not say whether September is a full
 * month or the first four days of one, and the difference decides whether the
 * period's figure means anything yet. The export is taken on a Tuesday and
 * the month is still running; reading the rate as final is a mistake the
 * screen was quietly inviting.
 *
 * Taken from the TICKETS tab, not from the upload log, because the log has
 * been wrong before — it records what an upload claimed, and a run killed
 * part-way leaves the claim without the rows. This reads what is there.
 *
 * One column of the sheet, in one call. The same read the month list needed
 * anyway, so this costs nothing extra.
 *
 * @return {Object} { months: ['YYYY-MM'] newest first, from: 'YYYY-MM-DD',
 *                    to: 'YYYY-MM-DD' } — from/to are '' when nothing is stored
 */
function ticketPeriod() {
  const empty = { months: [], from: '', to: '' };

  const sheet = ticketSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return empty;

  const col = CONFIG.TICKET_COLUMNS.indexOf('Request Date') + 1;
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();

  const months = {};
  let from = '';
  let to = '';

  values.forEach(function (row) {
    const month = monthKey(row[0]);
    if (!month) return;
    months[month] = true;

    // Compared as 'YYYY-MM-DD' text, which sorts chronologically without
    // making a Date out of every one of twenty thousand cells.
    const day = dayKey(row[0]);
    if (!day) return;
    if (!from || day < from) from = day;
    if (!to   || day > to)   to = day;
  });

  return { months: Object.keys(months).sort().reverse(), from: from, to: to };
}


/**
 * A cell's date as 'YYYY-MM-DD', or '' if it is not one.
 *
 * Mirrors monthKey, which the whole engine already leans on: SheetJS is read
 * with cellDates, so a date cell arrives as a Date, but a re-typed cell can
 * arrive as text and has to be read as written rather than guessed at.
 *
 * @param {*} value
 * @return {string}
 */
function dayKey(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.getFullYear() + '-' +
           String(value.getMonth() + 1).padStart(2, '0') + '-' +
           String(value.getDate()).padStart(2, '0');
  }

  const text = String(value == null ? '' : value).trim();
  const found = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return found ? found[1] + '-' + found[2] + '-' + found[3] : '';
}


/**
 * When the KPI 1 cache was last computed, and over how much.
 *
 * Answers the question the Settings card kept provoking — "the rebuild option
 * is still there, what do I do?" A permanent tool reads as an outstanding
 * task until it can tell you the state it is in. With this the card says when
 * the figures were last worked out, and the answer to "what do I do" becomes
 * visibly "nothing".
 *
 * @return {Object} { computedAt: ISO string or '', months: n }
 */
function kpiCacheState() {
  const sheet = SpreadsheetApp.openById(getSpreadsheetId())
    .getSheetByName(CONFIG.SHEETS.KPI_MONTH);
  if (!sheet || sheet.getLastRow() < 2) return { computedAt: '', months: 0 };

  const width = CONFIG.KPI_COLUMNS.length;
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();

  const at = CONFIG.KPI_COLUMNS.indexOf('Computed At');
  const months = {};
  let latest = null;

  rows.forEach(function (r) {
    const month = monthKey(r[0]);
    if (month) months[month] = true;

    const when = r[at];
    const time = (when instanceof Date) ? when : new Date(String(when || ''));
    if (!isNaN(time.getTime()) && (!latest || time > latest)) latest = time;
  });

  return {
    computedAt: latest ? latest.toISOString() : '',
    months: Object.keys(months).length
  };
}


/**
 * Headline counts for the top of the page.
 *
 * @return {Object}
 */
function quickStats() {
  const sheet = ticketSheet();
  const tickets = Math.max(0, sheet.getLastRow() - 1);

  const uploads = SpreadsheetApp
    .openById(getSpreadsheetId())
    .getSheetByName(CONFIG.SHEETS.UPLOADS);

  const training = SpreadsheetApp
    .openById(getSpreadsheetId())
    .getSheetByName(CONFIG.SHEETS.TRAINING);

  // Split by which KPI they feed. "Three uploads logged and no tickets
  // stored" is the sentence that tells you the database lost something; one
  // combined count cannot say it.
  let ticketUploads = 0;
  let feedbackUploads = 0;
  if (uploads && uploads.getLastRow() > 1) {
    uploads.getRange(2, 5, uploads.getLastRow() - 1, 1).getValues()
      .forEach(function (row) {
        if (String(row[0] || '').toUpperCase().indexOf('FEEDBACK') !== -1) feedbackUploads++;
        else ticketUploads++;
      });
  }

  return {
    tickets: tickets,
    uploads: uploads ? Math.max(0, uploads.getLastRow() - 1) : 0,
    ticketUploads: ticketUploads,
    feedbackUploads: feedbackUploads,
    feedback: training ? Math.max(0, training.getLastRow() - 1) : 0
  };
}


/**
 * Handle to the TICKETS tab.
 * Wrapped in a function so no other file has to know how to find it.
 *
 * @return {Sheet}
 */
function ticketSheet() {
  const id = getSpreadsheetId();
  if (!id) {
    throw new Error('No spreadsheet connected. Run setupDatabase() first.');
  }
  return SpreadsheetApp
    .openById(id)
    .getSheetByName(CONFIG.SHEETS.TICKETS);
}


/**
 * Turns whatever the ITSM gave us into a 'YYYY-MM' string.
 *
 * Necessary because the two exports disagree about dates. The Service/Part
 * report sends full timestamps ('2026-08-20 19:59:35'), the Personal report
 * sends date-only ('2026-08-20'), and Sheets may hand either back as a real
 * Date object depending on how it was written. All three must produce '2026-08'.
 *
 * @param {Date|string} value
 * @return {string} 'YYYY-MM', or '' if unreadable
 */
function monthKey(value) {
  if (!value) return '';

  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    return y + '-' + m;
  }

  const text = String(value).trim();
  // Matches '2026-08-20' and '2026-08-20 19:59:35' alike.
  const match = text.match(/^(\d{4})-(\d{2})/);
  return match ? match[1] + '-' + match[2] : '';
}
