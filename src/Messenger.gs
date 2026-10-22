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
    threads: [],
    unread: 0,
    name: '',
    canAnswer: false,
    canDelete: false
  };

  if (!session) return out;

  out.threads = myThreads(token);
  out.unread = out.threads.reduce(function (n, t) { return n + t.unread; }, 0);

  out.name = nameOf(String(session.u || '').trim());

  try {
    const rank = rankOf(liveRoleOf(session.u));
    out.canAnswer = rank >= rankOf(ROLE_ADMIN);
    // Deleting a conversation destroys it for the person who wrote it too, so
    // it belongs to whoever owns the dashboard rather than to every admin.
    out.canDelete = rank >= rankOf(ROLE_MASTER);
  } catch (e) {
    out.canAnswer = false;
    out.canDelete = false;
  }
  return out;
}


/**
 * This person's own queries, newest activity first, each with its conversation.
 *
 * Theirs and nobody else's, decided here. An endpoint that returned everybody's
 * and let the panel show the right one would be handing the lot to anyone who
 * opened a console.
 *
 * Only VERIFIED threads. A message somebody typed from the sign-in page with
 * this employee ID on it is not this person's to read - see the note at the
 * top of the file about why those live apart.
 */
function myThreads(token) {
  const session = currentSession(token);
  if (!session) return [];
  const me = String(session.u || '').trim();

  return readThreads()
    .filter(function (t) {
      return t.person === me && t.verified === VERIFIED_YES;
    })
    .map(function (t) {
      return {
        id: t.id,
        topic: t.topic,
        startedAt: t.startedAt,
        lastAt: t.lastAt,
        lastBy: t.lastBy,
        waiting: Number(t.waitingForTeam) || 0,
        unread: Number(t.unreadByPerson) || 0,
        messages: threadMessageList(t.id)
      };
    })
    .sort(function (a, b) {
      return String(b.lastAt).localeCompare(String(a.lastAt));
    });
}


/**
 * Starts a NEW query, or adds a line to one this person already owns.
 *
 * @param {string} token     the sender's session
 * @param {string} threadId  '' to start a new query, otherwise one of theirs
 * @param {string} topic     a short subject, only used on a new query
 * @param {string} text      the message
 * @param {string} name      what to call them
 */
