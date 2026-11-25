/**
 * THE ACCOUNTS SCREEN'S SERVER SIDE, against the real database and the real
 * HTTP endpoints.
 * ===========================================================================
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node accounts-test.js
 *
 * This is the one part of the system where a bug is not a wrong number on a
 * dashboard - it is somebody who should not have admin having it, or a
 * master who has locked everybody out of their own accounts. So the guards
 * get as much attention as the happy paths: the last master, demoting
 * yourself, deleting the account you are signed in with, and every single
 * route answering 403 to somebody who is merely an admin.
 *
 * EVERY ACCOUNT IT MAKES IS IN THE RESERVED TEST BLOCK - 2099xxxx - and
 * swept at both ends. It also refuses to run at all if the sweep would
 * touch an ID outside that block, because this suite deletes accounts and
 * the thing it must never do is delete somebody's real login.
 */
require('dotenv').config();
const db = require('./db');
const accounts = require('./accounts');
const { signToken } = require('./auth');
const { verifyPassword } = require('./password');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

/*
  THE FIXTURE'S OWN CORNER OF THE RESERVED BLOCK. 2099 is the test block;
  these five are this suite's.
*/
const MASTER = '20990901';     // the one driving the screen
const MASTER2 = '20990902';    // a second master, so the last-master guard
                               // can be tested in both directions
const ADMIN = '20990903';      // for the 403s
const VIEWER = '20990904';     // the one things are done to
const NOBODY = '20990905';     // on the roster, no account - for the invite
const OFF_ROSTER = '20990906'; // not on the roster at all

const MINE = [MASTER, MASTER2, ADMIN, VIEWER, NOBODY, OFF_ROSTER];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++;
  const line = name + (detail === undefined ? '' : '   ' + detail);
  failures.push(line);
  console.log('  FAIL ' + line);
}

function recap() {
  if (!failures.length) return;
  console.log('');
  console.log('  ' + failures.length + ' failed:');
  failures.forEach(function (line) { console.log('    - ' + line); });
}


/**
 * THE GUARD ON THE SWEEP ITSELF.
 *
 * This suite deletes accounts. Every ID it touches is built from the
 * constants above, but a typo in one of them would point a DELETE at a real
 * login - and the reserved blocks exist precisely so that cannot happen by
 * accident. Checked once, out loud, before anything is written.
 */
function refuseIfNotReserved() {
  const bad = MINE.filter(function (id) { return !/^2099\d{4}$/.test(id); });
  if (bad.length) {
    throw new Error('These are not reserved test IDs and this suite deletes ' +
                    'accounts: ' + bad.join(', '));
  }
}


async function sweep() {
  await db.query('DELETE FROM account WHERE employee_id = ANY($1)', [MINE]);
  await db.query('DELETE FROM auth_log WHERE employee_id = ANY($1)', [MINE]);
  await db.query('DELETE FROM team WHERE employee_id = ANY($1)', [MINE]);
}


/** Puts the five on the roster, because account has a foreign key to it. */
async function seed() {
  for (const id of [MASTER, MASTER2, ADMIN, VIEWER, NOBODY]) {
    await db.query(
      `INSERT INTO team (employee_id, full_name, designation, sub_department)
       VALUES ($1, $2, 'Test', 'Test')
       ON CONFLICT (employee_id) DO NOTHING`,
      [id, 'Test Account ' + id.slice(-3)]);
  }
  // OFF_ROSTER is deliberately NOT added - that is the whole point of it.

  const make = async function (id, role) {
    await db.query(
      `INSERT INTO account (employee_id, password_hash, role, must_change)
       VALUES ($1, $2, $3, false)`,
      [id, require('./password').hashPassword('fixture-' + id), role]);
  };
  await make(MASTER, 'MASTER');
  await make(MASTER2, 'MASTER');
  await make(ADMIN, 'ADMIN');
  await make(VIEWER, 'USER');
}


/** One HTTP call. Returns { code, body } and never throws on a 4xx. */
async function call(method, path, token, body) {
  const opts = { method: method, headers: {} };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  // A GET may not carry one, and the role sweep above calls every route the
  // same way - so the body is simply dropped where it is not allowed.
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  return { code: res.status, body: data || {} };
}


