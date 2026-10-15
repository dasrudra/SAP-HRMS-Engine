/**
 * Messenger.gs - the docked message panel, and the conversations behind it.
 *
 * WHAT THIS IS
 * A bar in the bottom corner of every screen that opens into a conversation
 * between one person and the EAS team. One thread per person, running forever,
 * the way messaging a company page works - not a ticket that closes. The team
 * answers from the Help & FAQ screen, which is their inbox.
 *
 *   somebody writes  ->  appended to MESSAGES, thread stamped on THREADS
 *                    ->  one email to the alert list, but only when the team is
 *                        not already holding an unanswered message from them
 *                    ->  the thread rises to the top of the team's inbox
 *   the team replies ->  appended to the same thread, Side = TEAM
 *                    ->  a dot on the asker's messenger bar, and the reply is
 *                        there when they open it
 *
 * TWO KINDS OF THREAD, AND WHY THEY MUST NOT MEET
 * The messenger is also on the SIGN-IN page, because the person most likely to
 * need it is the one who cannot get in. Nobody is signed in there, so there is
 * no token and no proven identity - only an employee ID somebody typed.
 *
 * Those messages go to a thread of their own, marked Verified = NO, which the
 * team sees flagged and which the real owner of that ID never sees. If they
 * shared one thread, a stranger could write into somebody's conversation and be
 * read as them, and a reply meant for the stranger would be sitting on the real
 * employee's screen the next time they signed in. See CONFIG.THREAD_COLUMNS.
 *
 * AN UNVERIFIED MESSAGE IS NOT EVIDENCE OF ANYTHING. It says somebody typed an
 * employee ID into a box on a public web page. Never reset a password, change a
 * role or say anything confidential on the strength of one. Ring the person, or
 * check with them in SAP, and do it out of band.
 *
 * ON NOT LEAKING WHO HAS AN ACCOUNT
 * sendUnverifiedMessage() accepts any employee ID and answers identically
 * whether or not it exists. Checking, and saying so, would turn the sign-in
 * page into a list of everybody who works here for anyone who cared to try
 * numbers at it.
 */


/** Which side of the conversation a message came from. */
const SIDE_USER = 'USER';
const SIDE_TEAM = 'TEAM';

const THREAD_OPEN = 'OPEN';
const THREAD_CLOSED = 'CLOSED';

const VERIFIED_YES = 'YES';
const VERIFIED_NO = 'NO';


// ---------------------------------------------------------------------------
// WHAT THE MESSENGER PANEL CALLS
// ---------------------------------------------------------------------------

/**
 * Everything the panel needs to draw itself, in one call.
 *
 * One round trip rather than three, because this runs on every page load for
 * every person, and google.script.run is not cheap.
 *
 * Works signed out, where it returns the FAQ and no conversation - that is the
 * sign-in page, and there is nothing of anybody's to show there.
 */
function messengerBoot(token) {
  const session = currentSession(token);

  const out = {
    signedIn: Boolean(session),
    faq: faqEntries(),
    messages: [],
    unread: 0,
    canAnswer: false
  };

  if (!session) return out;

  const thread = findThread(String(session.u || '').trim(), VERIFIED_YES);
  if (thread) {
    out.messages = threadMessageList(thread.id);
    out.unread = Number(thread.unreadByPerson) || 0;
  }

  try {
    out.canAnswer = rankOf(liveRoleOf(session.u)) >= rankOf(ROLE_ADMIN);
  } catch (e) {
    out.canAnswer = false;
  }
  return out;
}


/**
 * Sends a message as the signed-in person.
 *
 * The employee ID comes from the token. There is no field for it and no way to
 * pass one, so a message cannot be written in somebody else's name.
 */
function sendMessage(token, text) {
  const session = currentSession(token);
  if (!session) {
    return { ok: false, message: 'Your session has ended. Reload the page and ' +
                                 'sign in again.' };
  }
  const who = String(session.u || '').trim();

  const body = cleanMessage(text);
  if (body.bad) return { ok: false, message: body.bad };

  if (questionsLeftThisHour(who) <= 0) {
    return { ok: false,
             message: 'You have sent ' + CONFIG.QUESTION_RATE_PER_HOUR +
                      ' messages in the last hour, which is the limit. We have ' +
                      'them - somebody will reply here.' };
  }

  const result = appendToThread(who, VERIFIED_YES, SIDE_USER, who, body.text);
  noteQuestionAsked(who);

  // Only nudge if the team is not already sitting on something unanswered from
  // this person. Four messages in a row while they think out loud is one
  // interruption, not four, and four emails out of a hundred.
  const emailed = result.wasWaiting
    ? false
    : alertTeamOfMessage(who, body.text, VERIFIED_YES, result.threadId);

  return { ok: true, id: result.messageId, emailed: emailed,
           messages: threadMessageList(result.threadId),
           message: 'Sent.' };
}