function sendMessage(token, threadId, topic, text, name) {
  const session = currentSession(token);
  if (!session) {
    return { ok: false, message: 'Your session has ended. Reload the page and ' +
                                 'sign in again.' };
  }
  const me = String(session.u || '').trim();

  const body = cleanMessage(text);
  if (body.bad) return { ok: false, message: body.bad };

  // THE THREAD HAS TO BE THEIRS. Without this check a signed-in person could
  // paste any conversation's ID into the call and write a line into somebody
  // else's query, signed with that person's name - and it would be read as
  // theirs by the team answering it.
  let into = null;
  const wanted = String(threadId || '').trim();
  if (wanted) {
    into = threadById(wanted);
    if (!into || into.person !== me || into.verified !== VERIFIED_YES) {
      return { ok: false, message: 'That conversation is no longer there.' };
    }
  }

  if (questionsLeftThisHour(me) <= 0) {
    return { ok: false,
             message: 'You have sent ' + CONFIG.QUESTION_RATE_PER_HOUR +
                      ' messages in the last hour, which is the limit. We have ' +
                      'them - somebody will reply here.' };
  }

  const result = appendToThread(me, VERIFIED_YES, SIDE_USER, me, body.text,
                                null, null, wanted ? null : topic,
                                cleanName(name), null, into);
  noteQuestionAsked(me);

  // Only nudge if the team is not already sitting on something unanswered in
  // THIS query. Four lines in a row while somebody thinks out loud is one
  // interruption, not four.
  const emailed = result.wasWaiting
    ? false
    : alertTeamOfMessage(me, body.text, VERIFIED_YES, result.threadId,
                         cleanName(name));

  return { ok: true, id: result.messageId, threadId: result.threadId,
           emailed: emailed, threads: myThreads(token),
           name: cleanName(name), message: 'Sent.' };
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
function sendUnverifiedMessage(ignoredToken, employeeId, text, name) {
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

  const result = appendToThread(who, VERIFIED_NO, SIDE_USER, who, body.text,
                                null, null, null, cleanName(name), null, null);
  noteQuestionAsked('anon-' + who);

  const mayEmail = !result.wasWaiting &&
    takeFromHourlyBucket('EAS_UNVERIFIED_MAIL', CONFIG.UNVERIFIED_EMAILS_PER_HOUR);
  if (mayEmail) alertTeamOfMessage(who, body.text, VERIFIED_NO, result.threadId,
                                   cleanName(name));

  // Deliberately identical whether or not that employee ID exists.
  return { ok: true,
           message: 'Sent to the EAS team. They will contact you directly - ' +
                    'the reply cannot come back to this box, because you are ' +
                    'not signed in.' };
}


/** This person's queries again, for the panel's poll while it is open. */
function myMessages(token) {
  const threads = myThreads(token);
  return {
    threads: threads,
    unread: threads.reduce(function (n, t) { return n + t.unread; }, 0)
  };
}


/**
 * Marks the team's replies in ONE query as seen.
 *
 * Per query rather than all at once: opening one conversation is not reading
 * the others, and clearing their dots would hide a reply the person has not
 * looked at yet.
 */
function markMyMessagesRead(token, threadId) {
  const session = currentSession(token);
  if (!session) return { ok: false };
  const me = String(session.u || '').trim();

  const thread = threadById(String(threadId || '').trim());
  if (!thread || thread.person !== me || thread.verified !== VERIFIED_YES) {
    return { ok: false };
  }

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
        id: t.id, person: t.person, name: t.name,
        verified: t.verified === VERIFIED_YES,
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

  // INTO THIS THREAD - the last argument, and the whole point of the call.
  // Left off, appendToThread had nothing to append to and started a fresh
  // conversation owned by the asker, so every reply the team sent arrived as
  // a new untitled query sitting beside the question instead of under it.
  appendToThread(thread.person, thread.verified, SIDE_TEAM,
                 String(session.u || ''), body.text,
                 null, null, null, null, nameOf(String(session.u || '')),
                 thread);

  return { ok: true, message: 'Replied.',
           messages: threadMessageList(thread.id) };
}


/**
 * How many conversations are waiting on us, for a signed-in admin.
 *
 * The badge was set once at sign-in and then only refreshed by opening the
 * Help screen, so an admin working on KPI 1 never learned that anybody had
 * written to them. The screen polls this.
 *
 * Guarded, unlike the unguarded count below it: that one is called by
 * getBootstrap on the server, where there is no token to check and the caller
 * has already been identified.
 */
function messagesWaiting(token) {
  requireAdmin(token);
  return unansweredQuestionCount();
}


/** How many conversations are waiting on us. Called server-side only. */
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

  // The thread each already-migrated message landed in, not just that it is
  // there: a second run has to put the ANSWER into the same conversation as
  // the question, and on that run the question is not written again.
  const already = {};
  readMessages().forEach(function (m) { already[m.id] = m.threadId; });

  // Oldest first, so the conversation reads in the order it happened.
  const inOrder = questions.slice().reverse();
  let added = 0;

  inOrder.forEach(function (q) {
    const askId = 'M-' + q.id + '-Q';
    let threadId = already[askId] || '';
    if (!threadId) {
      threadId = appendToThread(q.from, VERIFIED_YES, SIDE_USER, q.from,
                                q.question, q.askedAt, askId, q.topic).threadId;
      added++;
    }
    if (q.answer) {
      const ansId = 'M-' + q.id + '-A';
      if (!already[ansId]) {
        // Into the question's own thread. An answer migrated on its own used
        // to become a second conversation, so a question and the reply it was
        // given arrived in the inbox as two unrelated queries.
        appendToThread(q.from, VERIFIED_YES, SIDE_TEAM,
                       q.answeredBy || 'team', q.answer, q.answeredAt, ansId,
                       null, null, null, threadById(threadId));
        added++;
      }
    }
  });

  Logger.log('Migrated %s question(s) into %s message(s). The QUESTIONS tab ' +
             'was not changed.', questions.length, added);
  return added;
}


