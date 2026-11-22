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
 *
 * AND IT WRITES THEM INTO MONTHS NOTHING REAL CAN REACH, which is the part
 * I got wrong first time.
 *
 * The test deleted its own tickets and then asked the endpoint for
 * 2026-09 - a month with 2,329 of Rudra's real tickets in it. Every figure
 * it checked was the real month plus its eleven fixtures, so on an empty
 * database all 42 checks passed and on the real one 28 failed. The failure
 * was in the test; the numbers it printed were correct.
 *
 * Deleting its rows is not enough, because the endpoint scores a MONTH and
 * cannot be asked for "only these tickets" - nor should it be able to be.
 * So the fixtures live in months no export will ever contain:
 *
 *     PRE  = 2019   before SECTION_ERA_START, so the pre-split sections
 *     POST = 2099   after it, and beyond any ticket anyone will file
 *
 * The era rule is a string comparison against '2026-08', so 2019 and 2099
 * exercise both sides of the August 2026 split exactly as 2026-07 and
 * 2026-09 did - without standing on a month that holds real work.
 *
 * The same idea as the reserved 2099xxxx employee IDs, applied to the
 * calendar: a test that shares a namespace with live data is a test whose
 * result depends on what somebody uploaded this morning.
 */

require('dotenv').config();

const http = require('http');
const { Client } = require('pg');
const auth = require('./auth');
const kpi = require('./kpi');

const PORT = Number(process.env.PORT || 3000);
const RUN = String(Math.floor(Math.random() * 90) + 10);