/**
 * Sends a message from the sign-in page, where nobody is signed in.
 *
 * NO TOKEN, BY DESIGN. Every global in an Apps Script web app is an endpoint,
 * so this one is reachable by anyone who can reach the dashboard - which is
 * anyone at all, the URL being on a public page. Everything that protects it is
 * in here: a global hourly cap, a cap on how many of those may send mail, a
 * length limit, and a thread marked UNVERIFIED that the claimed owner of the ID
 * will never see.
 *
 * @param {*} ignoredToken    every endpoint on this dashboard takes the token
 *                            first, and the client injects it in one place so
 *                            that a new call cannot be written without one by
 *                            forgetting. This one has nothing to do with a
 *                            token - it exists for people who have no session -
 *                            but it keeps the shape, because an endpoint with a
 *                            different calling convention is an endpoint
 *                            somebody will one day call wrongly.
 * @param {string} employeeId what the sender typed. Not checked against
 *                            ACCOUNTS on purpose - see the file header.
 * @param {string} text       the message
 */
function sendUnverifiedMessage(ignoredToken, employeeId, text) {
  const who = String(employeeId == null ? '' : employeeId).trim().slice(0, 40);
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(who)) {
    return { ok: false, message: 'Put your employee ID in first - the one you ' +
                                 'sign in with.' };
  }

  const body = cleanMessage(text);
  if (body.bad) return { ok: false, message: body.bad };

  // The same answer for a full bucket as for a successful send would be kinder
  // to a bot and crueller to a colleague, so this one says what happened.
  if (!takeFromHourlyBucket('EAS_UNVERIFIED', CONFIG.UNVERIFIED_PER_HOUR)) {
    return { ok: false,
             message: 'The sign-in message box is busy at the moment. If you ' +
                      'are locked out, please phone the EAS team instead.' };
  }
  if (questionsLeftThisHour('anon-' + who) <= 0) {
    return { ok: false,
             message: 'That is several messages from this ID in the last hour. ' +
                      'We have them - somebody will be in touch.' };
  }

  const result = appendToThread(who, VERIFIED_NO, SIDE_USER, who, body.text);
  noteQuestionAsked('anon-' + who);

  const mayEmail = !result.wasWaiting &&
    takeFromHourlyBucket('EAS_UNVERIFIED_MAIL', CONFIG.UNVERIFIED_EMAILS_PER_HOUR);
  if (mayEmail) alertTeamOfMessage(who, body.text, VERIFIED_NO, result.threadId);

  // Deliberately identical whether or not that employee ID exists.
  return { ok: true,
           message: 'Sent to the EAS team. They will contact you directly - ' +
                    'the reply cannot come back to this box, because you are ' +
                    'not signed in.' };
}


/** New messages in this person's own thread. Used by the panel while open. */
function myMessages(token) {
  const session = currentSession(token);
  if (!session) return { messages: [], unread: 0 };

  const thread = findThread(String(session.u || '').trim(), VERIFIED_YES);
  if (!thread) return { messages: [], unread: 0 };

  return { messages: threadMessageList(thread.id),
           unread: Number(thread.unreadByPerson) || 0 };
}


/** Marks the team's replies as seen, so the dot on the bar goes out. */
function markMyMessagesRead(token) {
  const session = currentSession(token);
  if (!session) return { ok: false };

  const thread = findThread(String(session.u || '').trim(), VERIFIED_YES);
  if (!thread) return { ok: true };

  setThreadField(thread.row, 'Unread By Person', 0);
  return { ok: true };
}


// ---------------------------------------------------------------------------
// THE TEAM'S SIDE - the inbox on the Help screen
// ---------------------------------------------------------------------------

