/**
 * tick-test.js - the tick endpoint, including the race that loses marks.
 * ===========================================================================
 *
 * NEEDS A RUNNING SERVER AND DATABASE, which is why it is not part of
 * `npm test` - that suite is pure arithmetic and must stay runnable with
 * nothing switched on.
 *
 *     terminal 1:   npm start
 *     terminal 2:   node tick-test.js
 *
 * It writes to obj_log for one objective and clears up after itself.
 *
 * WHY THE CONCURRENCY CASE IS HERE AT ALL
 *
 * Because the port had the bug, and nothing else would have found it.
 *
 * Objective.gs takes a script-wide lock around find-the-row-then-write-it,
 * and says why: "the page now sends ticks concurrently on purpose -
 * pressing five days in a row fires five calls without waiting. Two of
 * those landing together both find no row and both append one ... That is
 * how a month of recording disappears."
 *
 * The first port took a per-row advisory lock, which sounded equivalent and
 * was not: the caller read the log and worked out the new marks string
 * BEFORE calling the writer, so the lock protected only the write. Five
 * slots ticked at once all read the same empty string:
 *
 *     expected  YYYYY        got  Y...Y        three ticks lost, silently
 *
 * Every single-tick test passed throughout. A lock around only the write is
 * not a lock.
 */

const http = require('http');
const { Client } = require('pg');
const obj = require('./objectives');
require('dotenv').config();