/**
 * Puts replies that were forked into conversations of their own back where
 * they belong. Run from the editor.
 *
 * WHAT WENT WRONG
 * replyToThread() looked its thread up correctly and then called
 * appendToThread() one argument short, so every reply the team sent started a
 * fresh conversation owned by the person who had asked. The question stayed
 * where it was, the answer appeared beside it as a new untitled query, and
 * neither screen had any way of knowing they belonged together. The code is
 * fixed; the rows those replies already wrote are still in the sheet, and
 * this moves them.
 *
 * A STRAY IS A CONVERSATION WITH NOTHING BUT TEAM LINES IN IT. Nobody can
 * start one of those by hand - the team only ever replies - so every thread
 * matching that description was made by the bug.
 *
 * WHERE EACH ONE GOES, AND WHY YOU SHOULD READ THE REPORT
 * The link back to the question was never written down, so it has to be
 * inferred: the reply goes into whichever of that person's real conversations
 * was the most recently active at the moment the reply was typed, which is
 * the one the admin had open. That is right whenever the team answered the
 * query that had just come in, and wrong if somebody went back to an older
 * one while a newer was waiting. So this CHANGES NOTHING until you ask it to,
 * and prints what it intends to do first.
 *
 *   repairStrayReplies()        - report only, nothing is written
 *   repairStrayReplies(true)    - do it
 *
 * If a line of the report names the wrong conversation, say so explicitly and
 * only that one is overridden:
 *
 *   repairStrayReplies(true, { 'T2026...-ab12': 'T2026...-cd34' })
 *                              stray id          where it should go
 *
 * @param {boolean=} apply      false or missing to report and write nothing
 * @param {Object=} overrides   stray thread ID -> the thread it belongs in
 * @return {number} how many conversations were merged, or would be
 */
