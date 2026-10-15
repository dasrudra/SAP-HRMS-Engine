/**
 * Questions.gs - the published FAQ, and the plumbing the messenger shares.
 *
 * The conversations themselves live in Messenger.gs. What is left here is the
 * part that answers a question before anybody has to ask it:
 *
 *   faqEntries()     the published questions and answers, read from the FAQ tab
 *                    on every page load so a correction is a paste into a
 *                    spreadsheet and not a deployment
 *   syncFaqSheet()   puts the seed on that tab without ever overwriting an
 *                    answer somebody has improved
 *
 * plus the alert list, the hourly caps and the sheet helper, which both halves
 * use.
 *
 * ON THE SENDING QUOTA
 * MailApp allows a consumer Google account 100 recipients a day, a Workspace
 * one 1,500. One notification costs as many as there are addresses on the alert
 * list, so keep that list to the two or three people who will actually act on
 * it.
 *
 * THE QUESTIONS TAB
 * Still here, still holding every question asked before the messenger existed.
 * Nothing writes to it any more. migrateQuestionsToThreads() in Messenger.gs
 * reads it across into conversations and leaves it untouched, so the original
 * record survives whatever the migration does.
 */


/** Script Property holding the alert list, so it stays out of the repo. */
const QUESTION_ALERTS_KEY = 'EAS_QUESTION_ALERTS';

/** Status values on an old question row. Read, never written. */
const QUESTION_NEW = 'NEW';
const QUESTION_ANSWERED = 'ANSWERED';


// ---------------------------------------------------------------------------
// THE FAQ
// ---------------------------------------------------------------------------

/**
 * The published FAQ, in order.
 *
 * Read from the FAQ tab so it can be edited in the spreadsheet rather than in
 * code - the same reasoning as the KPI definition links. Falls back to the
 * seed in Config.gs when the tab is missing, so a fresh database still has
 * something to show.
 *
 * No token. The FAQ is on the sign-in page, where nobody has one, and there is
 * nothing in it that is not already meant for everybody.
 */
function faqEntries() {
  try {
    const sheet = sheetWithHeaders(CONFIG.SHEETS.FAQ, CONFIG.FAQ_COLUMNS);
    const last = sheet.getLastRow();
    if (last >= 2) {
      const rows = sheet.getRange(2, 1, last - 1, CONFIG.FAQ_COLUMNS.length).getValues();
      const out = rows
        .map(function (r) {
          return { order: Number(r[0]) || 0,
                   question: String(r[1] || '').trim(),
                   answer: String(r[2] || '').trim() };
        })
        .filter(function (e) { return e.question && e.answer; })
        .sort(function (a, b) { return a.order - b.order; });
      if (out.length) return out;
    }
  } catch (e) { /* fall through to the seed */ }

  return CONFIG.FAQ_SEED.map(function (pair, i) {
    return { order: i + 1, question: pair[0], answer: pair[1] };
  });
}


// ---------------------------------------------------------------------------
// RUN FROM THE EDITOR
// ---------------------------------------------------------------------------

/**
 * Who gets told when somebody sends a message.
 *
 *   setQuestionAlerts('you@example.com, someone@example.com')
 *
 * Kept in Script Properties, not in Config.gs, because this repository is
 * public and these are real addresses. Setting it to '' turns the emails off
 * and leaves everything else working - messages still arrive, and the badge on
 * the Help screen still counts them.
 *
 * @param {string} list  comma-separated addresses
 * @return {string[]} the addresses that were stored
 */
function setQuestionAlerts(list) {
  requireOwner();

  const clean = String(list || '').split(/[,;\s]+/)
    .map(function (a) { return a.trim(); })
    .filter(function (a) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a); });

  PropertiesService.getScriptProperties()
    .setProperty(QUESTION_ALERTS_KEY, clean.join(','));

  Logger.log(clean.length
    ? 'Messages will be emailed to: ' + clean.join(', ')
    : 'Message emails are OFF. Messages are still saved and still show on ' +
      'the Help screen with an unread count.');
  return clean;
}


/** Prints the current alert list without changing it. */
function questionAlerts() {
  requireOwner();
  const who = questionAlertList();
  Logger.log(who.length ? who.join(', ')
                        : '(nobody - run setQuestionAlerts to set it)');
  return who;
}


/**
 * Writes the FAQ seed into the FAQ tab, keeping anything already there.
 *
 * Safe to run at any time. It NEVER overwrites a question or an answer that is
 * already on the tab - it only adds seed entries whose question text is not
 * there yet. Edit the answers in the spreadsheet; they are read on every page
 * load, so a correction is live immediately with no deployment.
 */
