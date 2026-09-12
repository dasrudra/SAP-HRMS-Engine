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
    kpi: {
      resolution: CONFIG.KPI.RESOLUTION,
      feedback: CONFIG.KPI.FEEDBACK
    },
    // All four in display order. The screens iterate this rather than naming
    // KPIs individually, so adding a fifth is a Config.gs edit only.
    kpiList: CONFIG.KPI_ORDER.map(function (key) { return CONFIG.KPI[key]; }),
    // Months that actually have data, so the month picker only offers real
    // choices instead of a blank list of every month since January.
    availableMonths: configured ? listAvailableMonths() : [],

    // KPI 2 keeps its own month list: training runs on its own calendar and a
    // month with tickets need not have had a training session, or the reverse.
    feedbackMonths: (configured && typeof listFeedbackMonths === 'function')
      ? listFeedbackMonths() : [],

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
  const sheet = ticketSheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const col = CONFIG.TICKET_COLUMNS.indexOf('Request Date') + 1;
  const values = sheet.getRange(2, col, lastRow - 1, 1).getValues();

  const months = {};
  values.forEach(function (row) {
    const month = monthKey(row[0]);
    if (month) months[month] = true;
  });

  return Object.keys(months).sort().reverse();
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

  return {
    tickets: tickets,
    uploads: uploads ? Math.max(0, uploads.getLastRow() - 1) : 0,
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
