/**
 * messenger-write.js - sending, replying, attaching, deleting.
 * ===========================================================================
 *
 * Ported from src/Messenger.gs: sendMessage, sendUnverifiedMessage,
 * replyToThread, attachSignInThread, deleteThread, appendToThread,
 * recentTwinThread, twinThreadsOf, nameEverywhere, nameOf, cleanMessage.
 *
 * READ messenger-read.js FIRST. The rule that an unverified thread never
 * reaches the employee whose ID was typed is explained there, and three of
 * the functions here only make sense once it is understood.
 */

const crypto = require('crypto');
const db = require('./db');

const SIDE_USER = 'USER';
const SIDE_TEAM = 'TEAM';

// Config.gs:1103, 1106, 1197, 1200 and Messenger.gs:445. Plain constants
// rather than settings, because that is what they are in the original - a
// number in CONFIG that nobody has ever changed from a screen.
const QUESTION_MAX = 2000;
const QUESTION_RATE_PER_HOUR = 5;
const UNVERIFIED_PER_HOUR = 20;
const UNVERIFIED_EMAILS_PER_HOUR = 5;
const TWIN_WINDOW_MINUTES = 30;

// appsscript.json. The thread and message ids carry a local timestamp, and
// reading one as a time means knowing which clock it was written by.
const TZ = 'Asia/Dhaka';


// ---------------------------------------------------------------------------
// Small pieces, ported as they are
// ---------------------------------------------------------------------------

/** Trims and checks one message. Returns { text } or { bad }. */
function cleanMessage(text) {
  const body = String(text == null ? '' : text).trim();
  if (body.length < 2) return { bad: 'Write the message first.' };
  if (body.length > QUESTION_MAX) {
    return { bad: 'That is longer than ' + QUESTION_MAX + ' characters. ' +
                  'Send the short version and we will come back to you.' };
  }
  return { text: body };
}

/** Config.gs:2687. */
function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * How a person is written wherever both halves are shown.
 *
 * The ID is the half that means anything, so it is always there; the name is
 * a courtesy and may be missing. On an unverified thread BOTH are only what
 * somebody typed, which is why the word UNVERIFIED travels beside this and
 * not inside it.
 */
function who(employeeId, name) {
  const id = String(employeeId || '').trim();
  const said = cleanName(name);
  return said ? said + ' (' + id + ')' : id;
}

/** 'yyyyMMdd-HHmmss' in the dashboard's own timezone, as Utilities.formatDate. */
function stamp(when) {
  const d = when || new Date();
  const p = {};
  new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d).forEach(function (part) { p[part.type] = part.value; });
  // hour12:false gives '24' for midnight in some runtimes; Apps Script gives
  // '00', and an id that sorted after every other id of its own day would be
  // a nuisance to read in a list.
  const hh = p.hour === '24' ? '00' : p.hour;
  return p.year + p.month + p.day + '-' + hh + p.minute + p.second;
}

/** Six hex characters, as Utilities.getUuid().slice(0, 6). */
function shortId() {
  return crypto.randomUUID().slice(0, 6).toUpperCase();
}


// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------
/*
  CacheService.getScriptCache() HAS NO EQUIVALENT HERE, so the buckets are a
  Map in this process with the same one-hour window.

  That is the same guarantee the original gives and no more. Apps Script's
  script cache is per script and can be evicted at any moment; this one is
  per process and is lost on restart. Either way a determined caller gets a
  fresh allowance eventually, which is why the caps are a brake on accidents
  and floods rather than a security control. The things that actually
  protect the sign-in door are the length limit, the shape check on the
  employee ID, and the fact that an unverified thread reaches nobody.

  IF THIS API IS EVER RUN AS MORE THAN ONE PROCESS, each gets its own Map
  and the effective cap multiplies by the number of processes. At that
  point the buckets belong in a table. One process, which is what
  `npm start` gives, behaves exactly as the original does.

  The original has two different failure modes for an unreadable cache -
  questionsLeftThisHour forgives it ("losing somebody's question is worse
  than losing a cap") and takeFromHourlyBucket refuses ("fails closed,
  deliberately"). Neither is reachable here, because a Map cannot fail to
  be read, so neither is written. The reasoning is recorded rather than the
  dead branch.
*/
const buckets = new Map();

