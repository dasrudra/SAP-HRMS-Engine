/**
 * Questions.gs - the FAQ, and the box underneath it for asking something new.
 *
 * WHY THE CONVERSATION LIVES IN THE DASHBOARD AND NOT IN EMAIL
 * An account here is an employee ID and a password. There is no email address
 * on it, deliberately - nobody had to hand one over to use the dashboard, and
 * collecting two hundred of them to build a reply channel would be a large
 * price for a small feature.
 *
 * So the dashboard is the channel and email is only the nudge:
 *
 *   somebody asks  ->  saved to the QUESTIONS tab
 *                  ->  a short plain-text email to whoever is on the alert
 *                      list, saying there is one to look at
 *                  ->  an unread count on the Help nav item for admins
 *   an admin answers -> written back onto the same row
 *                  ->  the asker sees it under "Your questions" next time
 *                      they open the screen
 *
 * THE EMAIL MUST NEVER BE ABLE TO LOSE A QUESTION. The row is written first
 * and the send is wrapped - a failed, throttled or unauthorised send leaves a
 * question that is still saved, still visible to every admin, and still
 * answerable. It only means nobody was tapped on the shoulder about it.
 *
 * ON THE SENDING QUOTA
 * MailApp allows a consumer Google account 100 recipients a day, a Workspace
 * one 1,500. One question costs as many as there are addresses on the alert
 * list, so keep that list to the two or three people who will actually act on
 * it. QUESTION_RATE_PER_HOUR caps what one person can spend.
 */


/** Script Property holding the alert list, so it stays out of the repo. */
const QUESTION_ALERTS_KEY = 'EAS_QUESTION_ALERTS';

/** Status values on a question row. */
const QUESTION_NEW = 'NEW';
const QUESTION_ANSWERED = 'ANSWERED';


// ---------------------------------------------------------------------------
// WHAT THE DASHBOARD CALLS
// ---------------------------------------------------------------------------

/**
 * Asks a question. Any signed-in person may.
 *
 * @param {string} token    the asker's session
 * @param {string} topic    a short label, e.g. 'KPI 1' - optional
 * @param {string} question what they want to ask
 * @return {{ok: boolean, id: string, message: string, emailed: boolean}}
 */
function askQuestion(token, topic, question) {
  // Signed in, and the ID is taken from the token rather than the form, so a
  // question cannot be posted in somebody else's name.
  const session = currentSession(token);
  if (!session) {
    return { ok: false, id: '', emailed: false,
             message: 'Your session has ended. Reload the page and sign in again.' };
  }
  const from = String(session.u || '').trim();

  const text = String(question == null ? '' : question).trim();
  if (text.length < 5) {
    return { ok: false, id: '', emailed: false,
             message: 'Write the question first - a few words at least.' };
  }
  if (text.length > CONFIG.QUESTION_MAX) {
    return { ok: false, id: '', emailed: false,
             message: 'That is longer than ' + CONFIG.QUESTION_MAX + ' characters. ' +
                      'Send the short version and we will come back to you.' };
  }

  const left = questionsLeftThisHour(from);
  if (left <= 0) {
    return { ok: false, id: '', emailed: false,
             message: 'You have asked ' + CONFIG.QUESTION_RATE_PER_HOUR +
                      ' questions in the last hour, which is the limit. Try ' +
                      'again later, or add to one you have already sent.' };
  }

  // Seconds are not unique enough, and three random digits are worse than
  // nothing: nine questions inside the same second shared a reference about
  // 4% of the time. A shared reference is not a cosmetic problem. answerQuestion
  // looks a question up by it, found two rows, took the first, and wrote the
  // answer there - so one person would open the Help screen and read an answer
  // to a question somebody else had asked. Same fix as the upload IDs in
  // Ingest.gs, which had the same bug for the same reason.
  const id = 'Q' + Utilities.formatDate(new Date(), CONFIG_TZ(), 'yyyyMMdd-HHmmss') +
             '-' + Utilities.getUuid().slice(0, 6).toUpperCase();
  const now = new Date();

  // WRITTEN FIRST. Everything below here may fail without losing it.
  questionTab().appendRow([
    id, now, from, String(topic || '').trim().slice(0, 80), text,
    QUESTION_NEW, '', '', ''
  ]);
  noteQuestionAsked(from);

  const emailed = alertAdminsOfQuestion(id, from, topic, text);

  return {
    ok: true, id: id, emailed: emailed,
    message: emailed
      ? 'Sent. You will see the answer here on this screen.'
      : 'Saved. You will see the answer here on this screen.'
  };
}


/**
 * The questions THIS person asked, newest first.
 *
 * Their own and nobody else's - the filter is on the server, because an
 * endpoint that returned everyone's and let the screen hide the rest would be
 * handing every question to anyone who opened a console.
 */
function myQuestions(token) {
  const session = currentSession(token);
  if (!session) return [];
  const mine = String(session.u || '').trim();

  return readQuestions()
    .filter(function (q) { return q.from === mine; })
    .map(stripAsker);
}


/** Every question, newest first. Admin and above. */
function listQuestions(token) {
  requireAdmin(token);
  return readQuestions();
}


/**
 * Answers one. Admin and above.
 *
 * The answer goes onto the question's own row rather than into a thread of
 * its own: one question, one answer, one place to look. Answering again
 * replaces it, which is what somebody correcting a hasty reply expects.
 */
