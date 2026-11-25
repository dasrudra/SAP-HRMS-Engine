/**
 * messenger-test.js - reading the inbox, and the bug that emptied a chatbox.
 * ===========================================================================
 *
 * NEEDS A RUNNING SERVER AND DATABASE, like tick-test.js, which is why it is
 * not part of `npm test` - that suite is pure arithmetic and must stay
 * runnable with nothing switched on.
 *
 *     terminal 3:   npm start
 *     terminal 2:   node messenger-test.js
 *
 * It uses the same TICK_TEST_PASSWORD you already set, and signs its own
 * USER token for the role checks rather than asking you for a second
 * password.
 *
 * WHAT IT IS GUARDING
 *
 * One behaviour above all: an unverified thread - one somebody typed into
 * the public sign-in page - must NEVER appear in the panel of the employee
 * whose ID was typed. That is the rule behind
 *
 *     "I reset his password and sent a reply. But in his chatbox, there is
 *      nothing. No message, no reply, no conversation."
 *
 * The reply went into a sign-in-page thread, and those reach nobody. It
 * looks like a bug to fix by showing them. It is not: the sign-in page is
 * public, so anybody can type ANY employee ID into it and write under that
 * ID. Showing those to the owner of the ID lets a stranger put words into a
 * colleague's own message panel with the team's answer underneath. The fix
 * is an admin attaching the thread deliberately, and this test exists so
 * that nobody "fixes" it the other way a year from now.
 *
 * WHAT 52 PASSING IS WORTH
 *
 * Nothing, by itself. Thirteen deliberate breaks were made in
 * messenger-read.js and server.js - show the unverified threads, mark read
 * without checking the owner, sort newest-last, count waiting per thread
 * instead of per person, drop requireAdmin, and the rest - and every one
 * of them made this suite fail. None survived.
 *
 * One of those thirteen had to be written twice, which is the part worth
 * remembering. Deleting `AND person = $2` from the mark-read query looked
 * like a clean way to bypass the ownership check. It is not: the code
 * still passes two parameters, so PostgreSQL refused the bind and the
 * endpoint answered 500. The suite failed, but it failed because the query
 * was broken, not because the check was gone - which proves nothing about
 * the check. The honest mutation keeps the parameter in use:
 *
 *     AND person = $2        ->    AND (person = $2 OR true)
 *
 * and that one fails on "somebody else's thread cannot be marked read",
 * which is the assertion that was supposed to be under test. A mutation
 * that crashes the code is not a mutation, it is a different test.
 *
 * EVERY ROW IT WRITES has a thread id starting TEST- and a person who is
 * either the signed-in admin or an ID in the reserved 2099xxxx block. It
 * deletes them at the start as well as the end, so a run that dies halfway
 * does not poison the next one. Counts are checked as DELTAS against a
 * baseline taken first, so real conversations in the database neither
 * break the test nor get touched by it.
 */

/*
  dotenv FIRST, BEFORE ANY MODULE THAT READS THE ENVIRONMENT.

  require() runs a file top to bottom the moment it is first required, so
  by the time `require('./auth')` returns, auth.js has already read
  process.env.JWT_SECRET and - finding nothing, because dotenv had not run
  yet - printed "JWT_SECRET is missing" and killed the process. The secret
  was in api/.env the whole time.

  Every other file here is required by server.js, which loads dotenv on its
  first line. A test is the one place that starts the chain itself, so it
  is the one place this can bite.
*/
require('dotenv').config();

const http = require('http');
const { Client } = require('pg');
const msgRead = require('./messenger-read');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 3000);

// Reserved block. These must not be real employees and must not have
// accounts - the test checks that before it trusts any of its own answers.
const P_TWICE  = '20990101';   // asked twice, answered once
const P_ALONE  = '20990102';   // asked once, no answer at all
const P_DONE   = '20990103';   // asked, answered
const P_SIGNIN = '20990104';   // wrote from the sign-in page, no account
const P_GONE   = '20990105';   // signed in once, then the account was deleted

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