const PORT = Number(process.env.PORT || 3000);

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

  /*
    THE OBJECTIVE IS CHOSEN FOR ITS SLOT COUNT, not taken as the first row.

    The first version took whichever came first and then ticked slots 0 to
    4 regardless. On Rudra's real data that was OJT-005, which is MONTHLY -
    one slot in a month. Slots 1 to 4 do not exist, the endpoint correctly
    refused them with 400, and the test reported "TICKS LOST" five times
    over. The code was right and the test was wrong, which is the worse way
    round: it accuses working code.

    A race needs more than one slot to race over, so a daily or weekly
    objective is picked - whichever has the most squares this month.
  */
  const all = await db.query(
    'SELECT objective_id, grp, frequency FROM obj_task WHERE NOT kpi ORDER BY objective_id');
  if (!all.rows.length) {
    console.log('\n  No objectives in the database - run import-objectives.js first.\n');
    process.exit(1);
  }

  // Somebody who may tick it: an ADMIN may tick any module.
  const admin = await db.query(
    "SELECT employee_id FROM account WHERE role IN ('ADMIN','MASTER') LIMIT 1");
  if (!admin.rows.length) {
    console.log('\n  No admin account - run set-password.js <id> --admin first.\n');
    process.exit(1);
  }

  console.log('');
  console.log('  Signing in as ' + admin.rows[0].employee_id);

  const pw = process.env.TICK_TEST_PASSWORD;
  if (!pw) {
    console.log('  Set TICK_TEST_PASSWORD to that account\'s password first:');
    console.log('');
    console.log('    PowerShell:  $env:TICK_TEST_PASSWORD="..."; node tick-test.js');
    console.log('');
    process.exit(1);
  }

  const login = await call('POST', '/api/login', null,
    { employee_id: admin.rows[0].employee_id, password: pw });
  if (!login.body.token) {
    console.log('  Could not sign in: ' + (login.body.error || login.code));
    process.exit(1);
  }
  const token = login.body.token;

  const period = (await call('GET', '/api/objectives', token)).body.period;

  // Now the period is known, the slot count is too.
  let task = all.rows[0];
  let slots = obj.objSlotCount(period, task.frequency);
  all.rows.forEach(function (r) {
    const n = obj.objSlotCount(period, r.frequency);
    if (n > slots) { slots = n; task = r; }
  });

  console.log('  Objective under test: ' + task.objective_id +
              '  (' + task.grp + ', ' + task.frequency + ')  - ' +
              slots + ' slot(s) in ' + period);
  console.log('');

  const clean = function () {
    return db.query('DELETE FROM obj_log WHERE ref_id = $1', [task.objective_id]);
  };

  // ---- refusals ---------------------------------------------------------
  console.log('REFUSALS');
  console.log('-----------------------------------------------------------');

  let r = await call('POST', '/api/objectives/tick-task', null,
    { task_id: task.objective_id, period: period, slot: 0, mark: 'Y' });
  check('no token is 401', r.code === 401, 'got ' + r.code);

  r = await call('POST', '/api/objectives/tick-task', token,
    { task_id: task.objective_id, period: '2020-01', slot: 0, mark: 'Y' });
  check('a month outside the period is 400', r.code === 400, 'got ' + r.code);

  r = await call('POST', '/api/objectives/tick-task', token,
    { task_id: 'NOT-A-REAL-ID', period: period, slot: 0, mark: 'Y' });
  check('an unknown objective is 404', r.code === 404, 'got ' + r.code);

  const kpi = await db.query(
    'SELECT objective_id FROM obj_task WHERE kpi ORDER BY objective_id LIMIT 1');
  if (kpi.rows.length) {
    r = await call('POST', '/api/objectives/tick-task', token,
      { task_id: kpi.rows[0].objective_id, period: period, slot: 0, mark: 'Y' });
    // A KPI is nobody's to tick, an ADMIN included.
    check('a KPI is 403 even for an admin', r.code === 403, 'got ' + r.code);
  }

  r = await call('POST', '/api/objectives/tick-task', token,
    { task_id: task.objective_id, period: period, slot: 9999, mark: 'Y' });
  check('a slot out of range is 400', r.code === 400, 'got ' + r.code);

  // ---- one tick ---------------------------------------------------------
  console.log('');
  console.log('ONE TICK');
  console.log('-----------------------------------------------------------');
  await clean();

  r = await call('POST', '/api/objectives/tick-task', token,
    { task_id: task.objective_id, period: period, slot: 0, mark: 'Y' });
  check('a permitted tick is accepted', r.code === 200 && r.body.ok === true,
        'got ' + r.code);
  check('the mark lands in slot 0', r.body.marks && r.body.marks.charAt(0) === 'Y',
        'marks=' + r.body.marks);

  let row = (await db.query(
    'SELECT marks, marked_at FROM obj_log WHERE ref_id = $1',
    [task.objective_id])).rows[0];
  check('and a timestamp is stored with it',
        row && Object.keys(row.marked_at).length === 1,
        JSON.stringify(row && row.marked_at));

  // Clearing must remove the time as well, or an un-ticked then re-ticked
  // slot would keep its first claim about when the work was recorded.
  r = await call('POST', '/api/objectives/tick-task', token,
    { task_id: task.objective_id, period: period, slot: 0, mark: '.' });
  row = (await db.query(
    'SELECT marks, marked_at FROM obj_log WHERE ref_id = $1',
    [task.objective_id])).rows[0];
  check('clearing a slot removes its timestamp too',
        row && Object.keys(row.marked_at).length === 0,
        JSON.stringify(row && row.marked_at));

  /*
    AN ASSERTION THAT CANNOT FAIL IS NOT AN ASSERTION. The first version of
    this check read

        check('the timeline kept the state before the clear',
              row === undefined || true);

    which is true whatever the code does. It passed from the moment it was
    written and would have gone on passing if the timeline were dropped
    entirely.

    What it should ask: the newest entry records the row as it was BEFORE
    this write - so after ticking slot 0 and then clearing it, the top of
    the timeline must still say the slot was ticked.
  */
  const hist = (await db.query(
    'SELECT history FROM obj_log WHERE ref_id = $1', [task.objective_id])).rows[0];
  check('the timeline has entries', hist && hist.history.length > 0,
        'entries=' + (hist && hist.history.length));
  check('the newest entry is the state BEFORE the clear',
        hist && hist.history[0] && String(hist.history[0].marks).charAt(0) === 'Y',
        'newest marks=' + (hist && hist.history[0] && hist.history[0].marks));
  check('and the row itself shows the clear',
        row && row.marks.charAt(0) !== 'Y', 'row marks=' + (row && row.marks));

  // ---- the race ---------------------------------------------------------
  console.log('');
  console.log('EVERY SLOT TICKED AT ONCE - THE RACE THAT LOSES MARKS');
  console.log('-----------------------------------------------------------');

  // However many squares the month really holds, up to eight - enough to
  // race, few enough to stay readable.
  const racers = Math.min(slots, 8);
  const want = 'Y'.repeat(racers);

  if (racers < 2) {
    console.log('    every objective is monthly this period - one slot each,');
    console.log('    so there is nothing to race. Skipped.');
    check('a race needs more than one slot', true);
  } else {
    let allRuns = true;
    for (let run = 1; run <= 5; run++) {
      await clean();
      // Nothing awaited between them: this is the page sending presses
      // without waiting, which is what Objective.gs's lock exists for.
      const fire = [];
      for (let s = 0; s < racers; s++) fire.push(s);
      await Promise.all(fire.map(function (s) {
        return call('POST', '/api/objectives/tick-task', token,
          { task_id: task.objective_id, period: period, slot: s, mark: 'Y' });
      }));

      const got = (await db.query(
        'SELECT marks, marked_at FROM obj_log WHERE ref_id = $1',
        [task.objective_id])).rows;

      const marks = got.length ? got[0].marks.slice(0, racers) : '(no row)';
      const stamps = got.length ? Object.keys(got[0].marked_at).length : 0;
      const ok = got.length === 1 && marks === want && stamps === racers;
      if (!ok) allRuns = false;
      console.log('    run ' + run + ': marks=' + marks + '  timestamps=' +
                  stamps + '/' + racers + '  rows=' + got.length +
                  (ok ? '' : '   <- TICKS LOST'));
    }
    check('five runs of ' + racers + ' concurrent ticks, none lost', allRuns);
  }

  await clean();
  await db.end();

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n');
  process.exit(1);
});
