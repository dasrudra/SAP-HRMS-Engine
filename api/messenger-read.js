/**
 * messenger-read.js - the inbox, and one person's own conversations.
 * ===========================================================================
 *
 * Ported from src/Messenger.gs: myThreads, listThreads, enrolmentOf,
 * inboxKeyOf, peopleWaiting.
 *
 * The one rule to understand before reading any of it is in myThreads, and
 * it is the rule behind the bug Rudra reported - a password reset replied
 * to, and nothing in the person's chatbox.
 */

const db = require('./db');

const SIDE_USER = 'USER';
const SIDE_TEAM = 'TEAM';


/** Every line of one conversation, oldest first. */
async function threadMessageList(threadId) {
  const rows = await db.query(
    `SELECT message_id, at, side, author, body, author_name, files
       FROM msg_line WHERE thread_id = $1 ORDER BY at, message_id`,
    [threadId]);

  return rows.map(function (m) {
    return {
      id: m.message_id,
      at: m.at ? new Date(m.at).toISOString() : '',
      side: m.side,
      author: m.author || '',
      text: m.body,
      authorName: m.author_name || '',
      files: m.files || []
    };
  });
}


/**
 * This person's own queries, newest activity first.   [Messenger.gs:130]
 *
 * ONLY VERIFIED THREADS, STILL - including when the employee ID on an
 * unverified one has since been enrolled.
 *
 * That exception was written and then taken out again, so the reasoning is
 * here rather than in a commit nobody will find. The sign-in page is
 * public: anybody who can load it can type ANY employee ID and write
 * whatever they like under it. Showing those messages to the person who
 * owns the ID would let a stranger put words into a colleague's own
 * message panel, attributed to that colleague, with the team's reply
 * underneath looking like an answer to something they never asked.
 *
 * THE COST IS REAL AND IS THE TEAM'S TO CARRY, NOT THE READER'S: a reply
 * written into a sign-in-page thread reaches nobody. That is exactly what
 * happened when Rudra reset somebody's password, replied, and the person
 * saw an empty chatbox. The inbox says so on the card, and the fix is
 * attachSignInThread - an admin confirming out of band and attaching it.
 *
 * Theirs and nobody else's, decided HERE. An endpoint that returned
 * everybody's and let the panel show the right one would be handing the
 * lot to anyone who opened a console.
 */
async function myThreads(employeeId) {
  const me = String(employeeId || '').trim();
  if (!me) return [];

  const rows = await db.query(
    `SELECT thread_id, topic, started, last_message_at, last_message_by,
            waiting_for_team, unread_by_person
       FROM msg_thread
      WHERE person = $1 AND verified = true
      ORDER BY last_message_at DESC NULLS LAST`, [me]);

  const out = [];
  for (const t of rows) {
    out.push({
      id: t.thread_id,
      topic: t.topic || '',
      startedAt: t.started ? new Date(t.started).toISOString() : '',
      lastAt: t.last_message_at ? new Date(t.last_message_at).toISOString() : '',
      lastBy: t.last_message_by || '',
      waiting: Number(t.waiting_for_team) || 0,
      unread: Number(t.unread_by_person) || 0,
      messages: await threadMessageList(t.thread_id)
    });
  }
  return out;
}


/** Which of these employee IDs have an account.   [Messenger.gs:922] */
async function enrolmentOf(persons) {
  const out = {};
  const ids = [];
  persons.forEach(function (p) {
    const key = String(p || '').trim().toLowerCase();
    if (key && !(key in out)) { out[key] = false; ids.push(key); }
  });
  if (!ids.length) return out;

  // One query for the whole inbox rather than one per thread. Messenger.gs
  // makes the same point: "it is a spreadsheet read, and a busy inbox has
  // forty of them."
  const rows = await db.query(
    'SELECT lower(employee_id) AS id FROM account WHERE lower(employee_id) = ANY($1)',
    [ids]);
  rows.forEach(function (r) { out[r.id] = true; });
  return out;
}


/**
 * How the inbox groups cards.   [Messenger.gs:914]
 *
 * Somebody with an account is one person however they wrote in - their
 * sign-in-page attempts and their signed-in queries are the same human. An
 * ID with no account is grouped by what was true at the time, because
 * there is nobody to join them to.
 */
