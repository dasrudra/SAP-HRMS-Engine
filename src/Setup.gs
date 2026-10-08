/**
 * Setup.gs - run once, by hand, to build the database.
 *
 * HOW TO RUN A FUNCTION IN APPS SCRIPT
 * Open the Apps Script editor, pick "Setup.gs" in the file list, choose
 * `setupDatabase` from the function dropdown at the top, and press Run.
 * The first time, Google shows an authorisation screen - that is normal. It is
 * asking your permission for THIS script to touch YOUR Drive and Sheets.
 * Output appears in the "Execution log" panel at the bottom.
 *
 * These functions are safe to run more than once. They create what is missing
 * and leave what already exists alone.
 */


/**
 * Creates the spreadsheet and every tab the app needs.
 *
 * Run this first. It prints the spreadsheet ID - paste that into
 * Script Properties, then run verifySetup() to confirm.
 */
function setupDatabase() {
  let ss;
  const existing = getSpreadsheetId();

  if (existing) {
    // Already configured - open the existing one rather than making a second.
    ss = SpreadsheetApp.openById(existing);
    Logger.log('Using existing spreadsheet: %s', ss.getName());
  } else {
    // Only a BRAND NEW installation ever reaches this. An existing database is
    // found by the ID in Script Properties, never by its name, so a workbook
    // created before the rename keeps the name it has and goes on working.
    ss = SpreadsheetApp.create('Enterprise Application Services \u2014 Database');
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
  Logger.log('Spreadsheet ID saved to Script Properties \u2014 it will survive any code change.');

  // Build each tab with its header row.
  createSheet(ss, CONFIG.SHEETS.TICKETS,   CONFIG.TICKET_COLUMNS);
  createSheet(ss, CONFIG.SHEETS.KPI_MONTH, CONFIG.KPI_COLUMNS);
  createSheet(ss, CONFIG.SHEETS.UPLOADS,   CONFIG.UPLOAD_COLUMNS);
  createSheet(ss, CONFIG.SHEETS.TRAINING,  CONFIG.TRAINING_COLUMNS);
  createSheet(ss, CONFIG.SHEETS.OPERATORS, ['Operator', 'Display Name', 'Role',
                                            'Password Hash', 'Active', 'Created']);

  syncKpiConfigSheet(ss);

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
 * Rewrites the KPI_CONFIG tab from Config.gs. Safe to run at any time.
 *
 * WHAT THIS TAB IS, AND WHAT IT IS NOT
 * Every column but one is a READABLE COPY, for anyone who opens the database
 * and wants to see what the dashboard is scoring against without reading code.
 * Nothing reads those columns back. They cannot change a target, and that is
 * deliberate: the targets are set by an approved policy, and a spreadsheet
 * anyone with edit access could retype is the wrong place for them to live.
 *
 * It used to be seeded ONCE, only if empty, and described as "owned by the UI"
 * - which nothing ever implemented. The result was a tab that kept printing
 * the targets as they were on the day the database was built, while the
 * dashboard beside it scored against the current ones. A copy that is allowed
 * to go stale is worse than no copy, so it is rewritten every time rather than
 * written once, and it now says in the sheet itself where the figures come
 * from.
 *
 * THE ONE COLUMN THAT IS NOT A COPY: Document Link.
 * That one is read, and it is the place to put these addresses. A definition
 * PDF is not a policy figure - it is an address, and addresses change. When a
 * corrected PDF is uploaded to Drive as a new file it gets a new ID, and every
 * link to the old one quietly stops working. Keeping the address in a
 * spreadsheet cell means fixing it is a paste; keeping it in Config.gs means
 * pasting a 1,400-line file into Apps Script and deploying a new version to
 * change one URL.
 *
 * So this function NEVER overwrites what is in that column - it reads it,
 * keeps it, and only fills a blank cell from Config.gs. Run it as often as
 * you like; the links you pasted survive.
 *
 * RUN THIS AFTER A TARGET CHANGES. setupDatabase() calls it too.
 *
 * @param {Spreadsheet} [ss]  defaults to the configured database
 * @return {number} how many indicators were written
 */
function syncKpiConfigSheet(ss) {
  const book = ss || SpreadsheetApp.openById(getSpreadsheetId());

  const headers = ['KPI ID', 'Name', 'Target', 'Yellow Floor', 'Unit', 'Period',
                   'SLA Layer', 'In the policy?', 'Source', 'Document Link',
                   'Copied On'];
  const sheet = createSheet(book, CONFIG.SHEETS.CONFIG, headers);

  // Read the links BEFORE anything is cleared. These are the one thing on this
  // tab that somebody typed rather than something the code printed, and they
  // are the only thing here that would be lost by rewriting it.
  const keptLinks = readKpiConfigLinks(sheet);

  // createSheet leaves an existing tab alone, which is right for every other
  // tab in the database and wrong for this one: a tab built before these
  // columns existed would keep the old headings over the new figures. The
  // header is rewritten every time, like the rows under it.
  sheet.getRange(1, 1, 1, headers.length)
       .setValues([headers])
       .setFontWeight('bold')
       .setBackground('#1e3a5f')
       .setFontColor('#ffffff');
  sheet.setFrozenRows(1);

  const source = CONFIG.POLICY.id + ' v' + CONFIG.POLICY.version +
                 ', effective ' + CONFIG.POLICY.effective;
  const today = new Date();

  const rows = CONFIG.KPI_ORDER.map(function (key) {
    const kpi = CONFIG.KPI[key];
    // What was in the cell wins. Config.gs only fills a blank one, which is
    // what a brand-new installation starts with.
    const link = keptLinks[kpi.id] || String(kpi.policyUrl || '');
    return [kpi.id, kpi.name, kpi.target, kpi.yellowFloor, kpi.unit,
            kpi.period, kpi.slaLayer,
            kpi.policy === false ? 'No - internal measure' : 'Yes',
            kpi.policy === false ? 'EAS team' : source,
            link, today];
  });

  // A row for the approved policy itself, under the reserved id POLICY.
  //
  // It is not an indicator and has no target, which is why every figure column
  // is blank. It is here because this column is where the definition documents
  // live, and the policy IS one of them - the document that defines the other
  // three. Without a row it would be the one PDF with nowhere to be pasted.
  rows.push(['POLICY',
             CONFIG.POLICY.title + ' (' + CONFIG.POLICY.id +
               ' v' + CONFIG.POLICY.version + ')',
             '', '', '', '', CONFIG.POLICY.section,
             'It IS the policy', source,
             keptLinks.POLICY || String(CONFIG.POLICY.url || ''), today]);

  // Clear first. Dropping a KPI from Config.gs must drop its row here too,
  // and overwriting in place would leave the old one behind.
  const last = sheet.getLastRow();
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1,
                   Math.max(sheet.getLastColumn(), headers.length)).clearContent();
  }

  sheet.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  Logger.log('KPI_CONFIG rewritten from Config.gs - %s indicators, source: %s',
             rows.length, source);
  Logger.log('Document Link column: %s of %s filled in.',
             rows.filter(function (r) { return r[9]; }).length, rows.length);
  return rows.length;
}