function repairStrayReplies(apply, overrides) {
  requireOwner();

  const threads = readThreads();
  const byThread = {};
  readMessages().forEach(function (m) {
    (byThread[m.threadId] || (byThread[m.threadId] = [])).push(m);
  });

  const isStray = function (t) {
    const lines = byThread[t.id] || [];
    return lines.length > 0 && lines.every(function (m) {
      return m.side === SIDE_TEAM;
    });
  };
  const strays = threads.filter(isStray);

  if (!strays.length) {
    Logger.log('No stray replies. Every conversation has a question in it.');
    return 0;
  }

  const forced = overrides || {};
  const plan = strays.map(function (s) {
    const lines = byThread[s.id];
    const bornAt = lines[0].at || s.startedAt;

    let target = null;
    const said = String(forced[s.id] || '').trim();
    if (said) {
      target = threads.filter(function (t) { return t.id === said; })[0] || null;
    } else {
      target = threads.filter(function (t) {
        return t.id !== s.id && t.person === s.person &&
               t.verified === s.verified && !isStray(t) &&
               String(t.lastAt) < String(bornAt);
      }).sort(function (a, b) {
        return String(b.lastAt).localeCompare(String(a.lastAt));
      })[0] || null;
    }
    return { stray: s, target: target, lines: lines };
  });

  plan.forEach(function (p, i) {
    const first = p.lines[0];
    Logger.log('%s. %s line(s) from the team, in %s\'s conversation %s\n' +
               '     "%s"\n' +
               '     -> %s',
               i + 1, p.lines.length, p.stray.person, p.stray.id,
               String(first.text).slice(0, 70),
               p.target ? (p.target.id + '  "' + (p.target.topic || 'no subject') +
                           '", last active ' + p.target.lastAt)
                        : 'NOTHING TO MERGE INTO - left alone');
  });

  const doable = plan.filter(function (p) { return p.target; });

  if (!apply) {
    Logger.log('\nReport only - the sheet has not been touched. %s of %s can ' +
               'be merged. Read the list above, then run ' +
               'repairStrayReplies(true).', doable.length, plan.length);
    return doable.length;
  }

  // ---- move the lines ----
  const messages = messageTab();
  const threadIdColumn = CONFIG.MESSAGE_COLUMNS.indexOf('Thread ID') + 1;
  doable.forEach(function (p) {
    p.lines.forEach(function (m) {
      messages.getRange(m.row, threadIdColumn).setValue(p.target.id);
    });
  });

  // ---- re-add up the counters on what they were merged into ----
  // Replayed from the messages rather than added to what was there, because
  // the numbers on a thread are a running tally: a user line counts up and a
  // team line clears it. Unread is replayed too, which can mark a reply the
  // person has technically already seen - seen sitting in a query of its own,
  // where it made no sense. Showing it once more in the right place is the
  // kinder error.
  const fresh = {};
  readMessages().forEach(function (m) {
    (fresh[m.threadId] || (fresh[m.threadId] = [])).push(m);
  });

  const touched = {};
  doable.forEach(function (p) { touched[p.target.id] = p.target; });

  Object.keys(touched).forEach(function (id) {
    const t = touched[id];
    const lines = (fresh[id] || []).slice().sort(function (a, b) {
      return String(a.at).localeCompare(String(b.at));
    });
    if (!lines.length) return;

    let waiting = 0, unread = 0;
    lines.forEach(function (m) {
      waiting = m.side === SIDE_USER ? waiting + 1 : 0;
      unread  = m.side === SIDE_TEAM ? unread + 1 : 0;
    });
    const last = lines[lines.length - 1];

    setThreadField(t.row, 'Last Message At', new Date(last.at));
    setThreadField(t.row, 'Last Message By', last.side);
    setThreadField(t.row, 'Waiting For Team', waiting);
    setThreadField(t.row, 'Unread By Person', unread);
  });

  // ---- and take the empty shells away, bottom-up ----
  // Bottom-up because deleting a row moves every row under it up one, and a
  // list of row numbers read before the first delete is wrong from the second
  // delete onwards. The same reason deleteThread() walks its messages
  // backwards.
  doable.map(function (p) { return p.stray.row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (row) { threadTab().deleteRow(row); });

  Logger.log('\nMerged %s stray reply conversation(s) back into the questions ' +
             'they answered. %s left alone.',
             doable.length, plan.length - doable.length);
  return doable.length;
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
        unreadByPerson: Number(r[9]) || 0,
        name: String(r[10] || '')
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
    .map(function (r, i) {
      return {
        row: i + 2,                       // the sheet row, for the repair below
        id: String(r[0] || ''),
        threadId: String(r[1] || ''),
        at: r[2] ? new Date(r[2]).toISOString() : '',
        side: String(r[3] || SIDE_USER),
        author: String(r[4] || ''),
        text: String(r[5] || ''),
        authorName: String(r[6] || '')
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
      // The author goes out on a TEAM line and not on a USER one. A reply with
      // no name on it leaves the person wondering whether anybody owns it, and
      // leaves the next admin unable to tell that a colleague has it in hand.
      // The asker's own ID is left off their own lines - they know who they
      // are, and the thread header carries it for the team.
      const out = { id: m.id, at: m.at, side: m.side, text: m.text };
      if (m.side === SIDE_TEAM) out.by = who(m.author, m.authorName);
      return out;
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
function appendToThread(person, verified, side, author, text, whenIso, forceId,
                       topic, name, authorName, intoThread) {
  const who = String(person || '').trim();
  const level = verified === VERIFIED_NO ? VERIFIED_NO : VERIFIED_YES;
  const when = whenIso ? new Date(whenIso) : new Date();

  // An explicit thread means "this line belongs to THAT conversation". Without
  // one the unverified door still falls back to the single thread per claimed
  // ID - it is a lifeline channel, not a list of tickets.
  let thread = intoThread || (level === VERIFIED_NO ? findThread(who, level) : null);

  // THE TEAM DOES NOT START CONVERSATIONS. Somebody asks and somebody answers;
  // an answer with no question in front of it is not a conversation, it is a
  // caller that forgot to say which thread it meant. That is exactly what
  // happened - replyToThread stopped one argument short - and because the line
  // below happily made a thread for it, nothing failed, nothing was logged,
  // and the replies simply arrived as new queries of their own. Throwing is
  // the difference between a bug that announces itself in the execution log
  // and a bug that quietly rearranges somebody's inbox for three weeks.
  if (!thread && side === SIDE_TEAM) {
    throw new Error('A team reply has no conversation to go into - ' +
                    'appendToThread needs the thread as its last argument.');
  }

  if (!thread) {
    const threadId = 'T' + stamp(when) + '-' + shortId();
    threadTab().appendRow([
      threadId, who, level, when, String(topic || '').trim().slice(0, 80),
      when, side, THREAD_OPEN, 0, 0, String(name || '')
    ]);
    thread = threadById(threadId);
    if (!thread) throw new Error('Could not create a conversation for ' + who);
  }

  const wasWaiting = (Number(thread.waitingForTeam) || 0) > 0;
  const messageId = forceId || ('M' + stamp(when) + '-' + shortId());

  messageTab().appendRow([messageId, thread.id, when, side, String(author || ''),
                          text, cleanName(authorName)]);

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
  // A NAME BELONGS TO THE PERSON, NOT TO ONE OF THEIR QUERIES. Written onto
  // this row only, it would be missing from every other conversation they
  // have - the team's inbox would name them on one card and show a bare
  // employee ID on the next, and the panel would ask them to type it again
  // depending on which query it happened to read.
  //
  // A name given later replaces one given earlier, so somebody correcting a
  // typo in their own name is not stuck with it. An empty one never overwrites
  // a name already there, so leaving the box blank is not an erasure.
  if (name) nameEverywhere(who, level, name);

  return { threadId: thread.id, messageId: messageId, wasWaiting: wasWaiting };
}


function setThreadField(row, column, value) {
  const col = CONFIG.THREAD_COLUMNS.indexOf(column) + 1;
  if (col < 1) throw new Error('No such THREADS column: ' + column);
  threadTab().getRange(row, col).setValue(value);
}


/**
 * Deletes one conversation and everything in it. MASTER only.
 *
 * It really is gone - the thread row and every message row with it, from
 * everybody's screen at once. There is no undo, which is why the screen asks
 * first and names who the conversation is with.
 *
 * Messages are removed from the bottom up. Deleting row 5 moves row 6 to 5,
 * so walking downwards skips every second match - the kind of bug that leaves
 * half a conversation behind and looks like it worked.
 */
function deleteThread(token, threadId) {
  // MASTER, not ADMIN. This destroys a conversation for the person who wrote
  // it as well as for the team - their copy disappears from their own panel
  // with everything they were told in it. That is not a thing every admin
  // should be able to do to somebody else's record on a mis-click.
  requireMaster(token);

  const thread = threadById(threadId);
  if (!thread) return { ok: false, message: 'That conversation is no longer there.' };

  const messages = messageTab();
  const last = messages.getLastRow();
  if (last >= 2) {
    const ids = messages.getRange(2, 2, last - 1, 1).getValues();
    for (let i = ids.length - 1; i >= 0; i--) {
      if (String(ids[i][0] || '').trim() === thread.id) messages.deleteRow(i + 2);
    }
  }

  threadTab().deleteRow(thread.row);
  Logger.log('Deleted conversation %s with %s.', thread.id, thread.person);

  return { ok: true, message: 'Conversation deleted.' };
}


/** Puts a name on every one of this person's conversations at that level. */
function nameEverywhere(person, verified, name) {
  const said = cleanName(name);
  if (!said) return;

  readThreads().forEach(function (t) {
    if (t.person !== person || t.verified !== verified) return;
    if (t.name === said) return;              // nothing to write
    setThreadField(t.row, 'Name', said);
  });
}


/**
 * The name this employee ID is known by, or ''.
 *
 * Read from their conversations, which is the only place the dashboard
 * currently holds a name - any of them will do, since a name is written to
 * all of them at once. When the sign-up card starts asking for one this
 * should read the account instead, and everything above it keeps working.
 */
function nameOf(employeeId) {
  const hit = readThreads().filter(function (t) {
    return t.person === employeeId && t.verified === VERIFIED_YES && t.name;
  })[0];
  return hit ? hit.name : '';
}


/**
 * A name somebody typed, trimmed to something a line of an email can hold.
 *
 * Deliberately permissive about what is in it - people have apostrophes and
 * hyphens and more than three words in their names, and this is a label, not a
 * key. It is escaped wherever it is shown, which is where that question is
 * actually settled.
 */
function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 60);
}


/**
 * How a person is written wherever both halves are shown: "Rudra (20536723)".
 *
 * The ID is the half that means anything, so it is always there; the name is a
 * courtesy and may be missing. On an unverified thread BOTH are only what
 * somebody typed, which is why the word UNVERIFIED travels beside this and not
 * inside it.
 */
function who(employeeId, name) {
  const id = String(employeeId || '').trim();
  const said = cleanName(name);
  return said ? said + ' (' + id + ')' : id;
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
function alertTeamOfMessage(from, text, verified, threadId, name) {
  const to = questionAlertList();
  if (!to.length) return false;

  const unverified = verified === VERIFIED_NO;

  try {
    MailApp.sendEmail({
      to: to.join(','),
      subject: (unverified ? 'EAS dashboard - UNVERIFIED message from ' :
                             'EAS dashboard - a message from ') + who(from, name),
      body: [
        unverified
          ? 'Somebody used the message box on the SIGN-IN page, where nobody is'
          : 'Somebody sent a message on the Enterprise Application Services',
        unverified
          ? 'signed in. The employee ID below is only what they typed.'
          : 'dashboard.',
        '',
        'From:     ' + who(from, name),
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
