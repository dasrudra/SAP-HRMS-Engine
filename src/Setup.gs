/**
 * Setup.gs — run once, by hand, to build the database.
 *
 * HOW TO RUN A FUNCTION IN APPS SCRIPT
 * Open the Apps Script editor, pick "Setup.gs" in the file list, choose
 * `setupDatabase` from the function dropdown at the top, and press Run.
 * The first time, Google shows an authorisation screen — that is normal. It is
 * asking your permission for THIS script to touch YOUR Drive and Sheets.
 * Output appears in the "Execution log" panel at the bottom.
 *
 * These functions are safe to run more than once. They create what is missing
 * and leave what already exists alone.
 */


/**
 * Creates the spreadsheet and every tab the app needs.
 *
 * Run this first. It prints the spreadsheet ID — paste that into
 * Script Properties, then run verifySetup() to confirm.
 */
function setupDatabase() {
  let ss;
  const existing = getSpreadsheetId();

  if (existing) {
    // Already configured — open the existing one rather than making a second.
    ss = SpreadsheetApp.openById(existing);
    Logger.log('Using existing spreadsheet: %s', ss.getName());
  } else {
    ss = SpreadsheetApp.create('EAS KPI Engine — Database');
    Logger.log('');
    Logger.log('=========================================================');
    Logger.log(' CREATED A NEW SPREADSHEET');
    Logger.log('   %s', ss.getId());
    Logger.log('   %s', ss.getUrl());
    Logger.log('=========================================================');
    Logger.log('');
  }

  // Store it outside the code so replacing a file cannot disconnect it.
  PropertiesService.getScriptProperties().setProperty(SPREADSHEET_ID_KEY, ss.getId());
  Logger.log('Spreadsheet ID saved to Script Properties — it will survive any code change.');

  // Build each tab with its header row.
  createSheet(ss, CONFIG.SHEETS.TICKETS,   CONFIG.TICKET_COLUMNS);
  createSheet(ss, CONFIG.SHEETS.KPI_MONTH, CONFIG.KPI_COLUMNS);
  createSheet(ss, CONFIG.SHEETS.UPLOADS,   CONFIG.UPLOAD_COLUMNS);
  createSheet(ss, CONFIG.SHEETS.TRAINING,  ['Session Date', 'Session Title', 'Trainer',
                                            'Attendee', 'Employee ID', 'Department',
                                            'Score', 'Max Score', 'Comments', 'Source File']);
  createSheet(ss, CONFIG.SHEETS.OPERATORS, ['Operator', 'Display Name', 'Role',
                                            'Password Hash', 'Active', 'Created']);

  // KPI_CONFIG holds editable targets. Seeded from Config.gs, then owned by
  // the UI — so a committee decision does not require a code change.
  const cfgSheet = createSheet(ss, CONFIG.SHEETS.CONFIG,
    ['KPI ID', 'Name', 'Target', 'Yellow Floor', 'Unit', 'Period',
     'SLA Layer', 'Effective From', 'Updated By']);

  if (cfgSheet.getLastRow() <= 1) {
    const today = new Date();
    cfgSheet.getRange(2, 1, 2, 9).setValues([
      [CONFIG.KPI.RESOLUTION.id, CONFIG.KPI.RESOLUTION.name,
       CONFIG.KPI.RESOLUTION.target, CONFIG.KPI.RESOLUTION.yellowFloor,
       CONFIG.KPI.RESOLUTION.unit, CONFIG.KPI.RESOLUTION.period,
       CONFIG.KPI.RESOLUTION.slaLayer, today, 'setup'],
      [CONFIG.KPI.FEEDBACK.id, CONFIG.KPI.FEEDBACK.name,
       CONFIG.KPI.FEEDBACK.target, CONFIG.KPI.FEEDBACK.yellowFloor,
       CONFIG.KPI.FEEDBACK.unit, CONFIG.KPI.FEEDBACK.period,
       CONFIG.KPI.FEEDBACK.slaLayer, today, 'setup']
    ]);
    Logger.log('Seeded KPI_CONFIG with the two EAS KPIs.');
  }

  // A brand-new spreadsheet always has a "Sheet1" we never use.
  const blank = ss.getSheetByName('Sheet1');
  if (blank && ss.getSheets().length > 1) {
    ss.deleteSheet(blank);
  }

  Logger.log('Setup complete. Tabs present: %s',
             ss.getSheets().map(s => s.getName()).join(', '));
  return ss.getId();
}