/**
 * Every conversation, the ones waiting on us first, then by recent activity.
 *
 * Admin and above. The ordering is the whole value of an inbox: what somebody
 * is waiting for an answer to goes at the top, unverified ones marked, and the
 * rest underneath in the order they last moved.
 */
function listThreads(token) {
  requireAdmin(token);

  return readThreads()
    .map(function (t) {
      return {
        id: t.id, person: t.person, verified: t.verified === VERIFIED_YES,
        topic: t.topic, startedAt: t.startedAt, lastAt: t.lastAt,
        lastBy: t.lastBy, status: t.status,
        waiting: Number(t.waitingForTeam) || 0,
        messages: threadMessageList(t.id)
      };
    })
    .sort(function (a, b) {
      if ((a.waiting > 0) !== (b.waiting > 0)) return a.waiting > 0 ? -1 : 1;
      return String(b.lastAt).localeCompare(String(a.lastAt));
    });
}


/** Replies to one conversation. Admin and above. */
function replyToThread(token, threadId, text) {
  const session = requireAdminSession(token);

  const body = cleanMessage(text);
  if (body.bad) return { ok: false, message: body.bad };

  const thread = threadById(threadId);
  if (!thread) return { ok: false, message: 'That conversation is no longer there.' };

  appendToThread(thread.person, thread.verified, SIDE_TEAM,
                 String(session.u || ''), body.text);

  return { ok: true, message: 'Replied.',
           messages: threadMessageList(thread.id) };
}


/** How many conversations are waiting on us. For the badge. */
function unansweredQuestionCount() {
  try {
    return readThreads().filter(function (t) {
      return (Number(t.waitingForTeam) || 0) > 0;
    }).length;
  } catch (e) {
    // A missing tab is not a reason to fail the whole page load.
    return 0;
  }
}


// ---------------------------------------------------------------------------
// RUN FROM THE EDITOR
// ---------------------------------------------------------------------------

/**
 * Turns the old one-question-one-answer rows into conversations. Run once.
 *
 * Safe to run twice: every message it writes carries an ID derived from the
 * question it came from, so a second run finds them already there and adds
 * nothing. The QUESTIONS tab is left exactly as it is - this reads it and
 * never writes to it, so if any of this is wrong the original is still the
 * original.
 */
function migrateQuestionsToThreads() {
  requireOwner();

  let questions = [];
  try {
    questions = readQuestions();
  } catch (e) {
    Logger.log('No QUESTIONS tab to migrate - nothing to do.');
    return 0;
  }

  const already = {};
  readMessages().forEach(function (m) { already[m.id] = true; });

  // Oldest first, so the conversation reads in the order it happened.
  const inOrder = questions.slice().reverse();
  let added = 0;

  inOrder.forEach(function (q) {
    const askId = 'M-' + q.id + '-Q';
    if (!already[askId]) {
      appendToThread(q.from, VERIFIED_YES, SIDE_USER, q.from,
                     q.question, q.askedAt, askId, q.topic);
      added++;
    }
    if (q.answer) {
      const ansId = 'M-' + q.id + '-A';
      if (!already[ansId]) {
        appendToThread(q.from, VERIFIED_YES, SIDE_TEAM,
                       q.answeredBy || 'team', q.answer, q.answeredAt, ansId);
        added++;
      }
    }
  });

  Logger.log('Migrated %s question(s) into %s message(s). The QUESTIONS tab ' +
             'was not changed.', questions.length, added);
  return added;
}


// ---------------------------------------------------------------------------
// THE PARTS NOBODY CALLS DIRECTLY
// ---------------------------------------------------------------------------

function threadTab() {
  return sheetWithHeaders(CONFIG.SHEETS.THREADS, CONFIG.THREAD_COLUMNS);
}
function messageTab() {
  return sheetWithHeaders(CONFIG.SHEETS.MESSAGES, CONFIG.MESSAGE_COLUMNS);
}


/** Trims and checks one message. Returns { text } or { bad: why }. */
function cleanMessage(text) {
  const body = String(text == null ? '' : text).trim();
  if (body.length < 2) return { bad: 'Write the message first.' };
  if (body.length > CONFIG.QUESTION_MAX) {
    return { bad: 'That is longer than ' + CONFIG.QUESTION_MAX + ' characters. ' +
                  'Send the short version and we will come back to you.' };
  }
  return { text: body };
}