function bucketTake(key, cap) {
  const now = Date.now();
  const had = buckets.get(key);
  if (!had || had.until <= now) {
    buckets.set(key, { used: 1, until: now + 3600 * 1000 });
    return true;
  }
  if (had.used >= cap) return false;
  had.used++;
  return true;
}

function bucketLeft(key, cap) {
  const had = buckets.get(key);
  if (!had || had.until <= Date.now()) return cap;
  return Math.max(0, cap - had.used);
}

/** Only for the tests, which must not wait an hour. */
function bucketReset() { buckets.clear(); }


// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Puts a name on every one of this person's conversations at that level.
 *
 * A NAME BELONGS TO THE PERSON, NOT TO ONE OF THEIR QUERIES. Written onto
 * one row only, it would be missing from every other conversation they
 * have - the team's inbox would name them on one card and show a bare
 * employee ID on the next, and the panel would ask them to type it again
 * depending on which query it happened to read.
 *
 * Keyed by person AND level, which is why attachSignInThread has to carry
 * the name across by hand when it moves a thread from NO to YES.
 */
async function nameEverywhere(client, person, verified, name) {
  const said = cleanName(name);
  if (!said) return;
  await client.query(
    `UPDATE msg_thread SET name = $3
      WHERE person = $1 AND verified = $2 AND coalesce(name, '') <> $3`,
    [person, verified, said]);
}

/*
  db.query RETURNS THE ROWS; client.query RETURNS THE RESULT OBJECT. The two
  are not interchangeable - db.query ends in `return result.rows`, a pg
  client hands back { rows, rowCount, ... } - and a function that takes
  either has to know which it was given. rowsOf settles it in one place
  instead of at every call site, where sooner or later one of them reads
  .rows off an array and silently gets undefined.
*/
function rowsOf(result) {
  return Array.isArray(result) ? result : result.rows;
}

/** The name on this person's account, or ''. Auth.gs:1366. */
async function accountNameOf(employeeId, client) {
  const id = String(employeeId || '').trim().toLowerCase();
  if (!id) return '';
  const got = rowsOf(await (client || db).query(
    'SELECT full_name FROM account WHERE lower(employee_id) = $1', [id]));
  return (got[0] && got[0].full_name) ? String(got[0].full_name).trim() : '';
}

/**
 * The name this employee ID is known by, or ''.   [Messenger.gs:1467]
 *
 * THE ACCOUNT FIRST. A name used to live only on the conversations somebody
 * had started, which meant the dashboard could not name a person until they
 * had written to it - an admin replying for the first time signed their
 * reply with a bare employee ID.
 *
 * It does NOT read team.full_name, and that is deliberate in the original:
 * the directory entry is HR's, this is what somebody asked to be called.
 */
async function nameOf(employeeId, client) {
  const onAccount = await accountNameOf(employeeId, client);
  if (onAccount) return onAccount;

  const got = rowsOf(await (client || db).query(
    `SELECT name FROM msg_thread
      WHERE person = $1 AND verified = true AND coalesce(name, '') <> ''
      ORDER BY started NULLS LAST, thread_id LIMIT 1`, [employeeId]));
  return got[0] ? String(got[0].name) : '';
}

/**
 * Somebody setting their own name.   [Auth.gs:1389 setMyName]
 *
 * Their past messages carry a name stamped at the time, so the
 * conversations they have already started would keep the old one. This
 * brings them with.
 */
async function setMyName(client, employeeId, fullName) {
  const said = cleanName(fullName);
  if (!said) return '';

  const done = await client.query(
    'UPDATE account SET full_name = $2 WHERE employee_id = $1 RETURNING employee_id',
    [employeeId, said]);

  // Saved if it can be. If it cannot - an account removed while its owner
  // still holds a token - the message still goes out under the name they
  // typed, because failing to store a courtesy is no reason to strip it off
  // the line they are sending.
  if (done.rows.length) await nameEverywhere(client, employeeId, true, said);
  return said;
}