/**
 * Creates one tab with a frozen, formatted header row.
 * Returns the existing sheet untouched if it is already there.
 *
 * @param {Spreadsheet} ss       the spreadsheet to add to
 * @param {string}      name     tab name
 * @param {string[]}    headers  column titles for row 1
 * @return {Sheet}
 */
function createSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);

  if (sheet) {
    Logger.log('  tab "%s" already exists — left alone', name);
    return sheet;
  }

  sheet = ss.insertSheet(name);

  // setValues() takes a 2D array — a list of rows, each row a list of cells.
  // One row of headers is therefore [[a, b, c]], not [a, b, c].
  sheet.getRange(1, 1, 1, headers.length)
       .setValues([headers])
       .setFontWeight('bold')
       .setBackground('#1e3a5f')
       .setFontColor('#ffffff');

  sheet.setFrozenRows(1);

  Logger.log('  created tab "%s" with %s columns', name, headers.length);
  return sheet;
}


/**
 * Moves an ID out of Config.gs and into Script Properties. Run once.
 *
 * Use this when the app says the database is not connected but you already
 * have a spreadsheet: paste its ID into CONFIG.SPREADSHEET_ID, run this, and
 * the connection stops depending on that file's contents.
 */
function saveSpreadsheetIdToProperties() {
  if (!CONFIG.SPREADSHEET_ID) {
    Logger.log('Nothing to save — CONFIG.SPREADSHEET_ID is null.');
    Logger.log('Paste your spreadsheet ID there first, then run this again.');
    return false;
  }

  try {
    SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);   // fail fast on a bad ID
  } catch (err) {
    Logger.log('That ID could not be opened: %s', err.message);
    return false;
  }

  PropertiesService.getScriptProperties()
    .setProperty(SPREADSHEET_ID_KEY, CONFIG.SPREADSHEET_ID);

  Logger.log('Saved. You can set CONFIG.SPREADSHEET_ID back to null —');
  Logger.log('the connection now lives in Script Properties and survives code changes.');
  return true;
}


/**
 * Forgets the stored spreadsheet. Only needed to point at a different one.
 */
function clearStoredSpreadsheetId() {
  PropertiesService.getScriptProperties().deleteProperty(SPREADSHEET_ID_KEY);
  Logger.log('Stored spreadsheet ID cleared.');
}


/**
 * Confirms the app can reach its database and everything is in place.
 */
function verifySetup() {
  const id = getSpreadsheetId();

  if (!id) {
    Logger.log('FAIL — no spreadsheet is connected.');
    Logger.log('Either run setupDatabase(), or paste an existing ID into');
    Logger.log('CONFIG.SPREADSHEET_ID and run saveSpreadsheetIdToProperties().');
    return false;
  }

  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (err) {
    Logger.log('FAIL — could not open that spreadsheet ID.');
    Logger.log('Error: %s', err.message);
    return false;
  }

  Logger.log('Opened: %s', ss.getName());
  Logger.log('URL:    %s', ss.getUrl());
  Logger.log('');

  let allPresent = true;
  Object.keys(CONFIG.SHEETS).forEach(function (key) {
    const tabName = CONFIG.SHEETS[key];
    const sheet = ss.getSheetByName(tabName);
    if (sheet) {
      Logger.log('  OK      %-12s  %s data rows', tabName, Math.max(0, sheet.getLastRow() - 1));
    } else {
      Logger.log('  MISSING %s', tabName);
      allPresent = false;
    }
  });

  Logger.log('');
  Logger.log(allPresent ? 'All good. Ready to deploy.'
                        : 'Some tabs are missing — run setupDatabase() again.');
  return allPresent;
}