/** Every thread, as plain objects, with the row each sits on. */
function readThreads() {
  const sheet = threadTab();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  const at = CONFIG.THREAD_COLUMNS;
  return sheet.getRange(2, 1, last - 1, at.length).getValues()
    .map(function (r, i) {
      return {
        row: i + 2,
        id: String(r[0] || ''),
        person: String(r[1] || ''),
        verified: String(r[2] || VERIFIED_YES),
        startedAt: r[3] ? new Date(r[3]).toISOString() : '',
        topic: String(r[4] || ''),
        lastAt: r[5] ? new Date(r[5]).toISOString() : '',
        lastBy: String(r[6] || ''),
        status: String(r[7] || THREAD_OPEN),
        waitingForTeam: Number(r[8]) || 0,
        unreadByPerson: Number(r[9]) || 0
      };
    })
    .filter(function (t) { return t.id && t.person; });
}


/** The one thread for this person at this verification level, or null. */
function findThread(person, verified) {
  const want = String(person || '').trim();
  const level = verified === VERIFIED_NO ? VERIFIED_NO : VERIFIED_YES;
  if (!want) return null;

  const hits = readThreads().filter(function (t) {
    return t.person === want && t.verified === level;
  });
  return hits.length ? hits[0] : null;
}


function threadById(id) {
  const want = String(id || '').trim();
  if (!want) return null;
  const hits = readThreads().filter(function (t) { return t.id === want; });
  return hits.length ? hits[0] : null;
}


/** Every message, oldest first. */
function readMessages() {
  const sheet = messageTab();
  const last = sheet.getLastRow();
  if (last < 2) return [];

  return sheet.getRange(2, 1, last - 1, CONFIG.MESSAGE_COLUMNS.length).getValues()
    .map(function (r) {
      return {
        id: String(r[0] || ''),
        threadId: String(r[1] || ''),
        at: r[2] ? new Date(r[2]).toISOString() : '',
        side: String(r[3] || SIDE_USER),
        author: String(r[4] || ''),
        text: String(r[5] || '')
      };
    })
    .filter(function (m) { return m.id && m.threadId; });
}


/**
 * One thread's messages, oldest first, without the author's ID on the user's
 * own lines - they know who they are, and the team's name is not the point.
 */
function threadMessageList(threadId) {
  const want = String(threadId || '');
  return readMessages()
    .filter(function (m) { return m.threadId === want; })
    .map(function (m) {
      return { id: m.id, at: m.at, side: m.side, text: m.text };
    });
}


/**
 * Writes one message, making the thread first if there is not one yet.
 *
 * THE MESSAGE ROW GOES DOWN BEFORE THE THREAD IS STAMPED. If the second write
 * fails the counters are stale, which is a wrong number on a badge. If it were
 * the other way round the message itself would be the thing that went missing,
 * and somebody would have typed it believing it was sent.
 *
 * @param {string} person    whose conversation
 * @param {string} verified  VERIFIED_YES or VERIFIED_NO
 * @param {string} side      SIDE_USER or SIDE_TEAM
 * @param {string} author    employee ID of whoever typed it
 * @param {string} text      the message
 * @param {string=} whenIso  for migration, the original timestamp
 * @param {string=} forceId  for migration, a stable ID so a second run is a
 *                           no-op instead of a duplicate
 * @param {string=} topic    only used when the thread is being created
 * @return {{threadId: string, messageId: string, wasWaiting: boolean}}
 */
function appendToThread(person, verified, side, author, text, whenIso, forceId, topic) {
  const who = String(person || '').trim();
  const level = verified === VERIFIED_NO ? VERIFIED_NO : VERIFIED_YES;
  const when = whenIso ? new Date(whenIso) : new Date();

  let thread = findThread(who, level);
  if (!thread) {
    const threadId = 'T' + stamp(when) + '-' + shortId();
    threadTab().appendRow([
      threadId, who, level, when, String(topic || '').trim().slice(0, 80),
      when, side, THREAD_OPEN, 0, 0
    ]);
    thread = findThread(who, level);
    if (!thread) throw new Error('Could not create a conversation for ' + who);
  }

  const wasWaiting = (Number(thread.waitingForTeam) || 0) > 0;
  const messageId = forceId || ('M' + stamp(when) + '-' + shortId());

  messageTab().appendRow([messageId, thread.id, when, side, String(author || ''), text]);

  // Counters after the message. See the note above.
  const waiting = side === SIDE_USER ? (Number(thread.waitingForTeam) || 0) + 1 : 0;
  const unread  = side === SIDE_TEAM ? (Number(thread.unreadByPerson) || 0) + 1 : 0;

  setThreadField(thread.row, 'Last Message At', when);
  setThreadField(thread.row, 'Last Message By', side);
  setThreadField(thread.row, 'Waiting For Team', waiting);
  setThreadField(thread.row, 'Unread By Person', unread);
  if (!thread.topic && topic) {
    setThreadField(thread.row, 'Topic', String(topic).trim().slice(0, 80));
  }

  return { threadId: thread.id, messageId: messageId, wasWaiting: wasWaiting };
}