function rowFor(list, id) {
  return (list || []).filter(function (a) { return a.username === id; })[0] || null;
}

async function logFor(id) {
  return db.query(
    'SELECT event, role, detail FROM auth_log WHERE employee_id = $1 ORDER BY id',
    [id]);
}


async function main() {
  refuseIfNotReserved();

  try {
    const res = await fetch(BASE + '/api/health');
    if (!res.ok) throw new Error('health check answered ' + res.status);
  } catch (err) {
    console.log('');
    console.log('  The API is not answering on ' + BASE + '.');
    console.log('  Start it in Terminal 3 with:  npm start');
    console.log('  (' + err.message + ')');
    console.log('');
    process.exit(1);
  }

  await sweep();
  await seed();

  const master = signToken(MASTER, 'MASTER');
  const admin = signToken(ADMIN, 'ADMIN');
  const viewer = signToken(VIEWER, 'USER');


  // =======================================================================
  console.log('');
  console.log('  Who may open any of it');
  // =======================================================================
  /*
    THE WHOLE FAMILY AT ONCE. Hiding the screen from an admin is a courtesy;
    this is the thing that actually holds, and it has to hold on every
    route rather than on most of them. One missed requireMaster is an admin
    who can make themselves a master.
  */
  const routes = [
    ['GET', '/api/master/boot'],
    ['GET', '/api/master/accounts'],
    ['GET', '/api/master/log'],
    ['POST', '/api/master/grant'],
    ['POST', '/api/master/role'],
    ['POST', '/api/master/details'],
    ['POST', '/api/master/reset'],
    ['POST', '/api/master/remove']
  ];

  const asAdmin = [];
  const asViewer = [];
  const asNobody = [];
  for (const [method, path] of routes) {
    asAdmin.push((await call(method, path, admin, {})).code);
    asViewer.push((await call(method, path, viewer, {})).code);
    asNobody.push((await call(method, path, null, {})).code);
  }
  check('AN ADMIN IS REFUSED BY EVERY ONE OF THE ' + routes.length + ' ROUTES',
        asAdmin.every(function (c) { return c === 403; }),
        JSON.stringify(routes.map(function (r, i) {
          return r[1] + ':' + asAdmin[i]; })));
  check('and so is a viewer',
        asViewer.every(function (c) { return c === 403; }),
        JSON.stringify(asViewer));
  check('and somebody with no token at all gets 401, not 403',
        asNobody.every(function (c) { return c === 401; }),
        JSON.stringify(asNobody));


  // =======================================================================
  console.log('');
  console.log('  Reading the accounts');
  // =======================================================================
  let got = await call('GET', '/api/master/accounts', master);
  check('a master can read them', got.code === 200, got.code);

  const list = got.body.accounts || [];
  check('the fixture accounts are all there',
        MINE.slice(0, 4).every(function (id) { return rowFor(list, id); }),
        JSON.stringify(MINE.slice(0, 4).filter(function (id) {
          return !rowFor(list, id); })));

  check('NO HASH TRAVELS TO THE BROWSER, on any row',
        list.every(function (a) {
          return !('password_hash' in a) && !('hash' in a) &&
                 !JSON.stringify(a).match(/scrypt|\$2[aby]\$/);
        }),
        JSON.stringify(Object.keys(list[0] || {})));

  const viewerRow = rowFor(list, VIEWER);
  check('a row carries what the screen needs to manage it',
        viewerRow && viewerRow.role === 'USER' &&
        viewerRow.signIns === 0 && viewerRow.mustChange === false &&
        viewerRow.fullName === 'Test Account 904',
        JSON.stringify(viewerRow));

  check('the name falls back to the roster when the account has none',
        viewerRow && viewerRow.fullName === 'Test Account 904',
        viewerRow && viewerRow.fullName);


  // =======================================================================
  console.log('');
  console.log('  Signing in writes itself down');
  // =======================================================================
  const before = rowFor((await call('GET', '/api/master/accounts', master))
                          .body.accounts, VIEWER);
  const signedIn = await call('POST', '/api/login', null,
                              { employee_id: VIEWER, password: 'fixture-' + VIEWER });
  check('the fixture password signs in', signedIn.code === 200,
        JSON.stringify(signedIn.body));

  const after = rowFor((await call('GET', '/api/master/accounts', master))
                         .body.accounts, VIEWER);
  check('THE SIGN-IN COUNTER GOES UP, which last_login_at alone cannot say',
        after.signIns === before.signIns + 1,
        before.signIns + ' -> ' + after.signIns);
  check('and the clock is set',
        Boolean(after.lastSignIn) && !before.lastSignIn, after.lastSignIn);

  let rows = await logFor(VIEWER);
  check('and the sign-in log has a row for it',
        rows.length === 1 && rows[0].event === 'SIGNIN' && rows[0].role === 'USER',
        JSON.stringify(rows));


  // =======================================================================
  console.log('');
  console.log('  Giving and taking away admin');
  // =======================================================================
  got = await call('POST', '/api/master/role', master,
                   { employee_id: VIEWER, role: 'ADMIN' });
  check('a viewer can be made an admin', got.code === 200 &&
        got.body.role === 'ADMIN', JSON.stringify(got.body));

  rows = await logFor(VIEWER);
  check('AND THE LOG SAYS WHO DID IT, not just that it happened',
        rows.some(function (r) {
          return r.event === 'ROLE' && r.detail === 'set by ' + MASTER;
        }), JSON.stringify(rows));

  /*
    AND WHO DID IT CANNOT BE CLAIMED BY THE BODY.

    Every one of these routes takes the actor from req.user - which
    requireAuth put there after verifying a signature - and the body is only
    ever read for what is being done, never for who is doing it. That is the
    whole reason the log is worth keeping: a signature cannot be argued
    with and a JSON field can.

    A mutation that read `b.actor || req.user.employeeId` survived a whole
    run, because every check here looked at what changed rather than at
    whose name went into the row beside it.
  */
  await call('POST', '/api/master/role', master,
             { employee_id: VIEWER, role: 'ADMIN', actor: '20990000',
               employeeId: '20990000', user: '20990000' });
  rows = await logFor(VIEWER);
  check('A BODY CANNOT PUT SOMEBODY ELSE\'S NAME ON WHAT IT DID',
        rows.every(function (r) {
          return (r.detail || '').indexOf('20990000') === -1;
        }) &&
        rows.filter(function (r) { return r.event === 'ROLE'; })
            .every(function (r) { return r.detail === 'set by ' + MASTER; }),
        JSON.stringify(rows.filter(function (r) { return r.event === 'ROLE'; })));

  /* The same, for the one route that writes a note onto the account. */
  await call('POST', '/api/master/grant', master,
             { employee_id: NOBODY, role: 'USER', actor: '20990000' });
  const spoofNote = (await db.query(
    'SELECT note FROM account WHERE employee_id = $1', [NOBODY]))[0];
  check('nor onto the account it creates',
        !spoofNote || spoofNote.note.indexOf('20990000') === -1,
        spoofNote && spoofNote.note);
  await db.query('DELETE FROM account WHERE employee_id = $1', [NOBODY]);
  await db.query('DELETE FROM auth_log WHERE employee_id = $1', [NOBODY]);

  got = await call('POST', '/api/master/role', master,
                   { employee_id: VIEWER, role: 'USER' });
  check('and taken away again', got.code === 200 && got.body.role === 'USER');

  got = await call('POST', '/api/master/role', master,
                   { employee_id: VIEWER, role: 'WIZARD' });
  check('a role nobody has heard of is refused',
        got.code >= 400 && /Unknown role/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/master/role', master,
                   { employee_id: '20990000', role: 'ADMIN' });
  check('and an employee ID with no account is refused by name',
        got.code >= 400 && /No account for employee ID/.test(got.body.error || ''),
        JSON.stringify(got.body));


  // =======================================================================
  console.log('');
  console.log('  Standing on the branch you are sawing');
  // =======================================================================
  got = await call('POST', '/api/master/role', master,
                   { employee_id: MASTER, role: 'ADMIN' });
  check('A MASTER CANNOT DEMOTE THEMSELVES while they are the one doing it',
        got.code >= 400 && /remove your own master access/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/master/remove', master,
                   { employee_id: MASTER });
  check('nor delete the account they are signed in with',
        got.code >= 400 && /signed in with/.test(got.body.error || ''),
        JSON.stringify(got.body));

  /*
    THE LAST MASTER. Demoting the OTHER master is fine while there are two;
    once there is one, nobody can demote or remove them - including
    themselves, which the two checks above already cover from the other
    side. Tested by actually getting down to one, because a guard that
    counts is a guard that can count wrongly.
  */
  got = await call('POST', '/api/master/role', master,
                   { employee_id: MASTER2, role: 'USER' });
  check('the second master can be stood down while there are two',
        got.code === 200, JSON.stringify(got.body));

  const masters = await db.query(
    "SELECT count(*)::int AS n FROM account WHERE role = 'MASTER'");
  got = await call('POST', '/api/master/role', master,
                   { employee_id: MASTER, role: 'USER' });
  check('and then the last one cannot be stood down at all',
        got.code >= 400, JSON.stringify(got.body) + ' (masters: ' + masters[0].n + ')');

  // Put it back, so the rest of the suite has two again.
  await call('POST', '/api/master/role', master,
             { employee_id: MASTER2, role: 'MASTER' });

  /*
    AND THE OTHER WAY ROUND: the last master cannot be REMOVED either, which
    is a different code path from being demoted.

    REACHING IT TAKES A STALE TOKEN, and that is worth saying out loud
    rather than working around. The caller has to be a master (requireMaster)
    and must not be the account being removed (the guard above), so with one
    master left there is normally nobody who can even ask the question. The
    one person who can is somebody whose token still says MASTER because it
    was issued before they were stood down - a token is a snapshot, signed
    for eight hours, and nothing re-reads the database to see whether it is
    still true.

    So this is not a contrived fixture. It is the actual window in which the
    guard has to hold, and it holds for up to JWT_TTL after any demotion.
  */
  const staleMasterToken = signToken(MASTER2, 'MASTER');
  await call('POST', '/api/master/role', master,
             { employee_id: MASTER2, role: 'USER' });

  check('a token issued before a demotion still opens the master routes',
        (await call('GET', '/api/master/accounts', staleMasterToken)).code === 200);

  got = await call('POST', '/api/master/remove', staleMasterToken,
                   { employee_id: MASTER });
  check('BUT IT STILL CANNOT REMOVE THE LAST MASTER',
        got.code >= 400 && /only master account/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/master/role', staleMasterToken,
                   { employee_id: MASTER, role: 'USER' });
  check('nor stand them down',
        got.code >= 400 && /only master account/.test(got.body.error || ''),
        JSON.stringify(got.body));

  await call('POST', '/api/master/role', master,
             { employee_id: MASTER2, role: 'MASTER' });


  // =======================================================================
  console.log('');
  console.log('  Resetting a password');
  // =======================================================================
  got = await call('POST', '/api/master/reset', master, { employee_id: VIEWER });
  check('the reset answers with a password', got.code === 200 &&
        typeof got.body.password === 'string' && got.body.password.length >= 8,
        JSON.stringify(got.body).slice(0, 80));

  const firstPassword = got.body.password;
  check('IT IS NOT A CONSTANT - a second reset gives a different one',
        (await call('POST', '/api/master/reset', master,
                    { employee_id: VIEWER })).body.password !== firstPassword);

  const second = await call('POST', '/api/master/reset', master,
                            { employee_id: VIEWER });
  check('and it has no characters that get misread aloud',
        !/[Il1O0]/.test(second.body.password), second.body.password);

  const stored = (await db.query(
    'SELECT password_hash, must_change FROM account WHERE employee_id = $1',
    [VIEWER]))[0];
  check('THE PASSWORD IS NOT STORED, only a hash of it',
        stored.password_hash.indexOf(second.body.password) === -1 &&
        verifyPassword(second.body.password, stored.password_hash));
  check('and they are made to choose their own',
        stored.must_change === true);

  rows = await logFor(VIEWER);
  check('the log records the reset and NOT the password',
        rows.some(function (r) { return r.event === 'RESET'; }) &&
        !rows.some(function (r) {
          return (r.detail || '').indexOf(second.body.password) !== -1;
        }), JSON.stringify(rows.map(function (r) { return r.event; })));

  check('the new password actually signs in',
        (await call('POST', '/api/login', null,
                    { employee_id: VIEWER, password: second.body.password })).code === 200);
  check('AND THE SIGN-IN SAYS THEY MUST CHOOSE THEIR OWN',
        (await call('POST', '/api/login', null,
                    { employee_id: VIEWER, password: second.body.password }))
          .body.mustChange === true);
  check('while the one it replaced does not',
        (await call('POST', '/api/login', null,
                    { employee_id: VIEWER, password: firstPassword })).code === 401);


  // =======================================================================
  console.log('');
  console.log('  Changing your own password');
  // =======================================================================
  const viewerNow = signToken(VIEWER, 'USER');
  got = await call('POST', '/api/password', viewerNow,
                   { current: 'not it', next: 'brand-new-one', confirm: 'brand-new-one' });
  check('the current password has to be right',
        got.code >= 400 && /not your current password/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/password', viewerNow,
                   { current: second.body.password, next: 'abc', confirm: 'abc' });
  check('a short one is refused',
        got.code >= 400 && /at least/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/password', viewerNow,
                   { current: second.body.password, next: 'brand-new-one',
                     confirm: 'brand-new-two' });
  check('and two that do not match are refused',
        got.code >= 400 && /not the same/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/password', viewerNow,
                   { current: second.body.password, next: second.body.password,
                     confirm: second.body.password });
  check('so is the one they already have',
        got.code >= 400 && /already have/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/password', viewerNow,
                   { current: second.body.password, next: 'brand-new-one',
                     confirm: 'brand-new-one' });
  check('and a good one goes through', got.code === 200, JSON.stringify(got.body));

  check('THE MUST-CHANGE FLAG IS CLEARED, so the card stops appearing',
        (await call('POST', '/api/login', null,
                    { employee_id: VIEWER, password: 'brand-new-one' }))
          .body.mustChange === false);

  rows = await logFor(VIEWER);
  check('and the log says they changed it themselves',
        rows.some(function (r) {
          return r.event === 'PASSWORD' &&
                 r.detail === 'changed by the account holder';
        }), JSON.stringify(rows.map(function (r) { return r.event; })));

  /*
    THE ID COMES FROM THE TOKEN AND NOWHERE ELSE. changeMyPassword takes no
    employee ID at all, so this is really a check that nobody adds one
    later: a body claiming to be somebody else changes the caller's own
    password, not theirs.
  */
  const adminBefore = (await db.query(
    'SELECT password_hash FROM account WHERE employee_id = $1', [ADMIN]))[0];
  await call('POST', '/api/password', viewerNow,
             { employee_id: ADMIN, current: 'brand-new-one',
               next: 'another-new-one', confirm: 'another-new-one' });
  const adminAfter = (await db.query(
    'SELECT password_hash FROM account WHERE employee_id = $1', [ADMIN]))[0];
  check('A BODY CANNOT POINT THE CHANGE AT A COLLEAGUE',
        adminBefore.password_hash === adminAfter.password_hash);


  // =======================================================================
  console.log('');
  console.log('  Writing an employee ID down before they arrive');
  // =======================================================================
  got = await call('POST', '/api/master/grant', master,
                   { employee_id: NOBODY, role: 'ADMIN' });
  check('an ID with no account is invited', got.code === 200 &&
        got.body.invited === true && got.body.role === 'ADMIN',
        JSON.stringify(got.body));
  check('and comes with a password to pass on',
        typeof got.body.password === 'string' && got.body.password.length >= 8);

  const invited = got.body.password;
  check('THEY ARRIVE ALREADY HOLDING THE ACCESS THEY WERE GIVEN',
        (await call('POST', '/api/login', null,
                    { employee_id: NOBODY, password: invited }))
          .body.user.role === 'ADMIN');

  const note = (await db.query(
    'SELECT note FROM account WHERE employee_id = $1', [NOBODY]))[0].note;
  check('and the account says why it exists',
        note === 'added by ' + MASTER + ' before they signed in', note);

  got = await call('POST', '/api/master/grant', master,
                   { employee_id: NOBODY, role: 'USER' });
  check('granting again changes the role rather than inviting twice',
        got.code === 200 && got.body.invited === false && got.body.role === 'USER',
        JSON.stringify(got.body));

  got = await call('POST', '/api/master/grant', master,
                   { employee_id: OFF_ROSTER, role: 'USER' });
  check('AN ID THAT IS NOT ON THE ROSTER IS REFUSED IN PLAIN WORDS, ' +
        'not as a constraint violation',
        got.code >= 400 && /not on the roster/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/master/grant', master,
                   { employee_id: 'abc', role: 'USER' });
  check('an employee ID is digits only',
        got.code >= 400 && /digits only/.test(got.body.error || ''),
        JSON.stringify(got.body));

  got = await call('POST', '/api/master/grant', master,
                   { employee_id: '12', role: 'USER' });
  check('and has to be a plausible length',
        got.code >= 400 && /digits/.test(got.body.error || ''),
        JSON.stringify(got.body));


  // =======================================================================
  console.log('');
  console.log('  Names and where the alerts go');
  // =======================================================================
  got = await call('POST', '/api/master/details', master,
                   { employee_id: VIEWER, full_name: '  Test   Person  ',
                     email: null });
  check('a name is tidied on the way in',
        got.code === 200 && got.body.fullName === 'Test Person',
        JSON.stringify(got.body));

  got = await call('POST', '/api/master/details', master,
                   { employee_id: VIEWER, full_name: null,
                     email: 'not-an-address' });
  check('a nonsense address is refused',
        got.code >= 400 && /does not look like an email/.test(got.body.error || ''),
        JSON.stringify(got.body));

  check('AND REFUSING IT LEFT THE NAME ALONE',
        rowFor((await call('GET', '/api/master/accounts', master)).body.accounts,
               VIEWER).fullName === 'Test Person');

  got = await call('POST', '/api/master/details', master,
                   { employee_id: VIEWER, full_name: null,
                     email: 'test904@example.com' });
  check('a real one is stored', got.code === 200 &&
        got.body.email === 'test904@example.com', JSON.stringify(got.body));
  check('and the name beside it survived',
        got.body.fullName === 'Test Person', JSON.stringify(got.body));

  check('A VIEWER WITH AN ADDRESS IS NOT ALERTED, and the row says so',
        got.body.alerted === false, JSON.stringify(got.body));

  await call('POST', '/api/master/role', master,
             { employee_id: VIEWER, role: 'ADMIN' });
  check('making them an admin is what turns the address on',
        rowFor((await call('GET', '/api/master/accounts', master)).body.accounts,
               VIEWER).alerted === true);

  const alerts = await accounts.alertEmails();
  check('and that is the list a new query is emailed to',
        alerts.indexOf('test904@example.com') !== -1, JSON.stringify(alerts));

  await call('POST', '/api/master/role', master,
             { employee_id: VIEWER, role: 'USER' });
  check('AND TAKING IT AWAY TAKES THEM OFF THE LIST AGAIN - the list that ' +
        'maintains itself is the whole reason the column exists',
        (await accounts.alertEmails()).indexOf('test904@example.com') === -1);

  got = await call('POST', '/api/master/details', master,
                   { employee_id: VIEWER, full_name: null, email: '' });
  check('an empty address clears it on purpose',
        got.code === 200 && got.body.email === '', JSON.stringify(got.body));


  // =======================================================================
  console.log('');
  console.log('  The sign-in log');
  // =======================================================================
  got = await call('GET', '/api/master/log?limit=500', master);
  check('a master can read it', got.code === 200, got.code);

  const log = got.body.log || [];
  check('it is newest first',
        log.every(function (r, i) {
          return i === 0 || log[i - 1].when >= r.when;
        }), JSON.stringify(log.slice(0, 3)));

  check('and it carries every kind of event this suite caused',
        ['SIGNIN', 'ROLE', 'RESET', 'PASSWORD', 'INVITED', 'DETAILS']
          .every(function (e) {
            return log.some(function (r) {
              return r.event === e && MINE.indexOf(r.username) !== -1;
            });
          }),
        JSON.stringify(log.filter(function (r) {
          return MINE.indexOf(r.username) !== -1;
        }).map(function (r) { return r.event; })));

  check('the limit is honoured',
        ((await call('GET', '/api/master/log?limit=3', master)).body.log || [])
          .length <= 3);
  check('AND A SILLY LIMIT IS CLAMPED rather than obeyed',
        ((await call('GET', '/api/master/log?limit=999999', master)).body.log || [])
          .length <= 1000);


  // =======================================================================
  console.log('');
  console.log('  Pruning it');
  // =======================================================================
  await db.query(
    `INSERT INTO auth_log (at, employee_id, event, role, detail)
     VALUES (now() - interval '400 days', $1, 'SIGNIN', 'USER', 'ancient'),
            (now() - interval '31 days',  $1, 'SIGNIN', 'USER', 'just outside'),
            (now() - interval '29 days',  $1, 'SIGNIN', 'USER', 'just inside')`,
    [VIEWER]);

  const removed = await accounts.pruneAuthLog();
  check('the two rows outside the window go', removed >= 2, String(removed));

  const left = await db.query(
    `SELECT detail FROM auth_log
      WHERE employee_id = $1
        AND detail IN ('ancient', 'just outside', 'just inside')`, [VIEWER]);
  check('AND THE ONE INSIDE IT STAYS',
        left.some(function (r) { return r.detail === 'just inside'; }) &&
        !left.some(function (r) { return r.detail === 'ancient'; }),
        JSON.stringify(left.map(function (r) { return r.detail; })));

  /*
    OUT OF ORDER ON PURPOSE. Auth.gs prunes only a PREFIX of the sheet,
    because deleteRows is positional and an unsorted sheet would make it
    reach past fresh rows. A DELETE ... WHERE judges each row on its own
    date, so inserting an old row after a new one must still drop exactly
    the old one - which is the behaviour the sheet could not have.
  */
  await db.query(
    `INSERT INTO auth_log (at, employee_id, event, role, detail)
     VALUES (now(), $1, 'SIGNIN', 'USER', 'newest'),
            (now() - interval '90 days', $1, 'SIGNIN', 'USER', 'out of order')`,
    [VIEWER]);
  await accounts.pruneAuthLog();
  const after2 = await db.query(
    "SELECT detail FROM auth_log WHERE employee_id = $1 AND detail IN " +
    "('newest', 'out of order')", [VIEWER]);
  check('AN OLD ROW WRITTEN AFTER A NEW ONE IS STILL THE ONE THAT GOES',
        after2.length === 1 && after2[0].detail === 'newest',
        JSON.stringify(after2.map(function (r) { return r.detail; })));


  // =======================================================================
  console.log('');
  console.log('  Removing a login');
  // =======================================================================
  got = await call('POST', '/api/master/remove', master, { employee_id: NOBODY });
  check('it goes', got.code === 200, JSON.stringify(got.body));
  check('and they cannot sign in any more',
        (await call('POST', '/api/login', null,
                    { employee_id: NOBODY, password: invited })).code === 401);

  rows = await logFor(NOBODY);
  check('THE LOG KEEPS THE ROW ABOUT THE REMOVAL, which a foreign key ' +
        'would have deleted with the account',
        rows.some(function (r) {
          return r.event === 'REMOVED' && r.detail === 'by ' + MASTER;
        }), JSON.stringify(rows.map(function (r) { return r.event; })));


  // =======================================================================
  await sweep();
  check('no test accounts are left behind',
        (await db.query(
          'SELECT count(*)::int AS n FROM account WHERE employee_id = ANY($1)',
          [MINE]))[0].n === 0);
  check('no test log rows are left behind',
        (await db.query(
          'SELECT count(*)::int AS n FROM auth_log WHERE employee_id = ANY($1)',
          [MINE]))[0].n === 0);

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  recap();
  console.log('');
  await db.pool.end();
  process.exit(fail ? 1 : 0);
}


main().catch(async function (err) {
  console.error('\n  Failed: ' + err.message + '\n' + err.stack + '\n');
  recap();
  try { await sweep(); } catch (e) { /* best effort */ }
  try { await db.pool.end(); } catch (e) { /* best effort */ }
  process.exit(1);
});
