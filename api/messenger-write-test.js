/**
 * messenger-write-test.js - sending, replying, attaching, deleting.
 * ===========================================================================
 *
 * NEEDS A RUNNING SERVER AND DATABASE.
 *
 *     terminal 3:   npm start
 *     terminal 2:   node messenger-write-test.js
 *
 * NO PASSWORD IS NEEDED, unlike messenger-test.js. This one signs its own
 * tokens with auth.signToken for people it creates itself, because what is
 * under test is what the endpoints DO, not the sign-in path - which
 * messenger-test.js already covers by logging in for real. It also means
 * the suite can create a USER, an ADMIN and a MASTER and check all three
 * gates without anybody having to hold three passwords.
 *
 * IT CREATES ITS OWN PEOPLE AND DELETES THEM AFTERWARDS. Every employee ID
 * is in the reserved 2099xxxx block, every thread id it writes starts
 * TEST-W or is one the port generated for a thread owned by one of those
 * people. It clears up at the start as well as the end, so a run that dies
 * halfway does not poison the next one.
 *
 * THE THREE REPORTED BUGS each have a check here, named so that a failure
 * says which one came back:
 *
 *   - a reply must land IN the conversation, not beside it as a new query
 *   - a reply must reach the sender's own panel
 *   - the unread badge must clear when they read it
 */

require('dotenv').config();

const http = require('http');
const { Client } = require('pg');
const auth = require('./auth');
const write = require('./messenger-write');
const read = require('./messenger-read');

const PORT = Number(process.env.PORT || 3000);

/*
  A SENDER PER SECTION, because the cap is five messages per person per
  hour and several sections need more than that between them.

  It cannot be turned off from here: the buckets live in the SERVER's
  process, and this test is a different process, so calling bucketReset()
  would clear a Map the server never reads. Giving each section its own
  employee ID is the simple answer - and it is also closer to life, where
  five different people writing in is not one person flooding the box.
*/
/*
  AND A FRESH SET OF IDS ON EVERY RUN, inside that reserved block.

  The buckets live in the server, which keeps running between test runs, so
  fixed ids would make this suite work once an hour and then start failing
  on a cap it filled itself. There is no way to clear them from here and
  there should not be one - a reset endpoint on a live API is a worse idea
  than a test that picks new names.

  Every person it creates is called "Write Test NNN", which is what the
  sweep below matches on. Nobody real is called that.
*/
const RUN = String(Math.floor(Math.random() * 90) + 10);
const id = function (n) {
  // Eight digits, always - 2099 then two for the run and two for the
  // person. tests/wiring-test.js refuses any employee ID in this
  // repository that is not inside 200000xx, 2090xxxx or 2099xxxx, and a
  // nine-digit id would be outside all three.
  return '2099' + RUN + String(n).padStart(2, '0');
};

const MASTER = id(1);
const ADMIN  = id(2);
const USER   = id(3);   // the basic send tests
const OTHER  = id(4);   // duplicates, and the name tests
const NOBODY = id(5);   // never enrolled
const TWIN   = id(6);   // the double-send tests, and the reply tests
const CAPPED = id(7);   // the one that gets rate limited
const RACER  = id(8);   // the concurrency test
const DOUBLE = id(9);   // two identical sends landing together
const ANSWERED = id(0); // has an answer waiting, then writes back

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