function call(method, path, token, body) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = 'Bearer ' + token;

    const req = http.request(
      { host: 'localhost', port: PORT, path: path, method: method, headers: headers },
      function (res) {
        let buf = '';
        res.on('data', function (c) { buf += c; });
        res.on('end', function () {
          let parsed = {};
          try { parsed = JSON.parse(buf || '{}'); } catch (e) { parsed = { raw: buf }; }
          resolve({ code: res.statusCode, body: parsed });
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** The TEST- threads out of a full inbox, by id. */
function byId(threads) {
  const out = {};
  threads.forEach(function (t) {
    if (String(t.id).indexOf('TEST-') === 0) out[t.id] = t;
  });
  return out;
}


async function main() {
  const db = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER, password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'tvl_eas'
  });
  await db.connect();

  async function wipe() {
    // msg_line goes with it: ON DELETE CASCADE.
    await db.query("DELETE FROM msg_thread WHERE thread_id LIKE 'TEST-%'");
  }
  await wipe();

  /*
    ORDER BY, because LIMIT 1 without one picks whichever row the planner
    reaches first and that is not promised to be the same row twice. With
    more than one admin account in the database this test asked for a
    different person's password between runs and reported "wrong employee
    ID or password" at somebody who had typed the right one.
  */
  const admin = await db.query(
    `SELECT employee_id FROM account WHERE role IN ('ADMIN','MASTER')
      ORDER BY employee_id LIMIT 1`);
  if (!admin.rows.length) {
    console.log('\n  No admin account - run set-password.js <id> --admin first.\n');
    process.exit(1);
  }
  const me = admin.rows[0].employee_id;

  const pw = process.env.TICK_TEST_PASSWORD;
  if (!pw) {
    console.log('\n  Set TICK_TEST_PASSWORD to that account\'s password first:');
    console.log('');
    console.log('    PowerShell:  $env:TICK_TEST_PASSWORD="..."; node messenger-test.js');
    console.log('');
    process.exit(1);
  }

  console.log('');
  console.log('  Signing in as ' + me);

  const login = await call('POST', '/api/login', null,
    { employee_id: me, password: pw });
  if (!login.body.token) {
    console.log('  Could not sign in: ' + (login.body.error || login.code));
    process.exit(1);
  }
  const token = login.body.token;

  /*
    THE RESERVED IDS MUST NOT HAVE ACCOUNTS. Three of this test's answers
    depend on it - enrolled=false, the NO| grouping key, and the badge
    delta. If one of them ever became a real login the test would start
    reporting failures in correct code, so it says so plainly instead.
  */
  const clash = await db.query(
    'SELECT employee_id FROM account WHERE employee_id = ANY($1)',
    [[P_TWICE, P_ALONE, P_DONE, P_SIGNIN, P_GONE]]);
  if (clash.rows.length) {
    console.log('\n  Reserved test IDs have accounts: ' +
                clash.rows.map(function (r) { return r.employee_id; }).join(', '));
    console.log('  Pick different ones in messenger-test.js.\n');
    process.exit(1);
  }

  // Baselines, before a single row is written.
  const base = {
    mine:    (await call('GET', '/api/messages/mine', token)).body,
    waiting: (await call('GET', '/api/messages/waiting', token)).body.waiting,
    count:   (await call('GET', '/api/messages/threads', token)).body.count
  };
  const baseUnread = base.mine.unread;
  const baseMine = base.mine.threads.length;

  console.log('  Before: ' + base.count + ' threads, ' + base.waiting +
              ' waiting, ' + baseUnread + ' unread of my own');
  console.log('');

  // -----------------------------------------------------------------------
  // Fixtures. Times are relative so the ordering assertions hold whenever
  // this is run.
  // -----------------------------------------------------------------------
  async function thread(id, person, verified, topic, lastAt, lastBy,
                        waitingFor, unread, name) {
    await db.query(
      `INSERT INTO msg_thread (thread_id, person, verified, started, topic,
                               last_message_at, last_message_by, status,
                               waiting_for_team, unread_by_person, name)
       VALUES ($1,$2,$3, now() - interval '7 days', $4,
               now() - ($5 || ' hours')::interval, $6, 'OPEN', $7, $8, $9)`,
      [id, person, verified, topic, String(lastAt), lastBy,
       waitingFor, unread, name]);
  }

  async function line(id, threadId, hoursAgo, side, author, body) {
    await db.query(
      `INSERT INTO msg_line (message_id, thread_id, at, side, author, body,
                             author_name)
       VALUES ($1,$2, now() - ($3 || ' hours')::interval, $4,$5,$6,$7)`,
      [id, threadId, String(hoursAgo), side, author, body,
       side === 'TEAM' ? 'Team' : 'Asker']);
  }

  // Mine, verified - must be visible, and its 3 unread must count.
  await thread('TEST-MINE-V', me, true, 'My own query', 1, 'TEAM', 0, 3, 'Me');
  await line('TEST-LV3', 'TEST-MINE-V', 1,  'TEAM', me, 'Third, and newest');
  await line('TEST-LV1', 'TEST-MINE-V', 48, 'USER', me, 'First, and oldest');
  await line('TEST-LV2', 'TEST-MINE-V', 24, 'TEAM', me, 'Second');

  // Mine by employee ID, typed on the PUBLIC SIGN-IN PAGE by anybody at
  // all - must be invisible to me, and its 7 unread must not count.
  await thread('TEST-MINE-U', me, false, 'Reset my password', 2, 'TEAM', 0, 7, 'Stranger');
  await line('TEST-LU1', 'TEST-MINE-U', 30, 'USER', me, 'Please reset my password');
  await line('TEST-LU2', 'TEST-MINE-U', 2,  'TEAM', me, 'Done, new password sent');

  // Asked twice, answered in one of them: the per-person rule.
  await thread('TEST-TWICE-A', P_TWICE, true, 'Printer', 3, 'USER', 1, 0, 'Asker');
  await line('TEST-TA1', 'TEST-TWICE-A', 20, 'USER', P_TWICE, 'Printer is down');
  await line('TEST-TA2', 'TEST-TWICE-A', 3,  'USER', P_TWICE, 'Still down');
  await thread('TEST-TWICE-B', P_TWICE, true, 'Laptop', 1, 'TEAM', 0, 1, 'Asker');
  await line('TEST-TB1', 'TEST-TWICE-B', 19, 'USER', P_TWICE, 'Laptop is slow');
  await line('TEST-TB2', 'TEST-TWICE-B', 1,  'TEAM', me, 'Looked at it');

  /*
    Asked TWICE, answered NEITHER time - one person, two conversations,
    both waiting. This is the pair that shows what the badge counts: the
    old count said 2 because two threads had an unanswered line in them;
    the number an inbox wants is 1, because there is one person to get
    back to.
  */
  await thread('TEST-ALONE', P_ALONE, true, 'Access', 4, 'USER', 1, 0, 'Asker');
  await line('TEST-AL1', 'TEST-ALONE', 4, 'USER', P_ALONE, 'Can I get access');
  await thread('TEST-ALONE-2', P_ALONE, true, 'Badge', 6, 'USER', 1, 0, 'Asker');
  await line('TEST-AL2', 'TEST-ALONE-2', 6, 'USER', P_ALONE, 'And a door badge');

  // Asked and answered.
  await thread('TEST-DONE', P_DONE, true, 'Email', 2, 'TEAM', 0, 1, 'Asker');
  await line('TEST-DN1', 'TEST-DONE', 9, 'USER', P_DONE, 'Email not working');
  await line('TEST-DN2', 'TEST-DONE', 2, 'TEAM', me, 'Fixed');

  // From the sign-in page, under an ID with no account at all.
  await thread('TEST-SIGNIN', P_SIGNIN, false, 'Cannot sign in', 5, 'USER', 1, 0, 'Asker');
  await line('TEST-SI1', 'TEST-SIGNIN', 5, 'USER', P_SIGNIN, 'I cannot sign in');

  /*
    ONE EMPLOYEE ID, TWO CARDS - the state that makes the badge count card
    keys rather than persons.

    Somebody held an account, had a signed-in conversation (verified), and
    the account was later deleted. msg_thread has no foreign key to team or
    to account - deliberately, so the sign-in page cannot be used to find
    out who works here - so that verified thread survives the deletion. The
    ID now reads enrolled=false with one verified and one unverified
    thread, which inboxKeyOf splits into YES| and NO|: two cards, because
    with no account there is nothing to prove they are the same human.

    Both are waiting. Counting distinct `person` would call that one
    person waiting while the inbox showed two cards both marked WAITING.
  */
  await thread('TEST-GONE-V', P_GONE, true, 'Signed in then', 7, 'USER', 1, 0, 'Asker');
  await line('TEST-GN1', 'TEST-GONE-V', 7, 'USER', P_GONE, 'Asked while signed in');
  await thread('TEST-GONE-U', P_GONE, false, 'Locked out now', 8, 'USER', 1, 0, 'Asker');
  await line('TEST-GN2', 'TEST-GONE-U', 8, 'USER', P_GONE, 'Now I am locked out');

  // =======================================================================
  // 1. What the employee sees in their own panel.
  // =======================================================================
  console.log('  GET /api/messages/mine');

  let r = await call('GET', '/api/messages/mine', token);
  let mine = {};
  (r.body.threads || []).forEach(function (t) { mine[t.id] = t; });

  check('my own verified query is there', Boolean(mine['TEST-MINE-V']));

  /*
    THE ONE THAT MATTERS. If this ever fails, read the note at the top of
    this file before changing anything to make it pass.
  */
  check('A SIGN-IN-PAGE THREAD UNDER MY ID IS NOT',
        mine['TEST-MINE-U'] === undefined,
        'a stranger could write into my panel');

  check('exactly one thread was added to my panel',
        (r.body.threads || []).length === baseMine + 1,
        'got ' + (r.body.threads || []).length + ', expected ' + (baseMine + 1));

  check('the unread badge counts the verified thread only',
        r.body.unread === baseUnread + 3,
        'got ' + r.body.unread + ', expected ' + (baseUnread + 3) +
        (r.body.unread === baseUnread + 10 ? ' - it counted the unverified one' : ''));

  const lines = (mine['TEST-MINE-V'] || {}).messages || [];
  check('every line of the conversation is there', lines.length === 3,
        'got ' + lines.length);
  check('oldest first',
        lines.length === 3 && lines[0].id === 'TEST-LV1' &&
        lines[1].id === 'TEST-LV2' && lines[2].id === 'TEST-LV3',
        lines.map(function (m) { return m.id; }).join(','));
  check('the sheet header Text is sent as text',
        lines.length === 3 && lines[0].text === 'First, and oldest',
        JSON.stringify(lines.length ? lines[0].text : null));
  check('files defaults to an empty list, not null',
        lines.length === 3 && Array.isArray(lines[0].files) &&
        lines[0].files.length === 0,
        JSON.stringify(lines.length ? lines[0].files : null));
  check('who answered is sent, so the asker can see it',
        lines.length === 3 && lines[1].side === 'TEAM' && lines[1].author === me);

  // =======================================================================
  // 2. Marking one conversation read.
  // =======================================================================
  console.log('');
  console.log('  POST /api/messages/read');

  r = await call('POST', '/api/messages/read', token, { thread_id: 'TEST-MINE-V' });
  check('marks mine read', r.body.ok === true);
  r = await call('GET', '/api/messages/mine', token);
  check('the badge clears', r.body.unread === baseUnread,
        'got ' + r.body.unread + ', expected ' + baseUnread);

  /*
    PER QUERY, NOT ALL AT ONCE. Opening one conversation is not reading the
    others, and clearing their dots would hide a reply nobody has looked
    at. TEST-DONE belongs to somebody else and is checked below; this
    checks the unverified one under my own ID is not quietly cleared
    either.
  */
  let row = await db.query(
    "SELECT unread_by_person FROM msg_thread WHERE thread_id = 'TEST-MINE-U'");
  check('an unverified thread under my ID is left alone',
        Number(row.rows[0].unread_by_person) === 7,
        'got ' + row.rows[0].unread_by_person);

  r = await call('POST', '/api/messages/read', token, { thread_id: 'TEST-MINE-U' });
  check('and cannot be marked read at all', r.body.ok === false);

  r = await call('POST', '/api/messages/read', token, { thread_id: 'TEST-DONE' });
  check('somebody else\'s thread cannot be marked read', r.body.ok === false);
  row = await db.query(
    "SELECT unread_by_person FROM msg_thread WHERE thread_id = 'TEST-DONE'");
  check('and its counter is untouched',
        Number(row.rows[0].unread_by_person) === 1,
        'got ' + row.rows[0].unread_by_person);

  r = await call('POST', '/api/messages/read', token, { thread_id: 'NO-SUCH-THREAD' });
  check('an unknown thread answers ok:false, not an error',
        r.code === 200 && r.body.ok === false, 'got ' + r.code);

  r = await call('POST', '/api/messages/read', token, {});
  check('a missing thread id answers ok:false, not an error',
        r.code === 200 && r.body.ok === false, 'got ' + r.code);

  // =======================================================================
  // 3. The team's inbox.
  // =======================================================================
  console.log('');
  console.log('  GET /api/messages/threads');

  r = await call('GET', '/api/messages/threads', token);
  const inbox = byId(r.body.threads || []);

  check('all ten test threads are in the inbox',
        Object.keys(inbox).length === 10, 'got ' + Object.keys(inbox).length);
  check('including the unverified ones, which nobody else can see',
        Boolean(inbox['TEST-MINE-U']) && Boolean(inbox['TEST-SIGNIN']));

  /*
    verified AND enrolled ARE DIFFERENT QUESTIONS. verified is what was
    true when they wrote; enrolled is whether that ID has an account NOW.
    The red NOT VERIFIED used to stay on a card for ever after the person
    enrolled, telling the team not to trust an identity the accounts list
    had since confirmed.
  */
  check('an unverified thread for an ID that HAS an account says so',
        inbox['TEST-MINE-U'].verified === false &&
        inbox['TEST-MINE-U'].enrolled === true,
        'verified=' + inbox['TEST-MINE-U'].verified +
        ' enrolled=' + inbox['TEST-MINE-U'].enrolled);
  check('an unverified thread for an ID with no account says that instead',
        inbox['TEST-SIGNIN'].verified === false &&
        inbox['TEST-SIGNIN'].enrolled === false,
        'verified=' + inbox['TEST-SIGNIN'].verified +
        ' enrolled=' + inbox['TEST-SIGNIN'].enrolled);

  /*
    THE PER-PERSON RULE, which is the whole of the badge change.
    Messenger.gs:873 - "Somebody asks two things and the team answers in
    one of them; the conversation has been had, both of them know it, and
    the badge went on saying 1 for ever."
  */
  check('asked twice, answered once: the person is NOT owed a word',
        inbox['TEST-TWICE-A'].owed === false,
        'owed=' + inbox['TEST-TWICE-A'].owed);
  check('but that query still carries its own WAITING pill',
        inbox['TEST-TWICE-A'].waiting > 0,
        'waiting=' + inbox['TEST-TWICE-A'].waiting);
  check('asked once, never answered: owed',
        inbox['TEST-ALONE'].owed === true);
  check('asked twice, answered neither time: still one person, both owed',
        inbox['TEST-ALONE'].owed === true &&
        inbox['TEST-ALONE-2'].owed === true &&
        inbox['TEST-ALONE'].key === inbox['TEST-ALONE-2'].key);
  check('asked and answered: not owed',
        inbox['TEST-DONE'].owed === false);
  check('the sign-in page counts as asking too: owed',
        inbox['TEST-SIGNIN'].owed === true);

  // Both of one person's threads carry the same answer, because it is a
  // fact about the person and not about either thread.
  check('one answer per person, on every one of their threads',
        inbox['TEST-TWICE-A'].owed === inbox['TEST-TWICE-B'].owed);
  check('and they are grouped under one card',
        inbox['TEST-TWICE-A'].key === inbox['TEST-TWICE-B'].key,
        inbox['TEST-TWICE-A'].key + ' vs ' + inbox['TEST-TWICE-B'].key);

  /*
    An ID with no account is two cards, not one - there is nothing to prove
    the signed-in conversation and the sign-in-page one are the same human.
  */
  check('a deleted account leaves its verified thread readable',
        inbox['TEST-GONE-V'].verified === true &&
        inbox['TEST-GONE-V'].enrolled === false,
        'verified=' + inbox['TEST-GONE-V'].verified +
        ' enrolled=' + inbox['TEST-GONE-V'].enrolled);
  check('and its two threads are two separate cards',
        inbox['TEST-GONE-V'].key !== inbox['TEST-GONE-U'].key,
        inbox['TEST-GONE-V'].key + ' vs ' + inbox['TEST-GONE-U'].key);

  // Ordering, judged only among this test's own threads so that real
  // conversations around them cannot break it.
  const order = (r.body.threads || [])
    .filter(function (t) { return String(t.id).indexOf('TEST-') === 0; });
  let afterNotOwed = false, orderOk = true;
  order.forEach(function (t) {
    if (!t.owed) afterNotOwed = true;
    else if (afterNotOwed) orderOk = false;
  });
  check('the ones waiting on us come first', orderOk,
        order.map(function (t) { return (t.owed ? '+' : '-') + t.id; }).join(' '));

  const owedFirst = order.filter(function (t) { return t.owed; });
  let recentOk = true;
  for (let i = 1; i < owedFirst.length; i++) {
    if (String(owedFirst[i - 1].lastAt) < String(owedFirst[i].lastAt)) recentOk = false;
  }
  check('and then by most recent activity', recentOk,
        owedFirst.map(function (t) { return t.id; }).join(' '));

  // =======================================================================
  // 4. The badge.
  // =======================================================================
  console.log('');
  console.log('  GET /api/messages/waiting');

  /*
    THE DIFFERENCE, STATED AS NUMBERS. Five of this test's threads are
    waiting on an answer; they are four cards. An inbox badge is a to-do
    list and the to-do is a PERSON, so it says four.

        TEST-ALONE    + TEST-ALONE-2   one person, asked twice   -> 1
        TEST-SIGNIN                                              -> 1
        TEST-GONE-V   + TEST-GONE-U    one ID, no account        -> 2

    Counting threads would say five. Counting distinct `person` would say
    three, because it would merge the last pair - and the inbox would show
    two cards marked WAITING above a badge that disagreed with them.
  */
  r = await call('GET', '/api/messages/waiting', token);

  const again = await call('GET', '/api/messages/threads', token);
  const owedThreads = (again.body.threads || []).filter(function (t) {
    return t.owed && String(t.id).indexOf('TEST-') === 0;
  }).length;
  check('five of the test threads are waiting', owedThreads === 5,
        'got ' + owedThreads);
  check('and the badge counts them as four cards',
        r.body.waiting === base.waiting + 4,
        'badge says ' + r.body.waiting + ', baseline ' + base.waiting +
        (r.body.waiting === base.waiting + 3
          ? ' - it counted persons, not cards' : ''));

  // =======================================================================
  // 5. Who may ask.
  // =======================================================================
  console.log('');
  console.log('  Permission');

  const userToken = auth.signToken(P_TWICE, 'USER');

  r = await call('GET', '/api/messages/threads', userToken);
  check('a USER cannot read the team inbox', r.code === 403, 'got ' + r.code);
  r = await call('GET', '/api/messages/waiting', userToken);
  check('a USER cannot read the badge', r.code === 403, 'got ' + r.code);
  r = await call('GET', '/api/messages/mine', userToken);
  check('but a USER can read their own messages', r.code === 200, 'got ' + r.code);
  check('and sees only their own',
        (r.body.threads || []).every(function (t) {
          return String(t.id).indexOf('TEST-TWICE') === 0;
        }) && (r.body.threads || []).length === 2,
        (r.body.threads || []).map(function (t) { return t.id; }).join(','));

  r = await call('GET', '/api/messages/mine', null);
  check('no token is refused', r.code === 401, 'got ' + r.code);
  r = await call('GET', '/api/messages/threads', null);
  check('no token is refused on the inbox too', r.code === 401, 'got ' + r.code);

  // =======================================================================
  // 6. The functions underneath, called directly.
  // =======================================================================
  console.log('');
  console.log('  Functions');

  const empty = await msgRead.threadMessageList('NO-SUCH-THREAD');
  check('an unknown thread has no messages, and does not throw',
        Array.isArray(empty) && empty.length === 0);

  check('no employee ID means no threads, without a query',
        (await msgRead.myThreads('')).length === 0);
  check('and neither does a blank one',
        (await msgRead.myThreads('   ')).length === 0);

  const enrol = await msgRead.enrolmentOf([me, P_TWICE, '', me, null]);
  check('enrolmentOf finds the account', enrol[String(me).toLowerCase()] === true);
  check('and says so when there is none', enrol[P_TWICE] === false);
  check('and does not invent an entry for a blank id',
        !('' in enrol) && Object.keys(enrol).length === 2,
        Object.keys(enrol).join(','));

  check('an enrolled person is one card however they wrote in',
        msgRead.inboxKeyOf({ person: 'X', verified: true }, { x: true }) ===
        msgRead.inboxKeyOf({ person: 'X', verified: false }, { x: true }),
        'P| grouping');
  check('an ID with no account is grouped by what was true at the time',
        msgRead.inboxKeyOf({ person: 'X', verified: true }, {}) !==
        msgRead.inboxKeyOf({ person: 'X', verified: false }, {}));

  /*
    "No word from them at all is not waiting. Their word last is." A thread
    with nothing in it but the team talking is not somebody waiting.
  */
  check('a thread with no user line at all is not waiting',
        msgRead.peopleWaiting(
          [{ person: 'X', verified: true,
             messages: [{ side: 'TEAM', at: '2026-01-01T00:00:00.000Z' }] }],
          {}).length === 0);
  check('a thread with no messages at all is not waiting',
        msgRead.peopleWaiting([{ person: 'X', verified: true }], {}).length === 0);
  check('the same instant both ways is not waiting',
        msgRead.peopleWaiting(
          [{ person: 'X', verified: true, messages: [
            { side: 'USER', at: '2026-01-01T00:00:00.000Z' },
            { side: 'TEAM', at: '2026-01-01T00:00:00.000Z' }] }],
          {}).length === 0);

  // =======================================================================
  await wipe();
  await db.end();

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n');
  process.exit(1);
});