// ---------------------------------------------------------------------------
// appendToThread - every line that gets written goes through here
// ---------------------------------------------------------------------------
/**
 * Appends one line to a conversation, making the conversation if needed.
 *
 * NAMED OPTIONS, NOT TWELVE POSITIONAL ARGUMENTS, and this is the one
 * deliberate shape change in the file. The original takes
 *
 *     appendToThread(person, verified, side, author, text, whenIso, forceId,
 *                    topic, name, authorName, intoThread, files)
 *
 * and its own comment records what that cost:
 *
 *     "THE TEAM DOES NOT START CONVERSATIONS ... That is exactly what
 *      happened - replyToThread stopped one argument short - and because
 *      the line below happily made a thread for it, nothing failed,
 *      nothing was logged, and the replies simply arrived as new queries
 *      of their own."
 *
 * Eleven arguments in and the twelfth missing is not a mistake anybody
 * sees in review. Named keys make the same mistake impossible to write.
 * The behaviour is unchanged, including the throw below, which stays
 * because a guard that caught a real bug is not made redundant by making
 * the bug harder to write.
 *
 * TAKES A CLIENT, so it runs inside the caller's transaction rather than
 * opening its own. Writing the message and stamping the thread are one
 * change; a crash between them would leave a line nobody is waiting for.
 *
 * THE COUNTERS ARE INCREMENTED IN SQL, not read into JavaScript and written
 * back. Messenger.gs does
 *
 *     const waiting = side === SIDE_USER ? (thread.waitingForTeam || 0) + 1 : 0;
 *
 * which is a read-modify-write, and it takes no lock anywhere in the file -
 * two lines landing together both read the same number and the second
 * overwrites the first, so the badge quietly undercounts. `waiting_for_team
 * + 1` inside the statement cannot do that. The row is held with FOR UPDATE
 * from the moment it is read, so wasWaiting is the value this line actually
 * followed.
 */
