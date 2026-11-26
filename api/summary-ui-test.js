/**
 * THE SUMMARY SCREEN, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node summary-ui-test.js
 *
 * Three cards, and each of them is checked for a different kind of lie.
 *
 *   The thresholds table   - that it prints the targets and bands the
 *                            server actually scored against, including
 *                            when the KPI 1 toggle is on the team's own
 *                            standard rather than the policy's.
 *   The Database card      - that the counts are the database's and not
 *                            the upload log's, and that a disagreement
 *                            between the two is marked rather than left
 *                            to be noticed.
 *   The Rebuild card       - that it explains where the button went, and
 *                            is still admin-only.
 *
 * NOTHING HERE ASSERTS A FIGURE THAT DEPENDS ON WHAT ELSE IS IN THE
 * DATABASE, and that rule has been learnt five times on this port. The
 * Database card prints counts over EVERY row in the schema, and the
 * Reading now column is over every month there is, so on the live machine
 * they are twenty-six thousand tickets and on this one they are sixty. So
 * every such check compares the SCREEN against the SERVER'S OWN ANSWER for
 * the same question, which holds whatever is stored - and the fixture is
 * built so that the four counts are all different, because a check that
 * two numbers agree proves nothing if every number is the same.
 *
 * Its fixture is 2099 and swept at both ends.
 */
require('dotenv').config();
const db = require('./db');
const { signToken } = require('./auth');
const browser = require('../tests/harness/browser');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PAGE = BASE + '/summary.html';

const MONTHS = ['2099-01', '2099-02'];
const FEEDBACK_MONTH = '2099-05';
const SECTIONS = ['MM', 'SD'];

const KPI1_FILTERS = 'easKpi1Filters';

let pass = 0;
let fail = 0;
const failures = [];
const notes = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++;
  const line = name + (detail === undefined ? '' : '   ' + detail);
  failures.push(line);
  console.log('  FAIL ' + line);
}

function note(line) {
  notes.push(line);
  console.log('  ..   ' + line);
}

function recap() {
  if (notes.length) {
    console.log('');
    console.log('  ' + notes.length + ' note' + (notes.length === 1 ? '' : 's') +
                ':');
    notes.forEach(function (line) { console.log('    - ' + line); });
  }
  if (!failures.length) return;
  console.log('');
  console.log('  ' + failures.length + ' failed:');
  failures.forEach(function (line) { console.log('    - ' + line); });
}


async function sweep() {
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-SUM-%'");
  await db.query("DELETE FROM training WHERE response_id LIKE 'TEST-SUM%'");
  await db.query("DELETE FROM upload_run WHERE upload_id LIKE 'UPL-TEST-SUM%'");
}


/**
 * Forty tickets over two months, scoring 70% and 80%.
 *
 * BOTH BELOW BOTH TARGETS ON PURPOSE. 90% is the policy's and 99.50% is
 * the team's, and a fixture that scored above either would leave the band
 * colouring untested on the only rows that have a reading at all. On the
 * live machine the overall figure is whatever it is - which is why no
 * check below asserts a band, only that the band shown agrees with the
 * figure shown.
 *
 * in_dept AND in_overall ARE TRUE ON EVERY ROW. They are SCOPE flags -
 * whether a ticket belongs in the department's figures and in the overall
 * ones - not success flags. Setting them false on the tickets meant to
 * fail does not fail them, it removes them from the scoring altogether.
 * delay_days is what decides success.
 */
async function seedTickets() {
  const goodPerMonth = { '2099-01': 7, '2099-02': 8 };
  let n = 0;
  for (const month of MONTHS) {
    for (const part of SECTIONS) {
      for (let i = 0; i < 10; i++) {
        n++;
        await db.query(
          `INSERT INTO ticket (ticket_id, in_charge, service, part, department,
                               affiliate, request_date, completion_date,
                               delay_days, in_dept, in_overall, last_updated)
           VALUES ($1, 'TEST-SUM', 'SAP', $2, $2, 'TEST-SUM-AFF',
                   ($3 || '-05 09:00+06')::timestamptz,
                   ($3 || '-06 17:00+06')::timestamptz, $4, true, true, now())`,
          ['TEST-SUM-' + n, part, month, i < goodPerMonth[month] ? 0 : 3]);
      }
    }
  }
  return n;
}


/**
 * Three training responses and one upload that owns their file.
 *
 * THREE, NOT FORTY, and not four either: the Database card prints four
 * counts and a row wired to the wrong field is only caught when no two of
 * them can be confused. Here the fixture adds 40 tickets, 3 responses, 1
 * ticket upload and 1 feedback upload - and the two uploads are told apart
 * by their report_types, which is the one pair that could still collide.
 */
async function seedFeedback() {
  const GOOD = ['Excellent', 'Relevant and useful', 'Excellent', 'Good',
                'Very helpful', 'Much more confident', 'Appropriate'];
  const POOR = ['Poor', 'Not relevant', 'Average', 'Average',
                'Not helpful', 'No change', 'Too short'];

  let n = 0;
  for (const answers of [GOOD, GOOD, POOR]) {
    n++;
    await db.query(
      `INSERT INTO training (response_id, month, session_date, module,
                             session_title, trainer, plant, employee_id,
                             employee_name, q1_overall, q2_relevance,
                             q3_knowledge, q4_explanation, q5_materials,
                             q6_confidence, q7_duration, source_file, zone,
                             uploaded_at)
       VALUES ($1, $2, ($2 || '-15 10:00+06')::timestamptz,
               'Inventory Management', 'TEST-SUM session', '', '', '', '',
               $3,$4,$5,$6,$7,$8,$9, 'TEST-SUM feedback.xlsx', 'KEPZ', now())`,
      ['TEST-SUM-r' + n, FEEDBACK_MONTH, answers[0], answers[1], answers[2],
       answers[3], answers[4], answers[5], answers[6]]);
  }

  await db.query(
    `INSERT INTO upload_run (upload_id, uploaded_by, file_names, report_types,
                             departments, rows_in_file, rows_added, notes)
     VALUES ('UPL-TEST-SUM-F', 'TEST-SUM', 'TEST-SUM feedback.xlsx',
             'FEEDBACK', 'MM', 3, 3, 'complete')`);
  /*
    TWO TICKET UPLOADS, NOT ONE, and that is the point of the number. The
    four counts the card prints have to be four DIFFERENT numbers or a row
    wired to the wrong field passes by coincidence - and with one upload of
    each kind the two "uploads logged" rows were interchangeable. 40, 3, 2
    and 1.
  */
  await db.query(
    `INSERT INTO upload_run (upload_id, uploaded_by, file_names, report_types,
                             departments, rows_in_file, rows_added, notes)
     VALUES ('UPL-TEST-SUM-T1', 'TEST-SUM', 'TEST-SUM tickets Jan.xlsx',
             'DEPARTMENT', 'MM', 20, 20, 'complete')`);
  await db.query(
    `INSERT INTO upload_run (upload_id, uploaded_by, file_names, report_types,
                             departments, rows_in_file, rows_added, notes)
     VALUES ('UPL-TEST-SUM-T2', 'TEST-SUM', 'TEST-SUM tickets Feb.xlsx',
             'DEPARTMENT', 'SD', 20, 20, 'complete')`);
  return n;
}


