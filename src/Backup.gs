/**
 * Backup.gs - the copy of the database that is not the database.
 *
 * THIS FILE IS PLAIN ASCII, like the rest of the project. See the note at the
 * top of Auth.gs for what a stray byte costs.
 *
 *
 * WHAT CAN ACTUALLY GO WRONG, AND WHAT ALREADY COVERS IT
 *
 * Everything the dashboard knows lives on one Google spreadsheet. That is a
 * single point of failure, and it is worth being precise about which failures
 * it is a single point of, because Google already covers most of them and
 * covers them better than anything written here could.
 *
 *   somebody deletes rows, or a whole tab
 *       Google keeps version history on a Sheet, effectively for ever. File >
 *       Version history > See version history, pick a time before the damage,
 *       Restore. This needs nothing from us and is the right answer almost
 *       every time.
 *
 *   somebody deletes the spreadsheet
 *       It goes to Drive's Trash and can be put back for 30 days. After 30
 *       days it is gone.
 *
 *   a bad upload puts wrong figures in
 *       Not a disaster at all - Data Uploads > Delete removes exactly that
 *       upload's rows, which is what that screen is for.
 *
 *   the Google account is lost, suspended, or leaves the company
 *       Version history and Trash go with it. THIS is the gap, and it is the
 *       one a backup inside the same account does not close either.
 *
 *   the file is corrupted, or a script does something wrong and nobody
 *   notices for a month
 *       Version history would still have it, but finding the last good moment
 *       in a month of edits is a bad afternoon. A dated copy per day is a
 *       much easier thing to reason about.
 *
 * So this file exists for the last two, and the honest summary is: it makes
 * recovery EASIER and it does not, by itself, survive losing the account. The
 * remedy for that is in backupHealth() below and is said plainly on the
 * Summary screen rather than hidden here - keep one copy somewhere that is not
 * this Google account.
 *
 *
 * WHAT IT DOES
 * Once a day it copies the whole spreadsheet into a Backups folder beside it,
 * named with the date, and deletes copies older than the last BACKUP_KEEP. A
 * copy is the whole workbook - every tab, every row, the accounts and the
 * sign-in log included - so restoring is opening one and carrying on.
 */


/** How many daily copies to keep. A month is enough to notice and act. */
const BACKUP_KEEP = 30;

/** Where the copies go. Made beside the database the first time it runs. */
const BACKUP_FOLDER = 'EAS KPI Engine - Backups';

/** Script Properties: when the last one finished, and what it is called. */
const BACKUP_LAST_KEY = 'EAS_BACKUP_LAST';
const BACKUP_LAST_NAME_KEY = 'EAS_BACKUP_LAST_NAME';

/** Past this, the Summary screen stops saying "fine" and starts saying so. */
const BACKUP_STALE_HOURS = 36;


/**
 * Makes one backup now. Safe to run by hand at any time.
 *
 * Also what the daily trigger calls. Returns a plain object rather than only
 * logging, so the dashboard can show the result of the last one.
 *
 * @return {{ok: boolean, name: string, when: string, kept: number,
 *           message: string}}
 */
function backupNow() {
  const id = getSpreadsheetId();
  if (!id) {
    return { ok: false, name: '', when: '', kept: 0,
             message: 'No spreadsheet is connected. Run setupDatabase() first.' };
  }

  const file = DriveApp.getFileById(id);
  const folder = backupFolder(file);

  const stamp = Utilities.formatDate(new Date(), CONFIG_TZ(), 'yyyy-MM-dd HHmm');
  const name = 'EAS KPI backup ' + stamp;

  // copy() rather than reading the tabs and writing them out again. A copy is
  // the whole workbook - formats, every tab, anything added since this was
  // written - and it cannot drift out of date with the schema the way a
  // hand-rolled export would the moment a column is added.
  file.makeCopy(name, folder);

  const kept = pruneBackups(folder);

  const props = PropertiesService.getScriptProperties();
  const when = new Date().toISOString();
  props.setProperty(BACKUP_LAST_KEY, when);
  props.setProperty(BACKUP_LAST_NAME_KEY, name);

  Logger.log('Backup written: %s  (%s copies kept)', name, kept);
  return { ok: true, name: name, when: when, kept: kept, message: '' };
}


/** The Backups folder, made next to the database the first time. */
function backupFolder(file) {
  // Beside the database, not at the root of Drive: whoever inherits this
  // should find the copies in the same place as the thing they are copies of.
  const parents = file.getParents();
  const home = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();

  const found = home.getFoldersByName(BACKUP_FOLDER);
  return found.hasNext() ? found.next() : home.createFolder(BACKUP_FOLDER);
}


/**
 * Deletes copies past the newest BACKUP_KEEP.
 *
 * Trashes rather than deletes outright, so a mistake here is recoverable for
 * thirty days like anything else in Drive.
 *
 * @return {number} how many are left
 */
function pruneBackups(folder) {
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    files.push({ file: f, at: f.getDateCreated().getTime() });
  }

  files.sort(function (a, b) { return b.at - a.at; });   // newest first

  for (let i = BACKUP_KEEP; i < files.length; i++) {
    files[i].file.setTrashed(true);
  }

  return Math.min(files.length, BACKUP_KEEP);
}