/**
 * The Document Link column, as {KPI1: url, KPI2: url, ...}.
 *
 * Reads by HEADER NAME, not by column number. This tab has had two shapes
 * already and will have more; a reader that counted to column ten would start
 * returning the date, or the SLA layer, the first time a column was inserted
 * before it - and an SLA layer in an href is not a broken link, it is a
 * broken page.
 *
 * Anything that is not plainly an http(s) address is dropped here, on the
 * server, before it can reach a browser. The screen checks again - see
 * policyLink() in App.html - because a value that becomes an href deserves
 * two locks rather than one, and this one is new: until now these addresses
 * came from Config.gs, which only the two of us can edit. They now come from a
 * spreadsheet cell, which is the point of them being there.
 *
 * Never throws. No tab, no column, no spreadsheet at all - the answer is the
 * same empty object, and the Definition buttons fall back to Config.gs.
 *
 * @param {Sheet} [sheet]  an already-open KPI_CONFIG, if the caller has one
 * @return {!Object<string, string>}
 */
function readKpiConfigLinks(sheet) {
  const out = {};
  try {
    const tab = sheet || SpreadsheetApp.openById(getSpreadsheetId())
                                       .getSheetByName(CONFIG.SHEETS.CONFIG);
    if (!tab) return out;

    const last = tab.getLastRow();
    const wide = tab.getLastColumn();
    if (last < 2 || wide < 1) return out;

    const head = tab.getRange(1, 1, 1, wide).getValues()[0]
                    .map(function (h) { return String(h || '').trim().toLowerCase(); });
    const idAt = head.indexOf('kpi id');
    const linkAt = head.indexOf('document link');
    if (idAt === -1 || linkAt === -1) return out;

    tab.getRange(2, 1, last - 1, wide).getValues().forEach(function (row) {
      const id = String(row[idAt] || '').trim();
      const url = String(row[linkAt] || '').trim();
      if (id && /^https?:\/\//i.test(url)) out[id] = url;
    });
  } catch (e) {
    // A link nobody can read is a greyed button. A thrown error here would be
    // a dashboard nobody can open.
    return out;
  }
  return out;
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
    Logger.log('  tab "%s" already exists \u2014 left alone', name);
    return sheet;
  }

  sheet = ss.insertSheet(name);

  // setValues() takes a 2D array - a list of rows, each row a list of cells.
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
    Logger.log('Nothing to save \u2014 CONFIG.SPREADSHEET_ID is null.');
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

  Logger.log('Saved. You can set CONFIG.SPREADSHEET_ID back to null \u2014');
  Logger.log('the connection now lives in Script Properties and survives code changes.');
  return true;
}


/**
 * Forgets the stored spreadsheet. Only needed to point at a different one.
 */
function clearStoredSpreadsheetId() {
  // Editor-only maintenance, tied to the owning account - see Auth.gs.
  requireOwner();
  PropertiesService.getScriptProperties().deleteProperty(SPREADSHEET_ID_KEY);
  Logger.log('Stored spreadsheet ID cleared.');
}


/**
 * Confirms the app can reach its database and everything is in place.
 */
function verifySetup() {
  const id = getSpreadsheetId();

  if (!id) {
    Logger.log('FAIL \u2014 no spreadsheet is connected.');
    Logger.log('Either run setupDatabase(), or paste an existing ID into');
    Logger.log('CONFIG.SPREADSHEET_ID and run saveSpreadsheetIdToProperties().');
    return false;
  }

  let ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (err) {
    Logger.log('FAIL \u2014 could not open that spreadsheet ID.');
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
                        : 'Some tabs are missing \u2014 run setupDatabase() again.');
  return allPresent;
}