function setThreadField(row, column, value) {
  const col = CONFIG.THREAD_COLUMNS.indexOf(column) + 1;
  if (col < 1) throw new Error('No such THREADS column: ' + column);
  threadTab().getRange(row, col).setValue(value);
}


function stamp(when) {
  return Utilities.formatDate(when || new Date(), CONFIG_TZ(), 'yyyyMMdd-HHmmss');
}

/** Six hex characters of a UUID. See the note on question IDs in Questions.gs. */
function shortId() {
  return Utilities.getUuid().slice(0, 6).toUpperCase();
}


/**
 * Takes one from an hourly bucket. Returns false when it is empty.
 *
 * Caches can be evicted, and this one failing open would hand the sign-in page
 * to anybody with a script. So unlike the per-person limit, which forgives a
 * missing cache because losing a question is worse than losing a cap, a
 * cache that cannot be read here counts as empty.
 */
function takeFromHourlyBucket(key, cap) {
  try {
    const cache = CacheService.getScriptCache();
    const used = parseInt(cache.get(key), 10) || 0;
    if (used >= cap) return false;
    cache.put(key, String(used + 1), 3600);
    return true;
  } catch (e) {
    Logger.log('Hourly bucket %s unreadable, refusing: %s', key, e.message);
    return false;
  }
}


/**
 * Tells the alert list that somebody is waiting. Never throws.
 *
 * Plain text on purpose - the body carries words somebody typed into a form on
 * a public page, and the one thing that cannot go wrong in a plain-text email
 * is markup.
 *
 * @return {boolean} whether anything was sent
 */
function alertTeamOfMessage(from, text, verified, threadId) {
  const to = questionAlertList();
  if (!to.length) return false;

  const unverified = verified === VERIFIED_NO;

  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: (unverified ? 'EAS dashboard - UNVERIFIED message from ' :
                             'EAS dashboard - a message from ') + from,
      body: [
        unverified
          ? 'Somebody used the message box on the SIGN-IN page, where nobody is'
          : 'Somebody sent a message on the Enterprise Application Services',
        unverified
          ? 'signed in. The employee ID below is only what they typed.'
          : 'dashboard.',
        '',
        'From:     employee ID ' + from,
        'Identity: ' + (unverified
          ? 'NOT VERIFIED - they were not signed in'
          : 'verified - they were signed in as this ID'),
        'Sent at:  ' + Utilities.formatDate(new Date(), CONFIG_TZ(),
                                            'd MMM yyyy, HH:mm'),
        'Thread:   ' + threadId,
        '',
        '--------------------------------------------------',
        text,
        '--------------------------------------------------',
        '',
        'Reply on the Help & FAQ screen of the dashboard:',
        CONFIG.DASHBOARD_URL,
        ''
      ].concat(unverified ? [
        'BECAUSE THIS ONE IS NOT VERIFIED: it tells you that somebody typed',
        'that employee ID into a box on a public web page, and nothing more.',
        'Do not reset a password, change a role or say anything confidential',
        'on the strength of it. Ring the person, or check with them in SAP.',
        '',
        'They will not see your reply either - they were not signed in, so',
        'there is no screen of theirs to put it on. Contact them directly.'
      ] : [
        'They see the reply in their own message panel. They are not emailed -',
        'an account here is an employee ID, and the dashboard holds no address',
        'for anybody.'
      ]).join('\n')
    });
    return true;
  } catch (e) {
    // Out of quota, not authorised for mail, or a bad address on the list. The
    // message is already saved and already in the inbox, so this costs a nudge
    // and nothing else.
    Logger.log('Message in thread %s saved but not emailed: %s', threadId, e.message);
    return false;
  }
}