function answerQuestion(token, id, answer) {
  const session = requireAdminSession(token);

  const text = String(answer == null ? '' : answer).trim();
  if (text.length < 2) {
    return { ok: false, message: 'Write the answer first.' };
  }
  if (text.length > CONFIG.QUESTION_MAX) {
    return { ok: false, message: 'That is longer than ' +
                                 CONFIG.QUESTION_MAX + ' characters.' };
  }

  const sheet = questionTab();
  const row = questionRowNumber(sheet, id);
  if (row === -1) {
    return { ok: false,
             message: 'Two questions on the ' + CONFIG.SHEETS.QUESTIONS +
                      ' tab share that reference, so this answer has not been ' +
                      'saved - it could have landed on the wrong one. Make the ' +
                      'Id column unique and answer it again.' };
  }
  if (!row) return { ok: false, message: 'That question is no longer there.' };

  const at = CONFIG.QUESTION_COLUMNS;
  sheet.getRange(row, at.indexOf('Status') + 1).setValue(QUESTION_ANSWERED);
  sheet.getRange(row, at.indexOf('Answered By') + 1).setValue(session.u);
  sheet.getRange(row, at.indexOf('Answered At') + 1).setValue(new Date());
  sheet.getRange(row, at.indexOf('Answer') + 1).setValue(text);

  return { ok: true, message: 'Answered.' };
}


/** How many are still unanswered. For the badge on the nav item. */
function unansweredQuestionCount() {
  try {
    return readQuestions().filter(function (q) {
      return q.status !== QUESTION_ANSWERED;
    }).length;
  } catch (e) {
    // A missing tab is not a reason to fail the whole page load.
    return 0;
  }
}


/**
 * The published FAQ, in order.
 *
 * Read from the FAQ tab so it can be edited in the spreadsheet rather than in
 * code - the same reasoning as the KPI definition links. Falls back to the
 * seed in Config.gs when the tab is missing, so a fresh database still has
 * something to show.
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
 * Who gets told when somebody asks a question.
 *
 *   setQuestionAlerts('you@example.com, someone@example.com')
 *
 * Kept in Script Properties, not in Config.gs, because this repository is
 * public and these are real addresses. Setting it to '' turns the emails off
 * and leaves everything else working - questions still arrive, and the badge
 * on the Help screen still counts them.
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
    ? 'Questions will be emailed to: ' + clean.join(', ')
    : 'Question emails are OFF. Questions are still saved and still show on ' +
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
// THE PARTS NOBODY CALLS DIRECTLY
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
  }
  return sheet;
}


function questionTab() {
  return sheetWithHeaders(CONFIG.SHEETS.QUESTIONS, CONFIG.QUESTION_COLUMNS);
}


/** Every question, newest first, as plain objects. */
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


/** Which row a question is on, or 0. */
// The row holding this question: 0 if there is none, and -1 if the tab somehow
// holds two rows carrying the same reference.
//
// -1 is the whole point of the function. It used to return the first match,
// which is the wrong answer to an ambiguous question - the caller writes an
// answer onto a row at random and somebody reads a reply meant for a colleague.
// A unique ID makes that nearly impossible; refusing to guess makes it
// impossible, including after somebody edits the Id column by hand.
function questionRowNumber(sheet, id) {
  const want = String(id || '').trim();
  if (!want) return 0;

  const last = sheet.getLastRow();
  if (last < 2) return 0;

  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  let found = 0;
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() !== want) continue;
    if (found) {
      Logger.log('Question %s is on both row %s and row %s - refusing to guess.',
                 want, found, i + 2);
      return -1;
    }
    found = i + 2;
  }
  return found;
}


/**
 * The asker's own view of their question, without their ID echoed back.
 *
 * They know who they are. Leaving it off means the object the browser holds
 * carries one less identifier than it needs to.
 */
function stripAsker(q) {
  return {
    id: q.id, askedAt: q.askedAt, topic: q.topic, question: q.question,
    status: q.status, answeredAt: q.answeredAt, answer: q.answer
  };
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


/**
 * Tells the alert list that a question is waiting. Never throws.
 *
 * PLAIN TEXT, ON PURPOSE. The body carries words somebody typed into a form,
 * and the one thing that cannot go wrong in a plain-text email is markup.
 *
 * @return {boolean} whether anything was sent
 */
function alertAdminsOfQuestion(id, from, topic, text) {
  const to = questionAlertList();
  if (!to.length) return false;

  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: 'EAS dashboard - a question from ' + from +
               (topic ? ' (' + topic + ')' : ''),
      body: [
        'Somebody asked a question on the Enterprise Application Services dashboard.',
        '',
        'From:     employee ID ' + from,
        'Topic:    ' + (topic || '(none given)'),
        'Asked at: ' + Utilities.formatDate(new Date(), CONFIG_TZ(),
                                            'd MMM yyyy, HH:mm'),
        'Ref:      ' + id,
        '',
        '--------------------------------------------------',
        text,
        '--------------------------------------------------',
        '',
        'Answer it on the Help screen of the dashboard:',
        CONFIG.DASHBOARD_URL,
        '',
        'The person who asked sees the answer there. They are not emailed - ',
        'an account here is an employee ID, and the dashboard holds no address',
        'for anybody.'
      ].join('\n')
    });
    return true;
  } catch (e) {
    // Out of quota, not authorised for mail yet, or a bad address on the list.
    // The question is already saved and already on the Help screen, so this
    // costs a nudge and nothing else. Logged so it is findable.
    Logger.log('Question %s saved but not emailed: %s', id, e.message);
    return false;
  }
}


/** How many more questions this person may ask this hour. */
function questionsLeftThisHour(who) {
  const cap = CONFIG.QUESTION_RATE_PER_HOUR;
  try {
    const raw = CacheService.getScriptCache().get('EAS_QCOUNT_' + who);
    return Math.max(0, cap - (parseInt(raw, 10) || 0));
  } catch (e) {
    // No cache, no limit. Losing the cap is better than refusing a question.
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