async function main() {
  const db = new Client({
    host: process.env.PGHOST || '127.0.0.1',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER, password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'tvl_eas'
  });
  await db.connect();

  const ours = [MASTER, ADMIN, USER, OTHER, NOBODY, TWIN, CAPPED, RACER,
                DOUBLE, ANSWERED, id(11)];

  /*
    Clears this run AND anything a crashed earlier run left behind, matched
    on the name it gives its people rather than on their ids, which change
    every run. account rows go with the team row they reference.
  */
  async function wipe() {
    await db.query(
      `DELETE FROM msg_thread WHERE person IN (
         SELECT employee_id FROM team WHERE full_name LIKE 'Write Test %')`);
    await db.query("DELETE FROM msg_thread WHERE thread_id LIKE 'TEST-W%'");
    // The sign-in burst writes under an ID that is deliberately NOT
    // enrolled, so it has no team row for the sweep above to find it by.
    await db.query('DELETE FROM msg_thread WHERE person = ANY($1)', [ours]);
    await db.query("DELETE FROM team WHERE full_name LIKE 'Write Test %'");
  }
  await wipe();

  // A hash nobody can sign in with. These accounts exist to be looked up,
  // not to be logged into - the tokens are signed directly.
  const noLogin = 'scrypt$65536$8$1$00$00';
  for (const [who, role] of [[MASTER, 'MASTER'], [ADMIN, 'ADMIN'],
                             [USER, 'USER'], [OTHER, 'USER'],
                             [TWIN, 'USER'], [CAPPED, 'USER'],
                             [RACER, 'USER'], [DOUBLE, 'USER'],
                             [ANSWERED, 'USER']]) {
    await db.query('INSERT INTO team (employee_id, full_name) VALUES ($1,$2)',
                   [who, 'Write Test ' + who.slice(-3)]);
    await db.query(
      `INSERT INTO account (employee_id, password_hash, role, must_change)
       VALUES ($1,$2,$3,false)`, [who, noLogin, role]);
  }

  const tMaster = auth.signToken(MASTER, 'MASTER');
  const tAdmin  = auth.signToken(ADMIN,  'ADMIN');
  const tUser   = auth.signToken(USER,   'USER');
  const tOther  = auth.signToken(OTHER,  'USER');
  const tTwin   = auth.signToken(TWIN,   'USER');
  const tCapped = auth.signToken(CAPPED, 'USER');
  const tRacer  = auth.signToken(RACER,  'USER');
  const tDouble = auth.signToken(DOUBLE, 'USER');
  const tAnswered = auth.signToken(ANSWERED, 'USER');

  const threadsOf = async function (person) {
    return (await db.query(
      `SELECT * FROM msg_thread WHERE person = $1
        ORDER BY started, thread_id`, [person])).rows;
  };
  const linesOf = async function (threadId) {
    return (await db.query(
      'SELECT * FROM msg_line WHERE thread_id = $1 ORDER BY at, message_id',
      [threadId])).rows;
  };

  console.log('');

  // =======================================================================
  console.log('  POST /api/messages/send');
  // =======================================================================
  let r = await call('POST', '/api/messages/send', tUser,
    { thread_id: '', topic: 'Printer', text: 'The printer on 4 is jammed.' });
  check('a signed-in person can start a query', r.body.ok === true,
        JSON.stringify(r.body.message));
  const firstThread = r.body.threadId;
  check('and gets the thread id back', Boolean(firstThread));

  let rows = await threadsOf(USER);
  check('one thread exists', rows.length === 1, 'got ' + rows.length);
  check('marked verified, because they were signed in',
        rows[0].verified === true);
  check('with the topic they gave', rows[0].topic === 'Printer', rows[0].topic);
  check('waiting for the team', Number(rows[0].waiting_for_team) === 1,
        String(rows[0].waiting_for_team));
  check('nothing unread by them - they wrote it',
        Number(rows[0].unread_by_person) === 0);
  check('last word was theirs', rows[0].last_message_by === 'USER');

  r = await call('POST', '/api/messages/send', tUser,
    { thread_id: firstThread, text: 'Still jammed, any news?' });
  check('they can add a line to their own query', r.body.ok === true);
  rows = await threadsOf(USER);
  check('it goes in the SAME thread', rows.length === 1, 'got ' + rows.length);
  check('and the counter counts up, not over',
        Number(rows[0].waiting_for_team) === 2,
        String(rows[0].waiting_for_team));

  r = await call('POST', '/api/messages/send', tOther,
    { thread_id: firstThread, text: 'Writing into your conversation.' });
  check('SOMEBODY ELSE CANNOT WRITE INTO IT', r.body.ok === false,
        'they could sign a line with another person\'s name');
  check('and is told nothing about whose it is',
        /no longer there/.test(String(r.body.message)), r.body.message);

  /*
    THE SENDER COMES FROM THE TOKEN AND FROM NOWHERE ELSE. Everything in
    the body was typed by whoever is calling, so an employee_id in there is
    a suggestion, not a fact. Taking it would let anybody with a login post
    as any colleague.
  */
  r = await call('POST', '/api/messages/send', tUser,
    { thread_id: '', topic: 'Spoof', text: 'Writing this as somebody else.',
      employee_id: OTHER, person: OTHER });
  check('an employee_id in the body is ignored', r.body.ok === true);
  check('AND THE LINE IS FILED UNDER WHOEVER SIGNED IN',
        (await db.query('SELECT person FROM msg_thread WHERE thread_id = $1',
                        [r.body.threadId])).rows[0].person === USER,
        'anyone with a login could post as a colleague');

  /*
    A USER LINE CLEARS WHAT THEY HAD UNREAD, because the act of writing
    back IS having read it. db/08-messenger.sql: "the two counters are a
    running tally, not a total".
  */
  await db.query(
    `INSERT INTO msg_thread (thread_id, person, verified, started, topic,
                             last_message_at, last_message_by, status,
                             waiting_for_team, unread_by_person, name)
     VALUES ('TEST-W-UNREAD',$1,true, now() - interval '1 hour', 'Answered',
             now() - interval '5 minutes', 'TEAM', 'OPEN', 0, 3, '')`, [ANSWERED]);
  await db.query(
    `INSERT INTO msg_line (message_id, thread_id, at, side, author, body)
     VALUES ('TEST-W-UNREAD-L1','TEST-W-UNREAD', now() - interval '1 hour',
             'USER',$1,'My first question.'),
            ('TEST-W-UNREAD-L2','TEST-W-UNREAD', now() - interval '5 minutes',
             'TEAM','x','Here is the answer.')`, [ANSWERED]);

  r = await call('POST', '/api/messages/send', tAnswered,
    { thread_id: 'TEST-W-UNREAD', text: 'Thank you, that worked.' });
  check('writing back is allowed', r.body.ok === true, r.body.message);
  const answered = (await db.query(
    "SELECT * FROM msg_thread WHERE thread_id = 'TEST-W-UNREAD'")).rows[0];
  check('WRITING BACK CLEARS WHAT THEY HAD UNREAD',
        Number(answered.unread_by_person) === 0,
        'got ' + answered.unread_by_person + ' - a dot that will not go away');
  check('and the team owes them a word again',
        Number(answered.waiting_for_team) === 1,
        String(answered.waiting_for_team));

  r = await call('POST', '/api/messages/send', tUser, { thread_id: '', text: 'x' });
  check('one character is not a message', r.body.ok === false);
  r = await call('POST', '/api/messages/send', tUser,
    { thread_id: '', text: 'y'.repeat(write.QUESTION_MAX + 1) });
  check('and neither is 2001 characters', r.body.ok === false,
        r.body.message);

  // =======================================================================
  console.log('');
  console.log('  Attachments, with no file store configured');
  // =======================================================================
  r = await call('POST', '/api/messages/send', tUser,
    { thread_id: '', topic: 'Screenshot', text: '',
      images: [{ name: 'a.png', mime: 'image/png', data: 'AAAA' }] });
  check('a line that is nothing but a screenshot still sends',
        r.body.ok === true, r.body.message);
  check('and says the image did not make it',
        /1 image could not be attached/.test(String(r.body.message)),
        r.body.message);
  const shot = (await linesOf(r.body.threadId))[0];
  check('the line reads (screenshot) rather than being empty',
        shot && shot.body === '(screenshot)', shot && shot.body);
  check('and carries no files', shot && JSON.stringify(shot.files) === '[]',
        shot && JSON.stringify(shot.files));

  // =======================================================================
  console.log('');
  console.log('  A double-send is not a second question');
  // =======================================================================
  const before = (await threadsOf(TWIN)).length;
  const twinText = 'My laptop will not connect to the VPN.';
  const a = await call('POST', '/api/messages/send', tTwin,
    { thread_id: '', topic: 'VPN', text: twinText });
  const b = await call('POST', '/api/messages/send', tTwin,
    { thread_id: '', topic: 'VPN', text: twinText });
  check('the second press answers ok', b.body.ok === true);
  check('and returns the FIRST thread', b.body.threadId === a.body.threadId,
        a.body.threadId + ' vs ' + b.body.threadId);
  check('no second message was written', b.body.id === '', b.body.id);
  check('one new thread, not two',
        (await threadsOf(TWIN)).length === before + 1);
  check('and it still has exactly one line',
        (await linesOf(a.body.threadId)).length === 1);

  const c = await call('POST', '/api/messages/send', tTwin,
    { thread_id: '', topic: 'VPN again', text: twinText });
  check('the same words under a different subject is a new query',
        c.body.threadId !== a.body.threadId);

  /*
    The same words with a screenshot THIS time is somebody adding
    evidence, not somebody pressing Send twice - so the line is written
    rather than dropped. It still goes into the conversation that is
    already open on that question, which is where the evidence belongs:
    the original sets `into = twin` and appends.
  */
  const d = await call('POST', '/api/messages/send', tTwin,
    { thread_id: '', topic: 'VPN', text: twinText,
      images: [{ name: 'b.png', mime: 'image/png', data: 'AAAA' }] });
  check('the same words WITH a screenshot is not dropped',
        d.body.id !== '',
        'dropping it would lose the thing they went to the trouble of taking');
  check('and is added to the question already open, not a new one',
        d.body.threadId === a.body.threadId,
        d.body.threadId + ' vs ' + a.body.threadId);
  check('so that conversation now has two lines',
        (await linesOf(a.body.threadId)).length === 2,
        String((await linesOf(a.body.threadId)).length));

  // =======================================================================
  console.log('');
  console.log('  The hourly cap');
  // =======================================================================
  let refused = null;
  for (let i = 0; i < write.QUESTION_RATE_PER_HOUR + 2; i++) {
    const one = await call('POST', '/api/messages/send', tCapped,
      { thread_id: '', topic: 'Cap ' + i, text: 'Message number ' + i + ' please.' });
    if (one.body.ok === false && refused === null) refused = i;
  }
  check('the cap stops the ' + (write.QUESTION_RATE_PER_HOUR + 1) + 'th message',
        refused === write.QUESTION_RATE_PER_HOUR,
        'first refusal was number ' + refused);
  check('and says so plainly rather than pretending it sent',
        (await threadsOf(CAPPED)).length === write.QUESTION_RATE_PER_HOUR,
        String((await threadsOf(CAPPED)).length));

  // =======================================================================
  console.log('');
  console.log('  POST /api/messages/signin - the public box');
  // =======================================================================
  r = await call('POST', '/api/messages/signin', null,
    { employee_id: USER, text: 'I am locked out, please reset me.' });
  check('no token needed - that is the point', r.body.ok === true,
        JSON.stringify(r.body));

  const unver = (await threadsOf(USER)).filter(function (t) {
    return t.verified === false;
  });
  check('it makes an UNVERIFIED thread', unver.length === 1,
        'got ' + unver.length);

  r = await call('POST', '/api/messages/signin', null,
    { employee_id: USER, text: 'Any news on that reset?',
      name: 'Locked Out Person' });
  const unver2 = (await threadsOf(USER)).filter(function (t) {
    return t.verified === false;
  });
  check('a second message joins the same one - a lifeline, not a ticket list',
        unver2.length === 1, 'got ' + unver2.length);
  check('and the counter counted up',
        Number(unver2[0].waiting_for_team) === 2,
        String(unver2[0].waiting_for_team));

  /*
    THE LEAK CHECK. An employee ID that exists and one that does not must
    come back the same - same ok, same status code, same words. Anything
    that differs turns this endpoint into a way to find out who works here
    by trying numbers at it.
  */
  const real = await call('POST', '/api/messages/signin', null,
    { employee_id: USER, text: 'Testing a real ID for the reply wording.' });
  const fake = await call('POST', '/api/messages/signin', null,
    { employee_id: '20999999', text: 'Testing a fake ID for the reply wording.' });
  check('A REAL ID AND A MADE-UP ONE ANSWER IDENTICALLY',
        real.code === fake.code && real.body.ok === fake.body.ok &&
        real.body.message === fake.body.message,
        real.code + ' ' + JSON.stringify(real.body.message) + '  vs  ' +
        fake.code + ' ' + JSON.stringify(fake.body.message));

  r = await call('POST', '/api/messages/signin', null,
    { employee_id: 'ab', text: 'Too short an ID.' });
  check('an ID that is not ID-shaped is refused', r.body.ok === false);
  r = await call('POST', '/api/messages/signin', null,
    { employee_id: USER, text: '' });
  check('an empty message is refused', r.body.ok === false);

  /*
    AND THE WHOLE REASON ANY OF THIS IS SHAPED THIS WAY.
  */
  r = await call('GET', '/api/messages/mine', tUser);
  const mineIds = (r.body.threads || []).map(function (t) { return t.id; });
  check('NONE OF THOSE REACH THE REAL EMPLOYEE\'S PANEL',
        mineIds.indexOf(unver2[0].thread_id) === -1,
        'a stranger could write into their panel');

  // =======================================================================
  console.log('');
  console.log('  POST /api/messages/reply');
  // =======================================================================
  const askThread = a.body.threadId;
  const linesBefore = (await linesOf(askThread)).length;
  const threadsBefore = (await threadsOf(TWIN)).length;

  r = await call('POST', '/api/messages/reply', tAdmin,
    { thread_id: askThread, text: 'Reconnect to the VPN and try again.' });
  check('an admin can reply', r.body.ok === true, JSON.stringify(r.body));

  check('THE REPLY LANDS IN THE CONVERSATION',
        (await linesOf(askThread)).length === linesBefore + 1,
        'bug: a reply arriving as a new untitled query beside the question');
  check('AND MAKES NO NEW THREAD',
        (await threadsOf(TWIN)).length === threadsBefore,
        'bug: replyToThread one argument short');

  const after = (await threadsOf(TWIN)).filter(function (t) {
    return t.thread_id === askThread;
  })[0];
  check('the team no longer owes an answer here',
        Number(after.waiting_for_team) === 0,
        String(after.waiting_for_team));
  check('and the asker has something unread',
        Number(after.unread_by_person) === 1,
        String(after.unread_by_person));
  check('last word was the team\'s', after.last_message_by === 'TEAM');

  r = await call('GET', '/api/messages/mine', tTwin);
  const got = (r.body.threads || []).filter(function (t) {
    return t.id === askThread;
  })[0];
  check('THE REPLY REACHES THE SENDER\'S OWN PANEL',
        Boolean(got) && got.messages.length === linesBefore + 1,
        'bug: reply written but the asker never saw it');
  check('signed by whoever answered',
        got && got.messages[got.messages.length - 1].side === 'TEAM');
  check('and the unread badge is showing', r.body.unread >= 1,
        String(r.body.unread));

  r = await call('POST', '/api/messages/read', tTwin, { thread_id: askThread });
  check('reading it clears the badge', r.body.ok === true);
  r = await call('GET', '/api/messages/mine', tTwin);
  const cleared = (r.body.threads || []).filter(function (t) {
    return t.id === askThread;
  })[0];
  check('THE UNREAD BADGE CLEARS', cleared && cleared.unread === 0,
        'bug: the dot that would not go away');

  r = await call('POST', '/api/messages/reply', tAdmin,
    { thread_id: 'NO-SUCH-THREAD', text: 'Into thin air.' });
  check('a reply to nothing is refused', r.body.ok === false);
  r = await call('POST', '/api/messages/reply', tUser,
    { thread_id: askThread, text: 'I am not on the team.' });
  check('a USER cannot reply as the team', r.code === 403, 'got ' + r.code);

  // =======================================================================
  console.log('');
  console.log('  One answer for duplicate questions');
  // =======================================================================
  /*
    recentTwinThread stops new duplicates, but the ones already in the
    inbox from before it existed still have to be answerable - and
    answering them one at a time means typing the same answer three times.
    Written straight into the database, because the endpoint now refuses to
    make them.
  */
  const dupText = 'I need access to the shared drive.';
  for (const id of ['TEST-W-DUP1', 'TEST-W-DUP2']) {
    await db.query(
      `INSERT INTO msg_thread (thread_id, person, verified, started, topic,
                               last_message_at, last_message_by, status,
                               waiting_for_team, unread_by_person, name)
       VALUES ($1,$2,true, now() - interval '20 minutes', 'Drive',
               now() - interval '20 minutes', 'USER', 'OPEN', 1, 0, '')`,
      [id, OTHER]);
    await db.query(
      `INSERT INTO msg_line (message_id, thread_id, at, side, author, body)
       VALUES ($1,$2, now() - interval '20 minutes', 'USER', $3, $4)`,
      [id + '-L1', id, OTHER, dupText]);
  }

  r = await call('POST', '/api/messages/reply', tAdmin,
    { thread_id: 'TEST-W-DUP1', text: 'Access granted, try now.' });
  check('replying says it answered the duplicate too',
        /1 duplicate/.test(String(r.body.message)), r.body.message);
  check('and the duplicate really got the answer',
        (await linesOf('TEST-W-DUP2')).length === 2,
        String((await linesOf('TEST-W-DUP2')).length));

  // A thread the person has since added to has moved on and deserves its
  // own reply, so it is not treated as a copy.
  await db.query(
    `INSERT INTO msg_thread (thread_id, person, verified, started, topic,
                             last_message_at, last_message_by, status,
                             waiting_for_team, unread_by_person, name)
     VALUES ('TEST-W-DUP3',$1,true, now() - interval '20 minutes', 'Drive',
             now() - interval '19 minutes', 'USER', 'OPEN', 2, 0, '')`, [OTHER]);
  await db.query(
    `INSERT INTO msg_line (message_id, thread_id, at, side, author, body)
     VALUES ('TEST-W-DUP3-L1','TEST-W-DUP3', now() - interval '20 minutes',
             'USER',$1,$2),
            ('TEST-W-DUP3-L2','TEST-W-DUP3', now() - interval '19 minutes',
             'USER',$1,'And one more thing.')`, [OTHER, dupText]);

  await db.query(
    `UPDATE msg_thread SET waiting_for_team = 1, last_message_by = 'USER'
      WHERE thread_id = 'TEST-W-DUP2'`);
  r = await call('POST', '/api/messages/reply', tAdmin,
    { thread_id: 'TEST-W-DUP2', text: 'Second answer.' });
  /*
    ok === true IS PART OF THE ASSERTION, NOT DECORATION. Without it,
    "the message does not mention duplicates" is also true of a 500, whose
    body has no message at all - so the check passed while the endpoint
    was crashing. That is exactly how it was written first, and a
    deliberate break went undetected because of it.
  */
  check('a thread the person added to is not matched as a copy',
        r.body.ok === true && !/duplicate/.test(String(r.body.message)),
        r.code + ' ' + JSON.stringify(r.body.message));
  check('and really was left alone',
        (await linesOf('TEST-W-DUP3')).length === 2,
        String((await linesOf('TEST-W-DUP3')).length));

  /*
    THE SAME RULE FROM THE OTHER SIDE. Above, a thread with two lines is
    not matched AS a copy. Here, replying TO a thread with two lines does
    not go hunting for copies of it either - it has moved on, and its
    first line being the same as somebody's one-line query does not make
    the answer to this conversation the answer to that one.
  */
  await db.query(
    `INSERT INTO msg_thread (thread_id, person, verified, started, topic,
                             last_message_at, last_message_by, status,
                             waiting_for_team, unread_by_person, name)
     VALUES ('TEST-W-DUP5',$1,true, now() - interval '20 minutes', 'Drive',
             now() - interval '20 minutes', 'USER', 'OPEN', 1, 0, '')`, [OTHER]);
  await db.query(
    `INSERT INTO msg_line (message_id, thread_id, at, side, author, body)
     VALUES ('TEST-W-DUP5-L1','TEST-W-DUP5', now() - interval '20 minutes',
             'USER',$1,$2)`, [OTHER, dupText]);

  r = await call('POST', '/api/messages/reply', tAdmin,
    { thread_id: 'TEST-W-DUP3', text: 'Answer to the longer conversation.' });
  check('replying to a conversation that moved on finds no copies',
        r.body.ok === true && !/duplicate/.test(String(r.body.message)),
        r.code + ' ' + JSON.stringify(r.body.message));
  check('and the one-line query is still waiting for its own answer',
        (await linesOf('TEST-W-DUP5')).length === 1,
        String((await linesOf('TEST-W-DUP5')).length));

  // =======================================================================
  console.log('');
  console.log('  POST /api/messages/attach');
  // =======================================================================
  const signin = unver2[0].thread_id;
  r = await call('GET', '/api/messages/mine', tUser);
  check('before: the sign-in thread is invisible to them',
        (r.body.threads || []).every(function (t) { return t.id !== signin; }));

  r = await call('POST', '/api/messages/attach', tAdmin, { thread_id: signin });
  check('an admin can attach it', r.body.ok === true, JSON.stringify(r.body));

  r = await call('GET', '/api/messages/mine', tUser);
  check('AFTER: THEY CAN SEE IT, REPLIES INCLUDED',
        (r.body.threads || []).some(function (t) { return t.id === signin; }),
        'this is the fix for the empty chatbox');

  /*
    AND THE NAME COMES WITH IT. nameEverywhere is keyed by person AND
    level, so a name given on the sign-in page sits on the unverified rows
    and does not follow the thread over on its own - the person's own panel
    would show a conversation headed by a bare employee ID.
  */
  const carried = await db.query(
    `SELECT count(*) FILTER (WHERE name = 'Locked Out Person') AS named,
            count(*) AS total
       FROM msg_thread WHERE person = $1 AND verified = true`, [USER]);
  check('THE NAME IS CARRIED ACROSS WITH IT',
        carried.rows[0].named === carried.rows[0].total &&
        carried.rows[0].total > 0,
        carried.rows[0].named + ' of ' + carried.rows[0].total +
        ' - their panel would show a bare employee ID');

  r = await call('POST', '/api/messages/attach', tAdmin, { thread_id: signin });
  check('attaching it twice is refused', r.body.ok === false, r.body.message);

  await db.query(
    `INSERT INTO msg_thread (thread_id, person, verified, started, topic,
                             last_message_at, last_message_by, status,
                             waiting_for_team, unread_by_person, name)
     VALUES ('TEST-W-ORPHAN',$1,false, now(), 'Locked out', now(), 'USER',
             'OPEN', 1, 0, 'Someone')`, [NOBODY]);
  r = await call('POST', '/api/messages/attach', tAdmin,
    { thread_id: 'TEST-W-ORPHAN' });
  check('a thread for an ID with no account cannot be attached',
        r.body.ok === false, r.body.message);
  check('and the reason is given, because the admin can act on it',
        /no account|Nobody has opened an account/.test(String(r.body.message)),
        r.body.message);

  r = await call('POST', '/api/messages/attach', tUser, { thread_id: signin });
  check('a USER cannot attach anything', r.code === 403, 'got ' + r.code);

  // =======================================================================
  console.log('');
  console.log('  POST /api/messages/delete');
  // =======================================================================
  r = await call('POST', '/api/messages/delete', tAdmin,
    { thread_id: 'TEST-W-DUP1' });
  check('an ADMIN cannot delete a conversation', r.code === 403, 'got ' + r.code);
  check('and it is still there',
        (await linesOf('TEST-W-DUP1')).length > 0);

  r = await call('POST', '/api/messages/delete', tMaster,
    { thread_id: 'TEST-W-DUP1' });
  check('a MASTER can', r.body.ok === true, JSON.stringify(r.body));
  check('the conversation is gone',
        (await db.query(
          "SELECT 1 FROM msg_thread WHERE thread_id = 'TEST-W-DUP1'")).rows.length === 0);
  check('and every line with it, not half of them',
        (await linesOf('TEST-W-DUP1')).length === 0);

  r = await call('POST', '/api/messages/delete', tMaster,
    { thread_id: 'NO-SUCH-THREAD' });
  check('deleting nothing answers ok:false, not an error',
        r.code === 400 && r.body.ok === false, 'got ' + r.code);

  // =======================================================================
  console.log('');
  console.log('  Names');
  // =======================================================================
  r = await call('POST', '/api/messages/send', tOther,
    { thread_id: '', topic: 'Name test', text: 'Please call me by my name.',
      name: '  Mr   Example  ' });
  check('a name typed in the panel is kept ON THE ACCOUNT',
        (await db.query('SELECT full_name FROM account WHERE employee_id = $1',
                        [OTHER])).rows[0].full_name === 'Mr Example',
        'so the panel stops asking tomorrow');
  check('and squeezed into one space, not stored as typed',
        r.body.name === 'Mr Example', r.body.name);
  check('the panel is told it is on the account now',
        r.body.nameOnAccount === true);

  const named = await db.query(
    `SELECT count(*) FILTER (WHERE name = 'Mr Example') AS named,
            count(*) AS total
       FROM msg_thread WHERE person = $1 AND verified = true`, [OTHER]);
  check('and it goes onto every one of their verified conversations',
        named.rows[0].named === named.rows[0].total,
        named.rows[0].named + ' of ' + named.rows[0].total);

  r = await call('POST', '/api/messages/send', tOther,
    { thread_id: '', topic: 'Name test 2', text: 'Trying to rename myself.',
      name: 'Someone Else' });
  check('a name already on the account is NOT overwritten by a later message',
        (await db.query('SELECT full_name FROM account WHERE employee_id = $1',
                        [OTHER])).rows[0].full_name === 'Mr Example',
        'renaming is done on purpose, not as a side effect of sending');

  // =======================================================================
  console.log('');
  console.log('  The guard that caught a real bug');
  // =======================================================================
  const pool = require('./db').pool;
  const client = await pool.connect();
  let threw = '';
  try {
    await client.query('BEGIN');
    await write.appendToThread(client, {
      person: USER, verified: true, side: 'TEAM', author: ADMIN,
      text: 'An answer with no question in front of it.'
    });
  } catch (e) { threw = e.message; }
  await client.query('ROLLBACK');
  client.release();
  check('a team reply with no conversation THROWS rather than inventing one',
        /no conversation to go into/.test(threw), threw || 'it did not throw');

  // =======================================================================
  console.log('');
  console.log('  Five people pressing Send at once');
  // =======================================================================
  /*
    Messenger.gs takes no lock anywhere, and its counters are a
    read-modify-write:

        const waiting = side === SIDE_USER ? (thread.waitingForTeam || 0) + 1 : 0;

    Two lines landing together both read the same number and the second
    overwrites the first, so the badge quietly undercounts. The port does
    the arithmetic in SQL on a row it is holding, which cannot lose one.
  */
  const start = await call('POST', '/api/messages/send', tRacer,
    { thread_id: '', topic: 'Race', text: 'First line of the race test.' });
  const raceThread = start.body.threadId;

  // Four at once, not five: one has already been spent opening the thread
  // and the cap is five an hour. Four landing together is as much of a
  // race as five.
  await Promise.all([1, 2, 3, 4].map(function (n) {
    return call('POST', '/api/messages/send', tRacer,
      { thread_id: raceThread, text: 'Concurrent line number ' + n + '.' });
  }));

  const raced = (await threadsOf(RACER)).filter(function (t) {
    return t.thread_id === raceThread;
  })[0];
  check('all five lines are in the thread',
        (await linesOf(raceThread)).length === 5,
        String((await linesOf(raceThread)).length));
  check('AND THE COUNTER COUNTED EVERY ONE',
        Number(raced.waiting_for_team) === 5,
        'got ' + raced.waiting_for_team + ' of 5 - counts were lost');

  /*
    AND THE RACE THE LOCK IS ACTUALLY FOR.

    The counters above survive concurrency because the arithmetic happens
    in SQL on a row the statement holds - no lock needed. What the
    per-person lock protects is FIND-OR-CREATE, where the read and the
    write are two statements with a gap between them:

      - four sign-in messages from one ID landing together must join ONE
        thread. Without the lock all four look, all four find nothing, and
        that ID ends up with four sign-in threads where the original
        promises one - "a lifeline channel, not a list of tickets".

      - two identical sends landing together are the exact case
        recentTwinThread exists for, and the exact case where both can run
        the check before either has written anything. The original does
        this check outside any lock at all.
  */
  const burst = id(11);   // never enrolled, fresh every run
  await Promise.all([1, 2, 3, 4].map(function (n) {
    return call('POST', '/api/messages/signin', null,
      { employee_id: burst, text: 'Locked out, attempt number ' + n + '.' });
  }));
  check('four sign-in messages at once make ONE thread',
        (await threadsOf(burst)).length === 1,
        'got ' + (await threadsOf(burst)).length);
  check('with all four lines in it',
        (await linesOf((await threadsOf(burst))[0].thread_id)).length === 4,
        String((await linesOf((await threadsOf(burst))[0].thread_id)).length));

  const sameText = 'Pressing send twice because nothing happened.';
  await Promise.all([1, 2].map(function () {
    return call('POST', '/api/messages/send', tDouble,
      { thread_id: '', topic: 'Double', text: sameText });
  }));
  check('two identical sends at once make ONE query',
        (await threadsOf(DOUBLE)).length === 1,
        'got ' + (await threadsOf(DOUBLE)).length +
        ' - the duplicate guard ran before either had written');

  // =======================================================================
  console.log('');
  console.log('  Functions');
  // =======================================================================
  check('a name is squeezed and trimmed', write.cleanName('  a   b  ') === 'a b');
  check('and cut at 60 characters',
        write.cleanName('z'.repeat(80)).length === 60);
  check('who() shows both halves when there is a name',
        write.who('20990201', 'Ann') === 'Ann (20990201)');
  check('and just the ID when there is not',
        write.who('20990201', '') === '20990201');
  check('the id stamp is yyyyMMdd-HHmmss',
        /^\d{8}-\d{6}$/.test(write.stamp(new Date())), write.stamp(new Date()));
  check('and reads the dashboard clock, not UTC',
        write.stamp(new Date('2026-11-20T20:30:00Z')) === '20261121-023000',
        write.stamp(new Date('2026-11-20T20:30:00Z')) + ' - Asia/Dhaka is UTC+6');
  check('short ids are six hex characters',
        /^[0-9A-F]{6}$/.test(write.shortId()), write.shortId());
  check('a message of one character is refused',
        Boolean(write.cleanMessage(' x ').bad));
  check('and one of two is not', write.cleanMessage('ok').text === 'ok');

  // =======================================================================
  await wipe();
  await db.query("DELETE FROM msg_thread WHERE thread_id LIKE 'TEST-W%'");
  await db.end();

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});