async function appendToThread(client, opts) {
  const person = String(opts.person || '').trim();
  const verified = opts.verified === true;
  const side = opts.side === SIDE_TEAM ? SIDE_TEAM : SIDE_USER;
  const when = opts.when ? new Date(opts.when) : new Date();
  const topic = String(opts.topic || '').trim().slice(0, 80);
  const files = opts.files && opts.files.length ? opts.files : [];

  /*
    ONE LOCK PER PERSON AND LEVEL, taken before anything is read.

    It covers find-or-create as well as the counters. Without it two
    unverified messages from the same ID arriving together would both find
    no thread and both make one, and from then on that ID would have two
    sign-in threads where the original guarantees one - "it is a lifeline
    channel, not a list of tickets". Keyed per person, so two people
    writing at once do not queue behind each other.
  */
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
                     ['msg|' + person + '|' + (verified ? 'YES' : 'NO')]);

  let thread = null;
  if (opts.intoThreadId) {
    const got = await client.query(
      'SELECT * FROM msg_thread WHERE thread_id = $1 FOR UPDATE',
      [String(opts.intoThreadId)]);
    thread = got.rows[0] || null;
  } else if (!verified) {
    // An explicit thread means "this line belongs to THAT conversation".
    // Without one the unverified door still falls back to the single thread
    // per claimed ID.
    const got = await client.query(
      `SELECT * FROM msg_thread WHERE person = $1 AND verified = false
        ORDER BY started NULLS LAST, thread_id LIMIT 1 FOR UPDATE`, [person]);
    thread = got.rows[0] || null;
  }

  /*
    THE TEAM DOES NOT START CONVERSATIONS. Somebody asks and somebody
    answers; an answer with no question in front of it is not a
    conversation, it is a caller that forgot to say which thread it meant.
    Throwing is the difference between a bug that announces itself and a
    bug that quietly rearranges somebody's inbox for three weeks.
  */
  if (!thread && side === SIDE_TEAM) {
    throw new Error('A team reply has no conversation to go into - ' +
                    'appendToThread needs intoThreadId.');
  }

  if (!thread) {
    const newId = 'T' + stamp(when) + '-' + shortId();
    const made = await client.query(
      `INSERT INTO msg_thread (thread_id, person, verified, started, topic,
                               last_message_at, last_message_by, status,
                               waiting_for_team, unread_by_person, name)
       VALUES ($1,$2,$3,$4,$5,$4,$6,'OPEN',0,0,$7)
       RETURNING *`,
      [newId, person, verified, when, topic, side, String(opts.name || '')]);
    thread = made.rows[0];
  }

  const wasWaiting = Number(thread.waiting_for_team) > 0;
  const messageId = opts.forceId || ('M' + stamp(when) + '-' + shortId());

  await client.query(
    `INSERT INTO msg_line (message_id, thread_id, at, side, author, body,
                           author_name, files)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [messageId, thread.thread_id, when, side, String(opts.author || ''),
     opts.text, cleanName(opts.authorName), JSON.stringify(files)]);

  await client.query(
    `UPDATE msg_thread
        SET last_message_at  = $2,
            last_message_by  = $3,
            waiting_for_team = CASE WHEN $3 = 'USER'
                                    THEN waiting_for_team + 1 ELSE 0 END,
            unread_by_person = CASE WHEN $3 = 'TEAM'
                                    THEN unread_by_person + 1 ELSE 0 END,
            topic            = CASE WHEN coalesce(topic, '') = '' AND $4 <> ''
                                    THEN $4 ELSE topic END
      WHERE thread_id = $1`,
    [thread.thread_id, when, side, topic]);

  // A name given later replaces one given earlier, so somebody correcting a
  // typo is not stuck with it. An empty one never overwrites a name already
  // there, so leaving the box blank is not an erasure.
  if (opts.name) await nameEverywhere(client, person, verified, opts.name);

  return { threadId: thread.thread_id, messageId: messageId,
           wasWaiting: wasWaiting };
}


// ---------------------------------------------------------------------------
// Duplicate sends
// ---------------------------------------------------------------------------
/**
 * The same question, from the same person, minutes ago, still unanswered.
 *
 * A DOUBLE-SEND IS NOT A SECOND QUESTION. Every new query starts its own
 * thread, which is right - two questions deserve two conversations. But a
 * slow connection and a second press of Send are not two questions, and
 * they used to produce two identical threads with identical subjects a
 * minute apart. Answering one leaves the other sitting in the inbox as
 * unanswered work, for ever, and the count at the top of the screen goes on
 * saying somebody is waiting.
 *
 * Deliberately narrow: same person, same words, same subject, exactly one
 * line in it, inside the window. Ask the same question again next week and
 * it is a new query, because by then it is one.
 *
 * RUN INSIDE THE SAME LOCK as the append that follows it, unlike the
 * original, which checks outside any lock at all. Two presses of Send half
 * a second apart are the exact case this exists for, and that is also the
 * exact case where both calls can run the check before either has written
 * anything. Serialised per person, the second one sees the first.
 */
async function recentTwinThread(client, person, text, topic) {
  const said = String(text || '').trim();
  const want = String(topic || '').trim().toLowerCase();
  if (!person || !said) return null;

  /*
    "EXACTLY ONE LINE, AND IT SAYS THIS" IS ONE SUBQUERY, NOT TWO.

    It was written as two - a count, and then a bare
    (SELECT btrim(m.body) ...) = $4 beside it - which looks equivalent and
    is not. A scalar subquery that finds more than one row THROWS, and SQL
    gives no evaluation order to the operands of AND, so the count sitting
    to its left does not protect it. On a thread with two lines the
    planner is free to run the second subquery first, and then a perfectly
    ordinary reply answers 500.

    Aggregating both facts in one subquery cannot do that: it returns one
    row of one boolean whatever the thread holds.
  */
  const got = await client.query(
    `SELECT t.* FROM msg_thread t
      WHERE t.person = $1 AND t.verified = true
        AND lower(btrim(coalesce(t.topic, ''))) = $2
        AND t.last_message_at >= now() - ($3 || ' minutes')::interval
        AND (SELECT count(*) = 1 AND count(*) FILTER (WHERE btrim(m.body) = $4) = 1
               FROM msg_line m WHERE m.thread_id = t.thread_id)
      ORDER BY t.last_message_at DESC LIMIT 1`,
    [person, want, String(TWIN_WINDOW_MINUTES), said]);

  return got.rows[0] || null;
}

/**
 * The other copies of a query, for a reply to answer along with it.
 *
 * Cleans up what the guard above now prevents. Two identical unanswered
 * queries already in the inbox cannot be merged - they are two rows with
 * two ids - so a reply to one answers the rest, which is the honest
 * outcome: the same answer does answer the same question.
 *
 * Matched on the asker's words rather than on the thread, because that is
 * what makes them the same question. A thread the person has since added to
 * is left alone: it has moved on and deserves its own reply.
 */
async function twinThreadsOf(client, thread) {
  if (!thread || thread.verified !== true) return [];

  const asked = await client.query(
    `SELECT btrim(body) AS body FROM msg_line
      WHERE thread_id = $1 AND side = 'USER' ORDER BY at, message_id`,
    [thread.thread_id]);
  if (asked.rows.length !== 1) return [];

  const said = asked.rows[0].body;
  if (!said) return [];

  const got = await client.query(
    `SELECT t.* FROM msg_thread t
      WHERE t.thread_id <> $1
        AND t.person = $2 AND t.verified = true
        AND t.waiting_for_team > 0
        AND lower(btrim(coalesce(t.topic, ''))) = $3
        -- One subquery, for the reason spelled out in recentTwinThread.
        AND (SELECT count(*) = 1 AND count(*) FILTER (WHERE btrim(m.body) = $4) = 1
               FROM msg_line m WHERE m.thread_id = t.thread_id)
        AND ($5::timestamptz IS NULL
             OR coalesce(t.started, t.last_message_at) IS NULL
             OR abs(extract(epoch from
                    coalesce(t.started, t.last_message_at) - $5::timestamptz))
                <= $6 * 60)`,
    [thread.thread_id, thread.person,
     String(thread.topic || '').trim().toLowerCase(), said,
     thread.started || thread.last_message_at, TWIN_WINDOW_MINUTES]);

  return got.rows;
}


// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
/*
  THERE IS NO FILE STORE IN THIS PORT YET, so every attachment is dropped
  and the sender is told how many.

  THIS IS NOT A GAP - IT IS WHAT THE LIVE SYSTEM DOES TODAY. saveChatImages
  returns [] and writes nothing when no folder is configured, and
  CHAT_FOLDER has never been set on the live script:

    "Returns [] and writes nothing when no folder is configured ... The
     caller reports it; the message is never held hostage to it."

  So the path below is the one the original takes right now, down to the
  wording of the message, and the sender is told rather than left believing
  a screenshot went. When a store is chosen, this is the only function that
  changes - the limits are already written down: three images a line and
  three megabytes each, images only, checked here rather than trusted from
  the browser.
*/
function saveChatImages() { return []; }


// ---------------------------------------------------------------------------
// The endpoints
// ---------------------------------------------------------------------------

/**
 * Starts a NEW query, or adds a line to one this person already owns.
 *
 * THE THREAD HAS TO BE THEIRS. Without this check a signed-in person could
 * paste any conversation's ID into the call and write a line into somebody
 * else's query, signed with that person's name - and it would be read as
 * theirs by the team answering it.
 */
async function sendMessage(me, threadId, topic, text, name, images) {
  // A LINE THAT IS NOTHING BUT A SCREENSHOT IS A LINE. "Here, look" with
  // the picture attached is how people actually report a fault, and
  // refusing it because the text box was empty would make them type a full
  // stop to get past the check.
  const has = (images || []).length > 0;
  const body = cleanMessage(has && !String(text || '').trim() ? '(screenshot)' : text);
  if (body.bad) return { ok: false, message: body.bad };

  if (bucketLeft('q|' + me, QUESTION_RATE_PER_HOUR) <= 0) {
    return { ok: false,
             message: 'You have sent ' + QUESTION_RATE_PER_HOUR +
                      ' messages in the last hour, which is the limit. We have ' +
                      'them - somebody will reply here.' };
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const wanted = String(threadId || '').trim();
    let intoId = null;
    if (wanted) {
      const got = await client.query(
        'SELECT thread_id, person, verified FROM msg_thread WHERE thread_id = $1',
        [wanted]);
      const t = got.rows[0];
      if (!t || t.person !== me || t.verified !== true) {
        await client.query('ROLLBACK');
        return { ok: false, message: 'That conversation is no longer there.' };
      }
      intoId = t.thread_id;
    }

    /*
      WHAT THIS PERSON IS CALLED, decided once rather than per message.
      The account wins if it has a name: correcting a name is something
      done on purpose, from the prompt or the Accounts screen, and not a
      side effect of sending a message - otherwise a typo in the panel
      would silently rename somebody across every conversation they have.
    */
    let myName = await accountNameOf(me, client);
    if (!myName) {
      const said = cleanName(name);
      if (said) myName = (await setMyName(client, me, said)) || said;
    }

    // The lock the twin check needs is taken by appendToThread, so it has
    // to be taken here too - before the read it protects.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',
                       ['msg|' + me + '|YES']);

    if (!intoId) {
      const twin = await recentTwinThread(client, me, body.text, topic);
      // Only when there is nothing attached. The same words with a
      // screenshot this time is somebody adding evidence, not somebody
      // pressing Send twice, and dropping it would lose the thing they
      // went to the trouble of taking.
      if (twin && !has) {
        await client.query('COMMIT');
        // It answers ok, because from where the sender is sitting it
        // worked - their question is in the inbox exactly once, which is
        // what they were trying to achieve by pressing the button again.
        return { ok: true, id: '', threadId: twin.thread_id, emailed: false,
                 name: myName,
                 // Re-read, not inferred from myName. setMyName does not
                 // save when the account has since been removed, and the
                 // message still goes out under the name they typed - so
                 // "do they have a name on their account" and "is this
                 // message signed" are two different questions.
                 nameOnAccount: Boolean(await accountNameOf(me, client)),
                 message: 'Sent.' };
      }
      if (twin) intoId = twin.thread_id;
    }

    const kept = saveChatImages(images);

    const result = await appendToThread(client, {
      person: me, verified: true, side: SIDE_USER, author: me,
      text: body.text, topic: wanted ? '' : topic, name: myName,
      authorName: myName, intoThreadId: intoId, files: kept
    });

    // Read before the commit, while the client is still ours.
    const nameOnAccount = Boolean(await accountNameOf(me, client));

    await client.query('COMMIT');
    bucketTake('q|' + me, QUESTION_RATE_PER_HOUR);

    // SAY SO IF AN IMAGE DID NOT MAKE IT. Somebody who attached a
    // screenshot and sees "Sent." must not be left believing it went.
    const lost = (images || []).length - kept.length;

    return { ok: true, id: result.messageId, threadId: result.threadId,
             // Only nudge if the team is not already sitting on something
             // unanswered in THIS query. Four lines in a row while somebody
             // thinks out loud is one interruption, not four. No mail is
             // sent by this port yet - see alertTeamOfMessage in the
             // inventory - so this reports what WOULD have been sent.
             emailed: false,
             wouldEmail: !result.wasWaiting,
             name: myName, nameOnAccount: nameOnAccount,
             message: lost
               ? 'Sent, but ' + lost + (lost === 1 ? ' image' : ' images') +
                 ' could not be attached.'
               : 'Sent.' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


/**
 * Sends a message from the sign-in page, where nobody is signed in.
 *
 * NO TOKEN, BY DESIGN. Everything that protects it is in here: a global
 * hourly cap, a cap on how many of those may send mail, a length limit, and
 * a thread marked unverified that the claimed owner of the ID will never
 * see.
 *
 * The employee ID is NOT checked against the accounts, on purpose. Checking
 * it, and saying so, would turn the sign-in page into a list of everybody
 * who works here for anyone who cared to try numbers at it.
 */
async function sendUnverifiedMessage(employeeId, text, name) {
  const id = String(employeeId == null ? '' : employeeId).trim().slice(0, 40);
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(id)) {
    return { ok: false, message: 'Put your employee ID in first - the one you ' +
                                 'sign in with.' };
  }

  const body = cleanMessage(text);
  if (body.bad) return { ok: false, message: body.bad };

  // The same answer for a full bucket as for a successful send would be
  // kinder to a bot and crueller to a colleague, so this one says what
  // happened.
  if (!bucketTake('EAS_UNVERIFIED', UNVERIFIED_PER_HOUR)) {
    return { ok: false,
             message: 'The sign-in message box is busy at the moment. If you ' +
                      'are locked out, please phone the EAS team instead.' };
  }
  if (bucketLeft('q|anon-' + id, QUESTION_RATE_PER_HOUR) <= 0) {
    return { ok: false,
             message: 'That is several messages from this ID in the last hour. ' +
                      'We have them - somebody will be in touch.' };
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await appendToThread(client, {
      person: id, verified: false, side: SIDE_USER, author: id,
      text: body.text, name: cleanName(name), authorName: cleanName(name)
    });
    await client.query('COMMIT');
    bucketTake('q|anon-' + id, QUESTION_RATE_PER_HOUR);

    const mayEmail = !result.wasWaiting &&
      bucketTake('EAS_UNVERIFIED_MAIL', UNVERIFIED_EMAILS_PER_HOUR);

    // Deliberately identical whether or not that employee ID exists.
    return { ok: true, wouldEmail: mayEmail,
             message: 'Sent to the EAS team. They will contact you directly - ' +
                      'the reply cannot come back to this box, because you are ' +
                      'not signed in.' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


/** Replies to one conversation. Admin and above. */
async function replyToThread(adminId, threadId, text, images) {
  const has = (images || []).length > 0;
  const body = cleanMessage(has && !String(text || '').trim() ? '(screenshot)' : text);
  if (body.bad) return { ok: false, message: body.bad };

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const got = await client.query(
      'SELECT * FROM msg_thread WHERE thread_id = $1',
      [String(threadId || '').trim()]);
    const thread = got.rows[0];
    if (!thread) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'That conversation is no longer there.' };
    }

    const kept = saveChatImages(images);
    const signedBy = await nameOf(adminId, client);

    // INTO THIS THREAD - the whole point of the call. Left off,
    // appendToThread had nothing to append to and started a fresh
    // conversation owned by the asker, so every reply the team sent
    // arrived as a new untitled query sitting beside the question instead
    // of under it.
    await appendToThread(client, {
      person: thread.person, verified: thread.verified, side: SIDE_TEAM,
      author: adminId, text: body.text, authorName: signedBy,
      intoThreadId: thread.thread_id, files: kept
    });

    /*
      AND THE OTHER COPIES OF THE SAME QUESTION, if there are any.

      Duplicates cannot happen any more - see recentTwinThread - but the
      ones already in the inbox have to be answerable, and answering them
      one at a time means reading the same question three times and typing
      the same answer three times.

      NOT wrapped in its own try/catch the way the original is. There it
      swallows a failure because the reply has already been written to the
      sheet and cannot be taken back; here everything is in one
      transaction, so a failure rolls the whole reply back and the admin
      sees an error instead of a half-delivered answer. Swallowing it
      would mean committing a transaction we know threw.
    */
    let also = 0;
    const twins = await twinThreadsOf(client, thread);
    for (const twin of twins) {
      await appendToThread(client, {
        person: twin.person, verified: twin.verified, side: SIDE_TEAM,
        author: adminId, text: body.text, authorName: signedBy,
        intoThreadId: twin.thread_id, files: kept
      });
      also++;
    }

    await client.query('COMMIT');

    const lost = (images || []).length - kept.length;
    return { ok: true,
             message: (also
               ? 'Replied, and to ' + also +
                 (also === 1 ? ' duplicate of it.' : ' duplicates of it.')
               : 'Replied.') +
               (lost ? ' ' + lost + (lost === 1 ? ' image' : ' images') +
                       ' could not be attached.' : '') };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


/**
 * Puts a sign-in-page conversation onto the account that owns that ID.
 *
 * WHY THIS IS A BUTTON AND NOT A RULE.
 *
 * myThreads refuses unverified threads to everybody, and the reasoning
 * still stands: the sign-in page is public, so anybody who can load it can
 * type ANY employee ID and write under it. Attaching those messages to the
 * account automatically, because the ID now has one, would let a stranger
 * put words into a colleague's own message panel with the team's reply
 * underneath.
 *
 * The missing piece was never the check. It was that the team had no way to
 * say "I have confirmed this is them" - so a reply to somebody who wrote in
 * locked out, got helped, and then enrolled reached nobody at all, which is
 * the whole case that box exists for.
 *
 * So: a person decides, one conversation at a time, and the decision is the
 * evidence. Nothing is linked by matching an ID. The admin pressing this
 * has read the thread and knows who they rang.
 *
 * Admin, like replying. Deleting is master-only because it destroys
 * somebody's record; this only makes a conversation visible to the person
 * it already names, which is a smaller thing than the reply itself.
 */
async function attachSignInThread(adminId, threadId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const got = await client.query(
      'SELECT * FROM msg_thread WHERE thread_id = $1 FOR UPDATE',
      [String(threadId || '').trim()]);
    const thread = got.rows[0];
    if (!thread) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'That conversation is no longer there.' };
    }
    if (thread.verified === true) {
      await client.query('ROLLBACK');
      return { ok: false, message: 'That one is already on their account.' };
    }

    /*
      THE ID MUST BE ENROLLED. Not as a proof of anything - it is not one -
      but because attaching a thread to an account that does not exist
      leaves a verified conversation that no one can ever open, and whoever
      enrols under that ID later would inherit a stranger's messages.
    */
    const acc = await client.query(
      'SELECT employee_id FROM account WHERE employee_id = $1', [thread.person]);
    if (!acc.rows.length) {
      await client.query('ROLLBACK');
      return { ok: false,
               message: 'Nobody has opened an account under ' + thread.person +
                        ' yet, so there is nothing to attach it to.' };
    }

    await client.query(
      'UPDATE msg_thread SET verified = true WHERE thread_id = $1',
      [thread.thread_id]);

    // AND CARRY THE NAME ACROSS. nameEverywhere is keyed by person AND
    // level, so a name given on the sign-in page sits on the unverified
    // rows and does not follow the thread over on its own - the person's
    // own panel would show a conversation headed by a bare employee ID.
    if (thread.name) {
      await nameEverywhere(client, thread.person, true, thread.name);
    }

    await client.query('COMMIT');
    console.log('  Thread ' + thread.thread_id + ' with ' + thread.person +
                ' attached to their account by ' + adminId + '.');

    return { ok: true,
             message: who(thread.person, thread.name) +
                      ' can see this conversation now, replies included.' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}


/**
 * Deletes one conversation and everything in it. MASTER only.
 *
 * It really is gone - the thread row and every message row with it, from
 * everybody's screen at once. There is no undo, which is why the screen
 * asks first and names who the conversation is with.
 *
 * MASTER, not ADMIN. This destroys a conversation for the person who wrote
 * it as well as for the team - their copy disappears from their own panel
 * with everything they were told in it. That is not a thing every admin
 * should be able to do to somebody else's record on a mis-click.
 *
 * The original deletes the message rows from the bottom up, because
 * deleting row 5 moves row 6 to 5 and walking downwards skips every second
 * match - "the kind of bug that leaves half a conversation behind and looks
 * like it worked". There are no row numbers here: ON DELETE CASCADE takes
 * the lines with the thread, as one statement, and there is nothing left to
 * get wrong.
 */
async function deleteThread(masterId, threadId) {
  const got = await db.query(
    'DELETE FROM msg_thread WHERE thread_id = $1 RETURNING thread_id, person',
    [String(threadId || '').trim()]);

  if (!got.length) {
    return { ok: false, message: 'That conversation is no longer there.' };
  }
  console.log('  Deleted conversation ' + got[0].thread_id + ' with ' +
              got[0].person + ', by ' + masterId + '.');
  return { ok: true, message: 'Conversation deleted.' };
}


module.exports = {
  QUESTION_MAX, QUESTION_RATE_PER_HOUR, UNVERIFIED_PER_HOUR,
  UNVERIFIED_EMAILS_PER_HOUR, TWIN_WINDOW_MINUTES,
  cleanMessage, cleanName, who, stamp, shortId,
  bucketTake, bucketLeft, bucketReset,
  nameEverywhere, accountNameOf, nameOf, setMyName,
  appendToThread, recentTwinThread, twinThreadsOf, saveChatImages,
  sendMessage, sendUnverifiedMessage, replyToThread,
  attachSignInThread, deleteThread
};