/**
 * Turns the daily backup on. Run once, from the editor.
 *
 * Replaces any backup trigger already installed rather than adding a second,
 * so running it twice does not make two copies a day for ever.
 */
function installBackupTrigger() {
  removeBackupTrigger();

  ScriptApp.newTrigger('backupNow')
    .timeBased()
    .atHour(2)            // the small hours, local time - nobody is uploading
    .everyDays(1)
    .create();

  Logger.log('');
  Logger.log('=========================================================');
  Logger.log(' DAILY BACKUP IS ON');
  Logger.log('   a copy of the whole workbook, around 2am');
  Logger.log('   kept in: %s', BACKUP_FOLDER);
  Logger.log('   the newest %s are kept, older ones go to Trash', BACKUP_KEEP);
  Logger.log('=========================================================');
  Logger.log('');
  Logger.log('One copy of this lives in the same Google account as the');
  Logger.log('database. That covers a deletion or a bad month. It does NOT');
  Logger.log('cover losing the account itself - download a copy somewhere');
  Logger.log('else now and then for that.');
}


/** Turns the daily backup off. */
function removeBackupTrigger() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'backupNow') {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  if (removed) Logger.log('Removed %s backup trigger(s).', removed);
  return removed;
}


/**
 * How the backups are doing, for the Summary screen.
 *
 * Deliberately NOT guarded by a token: it says when the last copy was made and
 * nothing about what is in it, and a viewer being able to see that the
 * database is being looked after is a good thing rather than a leak.
 *
 * @return {{on: boolean, last: string, name: string, count: number,
 *           stale: boolean, folder: string, keep: number}}
 */
function backupHealth() {
  const props = PropertiesService.getScriptProperties();
  const last = props.getProperty(BACKUP_LAST_KEY) || '';
  const name = props.getProperty(BACKUP_LAST_NAME_KEY) || '';

  let on = false;
  try {
    on = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'backupNow';
    });
  } catch (e) { on = false; }

  let count = 0;
  try {
    const id = getSpreadsheetId();
    if (id) {
      const folder = backupFolder(DriveApp.getFileById(id));
      const it = folder.getFiles();
      while (it.hasNext()) { it.next(); count++; }
    }
  } catch (e) { count = 0; }

  const age = last ? (Date.now() - new Date(last).getTime()) / 3600000 : Infinity;

  return {
    on: on,
    last: last,
    name: name,
    count: count,
    stale: age > BACKUP_STALE_HOURS,
    folder: BACKUP_FOLDER,
    keep: BACKUP_KEEP
  };
}


/**
 * Prints what to do when something has actually gone wrong.
 *
 * Here rather than in a document because a document is somewhere else on the
 * day you need it, and because the steps change when the code does.
 */
function restoreGuide() {
  Logger.log('');
  Logger.log('=========================================================');
  Logger.log(' SOMETHING WENT WRONG. IN ORDER OF WHAT TO TRY.');
  Logger.log('=========================================================');
  Logger.log('');
  Logger.log('1. ROWS OR A TAB WERE DELETED, OR THE FIGURES LOOK WRONG');
  Logger.log('   Open the spreadsheet.');
  Logger.log('   File > Version history > See version history.');
  Logger.log('   Pick a time before the damage and press Restore.');
  Logger.log('   This is the right answer almost every time and loses');
  Logger.log('   nothing else that happened since.');
  Logger.log('');
  Logger.log('2. A BAD UPLOAD WENT IN');
  Logger.log('   Not a disaster. Data Uploads > find the row > Delete.');
  Logger.log('   That removes exactly that upload and nothing else.');
  Logger.log('');
  Logger.log('3. THE WHOLE SPREADSHEET IS GONE');
  Logger.log('   Drive > Trash. It can be restored for 30 days.');
  Logger.log('   If it is past that, open the newest file in the');
  Logger.log('   "%s" folder, make a copy, and', BACKUP_FOLDER);
  Logger.log('   point the dashboard at it:');
  Logger.log('     - open the copy and take the ID out of its address');
  Logger.log('     - Project Settings > Script Properties');
  Logger.log('     - set EAS_SPREADSHEET_ID to that ID');
  Logger.log('   Everything uploaded since that backup has to be');
  Logger.log('   uploaded again - the exports are still in the ITSM.');
  Logger.log('');
  Logger.log('4. THE APPS SCRIPT PROJECT IS GONE');
  Logger.log('   The code is on GitHub. Make a new Apps Script project,');
  Logger.log('   paste the files back, set EAS_SPREADSHEET_ID to the');
  Logger.log('   existing database, and deploy. No data is involved -');
  Logger.log('   the spreadsheet is the data.');
  Logger.log('');
  Logger.log('5. THE GOOGLE ACCOUNT IS GONE');
  Logger.log('   This is the one nothing above covers, because the');
  Logger.log('   backups live in the same account. It is why a copy');
  Logger.log('   should be downloaded somewhere else now and then:');
  Logger.log('   open the newest backup, File > Download > Excel, and');
  Logger.log('   keep it wherever your team keeps things that matter.');
  Logger.log('');
}