async function open(p, role, standard) {
  await p.goto(PAGE);
  await p.evaluate(function (seed) {
    sessionStorage.setItem('easToken', seed.token);
    /*
      Start from a KNOWN standard rather than from whatever a previous run
      of kpi1-ui-test left behind. The screen reads the KPI 1 screen's own
      remembered toggle, which is the whole point of that wiring, and a
      suite that did not control it would pass or fail by accident.
    */
    try {
      if (seed.standard) {
        sessionStorage.setItem('easKpi1Filters',
          JSON.stringify({ fKpi1Standard: seed.standard }));
      } else {
        sessionStorage.removeItem('easKpi1Filters');
      }
    } catch (e) { /* fine */ }
  }, { token: signToken('20990' + (role === 'USER' ? '771' : '770'), role),
       standard: standard || '' });
  await p.goto(PAGE);
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  // The two readings arrive after the boot; the rows repaint when they do.
  await p.waitForFunction(function () {
    const row = document.querySelector('#settingsTable tbody tr[data-key="KPI1"]');
    return row && !/Loading/.test(row.textContent);
  }, null, { timeout: 20000 });
  await p.waitForTimeout(400);
}


/** The thresholds table as text, row by row, keyed by KPI. */
async function tableOf(p) {
  return p.evaluate(function () {
    const head = Array.prototype.slice.call(
      document.querySelectorAll('#settingsTable thead th'))
      .map(function (th) { return th.textContent.trim(); });

    const rows = {};
    const order = [];
    Array.prototype.slice.call(
      document.querySelectorAll('#settingsTable tbody tr'))
      .forEach(function (tr) {
        const key = tr.dataset.key;
        order.push(key);
        const cell = tr.querySelectorAll('td');
        rows[key] = {
          no: cell[0] ? cell[0].textContent.trim() : '',
          name: tr.querySelector('.thr-name')
            ? tr.querySelector('.thr-name').textContent.trim() : '',
          pills: Array.prototype.slice.call(tr.querySelectorAll('.pill'))
            .map(function (s) { return s.textContent.trim(); }),
          internalTitle: tr.querySelector('.pill.i')
            ? tr.querySelector('.pill.i').title : '',
          formula: tr.querySelector('.thr-formula')
            ? tr.querySelector('.thr-formula').textContent.trim() : '',
          target: tr.querySelector('.thr-target')
            ? tr.querySelector('.thr-target').textContent.trim() : '',
          chips: Array.prototype.slice.call(tr.querySelectorAll('.thr-chip'))
            .map(function (b) { return b.textContent.trim(); }),
          grows: Array.prototype.slice.call(tr.querySelectorAll('.thr-seg'))
            .map(function (s) { return Number(s.style.flexGrow); }),
          segTitles: Array.prototype.slice.call(tr.querySelectorAll('.thr-seg'))
            .map(function (s) { return s.title; }),
          layer: cell[4] ? cell[4].textContent.trim() : '',
          layerTitle: cell[4] ? cell[4].title : '',
          achievement: tr.querySelector('.thr-ach-val')
            ? tr.querySelector('.thr-ach-val').textContent.trim() : '',
          achievementColour: tr.querySelector('.thr-ach-val')
            ? tr.querySelector('.thr-ach-val').style.color : '',
          achievementNone: Boolean(tr.querySelector('.thr-ach-none')),
          reading: tr.querySelector('.thr-read')
            ? tr.querySelector('.thr-read').textContent.trim() : '',
          readingColour: tr.querySelector('.thr-read')
            ? tr.querySelector('.thr-read').style.color : '',
          readingIsNone: Boolean(tr.querySelector('.thr-read.is-none')),
          period: tr.querySelector('.thr-now small')
            ? tr.querySelector('.thr-now small').textContent.trim() : '',
          doc: tr.querySelector('.doc-btn')
            ? {
                tag: tr.querySelector('.doc-btn').tagName,
                text: tr.querySelector('.doc-btn').textContent.trim(),
                href: tr.querySelector('.doc-btn').getAttribute('href') || '',
                target: tr.querySelector('.doc-btn').getAttribute('target') || '',
                rel: tr.querySelector('.doc-btn').getAttribute('rel') || '',
                title: tr.querySelector('.doc-btn').title,
                off: tr.querySelector('.doc-btn').classList.contains('is-off'),
                folder: tr.querySelector('.doc-btn')
                  .classList.contains('is-folder')
              }
            : null
        };
      });
    return { head: head, order: order, rows: rows };
  });
}


/** The Database card as a plain name -> value map, in order. */
async function dbCard(p) {
  return p.evaluate(function () {
    const out = { order: [], value: {}, red: {} };
    const kids = Array.prototype.slice.call(
      document.getElementById('dbInfo').children);
    let label = '';
    kids.forEach(function (el) {
      if (el.tagName === 'DT') {
        label = el.textContent.trim();
        out.order.push(label);
      } else if (el.tagName === 'DD') {
        out.value[label] = el.textContent.trim();
        /*
          THE MARKED ROWS ARE THE ONES IN A COLOURED SPAN, and the colour is
          read off the inline style rather than computed. An inline
          `color: var(--red)` comes back from style.color as the literal
          `var(--red)` - it is not resolved there - so a first version of
          this looked for `rgb(` and found nothing on a row that was plainly
          red on screen, and reported the page as broken.
        */
        const span = el.querySelector('span');
        out.red[label] = Boolean(span && span.style.color);
      }
    });
    return out;
  });
}