function inboxKeyOf(thread, enrolled) {
  const who = String(thread.person || '');
  return enrolled[who.trim().toLowerCase()]
    ? 'P|' + who
    : (thread.verified ? 'YES' : 'NO') + '|' + who;
}


/**
 * The people the team has not got back to.   [Messenger.gs:940]
 *
 * Per PERSON, not per thread: somebody who asked twice and got one answer
 * is still owed a word. "No word from them at all is not waiting. Their
 * word last is."
 */
function peopleWaiting(threads, enrolled) {
  const spoke = {};

  threads.forEach(function (t) {
    const key = inboxKeyOf(t, enrolled);
    const seen = spoke[key] || (spoke[key] = { user: '', team: '' });
    (t.messages || []).forEach(function (m) {
      const side = m.side === SIDE_TEAM ? 'team' : 'user';
      if (String(m.at) > seen[side]) seen[side] = String(m.at);
    });
  });

  return Object.keys(spoke).filter(function (key) {
    const s = spoke[key];
    return s.user && s.user > s.team;
  });
}


/**
 * Every conversation, the ones waiting on us first.   [Messenger.gs:393]
 *
 * The ordering is the whole value of an inbox: what somebody is waiting for
 * an answer to goes at the top, and the rest underneath in the order they
 * last moved.
 *
 * `verified` AND `enrolled` ARE DIFFERENT QUESTIONS and both are sent.
 * verified is what was true when they wrote; enrolled is whether that ID
 * has an account NOW. Somebody writes from the sign-in page BECAUSE they
 * cannot get in yet, and then they enrol - which is the whole point of
 * that box. The red NOT VERIFIED used to stay on their card for ever
 * afterwards, telling the team not to trust an identity the accounts list
 * had since confirmed.
 */
async function listThreads() {
  const rows = await db.query(
    `SELECT thread_id, person, name, verified, topic, started,
            last_message_at, last_message_by, status,
            waiting_for_team, unread_by_person
       FROM msg_thread`);

  const enrolled = await enrolmentOf(rows.map(function (r) { return r.person; }));

  const threads = [];
  for (const t of rows) {
    threads.push({
      id: t.thread_id,
      person: t.person,
      name: t.name || '',
      verified: t.verified === true,
      enrolled: Boolean(enrolled[String(t.person || '').trim().toLowerCase()]),
      topic: t.topic || '',
      startedAt: t.started ? new Date(t.started).toISOString() : '',
      lastAt: t.last_message_at ? new Date(t.last_message_at).toISOString() : '',
      lastBy: t.last_message_by || '',
      status: t.status,
      // Per query: has THIS question been answered.
      waiting: Number(t.waiting_for_team) || 0,
      messages: await threadMessageList(t.thread_id)
    });
  }

  const owed = {};
  peopleWaiting(threads, enrolled).forEach(function (k) { owed[k] = true; });
  threads.forEach(function (t) {
    // WHICH CARD THIS THREAD BELONGS TO. Sent, not just used here, because
    // the sidebar badge counts these and the inbox groups by them - and if
    // the badge counted something else the two could disagree. That is not
    // hypothetical: counting distinct PERSON instead collapses an ID that
    // has a verified thread and an unverified one (which happens when an
    // account is deleted after a signed-in conversation) into one, so the
    // page would show two cards both marked WAITING above a badge saying 1.
    t.key = inboxKeyOf(t, enrolled);

    // Per person: are we the ones who owe a word. Drives the pill on the
    // card, the ordering, and the badge in the sidebar - all from one
    // answer, so the number at the top and the pills down the page cannot
    // disagree.
    t.owed = Boolean(owed[t.key]);
  });

  threads.sort(function (a, b) {
    if (a.owed !== b.owed) return a.owed ? -1 : 1;
    return String(b.lastAt).localeCompare(String(a.lastAt));
  });

  return threads;
}


module.exports = {
  SIDE_USER, SIDE_TEAM,
  threadMessageList, myThreads, listThreads,
  enrolmentOf, inboxKeyOf, peopleWaiting
};
