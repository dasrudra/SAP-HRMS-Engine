/**
 * kpi-read-test.js - scoring real tickets into KPI 1 figures.
 * ===========================================================================
 *
 *     terminal 3:   npm start
 *     terminal 2:   node kpi-read-test.js
 *
 * No password needed - it signs its own token.
 *
 * WHAT THIS COVERS THAT kpi-equivalence-test.js DOES NOT. That one proves
 * the arithmetic matches Kpi.gs, over sixteen thousand inputs, and says
 * nothing about which rows are fed to it. This covers exactly that: the
 * month scoping, which population is scored, how sections are attributed
 * and when, and the summing across months.
 *
 * EVERY TICKET IT WRITES STARTS 'TEST-K-', and every person it invents is
 * in the reserved 2099xxxx block. It sweeps at both ends.
 */

require('dotenv').config();

const http = require('http');
const { Client } = require('pg');
const auth = require('./auth');
const kpi = require('./kpi');

const PORT = Number(process.env.PORT || 3000);
const RUN = String(Math.floor(Math.random() * 90) + 10);

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '   ' + detail : '')); }
}

function call(path, token) {
  return new Promise(function (resolve, reject) {
    const req = http.request(
      { host: 'localhost', port: PORT, path: path, method: 'GET',
        headers: token ? { Authorization: 'Bearer ' + token } : {} },
      function (res) {
        let buf = '';
        res.on('data', function (c) { buf += c; });
        res.on('end', function () {
          let p = {};
          try { p = JSON.parse(buf || '{}'); } catch (e) { p = { raw: buf }; }
          resolve({ code: res.statusCode, body: p });
        });
      });
    req.on('error', reject);
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

  const ADMIN = '2099' + RUN + '01';
  const P1 = 'Test Alpha ' + RUN;        // invented, not on the real chart
  const P2 = 'Test Beta ' + RUN;

  async function wipe() {
    await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
    await db.query("DELETE FROM roster WHERE display_name LIKE 'Test %'");
    await db.query("DELETE FROM account WHERE employee_id = $1", [ADMIN]);
    await db.query("DELETE FROM team WHERE employee_id = $1", [ADMIN]);
  }
  await wipe();

  // The real roster must be loaded for the rest of the system; these two go
  // beside it and are removed afterwards.
  await db.query(
    `INSERT INTO roster (person_key, display_name, section, is_former) VALUES
       ($1,$2,'Manufacturing Applications',false),
       ($3,$4,'Sales Applications',false)`,
    [P1.toLowerCase().replace(/[^a-z]/g, ''), P1,
     P2.toLowerCase().replace(/[^a-z]/g, ''), P2]);

  await db.query('INSERT INTO team (employee_id, full_name) VALUES ($1,$2)',
                 [ADMIN, 'KPI Test Admin']);
  await db.query(
    `INSERT INTO account (employee_id, password_hash, role, must_change)
     VALUES ($1,'scrypt$65536$8$1$00$00','ADMIN',false)`, [ADMIN]);
  const token = auth.signToken(ADMIN, 'ADMIN');

  let n = 0;
  async function ticket(month, who, opts) {
    const o = opts || {};
    n++;
    await db.query(
      `INSERT INTO ticket (ticket_id, in_charge, service, part, department,
                           request_date, completion_date, delay_days,
                           in_dept, in_overall, last_updated)
       VALUES ($1,$2,$3,$4,$5, ($6 || '-05 09:00+06')::timestamptz, $7,$8,$9,$10, now())`,
      ['TEST-K-' + n, who, o.service || 'SAP', o.part || 'MM',
       o.department || 'Claimed Dept', month,
       o.open ? null : (month + '-06 17:00+06'),
       o.delay === undefined ? 0 : o.delay,
       o.inDept === undefined ? true : o.inDept,
       o.inOverall === undefined ? true : o.inOverall]);
  }

  console.log('');

  // =======================================================================
  console.log('  Scoring one month');
  // =======================================================================
  // 10 completed, 2 of them late, 1 still open.
  for (let i = 0; i < 8; i++) await ticket('2026-09', P1);
  for (let i = 0; i < 2; i++) await ticket('2026-09', P1, { delay: 3 });
  await ticket('2026-09', P1, { open: true });

  let r = await call('/api/kpi1?month=2026-09', token);
  let t = r.body.total;
  check('the endpoint answers', r.code === 200 && r.body.ok === true);
  check('received counts everything', t.received === 11, String(t.received));
  check('completed counts only what has a completion date',
        t.completed === 10, String(t.completed));
  check('open is received minus completed, derived not stored',
        t.open === 1, String(t.open));
  check('delayed counts Delay Days above zero', t.delayed === 2, String(t.delayed));
  check('successful is completed minus delayed',
        t.successful === 8, String(t.successful));
  check('the rate divides by COMPLETED, not received',
        t.rate === 80, String(t.rate) + ' - 8/10, not 8/11');
  check('achievement is rate over target',
        t.achievement === kpi.round2((80 / 90) * 100), String(t.achievement));
  check('80% is RED against a 90 target and an 85 floor',
        t.band === 'RED', t.band);

  /*
    HEADROOM IS THE NUMBER THE DASHBOARD LEADS WITH. Green needs
    ceil(0.9 x 10) = 9 successful; there are 8, so it is one short.
  */
  check('headroom says how far from green, as a signed count',
        t.headroom === -1, String(t.headroom));

  // =======================================================================
  console.log('');
  console.log('  The same tickets, the other standard');
  // =======================================================================
  r = await call('/api/kpi1?month=2026-09&standard=EAS', token);
  check('the rate is unchanged - it is a fact, not a judgement',
        r.body.total.rate === 80, String(r.body.total.rate));
  check('but the target is the internal one',
        r.body.target === 99.5 && r.body.standard === 'EAS',
        r.body.target + ' ' + r.body.standard);
  check('and achievement is scored against it',
        r.body.total.achievement === kpi.round2((80 / 99.5) * 100),
        String(r.body.total.achievement));
  check('an unknown standard falls back to the company one',
        (await call('/api/kpi1?month=2026-09&standard=BANANA', token))
          .body.target === 90);

  // =======================================================================
  console.log('');
  console.log('  AN ALL-MONTHS FIGURE IS NOT AN AVERAGE');
  // =======================================================================
  /*
    Kpi.gs: "January with 4 completed tickets and one delay scores 75%;
    August with 2,640 and 11 scores 99.58%. Their mean is 87.29%, which
    describes nothing that happened."

    So the two months here are deliberately lopsided. With months of
    similar size, summing and averaging differ by hundredths and a test
    could pass either way; with 4 against 400 they differ by ten points,
    and only one of the two answers is defensible.
  */
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  for (let i = 0; i < 3; i++) await ticket('2026-01', P1);
  await ticket('2026-01', P1, { delay: 2 });              // 4 done, 1 late
  for (let i = 0; i < 396; i++) await ticket('2026-02', P1);
  for (let i = 0; i < 4; i++) await ticket('2026-02', P1, { delay: 1 });

  const jan = (await call('/api/kpi1?month=2026-01', token)).body.total;
  const feb = (await call('/api/kpi1?month=2026-02', token)).body.total;
  const all = (await call('/api/kpi1?month=2026-01,2026-02', token)).body.total;

  check('the small month scores 75%', jan.rate === 75, String(jan.rate));
  check('the large month scores 99%', feb.rate === 99, String(feb.rate));

  const summed = kpi.round2(((jan.successful + feb.successful) /
                             (jan.completed + feb.completed)) * 100);
  const averaged = kpi.round2((jan.rate + feb.rate) / 2);
  check('the two months together are the SUM of the counts',
        all.rate === summed, all.rate + ' vs ' + summed);
  check('and NOT the mean of the two rates',
        all.rate !== averaged,
        'summing gives ' + summed + ', averaging would give ' + averaged);
  check('the counts add up too',
        all.completed === jan.completed + feb.completed &&
        all.received === jan.received + feb.received);

  // =======================================================================
  console.log('');
  console.log('  Which months a scope covers');
  // =======================================================================
  check('one month covers one', (await call('/api/kpi1?month=2026-01', token))
          .body.monthsCovered === 1);
  check('a list covers both', (await call('/api/kpi1?month=2026-01,2026-02', token))
          .body.monthsCovered === 2);
  check('a quarter covers the months in it that have tickets',
        (await call('/api/kpi1?month=2026-Q1', token)).body.monthsCovered === 2);
  check('ALL covers everything there is',
        (await call('/api/kpi1?month=ALL', token)).body.monthsCovered >= 2);
  check('a month with no tickets has no data, and does not throw',
        (await call('/api/kpi1?month=2019-05', token)).body.hasData === false);

  // =======================================================================
  console.log('');
  console.log('  Which population gets scored');
  // =======================================================================
  /*
    "The four department exports are the accurate scope. The overall
    Service/Part report is wider - it also contains work by engineers who
    belong to no EAS department - so scoring EAS on it credits the
    department with work it did not do."
  */
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  for (let i = 0; i < 5; i++) await ticket('2026-05', P1, { inDept: true });
  for (let i = 0; i < 3; i++) {
    await ticket('2026-05', P2, { inDept: false, inOverall: true });
  }

  r = await call('/api/kpi1?month=2026-05', token);
  check('with department files present, only those are scored',
        r.body.total.received === 5, String(r.body.total.received));
  check('and the basis says so, with both counts',
        r.body.basis.source === 'DEPARTMENT' && r.body.basis.scored === 5 &&
        r.body.basis.total === 8, JSON.stringify(r.body.basis));

  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  for (let i = 0; i < 4; i++) {
    await ticket('2026-06', P1, { inDept: false, inOverall: true });
  }
  r = await call('/api/kpi1?month=2026-06', token);
  check('with no department file, the whole set is scored instead',
        r.body.total.received === 4 && r.body.basis.source === 'OVERALL',
        JSON.stringify(r.body.basis));
  check('and there is no section breakdown, because that would not be EAS',
        r.body.departments.length === 0,
        String(r.body.departments.length));

  /*
    A MIXED RANGE IS REPORTED AS OVERALL. "That direction is the safe one:
    it warns that some month in the range counted people outside EAS."
  */
  for (let i = 0; i < 4; i++) await ticket('2026-07', P1, { inDept: true });
  r = await call('/api/kpi1?month=2026-06,2026-07', token);
  check('a mixed range is reported as OVERALL, the safe direction',
        r.body.basis.source === 'OVERALL', r.body.basis.source);

  // =======================================================================
  console.log('');
  console.log('  Attribution');
  // =======================================================================
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  await ticket('2026-09', P1, { department: 'A Claimed Department' });
  await ticket('2026-09', P2, { department: 'Another Claim' });

  r = await call('/api/kpi1?month=2026-09', token);
  const names = r.body.departments.map(function (d) { return d.name; }).sort();
  check('THE ROSTER DECIDES THE SECTION, NOT THE DEPARTMENT COLUMN',
        names.join(',') === 'Manufacturing Applications,Sales Applications',
        names.join(','));

  /*
    SECTIONS CHANGED SHAPE IN AUGUST 2026. Before that there were two, so
    the same two people are reported under the names in force then.
  */
  await ticket('2026-07', P1);
  await ticket('2026-07', P2);
  r = await call('/api/kpi1?month=2026-07', token);
  check('a month before the split uses the sections of the time',
        r.body.departments.length === 1 &&
        r.body.departments[0].name === 'Functional Applications',
        JSON.stringify(r.body.departments.map(function (d) { return d.name; })));

  r = await call('/api/kpi1?month=2026-07,2026-09', token);
  check('a range spanning the split shows both eras, not a merge',
        r.body.departments.length === 3,
        JSON.stringify(r.body.departments.map(function (d) { return d.name; })));

  /*
    A PERSON IS ONE ROW even across the split, because "the individual is
    the unit of that table". Their section is the last one seen.
  */
  const people = r.body.people.filter(function (p) {
    return p.name === P1 || p.name === P2;
  });
  check('but a person is ONE row across the whole range',
        people.length === 2, JSON.stringify(people.map(function (p) {
          return p.name + '=' + p.received; })));
  check('with their totals summed, not split in two',
        people.every(function (p) { return p.received === 2; }),
        JSON.stringify(people.map(function (p) { return p.received; })));
  check('and labelled with the section they are in now',
        people.filter(function (p) { return p.name === P1; })[0].department ===
        'Manufacturing Applications',
        people.filter(function (p) { return p.name === P1; })[0].department);

  // =======================================================================
  console.log('');
  console.log('  Service / Part, and the source counts');
  // =======================================================================
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  await ticket('2026-10', P1, { service: 'SAP', part: 'MM' });
  await ticket('2026-10', P1, { service: 'SAP', part: 'MM' });
  await ticket('2026-10', P1, { service: 'e-Accounting', part: 'MM' });

  r = await call('/api/kpi1?month=2026-10', token);
  check('PART IS SCOPED TO SERVICE, so one Part name under two services ' +
        'is two rows',
        r.body.parts.length === 2,
        JSON.stringify(r.body.parts.map(function (p) { return p.name; })));
  check('and the busiest comes first',
        r.body.parts[0].received === 2, String(r.body.parts[0].received));

  /*
    BUSIEST FIRST HAS TO BE CHECKED ACROSS MONTHS, not within one.

    groupByKey already returns the biggest bucket first, so for a single
    month the final sort changes nothing and deleting it is invisible - it
    survived a deliberate break until this case existed. What it is
    actually for is a range: "a name's rank in January says nothing about
    its rank overall."

    Here A is the busier Part in October and B is far busier over the two
    months together. Without the final sort the October order survives and
    A comes first, which is the wrong answer to the question the table
    asks.
  */
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  for (let i = 0; i < 5; i++) await ticket('2026-10', P1, { part: 'AAA' });
  for (let i = 0; i < 3; i++) await ticket('2026-10', P2, { part: 'BBB' });
  for (let i = 0; i < 10; i++) await ticket('2026-11', P2, { part: 'BBB' });

  r = await call('/api/kpi1?month=2026-10,2026-11', token);
  check('ACROSS MONTHS, the busiest Part overall comes first',
        r.body.parts[0].name === 'SAP / BBB' && r.body.parts[0].received === 13,
        JSON.stringify(r.body.parts.map(function (p) {
          return p.name + '=' + p.received; })));
  check('and the busiest person overall, not the busiest in month one',
        r.body.people[0].name === P2 && r.body.people[0].received === 13,
        JSON.stringify(r.body.people.map(function (p) {
          return p.name + '=' + p.received; })));
  check('and the busiest section overall, for the same reason',
        r.body.departments[0].name === 'Sales Applications' &&
        r.body.departments[0].received === 13,
        JSON.stringify(r.body.departments.map(function (d) {
          return d.name + '=' + d.received; })));

  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  await ticket('2026-10', P1, { service: 'SAP', part: 'MM' });
  await ticket('2026-10', P1, { service: 'SAP', part: 'MM' });
  await ticket('2026-10', P1, { service: 'e-Accounting', part: 'MM' });
  await ticket('2026-10', P1, { inDept: true,  inOverall: false });
  await ticket('2026-10', P1, { inDept: false, inOverall: true });
  r = await call('/api/kpi1?month=2026-10', token);
  const src = {};
  r.body.sources.forEach(function (s) { src[s.name] = s.count; });
  check('the source counts say which reports each ticket came from',
        src['In both reports'] === 3 && src['Department only'] === 1 &&
        src['Overall report only'] === 1, JSON.stringify(src));

  // =======================================================================
  console.log('');
  console.log('  Permission');
  // =======================================================================
  check('the figures need a sign-in',
        (await call('/api/kpi1?month=ALL', null)).code === 401);

  // =======================================================================
  await wipe();
  await db.end();

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});