function syncFaqSheet() {
  requireOwner();

  const sheet = sheetWithHeaders(CONFIG.SHEETS.FAQ, CONFIG.FAQ_COLUMNS);
  const last = sheet.getLastRow();

  const existing = {};
  let maxOrder = 0;
  if (last >= 2) {
    sheet.getRange(2, 1, last - 1, CONFIG.FAQ_COLUMNS.length).getValues()
      .forEach(function (r) {
        const q = String(r[1] || '').trim().toLowerCase();
        if (q) existing[q] = true;
        maxOrder = Math.max(maxOrder, Number(r[0]) || 0);
      });
  }

  const now = new Date();
  const toAdd = CONFIG.FAQ_SEED
    .filter(function (pair) { return !existing[pair[0].trim().toLowerCase()]; })
    .map(function (pair) { return [++maxOrder, pair[0], pair[1], now]; });

  if (toAdd.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, CONFIG.FAQ_COLUMNS.length)
         .setValues(toAdd);
  }

  Logger.log('FAQ: %s entr%s added, %s already there. Edit the answers on the ' +
             'FAQ tab - they are read live, with no deployment.',
             toAdd.length, toAdd.length === 1 ? 'y' : 'ies',
             Object.keys(existing).length);
  return toAdd.length;
}


// ---------------------------------------------------------------------------
// SHARED WITH THE MESSENGER
// ---------------------------------------------------------------------------

/** A tab, created with its header row the first time it is wanted. */
function sheetWithHeaders(name, headers) {
  const id = getSpreadsheetId();
  if (!id) throw new Error('No spreadsheet is connected. Run setupDatabase().');

  const book = SpreadsheetApp.openById(id);
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
         .setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    return sheet;
  }

  // A tab made before a column was added must keep working. Reading a range
  // wider than the sheet throws, so the header row is widened to match - which
  // only ever ADDS columns on the right and never touches a cell that has
  // something in it. Existing rows then read back empty in the new column,
  // which is exactly what "this was written before we asked" should look like.
  const have = sheet.getLastColumn();
  if (have < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
         .setFontWeight('bold').setBackground('#1e3a5f').setFontColor('#ffffff');
    Logger.log('Tab "%s": widened from %s to %s columns.',
               name, have, headers.length);
  }
  return sheet;
}


function questionTab() {
  return sheetWithHeaders(CONFIG.SHEETS.QUESTIONS, CONFIG.QUESTION_COLUMNS);
}


/**
 * Every question from before the messenger, newest first.
 *
 * Only migrateQuestionsToThreads() calls this now. Kept because the tab is
 * kept: the migration reads it and never writes to it, so if anything about
 * the move is wrong the original record is still sitting there intact.
 */
function readQuestions() {
  const sheet = questionTab();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const rows = sheet.getRange(2, 1, last - 1, CONFIG.QUESTION_COLUMNS.length)
                    .getValues();
  return rows
    .map(function (r) {
      return {
        id:         String(r[0] || ''),
        askedAt:    r[1] ? new Date(r[1]).toISOString() : '',
        from:       String(r[2] || ''),
        topic:      String(r[3] || ''),
        question:   String(r[4] || ''),
        status:     String(r[5] || QUESTION_NEW),
        answeredBy: String(r[6] || ''),
        answeredAt: r[7] ? new Date(r[7]).toISOString() : '',
        answer:     String(r[8] || '')
      };
    })
    .filter(function (q) { return q.id && q.question; })
    .reverse();
}


/** Like requireAdmin, but hands back who it was. */
function requireAdminSession(token) {
  requireAdmin(token);
  return currentSession(token);
}


/** The alert list, or an empty list when nobody has set one. */
function questionAlertList() {
  const raw = PropertiesService.getScriptProperties()
                .getProperty(QUESTION_ALERTS_KEY) || '';
  return raw.split(',').map(function (a) { return a.trim(); })
            .filter(Boolean);
}


/** How many more messages this person may send this hour. */
function questionsLeftThisHour(who) {
  const cap = CONFIG.QUESTION_RATE_PER_HOUR;
  try {
    const raw = CacheService.getScriptCache().get('EAS_QCOUNT_' + who);
    return Math.max(0, cap - (parseInt(raw, 10) || 0));
  } catch (e) {
    // No cache, no limit. Losing the cap is better than refusing a message
    // somebody needs to send. The sign-in page's cap is the other way round -
    // see takeFromHourlyBucket in Messenger.gs, and the reason it differs.
    return cap;
  }
}


/** Counts one against the hour. Re-stamped, so the window rolls. */
function noteQuestionAsked(who) {
  try {
    const cache = CacheService.getScriptCache();
    const key = 'EAS_QCOUNT_' + who;
    const next = (parseInt(cache.get(key), 10) || 0) + 1;
    cache.put(key, String(next), 3600);
  } catch (e) { /* see questionsLeftThisHour */ }
}