/** What the server itself says, for the checks that must not hard-code. */
async function serverSays(role, standard) {
  const token = signToken('20990' + (role === 'USER' ? '771' : '770'), role);
  const headers = { Authorization: 'Bearer ' + token };
  const [boot, one, two] = await Promise.all([
    fetch(BASE + '/api/summary/boot', { headers }).then(function (r) {
      return r.json();
    }),
    fetch(BASE + '/api/kpi1?month=ALL&standard=' + (standard || 'COMPANY'),
          { headers }).then(function (r) { return r.json(); }),
    fetch(BASE + '/api/kpi2?scope=ALL', { headers })
      .then(function (r) { return r.json(); })
  ]);
  return { boot: boot, kpi1: one, kpi2: two };
}


function fmt(n) {
  return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
}


async function main() {
  if (!browser.ready) {
    console.log('');
    console.log('  SKIPPED - no browser to drive.');
    console.log('  ' + browser.skipReason());
    console.log('');
    process.exit(0);
  }

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
  const ticketsSeeded = await seedTickets();
  const responsesSeeded = await seedFeedback();

  const b = await browser.launch();
  const context = await b.newContext();
  const p = await context.newPage();

  const thrown = [];
  const badRequests = [];
  p.on('pageerror', function (e) { thrown.push(String(e.message || e)); });
  p.on('console', function (m) {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      thrown.push(m.text());
    }
  });
  p.on('response', function (r) {
    if (r.status() >= 400) badRequests.push(r.status() + ' ' + r.url());
  });
  p.on('requestfailed', function (r) {
    const why = (r.failure() || {}).errorText || '';
    if (/ERR_ABORTED/.test(why)) return;
    badRequests.push('could not be reached: ' + r.url() + ' (' + why + ')');
  });

  await open(p, 'ADMIN', 'COMPANY');
  let says = await serverSays('ADMIN', 'COMPANY');
  let t = await tableOf(p);

  console.log('');
  console.log('  Fixture: ' + ticketsSeeded + ' tickets, ' + responsesSeeded +
              ' responses. The database holds ' +
              says.boot.stats.tickets + ' tickets and ' +
              says.boot.stats.feedback + ' responses in all, which is what ' +
              'the card must print.');


  // =======================================================================
  console.log('');
  console.log('  The screen opens, in the shell');
  // =======================================================================
  check('Summary is served at summary.html',
        /\/summary\.html$/.test(p.url().split('?')[0]), p.url());
  check('the sidebar has it lit, under its old internal name',
        await p.evaluate(function () {
          const lit = document.querySelector('.nav-item.is-active');
          return lit && lit.getAttribute('data-view') === 'settings';
        }));
  check('AND THE TOP BAR CALLS IT SUMMARY, not Settings',
        (await p.textContent('#viewLabel')) === 'Summary',
        await p.textContent('#viewLabel'));
  check('the heading and the sentence under it are the original\'s',
        /^Summary$/.test((await p.textContent('#view-settings h1')).trim()) &&
        /every indicator's target, bands and achievement/i
          .test(await p.textContent('.page-head .sub')),
        await p.textContent('.page-head .sub'));
  check('the signed-in line names the person, not their role',
        (await p.textContent('#operatorName')) === '20990770',
        await p.textContent('#operatorName'));


  // =======================================================================
  console.log('');
  console.log('  The thresholds table');
  // =======================================================================
  check('the eight columns are the original\'s, in the original\'s order',
        JSON.stringify(t.head) === JSON.stringify(
          ['#', 'Indicator', 'Target', 'Performance bands', 'SLA layer',
           'KPI Achievement', 'Reading now', 'Definition']),
        JSON.stringify(t.head));
  check('ALL FOUR INDICATORS ARE LISTED, in the policy\'s order - a ' +
        'selector that omits KPI 3 and KPI 4 says they do not exist',
        JSON.stringify(t.order) ===
        JSON.stringify(['KPI1', 'KPI2', 'KPI3', 'KPI4']),
        JSON.stringify(t.order));
  check('the badge is the KPI number alone',
        t.rows.KPI1.no === '1' && t.rows.KPI2.no === '2' &&
        t.rows.KPI3.no === '3' && t.rows.KPI4.no === '4',
        JSON.stringify(['KPI1', 'KPI2', 'KPI3', 'KPI4']
          .map(function (k) { return t.rows[k].no; })));

  const names = says.boot.kpiList.map(function (k) { return k.name; });
  check('every name is the server\'s own, not retyped on the screen',
        names.every(function (name, i) {
          return t.rows[t.order[i]].name.indexOf(name) === 0;
        }),
        JSON.stringify(t.order.map(function (k) { return t.rows[k].name; })));
  check('and so is every formula',
        says.boot.kpiList.every(function (k, i) {
          return t.rows[t.order[i]].formula === k.formula;
        }),
        JSON.stringify(t.order.map(function (k) {
          return t.rows[k].formula; })));

  check('the two with a pipeline say LIVE and the two without say PENDING',
        t.rows.KPI1.pills.indexOf('LIVE') !== -1 &&
        t.rows.KPI2.pills.indexOf('LIVE') !== -1 &&
        t.rows.KPI3.pills.indexOf('PENDING') !== -1 &&
        t.rows.KPI4.pills.indexOf('PENDING') !== -1,
        JSON.stringify(t.order.map(function (k) { return t.rows[k].pills; })));

  /*
    THE ONE MARK ON THIS SCREEN THAT IS ABOUT STANDING RATHER THAN NUMBERS.
    Three of these are the approved policy's; KPI 2 is the team's own. An
    internal measure sitting unmarked beside three approved indicators is
    the table claiming something about it that is not true.
  */
  check('KPI 2 IS MARKED INTERNAL AND NOTHING ELSE IS',
        t.rows.KPI2.pills.indexOf('INTERNAL') !== -1 &&
        ['KPI1', 'KPI3', 'KPI4'].every(function (k) {
          return t.rows[k].pills.indexOf('INTERNAL') === -1;
        }),
        JSON.stringify(t.order.map(function (k) {
          return k + ':' + t.rows[k].pills.join('/'); })));
  check('and the mark says which document it is not in, and names it',
        /not one of the three indicators in TVL-KPI-001 v1\.0/i
          .test(t.rows.KPI2.internalTitle) &&
        /not reported against it/i.test(t.rows.KPI2.internalTitle),
        JSON.stringify(t.rows.KPI2.internalTitle));

  check('the target is the server\'s figure with the server\'s unit',
        says.boot.kpiList.every(function (k, i) {
          return t.rows[t.order[i]].target === String(k.target) + k.unit;
        }),
        JSON.stringify(t.order.map(function (k) { return t.rows[k].target; })));

  /*
    THE BANDS BAR. Its widths are the whole reason it is a bar: nearly the
    entire 0-100 range is a breach and the window is a sliver at the top,
    and that is the thing worth seeing before any number is read.
  */
  check('the bar is three segments, red then yellow then green',
        t.order.every(function (k) { return t.rows[k].grows.length === 3; }) &&
        /^Red /.test(t.rows.KPI1.segTitles[0]) &&
        /^Yellow /.test(t.rows.KPI1.segTitles[1]) &&
        /^Green /.test(t.rows.KPI1.segTitles[2]),
        JSON.stringify(t.rows.KPI1.segTitles));
  check('AND THE WIDTHS ARE THE BANDS, in proportion across the whole 0-100',
        says.boot.kpiList.every(function (k, i) {
          const g = t.rows[t.order[i]].grows;
          return g[0] === k.yellowFloor &&
                 Math.abs(g[1] - (k.target - k.yellowFloor)) < 0.0001 &&
                 Math.abs(g[2] - (100 - k.target)) < 0.0001;
        }),
        JSON.stringify(t.order.map(function (k) { return t.rows[k].grows; })));
  check('the exact figures are printed underneath, since the slivers have ' +
        'a floor and cannot be measured',
        JSON.stringify(t.rows.KPI1.chips) ===
        JSON.stringify(['\u2265 90%', '85 \u2013 89.99%', '< 85%']),
        JSON.stringify(t.rows.KPI1.chips));
  check('and the yellow band stops one hundredth below the target, not at it',
        /85 to 89\.99%/.test(t.rows.KPI1.segTitles[1]),
        JSON.stringify(t.rows.KPI1.segTitles[1]));

  check('THE LAYER IS NOT READ TWICE - the badge carries the number, the ' +
        'text carries the name',
        t.rows.KPI1.layer === 'L3 Service Requests' &&
        t.rows.KPI3.layer === 'L1 Incident & Emergency Management' &&
        t.rows.KPI4.layer === 'L2 Service Availability',
        JSON.stringify(t.order.map(function (k) { return t.rows[k].layer; })));
  check('and the full layer name is on the hover',
        t.rows.KPI1.layerTitle === 'Layer 3: Service Requests',
        JSON.stringify(t.rows.KPI1.layerTitle));


  // =======================================================================
  console.log('');
  console.log('  Reading now, and KPI Achievement');
  // =======================================================================
  /*
    COMPARED AGAINST THE SERVER'S OWN ANSWER, never against a number
    written here. This column is over every month there is, which on the
    live machine is eleven months of real tickets and here is two of
    fixture - so the only honest assertion is that the screen prints what
    /api/kpi1 and /api/kpi2 said.
  */
  check('KPI 1\'s reading is the figure /api/kpi1 returned for all months',
        says.kpi1.hasData &&
        t.rows.KPI1.reading === fmt(says.kpi1.total.rate) + '%',
        JSON.stringify(t.rows.KPI1.reading) + ' vs ' +
        JSON.stringify(says.kpi1.hasData ? fmt(says.kpi1.total.rate) : null));
  check('KPI 2\'s reading is the figure /api/kpi2 returned for all quarters',
        says.kpi2.hasData &&
        t.rows.KPI2.reading === fmt(says.kpi2.total.rate) + '%',
        JSON.stringify(t.rows.KPI2.reading) + ' vs ' +
        JSON.stringify(says.kpi2.hasData ? fmt(says.kpi2.total.rate) : null));
  check('each says what period it is over',
        t.rows.KPI1.period === 'all months' &&
        t.rows.KPI2.period === 'all quarters',
        JSON.stringify([t.rows.KPI1.period, t.rows.KPI2.period]));

  /*
    KPI ACHIEVEMENT IS READ FROM THE SERVER'S FIGURE, not recomputed from
    the rate, so this column and that indicator's own screen can never
    round differently. Asserted against the server for the same reason.
  */
  check('ACHIEVEMENT IS THE SERVER\'S, NOT RECOMPUTED FROM THE RATE',
        t.rows.KPI1.achievement === fmt(says.kpi1.total.achievement) + '%' &&
        t.rows.KPI2.achievement === fmt(says.kpi2.total.achievement) + '%',
        JSON.stringify([t.rows.KPI1.achievement, t.rows.KPI2.achievement]) +
        ' vs ' + JSON.stringify([fmt(says.kpi1.total.achievement),
                                 fmt(says.kpi2.total.achievement)]));
  check('and says what 100% means, once per row, since the four targets ' +
        'differ',
        await p.evaluate(function () {
          return Array.prototype.slice.call(
            document.querySelectorAll('td.thr-ach small'))
            .every(function (s) { return /100% = on target/.test(s.textContent); });
        }));

  /*
    THE BAND COLOUR. Which band the figure falls in depends on what is
    stored, so this checks the AGREEMENT between the colour and the figure
    rather than the colour itself - which holds on sixty tickets and on
    twenty-six thousand.
  */
  const bandAgrees = await p.evaluate(function () {
    const s = window.__summaryScreen;
    const want = {
      GREEN: 'rgb(12, 163, 12)', YELLOW: 'rgb(250, 178, 25)',
      RED: 'rgb(208, 59, 59)'
    };
    return ['KPI1', 'KPI2'].map(function (id) {
      const kpi = s.activeDefinition((s.state.boot.kpiList || [])
        .filter(function (k) { return k.id === id; })[0]);
      const read = (s.state[id === 'KPI1' ? 'kpi' : 'kpi2'] || {});
      if (!read.hasData) return id + ': no data';
      const band = s.bandOf(read.total.rate, kpi);
      const row = document.querySelector(
        '#settingsTable tbody tr[data-key="' + id + '"]');
      const painted = row.querySelector('.thr-read').style.color;
      return painted === want[band]
        ? 'ok'
        : id + ': ' + read.total.rate + ' is ' + band + ' against ' +
          kpi.target + ' but painted ' + painted;
    });
  });
  check('the figure is painted in its own band\'s colour',
        bandAgrees.every(function (r) { return r === 'ok'; }),
        JSON.stringify(bandAgrees));
  check('AND THE ACHIEVEMENT IS PAINTED THE SAME - they are one measurement ' +
        'said two ways, so two colours on one row would be a contradiction',
        t.rows.KPI1.achievementColour === t.rows.KPI1.readingColour &&
        t.rows.KPI2.achievementColour === t.rows.KPI2.readingColour,
        JSON.stringify([t.rows.KPI1.achievementColour,
                        t.rows.KPI1.readingColour]));
  check('the three band colours are the chart layer\'s, not a second copy',
        await p.evaluate(function () {
          return Boolean(window.kpiCharts) &&
                 window.kpiCharts.bandColour('GREEN') === '#0ca30c' &&
                 window.kpiCharts.bandColour('YELLOW') === '#fab219' &&
                 window.kpiCharts.bandColour('RED') === '#d03b3b';
        }));

  check('AN INDICATOR WITH NO PIPELINE SAYS "awaiting data", not 0.00%',
        t.rows.KPI3.readingIsNone && t.rows.KPI3.reading === 'awaiting data' &&
        t.rows.KPI4.readingIsNone && t.rows.KPI4.reading === 'awaiting data',
        JSON.stringify([t.rows.KPI3.reading, t.rows.KPI4.reading]));
  check('and its achievement is a dash rather than a figure',
        t.rows.KPI3.achievementNone && t.rows.KPI4.achievementNone &&
        !t.rows.KPI1.achievementNone && !t.rows.KPI2.achievementNone);


  // =======================================================================
  console.log('');
  console.log('  The Definition buttons, and the policy behind the table');
  // =======================================================================
  check('every indicator has a Definition button',
        t.order.every(function (k) { return Boolean(t.rows[k].doc); }),
        JSON.stringify(t.order.filter(function (k) {
          return !t.rows[k].doc; })));
  check('each is a real link to that indicator\'s own document',
        t.order.every(function (k) {
          const d = t.rows[k].doc;
          return d && d.tag === 'A' && /^https:\/\//.test(d.href) &&
                 d.target === '_blank' && /noopener/.test(d.rel) && !d.off;
        }),
        JSON.stringify(t.order.map(function (k) {
          return k + ':' + (t.rows[k].doc || {}).href; })));
  check('AND THE FOUR ADDRESSES ARE FOUR DIFFERENT DOCUMENTS - one address ' +
        'on all of them is the fallback having quietly swallowed the lot',
        new Set(t.order.map(function (k) {
          return (t.rows[k].doc || {}).href; })).size === 4,
        JSON.stringify(t.order.map(function (k) {
          return (t.rows[k].doc || {}).href; })));
  check('each is the address the server sent for that indicator',
        says.boot.kpiList.every(function (k, i) {
          return (t.rows[t.order[i]].doc || {}).href === k.policyUrl;
        }));
  check('and none of them is the folder fallback, which would mean a dead ' +
        'policyUrl',
        t.order.every(function (k) { return !(t.rows[k].doc || {}).folder; }));

  const docBtn = await p.evaluate(function () {
    const el = document.getElementById('kpiPolicyDoc');
    return {
      hidden: el.hidden,
      text: el.textContent.trim(),
      href: el.getAttribute('href') || '',
      target: el.getAttribute('target') || '',
      rel: el.getAttribute('rel') || '',
      title: el.title,
      svg: Boolean(el.querySelector('svg'))
    };
  });
  check('THE POLICY BUTTON SAYS THE DOCUMENT\'S TITLE, not its code - ' +
        '"who decided these" is what a reader wants and TVL-KPI-001 does ' +
        'not answer it',
        !docBtn.hidden && docBtn.text === says.boot.kpiPolicy.title,
        JSON.stringify(docBtn.text));
  check('with the code, the version and the effective date on the hover',
        /TVL-KPI-001 v1\.0/.test(docBtn.title) &&
        /effective 1 October 2026/.test(docBtn.title),
        JSON.stringify(docBtn.title));
  check('and it opens the policy itself, in a new tab',
        docBtn.href === says.boot.kpiPolicy.url &&
        docBtn.target === '_blank' && /noopener/.test(docBtn.rel) && docBtn.svg,
        JSON.stringify(docBtn.href));

  /*
    THE THREE FALLBACKS, WHICH NO ROW OF THE REAL CONFIG REACHES.

    All four indicators have a definition sheet, so the rows above only ever
    exercise the first choice - and a mutation that removed the greyed "Not
    linked" state went through unnoticed, because nothing on the screen was
    in that state. Driven directly instead, with the policy block
    substituted, which is the only way to reach the other three.
  */
  const fallbacks = await p.evaluate(function () {
    const s = window.__summaryScreen;
    const was = s.state.boot.kpiPolicy;
    const kpi = { id: 'KPIX', name: 'A measure with no sheet of its own' };
    const out = {};
    try {
      s.state.boot.kpiPolicy = was;
      out.policy = s.docTarget(kpi);

      s.state.boot.kpiPolicy = { id: was.id, version: was.version,
                                 folderUrl: was.folderUrl };
      out.folder = s.docTarget(kpi);

      s.state.boot.kpiPolicy = { id: was.id, version: was.version };
      out.none = s.docTarget(kpi);
      out.noneHtml = s.policyLink(kpi);

      out.refused = [s.linkOf('javascript:alert(1)'),
                     s.linkOf('drive.google.com/x'),
                     s.linkOf('  https://ok.example/x  '),
                     s.linkOf(null)];
    } finally {
      s.state.boot.kpiPolicy = was;
    }
    return out;
  });
  check('an indicator with no sheet of its own falls back to the policy, ' +
        'which does define it',
        fallbacks.policy && fallbacks.policy.label === 'PDF' &&
        fallbacks.policy.url === says.boot.kpiPolicy.url &&
        /which defines A measure with no sheet/.test(fallbacks.policy.what),
        JSON.stringify(fallbacks.policy));
  check('AND WITH NO POLICY ADDRESS EITHER IT OPENS THE FOLDER - the right ' +
        'place beats a dead button, and a folder outlives the files in it',
        fallbacks.folder && fallbacks.folder.label === 'Folder' &&
        fallbacks.folder.url === says.boot.kpiPolicy.folderUrl &&
        /no document of its own linked yet/.test(fallbacks.folder.what),
        JSON.stringify(fallbacks.folder));
  check('with nothing at all it is drawn greyed and says so, rather than ' +
        'left empty - an empty cell reads as "there is no such document"',
        fallbacks.none === null &&
        /class="doc-btn is-off"/.test(fallbacks.noneHtml) &&
        />Not linked</.test(fallbacks.noneHtml) &&
        /No document linked yet/.test(fallbacks.noneHtml),
        JSON.stringify(fallbacks.noneHtml));
  check('and anything that is not plainly http(s) is refused as an address',
        JSON.stringify(fallbacks.refused) ===
        JSON.stringify(['', '', 'https://ok.example/x', '']),
        JSON.stringify(fallbacks.refused));

  check('the note beside the heading counts the indicators and the live ones',
        (await p.textContent('#kpiTableNote')) ===
        '4 indicators \u00b7 2 live \u00b7 2 awaiting a pipeline',
        JSON.stringify(await p.textContent('#kpiTableNote')));


  // =======================================================================
  console.log('');
  console.log('  KPI 1\'s two standards');
  // =======================================================================
  /*
    THE ROW MUST NOT DISAGREE WITH ITSELF, and App.html names the exact
    failure: "97.50% shown in red against a target of 90%". The reading
    comes from the server, scored against one of the two standards; the
    target beside it comes from the definition the toggle is on. If the
    screen asks for one and prints the other, this is what catches it.
  */
  const company = t.rows.KPI1;
  await open(p, 'ADMIN', 'EAS');
  const eas = (await tableOf(p)).rows.KPI1;
  const easSays = await serverSays('ADMIN', 'EAS');

  check('switching the toggle moves KPI 1\'s target to the team\'s own',
        company.target === '90%' && eas.target === '99.5%',
        JSON.stringify([company.target, eas.target]));
  check('and its band edges with it',
        JSON.stringify(company.grows) === JSON.stringify([85, 5, 10]) &&
        JSON.stringify(eas.grows) === JSON.stringify([89.55, 9.95, 0.5]),
        JSON.stringify([company.grows, eas.grows]));
  check('and the chips underneath',
        JSON.stringify(eas.chips) ===
        JSON.stringify(['\u2265 99.5%', '89.55 \u2013 99.49%', '< 89.55%']),
        JSON.stringify(eas.chips));
  check('AND THE FIGURE WAS SCORED AGAINST THAT TARGET, not the other one',
        easSays.kpi1.hasData && easSays.kpi1.standard === 'EAS' &&
        eas.reading === fmt(easSays.kpi1.total.rate) + '%' &&
        eas.achievement === fmt(easSays.kpi1.total.achievement) + '%',
        JSON.stringify([eas.reading, eas.achievement]) + ' vs ' +
        JSON.stringify(easSays.kpi1.hasData
          ? [fmt(easSays.kpi1.total.rate),
             fmt(easSays.kpi1.total.achievement)] : null));
  /*
    THE ACHIEVEMENT IS THE ONE THAT PROVES IT. The success rate is the same
    count either way - the same tickets, the same two formulas - so a
    screen that asked for the wrong standard would still print a plausible
    rate. Achievement is rate against TARGET, so it has to move.
  */
  if (fmt(says.kpi1.total.achievement) === fmt(easSays.kpi1.total.achievement)) {
    note('the two standards happen to give the same achievement on this ' +
         'data, so the stronger form of that check could not be made');
  } else {
    check('THE ACHIEVEMENT ACTUALLY MOVED, which the success rate need not',
          company.achievement !== eas.achievement,
          JSON.stringify([company.achievement, eas.achievement]));
  }
  check('and the policy row\'s definition button follows the standard too',
        Boolean(eas.doc) && eas.doc.href !== company.doc.href,
        JSON.stringify([company.doc.href, eas.doc.href]));

  await open(p, 'ADMIN', 'COMPANY');
  t = await tableOf(p);


  // =======================================================================
  console.log('');
  console.log('  The Database card');
  // =======================================================================
  const card = await dbCard(p);
  check('the rows are the original\'s, in the original\'s order',
        JSON.stringify(card.order.slice(0, 8)) === JSON.stringify([
          'Version', 'Sections',
          'KPI 1 \u00b7 tickets stored', 'KPI 1 \u00b7 months',
          'KPI 1 \u00b7 uploads logged',
          'KPI 2 \u00b7 responses stored', 'KPI 2 \u00b7 quarters',
          'KPI 2 \u00b7 uploads logged']),
        JSON.stringify(card.order));
  /*
    EVERY COUNT AGAINST THE SERVER'S OWN, never against a number written
    here. These are counts over the whole schema: forty on this machine and
    twenty-six thousand on the live one.
  */
  const want = {
    'KPI 1 \u00b7 tickets stored': says.boot.stats.tickets,
    'KPI 1 \u00b7 uploads logged': says.boot.stats.ticketUploads,
    'KPI 2 \u00b7 responses stored': says.boot.stats.feedback,
    'KPI 2 \u00b7 uploads logged': says.boot.stats.feedbackUploads
  };
  const wrong = Object.keys(want).filter(function (row) {
    return card.value[row] !== Number(want[row]).toLocaleString('en-US');
  });
  check('WHAT IS ACTUALLY STORED, and what the upload log claims, both as ' +
        'the server counted them',
        wrong.length === 0,
        JSON.stringify(wrong.map(function (row) {
          return row + ': ' + card.value[row] + ' vs ' + want[row]; })));
  /*
    WHICH ROW READS WHICH FIELD, proved on numbers the database cannot
    reach.

    THIS CHECK USED TO ASSERT THAT THE LIVE COUNTS WERE FOUR DIFFERENT
    NUMBERS, so that the check above could not pass by coincidence - and
    that was the sixth-time mistake all over again, committed inside the
    guard against it. The live counts are the database's, not the
    fixture's: the fixture adds two ticket uploads to however many are
    already there, so on a machine with one real upload that row reads 3,
    which is also how many responses the fixture seeds. Two rows collide,
    and a correct screen is reported as broken. It was, on the live
    machine, on the first run.

    The card is drawn from a made-up bootstrap instead, with four numbers
    that cannot collide and are nothing like any real count. That is
    strictly stronger than the check it replaces: it proves which field
    each row reads, rather than arguing that a pass could not have been
    luck. The months and the quarters go in too, since they are two more
    numbers that could be crossed.
  */
  await p.evaluate(function () {
    window.__summaryScreen.renderDatabase({
      appVersion: 'v-made-up',
      sections: ['a', 'b', 'c'],
      availableMonths: ['m1', 'm2', 'm3', 'm4', 'm5'],
      feedbackQuarters: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'],
      feedbackMonths: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9'],
      stats: { tickets: 1111, feedback: 2222,
               ticketUploads: 3333, feedbackUploads: 4444 },
      orphanedFeedback: 0,
      backup: { on: true, count: 5, last: null, stale: false }
    });
  });
  const wired = await dbCard(p);
  await p.evaluate(function () {
    const s = window.__summaryScreen;
    s.renderDatabase(s.state.boot);
  });
  check('EACH ROW READS ITS OWN FIELD, on four numbers that cannot collide',
        wired.value['KPI 1 \u00b7 tickets stored'] === '1,111' &&
        wired.value['KPI 2 \u00b7 responses stored'] === '2,222' &&
        wired.value['KPI 1 \u00b7 uploads logged'] === '3,333' &&
        wired.value['KPI 2 \u00b7 uploads logged'] === '4,444',
        JSON.stringify([wired.value['KPI 1 \u00b7 tickets stored'],
                        wired.value['KPI 2 \u00b7 responses stored'],
                        wired.value['KPI 1 \u00b7 uploads logged'],
                        wired.value['KPI 2 \u00b7 uploads logged']]));
  check('and so do the months, the quarters, the version and the sections',
        wired.value['KPI 1 \u00b7 months'] === '5' &&
        wired.value['KPI 2 \u00b7 quarters'] === '7 (9 months)' &&
        wired.value.Version === 'v-made-up' &&
        wired.value.Sections === '3',
        JSON.stringify([wired.value['KPI 1 \u00b7 months'],
                        wired.value['KPI 2 \u00b7 quarters'],
                        wired.value.Version, wired.value.Sections]));
  await p.evaluate(function () {
    window.__summaryScreen.renderDatabase({
      appVersion: 'v-made-up', sections: [],
      availableMonths: [], feedbackQuarters: ['q1'], feedbackMonths: ['f1'],
      stats: { tickets: 0, feedback: 1, ticketUploads: 0, feedbackUploads: 0 },
      orphanedFeedback: 0, backup: null
    });
  });
  const singular = (await dbCard(p)).value['KPI 2 \u00b7 quarters'];
  await p.evaluate(function () {
    const s = window.__summaryScreen;
    s.renderDatabase(s.state.boot);
  });
  check('one month is "1 month", not "1 months"',
        singular === '1 (1 month)', JSON.stringify(singular));

  check('the card went back to the real figures afterwards',
        (await dbCard(p)).value['KPI 1 \u00b7 tickets stored'] ===
        Number(says.boot.stats.tickets).toLocaleString('en-US'),
        JSON.stringify((await dbCard(p)).value['KPI 1 \u00b7 tickets stored']));
  check('the fixture\'s own rows are in those totals',
        says.boot.stats.tickets >= ticketsSeeded &&
        says.boot.stats.feedback >= responsesSeeded,
        JSON.stringify([says.boot.stats.tickets, says.boot.stats.feedback]));
  check('the months and quarters are the ones the pickers would offer',
        card.value['KPI 1 \u00b7 months'] ===
        String(says.boot.availableMonths.length) &&
        new RegExp('^' + says.boot.feedbackQuarters.length + ' \\(' +
                   says.boot.feedbackMonths.length + ' months?\\)$')
          .test(card.value['KPI 2 \u00b7 quarters']),
        JSON.stringify([card.value['KPI 1 \u00b7 months'],
                        card.value['KPI 2 \u00b7 quarters']]));
  check('the version is the server\'s, so a stale page is visible',
        card.value.Version === says.boot.appVersion,
        JSON.stringify([card.value.Version, says.boot.appVersion]));
  check('and the section count is the roster\'s',
        card.value.Sections === String(says.boot.sections.length),
        JSON.stringify([card.value.Sections, says.boot.sections.length]));
  check('a thousand is printed with its separator, since these get large',
        await p.evaluate(function () {
          return (12345).toLocaleString('en-US') === '12,345';
        }));

  /*
    THE BACKUPS. `on` is DECLARED, not detected - nothing in a Node process
    can ask Windows Task Scheduler whether the nightly task exists - so the
    row says where the declaration lives when it is off.
  */
  if (says.boot.backup) {
    check('the backups have their own two rows',
          card.order.indexOf('Backups') !== -1 &&
          card.order.indexOf('Last backup') !== -1,
          JSON.stringify(card.order));
    check('AND SAY WHERE THE DECLARATION LIVES WHEN THEY ARE NOT ON, since ' +
          'nothing here can detect a scheduled task',
          says.boot.backup.on
            ? /kept, daily/.test(card.value.Backups)
            : /BACKUP_SCHEDULED in api\/\.env/.test(card.value.Backups),
          JSON.stringify(card.value.Backups));
    check('and the one that is a problem is the one in red',
          card.red.Backups === !says.boot.backup.on,
          JSON.stringify([card.value.Backups, card.red.Backups]));
  } else {
    check('a backup folder that cannot be read says so rather than ' +
          'vanishing from the card',
          /Cannot be read/.test(card.value.Backups || ''),
          JSON.stringify(card.value.Backups));
  }

  /*
    THE DISAGREEMENT THIS CARD EXISTS FOR: uploads logged with nothing
    stored. Proved by deleting the fixture's rows and leaving its upload
    log behind - which is exactly the state a failed import leaves. Only
    assertable where the database holds nothing but the fixture, so it is
    skipped with a note on a machine with real data.
  */
  if (says.boot.stats.tickets === ticketsSeeded) {
    await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-SUM-%'");
    await open(p, 'ADMIN', 'COMPANY');
    const empty = await dbCard(p);
    check('UPLOADS LOGGED WITH NOTHING STORED IS MARKED, which is the whole ' +
          'reason this card prints both numbers',
          empty.value['KPI 1 \u00b7 tickets stored'] === '0' &&
          empty.red['KPI 1 \u00b7 tickets stored'] === true &&
          empty.value['KPI 1 \u00b7 uploads logged'] !== '0',
          JSON.stringify([empty.value['KPI 1 \u00b7 tickets stored'],
                          empty.red['KPI 1 \u00b7 tickets stored'],
                          empty.value['KPI 1 \u00b7 uploads logged']]));
    check('and with nothing uploaded either it is NOT marked - zero and ' +
          'zero agree, and a red zero on a fresh install is a false alarm',
          await p.evaluate(function () {
            const s = window.__summaryScreen;
            return s.nothingStored(0, 0) === false &&
                   s.nothingStored(0, 2) === true;
          }));
    /*
      PUT THE TICKETS BACK AND RELOAD. The check above deliberately emptied
      the table, and the Rebuild card below prints how many tickets are
      scored - so without this reload it reads the emptied state and reports
      the page as saying "nothing is stored yet" when the fixture is back.
      That is this test's own mistake, not the screen's, and it cost a run.
    */
    await seedTickets();
    await open(p, 'ADMIN', 'COMPANY');
  } else {
    note('the database holds rows besides the fixture, so the ' +
         '"uploads logged with nothing stored" warning could not be ' +
         'exercised against the real counts - its logic is checked directly ' +
         'instead');
    check('the warning fires on uploads with nothing stored, and not on a ' +
          'fresh install',
          await p.evaluate(function () {
            const s = window.__summaryScreen;
            return s.nothingStored(0, 2) === true &&
                   s.nothingStored(0, 0) === false &&
                   s.nothingStored(9, 2) === false;
          }));
  }

  if (says.boot.orphanedFeedback) {
    check('orphaned responses are counted and marked',
          card.value['Orphaned responses'] ===
          Number(says.boot.orphanedFeedback).toLocaleString('en-US') &&
          card.red['Orphaned responses'] === true,
          JSON.stringify(card.value['Orphaned responses']));
  } else {
    check('WITH NO ORPHANS THE ROW IS ABSENT, not a reassuring zero nobody ' +
          'asked about',
          card.order.indexOf('Orphaned responses') === -1,
          JSON.stringify(card.order));
  }


  // =======================================================================
  console.log('');
  console.log('  Where the Rebuild button went');
  // =======================================================================
  check('the card is still there, under the original\'s heading',
        await p.isVisible('#rebuildCard'));
  const why = await p.textContent('#rebuildWhy');
  check('AND SAYS THERE IS NOTHING TO REBUILD, rather than leaving a gap ' +
        'where somebody is looking for a button',
        /nothing to rebuild/i.test(why) && /scores the tickets directly/i.test(why),
        JSON.stringify(why.slice(0, 80)));
  check('it says why - the figures are not stored, so they cannot go stale',
        /no figure can go stale/i.test(why) &&
        /KPI 2 always worked this way/i.test(why),
        JSON.stringify(why.slice(-80)));
  check('and how many tickets are scored on every read',
        new RegExp(Number(says.boot.stats.tickets).toLocaleString('en-US') +
                   ' tickets').test(await p.textContent('#rebuildWhen')),
        JSON.stringify(await p.textContent('#rebuildWhen')));
  check('THERE IS NO REBUILD BUTTON TO PRESS, because there is nothing for ' +
        'it to do',
        await p.evaluate(function () {
          return !document.getElementById('rebuildKpi1');
        }));


  // =======================================================================
  console.log('');
  console.log('  What a viewer sees');
  // =======================================================================
  await open(p, 'USER', 'COMPANY');
  check('the thresholds table is for everybody - it names no individual and ' +
        'carries no figure that is not on a dashboard they can open',
        (await p.evaluate(function () {
          return document.querySelectorAll('#settingsTable tbody tr').length;
        })) === 4);
  check('so is the Database card',
        await p.isVisible('#dbInfo'));
  /*
    NAMED, NOT SELECTED BY ATTRIBUTE, and that is the whole lesson of this
    check. `[data-admin-only]` matches TWO elements on this page - the
    Rebuild card, and the Help item the shell marks in its own sidebar - and
    a bare selector resolves to the first, which is the shell's. So this
    check passed while the card was plainly on screen for a viewer, and the
    mutation that unhid it went through unnoticed. The card is asked for by
    name now, and the count is asserted so that a second admin-only element
    added to the page cannot slip past the same way.
  */
  check('AND THE REBUILD CARD IS NOT, exactly as the original gated it',
        await p.isHidden('#rebuildCard'),
        'rebuildCard.hidden=' + await p.evaluate(function () {
          return document.getElementById('rebuildCard').hidden;
        }));
  check('and it is the only thing on the page a viewer loses',
        (await p.evaluate(function () {
          return Array.prototype.slice.call(
            document.getElementById('page')
              .querySelectorAll('[data-admin-only]'))
            .map(function (el) { return el.id || el.className; });
        })).join(',') === 'rebuildCard');
  check('the admin-only sweep did not reach into the shell',
        await p.isVisible('.nav-item[data-view="kpi1"]') &&
        await p.isVisible('#operatorName'));
  /*
    THE SHELL'S OWN ADMIN-ONLY ITEM STAYS THE SHELL'S BUSINESS. It is
    hidden here because the shell hid it for a viewer, not because this
    page swept the document - and the mutation that makes the page sweep
    the document is caught by the check above.
  */
  check('and the shell is still the one deciding about Help',
        await p.isHidden('.nav-item[data-view="help"]'));


  // =======================================================================
  console.log('');
  console.log('  Signing out, and coming back');
  // =======================================================================
  await p.click('#signOut');
  await p.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  check('signing out puts the sign-in box back and takes the screen away',
        await p.isHidden('#page') && await p.isVisible('#signinCard'));
  check('and the token is gone from this tab',
        (await p.evaluate(function () {
          return sessionStorage.getItem('easToken');
        })) === null);


  // =======================================================================
  console.log('');
  console.log('  Nothing on fire in the console');
  // =======================================================================
  check('the page threw nothing', thrown.length === 0, thrown.join(' | '));
  const unexpected = badRequests.filter(function (r) {
    return !/cdnjs\.cloudflare\.com/.test(r);
  });
  check('every file the screen asked for was served',
        unexpected.length === 0, unexpected.slice(0, 4).join(' | '));

  await context.close();
  await b.close();

  await sweep();
  check('no test tickets are left behind',
        (await db.query("SELECT count(*)::int AS n FROM ticket" +
                        " WHERE ticket_id LIKE 'TEST-SUM-%'"))[0].n === 0);
  check('no test responses are left behind',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-SUM%'"))[0].n === 0);
  check('no test uploads are left behind',
        (await db.query("SELECT count(*)::int AS n FROM upload_run" +
                        " WHERE upload_id LIKE 'UPL-TEST-SUM%'"))[0].n === 0);

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