// Years no ITSM export will ever carry. See the note at the top.
const PRE = '2019';    // before SECTION_ERA_START '2026-08'
const POST = '2099';   // after it

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
      // `=== undefined`, not `||`: an explicitly empty Part is the whole
      // point of some of these fixtures, and `o.part || 'MM'` quietly
      // turned every one of them back into MM.
      ['TEST-K-' + n, who, o.service || 'SAP',
       o.part === undefined ? 'MM' : o.part,
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
  for (let i = 0; i < 8; i++) await ticket(POST + '-09', P1);
  for (let i = 0; i < 2; i++) await ticket(POST + '-09', P1, { delay: 3 });
  await ticket(POST + '-09', P1, { open: true });

  let r = await call('/api/kpi1?month=' + POST + '-09', token);
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
  r = await call('/api/kpi1?month=' + POST + '-09&standard=EAS', token);
  check('the rate is unchanged - it is a fact, not a judgement',
        r.body.total.rate === 80, String(r.body.total.rate));
  check('but the target is the internal one',
        r.body.target === 99.5 && r.body.standard === 'EAS',
        r.body.target + ' ' + r.body.standard);
  check('and achievement is scored against it',
        r.body.total.achievement === kpi.round2((80 / 99.5) * 100),
        String(r.body.total.achievement));
  check('an unknown standard falls back to the company one',
        (await call('/api/kpi1?month=' + POST + '-09&standard=BANANA', token))
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
  for (let i = 0; i < 3; i++) await ticket(POST + '-01', P1);
  await ticket(POST + '-01', P1, { delay: 2 });              // 4 done, 1 late
  for (let i = 0; i < 396; i++) await ticket(POST + '-02', P1);
  for (let i = 0; i < 4; i++) await ticket(POST + '-02', P1, { delay: 1 });

  const jan = (await call('/api/kpi1?month=' + POST + '-01', token)).body.total;
  const feb = (await call('/api/kpi1?month=' + POST + '-02', token)).body.total;
  const all = (await call('/api/kpi1?month=' + POST + '-01,' + POST + '-02', token)).body.total;

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
  check('one month covers one', (await call('/api/kpi1?month=' + POST + '-01', token))
          .body.monthsCovered === 1);
  check('a list covers both', (await call('/api/kpi1?month=' + POST + '-01,' + POST + '-02', token))
          .body.monthsCovered === 2);
  check('a quarter covers the months in it that have tickets',
        (await call('/api/kpi1?month=' + POST + '-Q1', token)).body.monthsCovered === 2);
  check('ALL covers everything there is',
        (await call('/api/kpi1?month=ALL', token)).body.monthsCovered >= 2);
  check('a month with no tickets has no data, and does not throw',
        (await call('/api/kpi1?month=2098-05', token)).body.hasData === false);

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
  for (let i = 0; i < 5; i++) await ticket(POST + '-05', P1, { inDept: true });
  for (let i = 0; i < 3; i++) {
    await ticket(POST + '-05', P2, { inDept: false, inOverall: true });
  }

  r = await call('/api/kpi1?month=' + POST + '-05', token);
  check('with department files present, only those are scored',
        r.body.total.received === 5, String(r.body.total.received));
  check('and the basis says so, with both counts',
        r.body.basis.source === 'DEPARTMENT' && r.body.basis.scored === 5 &&
        r.body.basis.total === 8, JSON.stringify(r.body.basis));

  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  for (let i = 0; i < 4; i++) {
    await ticket(POST + '-06', P1, { inDept: false, inOverall: true });
  }
  r = await call('/api/kpi1?month=' + POST + '-06', token);
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
  for (let i = 0; i < 4; i++) await ticket(PRE + '-07', P1, { inDept: true });
  r = await call('/api/kpi1?month=' + POST + '-06,' + PRE + '-07', token);
  check('a mixed range is reported as OVERALL, the safe direction',
        r.body.basis.source === 'OVERALL', r.body.basis.source);

  // =======================================================================
  console.log('');
  console.log('  Attribution');
  // =======================================================================
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  await ticket(POST + '-09', P1, { department: 'A Claimed Department' });
  await ticket(POST + '-09', P2, { department: 'Another Claim' });

  r = await call('/api/kpi1?month=' + POST + '-09', token);
  const names = r.body.departments.map(function (d) { return d.name; }).sort();
  check('THE ROSTER DECIDES THE SECTION, NOT THE DEPARTMENT COLUMN',
        names.join(',') === 'Manufacturing Applications,Sales Applications',
        names.join(','));

  /*
    SECTIONS CHANGED SHAPE IN AUGUST 2026. Before that there were two, so
    the same two people are reported under the names in force then.
  */
  await ticket(PRE + '-07', P1);
  await ticket(PRE + '-07', P2);
  r = await call('/api/kpi1?month=' + PRE + '-07', token);
  check('a month before the split uses the sections of the time',
        r.body.departments.length === 1 &&
        r.body.departments[0].name === 'Functional Applications',
        JSON.stringify(r.body.departments.map(function (d) { return d.name; })));

  r = await call('/api/kpi1?month=' + PRE + '-07,' + POST + '-09', token);
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
  await ticket(POST + '-10', P1, { service: 'SAP', part: 'MM' });
  await ticket(POST + '-10', P1, { service: 'SAP', part: 'MM' });
  await ticket(POST + '-10', P1, { service: 'e-Accounting', part: 'MM' });

  r = await call('/api/kpi1?month=' + POST + '-10', token);
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
  for (let i = 0; i < 5; i++) await ticket(POST + '-10', P1, { part: 'AAA' });
  for (let i = 0; i < 3; i++) await ticket(POST + '-10', P2, { part: 'BBB' });
  for (let i = 0; i < 10; i++) await ticket(POST + '-11', P2, { part: 'BBB' });

  r = await call('/api/kpi1?month=' + POST + '-10,' + POST + '-11', token);
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
  await ticket(POST + '-10', P1, { service: 'SAP', part: 'MM' });
  await ticket(POST + '-10', P1, { service: 'SAP', part: 'MM' });
  await ticket(POST + '-10', P1, { service: 'e-Accounting', part: 'MM' });
  await ticket(POST + '-10', P1, { inDept: true,  inOverall: false });
  await ticket(POST + '-10', P1, { inDept: false, inOverall: true });
  r = await call('/api/kpi1?month=' + POST + '-10', token);
  const src = {};
  r.body.sources.forEach(function (s) { src[s.name] = s.count; });
  check('the source counts say which reports each ticket came from',
        src['In both reports'] === 3 && src['Department only'] === 1 &&
        src['Overall report only'] === 1, JSON.stringify(src));

  // =======================================================================
  console.log('');
  console.log('  The module breakdown');
  // =======================================================================
  /*
    THREE SOURCES IN ORDER: the Part column when it names a module, then
    the person who handled it, then '(unassigned)' so it is visible.

    P1 is in Manufacturing, whose usual module is PP; P2 is in Sales,
    whose usual module is SD. Neither has a module of their own, so their
    tickets fall through to those.
  */
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  await ticket(POST + '-04', P1, { part: 'MM' });          // Part says MM
  await ticket(POST + '-04', P1, { part: 'Monitoring' });  // not a module -> PP
  await ticket(POST + '-04', P2, { part: '' });            // nothing -> SD
  await ticket(POST + '-04', 'Nobody At All', { part: 'Others' });

  r = await call('/api/kpi1?month=' + POST + '-04', token);
  const mods = {};
  r.body.modules.forEach(function (x) { mods[x.name] = x.received; });

  check('the Part column names the module when it can',
        mods.MM === 1, JSON.stringify(mods));
  check('a Part that is not a module falls through to the person',
        mods.PP === 1, JSON.stringify(mods));
  check('and so does an empty Part',
        mods.SD === 1, JSON.stringify(mods));
  check('somebody off the chart with an unusable Part is VISIBLE, not guessed',
        mods['(unassigned)'] === 1, JSON.stringify(mods));
  check('every scored ticket lands in exactly one module',
        Object.keys(mods).reduce(function (n, k) { return n + mods[k]; }, 0) === 4,
        JSON.stringify(mods));

  /*
    'Accounting' CONTAINS 'co', and CO is a module. The word boundary in
    the pattern is the only thing stopping every Accounting ticket being
    filed under CO.
  */
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  await ticket(POST + '-04', P1, { part: 'Accounting' });
  r = await call('/api/kpi1?month=' + POST + '-04', token);
  check('a Part containing "co" inside a word is NOT filed under CO',
        r.body.modules.length === 1 && r.body.modules[0].name === 'PP',
        JSON.stringify(r.body.modules.map(function (x) { return x.name; })));

  /*
    AND BUSIEST FIRST ACROSS MONTHS, which the single-month cases above
    cannot see: groupByKey already returns the biggest bucket first within
    a month, so the final sort only shows when two months disagree. SD
    leads in the first month and MM is far bigger over the two.
  */
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  for (let i = 0; i < 5; i++) await ticket(POST + '-04', P1, { part: 'SD' });
  for (let i = 0; i < 3; i++) await ticket(POST + '-04', P1, { part: 'MM' });
  for (let i = 0; i < 9; i++) await ticket(POST + '-05', P1, { part: 'MM' });

  r = await call('/api/kpi1?month=' + POST + '-04,' + POST + '-05', token);
  check('ACROSS MONTHS, the busiest module overall comes first',
        r.body.modules[0].name === 'MM' && r.body.modules[0].received === 12,
        JSON.stringify(r.body.modules.map(function (x) {
          return x.name + '=' + x.received; })));

  // =======================================================================
  console.log('');
  console.log('  Comparing months');
  // =======================================================================
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  // Two months, two sections, one of them late in the second month only.
  for (let i = 0; i < 4; i++) await ticket(POST + '-01', P1);
  for (let i = 0; i < 2; i++) await ticket(POST + '-01', P2);
  for (let i = 0; i < 3; i++) await ticket(POST + '-02', P1);
  await ticket(POST + '-02', P1, { delay: 2 });
  for (let i = 0; i < 2; i++) await ticket(POST + '-02', P2);

  r = await call('/api/kpi1/compare?months=' + POST + '-01,' + POST + '-02',
                 token);
  check('the comparison answers', r.code === 200 && r.body.ok === true);
  check('with the periods asked for, in order',
        JSON.stringify(r.body.periods) ===
        JSON.stringify([POST + '-01', POST + '-02']),
        JSON.stringify(r.body.periods));
  check('a total per period', Boolean(r.body.totals[POST + '-01']) &&
        Boolean(r.body.totals[POST + '-02']));
  check('the first month is clean', r.body.totals[POST + '-01'].rate === 100,
        String(r.body.totals[POST + '-01'].rate));
  check('and the second carries its one delay',
        r.body.totals[POST + '-02'].delayed === 1 &&
        r.body.totals[POST + '-02'].completed === 6,
        JSON.stringify(r.body.totals[POST + '-02']));

  check('sections are listed alphabetically, not busiest first',
        JSON.stringify(r.body.sections) ===
        JSON.stringify(['Manufacturing Applications', 'Sales Applications']),
        JSON.stringify(r.body.sections));
  check('each section has a cell per period it had tickets in',
        Object.keys(r.body.bySection['Manufacturing Applications']).length === 2);

  /*
    THE SCREEN RENDERS WHAT THE KPI DECLARES, so that the same table can
    draw KPI 2 without a second implementation. A KPI also names its own
    reporting period - KPI 1 is monthly, KPI 2 quarterly - and taking that
    from here is what stops one of them being mislabelled.
  */
  check('the KPI describes its own columns and period',
        r.body.kpi === 'KPI1' && r.body.periodKind === 'MONTH' &&
        r.body.measures.length === 5 && r.body.volumeKey === 'completed',
        JSON.stringify({ kpi: r.body.kpi, period: r.body.periodKind }));

  /*
    THE TWO SCREENS MUST AGREE. Reading stored verdicts back was a live
    defect: the same section, the same month and the same rate came out
    YELLOW on one screen and GREEN on the other, because one recomputed
    against the current target and the other did not.
  */
  const one = (await call('/api/kpi1?month=' + POST + '-02', token)).body;
  const cmp = r.body.totals[POST + '-02'];
  check('AND AGREE WITH /api/kpi1 FOR THE SAME MONTH, to the band',
        cmp.rate === one.total.rate && cmp.band === one.total.band &&
        cmp.achievement === one.total.achievement &&
        cmp.headroom === one.total.headroom,
        JSON.stringify({ compare: cmp.rate + ' ' + cmp.band,
                         kpi1: one.total.rate + ' ' + one.total.band }));

  const eas = await call('/api/kpi1/compare?months=' + POST + '-02&standard=EAS',
                         token);
  const easOne = (await call('/api/kpi1?month=' + POST + '-02&standard=EAS',
                             token)).body;
  check('and under the other standard too, which is where they drifted before',
        eas.body.totals[POST + '-02'].band === easOne.total.band &&
        eas.body.target === easOne.target,
        eas.body.totals[POST + '-02'].band + ' vs ' + easOne.total.band);

  /*
    THE SAME BASIS RULE AS /api/kpi1, AND IT NEEDS ITS OWN FIXTURE HERE.
    Every month above has a department file, so `usingDept` is always true
    and neither branch can be seen - two deliberate breaks survived until
    these two months existed.

    POST-06 has both kinds, so only the department rows must be scored.
    POST-07 has none, so it is scored whole AND gets no section row at all:
    a breakdown by section of a population that includes non-EAS engineers
    is not a breakdown of EAS.
  */
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K-%'");
  for (let i = 0; i < 3; i++) await ticket(POST + '-06', P1, { inDept: true });
  for (let i = 0; i < 2; i++) {
    await ticket(POST + '-06', P2, { inDept: false, inOverall: true });
  }
  for (let i = 0; i < 4; i++) {
    await ticket(POST + '-07', P2, { inDept: false, inOverall: true });
  }

  r = await call('/api/kpi1/compare?months=' + POST + '-06,' + POST + '-07',
                 token);
  check('a month with department files scores only those',
        r.body.totals[POST + '-06'].received === 3,
        String(r.body.totals[POST + '-06'].received) + ' of 5');
  check('a month without one is scored whole',
        r.body.totals[POST + '-07'].received === 4,
        String(r.body.totals[POST + '-07'].received));
  check('AND HAS NO SECTION ROW, because that would not be EAS',
        r.body.sections.every(function (s) {
          return !r.body.bySection[s][POST + '-07'];
        }),
        JSON.stringify(r.body.sections.map(function (s) {
          return s + ':' + Object.keys(r.body.bySection[s]).join('|'); })));
  check('while the month that does have one still gets its sections',
        r.body.sections.some(function (s) {
          return Boolean(r.body.bySection[s][POST + '-06']);
        }));

  check('no months asked for means an empty table, not an error',
        (await call('/api/kpi1/compare?months=', token)).body.periods.length === 0);
  check('a month with no tickets simply has no cell',
        Object.keys((await call('/api/kpi1/compare?months=2098-05', token))
          .body.totals).length === 0);
  check('the comparison needs a sign-in',
        (await call('/api/kpi1/compare?months=' + POST + '-01', null)).code === 401);

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
