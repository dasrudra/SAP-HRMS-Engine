/**
 * THE COMPARISON SCREEN, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node compare-ui-test.js
 *
 * kpi-equivalence-test.js already proves the comparison arithmetic against
 * the original over 16,239 comparisons, and kpi2-equivalence-test.js does
 * the same for KPI 2. This proves the SCREEN: that the pickers follow the
 * KPI, that the right endpoint is called, that the tables and both charts
 * are built from what came back, and that the four refusals say the right
 * thing.
 *
 * THE ONE THING THIS SCREEN HAS THAT NO OTHER DOES: it serves two KPIs
 * through one render path, and the two disagree about what a period even
 * is - KPI 1 compares months, KPI 2 compares quarters. Most of the checks
 * below are about the seam between them, because that is where App.html
 * records every bug this screen has ever had.
 *
 * ITS FIXTURE IS 2099 AND SWEPT AT BOTH ENDS, and nothing here asserts a
 * figure that depends on what else is in the database.
 */
require('dotenv').config();
const db = require('./db');
const { signToken } = require('./auth');
const browser = require('../tests/harness/browser');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PAGE = BASE + '/compare.html';

const MONTHS = ['2099-01', '2099-02', '2099-03'];
const QUARTER_MONTH = '2099-05';     // Q2, for the KPI 2 half
const QUARTER2_MONTH = '2099-08';    // Q3, so there are two quarters
const SECTIONS = ['MM', 'SD'];

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


async function sweep() {
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-CMP-%'");
  await db.query("DELETE FROM training WHERE response_id LIKE 'TEST-CMP%'");
  await db.query("DELETE FROM upload_run WHERE upload_id LIKE 'UPL-TEST-CMP%'");
}


/**
 * Three months of tickets, each month better than the last.
 *
 * DELIBERATELY RISING: 80%, 90%, 100%. The Change column is the only thing
 * on this screen that is about the relationship BETWEEN two periods rather
 * than about either of them, so a fixture where every month scores the
 * same would leave it reading a dash and prove nothing.
 *
 * in_dept AND in_overall ARE TRUE ON EVERY ROW, AND THAT IS NOT A DETAIL.
 * They are SCOPE flags - whether a ticket belongs in the department's
 * figures and in the overall ones - not success flags. Setting them to
 * false on the tickets meant to fail did not fail them, it removed them
 * from the comparison altogether: January came back as 16 received out of
 * 16, scoring 100%, and every month looked identical. What decides success
 * is delay_days, which is what varies here.
 */
async function seedTickets() {
  const goodPerMonth = { '2099-01': 8, '2099-02': 9, '2099-03': 10 };
  let n = 0;
  for (const month of MONTHS) {
    for (const part of SECTIONS) {
      for (let i = 0; i < 10; i++) {
        n++;
        const good = i < goodPerMonth[month];
        await db.query(
          `INSERT INTO ticket (ticket_id, in_charge, service, part, department,
                               affiliate, request_date, completion_date,
                               delay_days, in_dept, in_overall, last_updated)
           VALUES ($1, 'TEST-CMP', 'SAP', $2, $2, 'TEST-CMP-AFF',
                   ($3 || '-05 09:00+06')::timestamptz,
                   ($3 || '-06 17:00+06')::timestamptz, $4, true, true, now())`,
          ['TEST-CMP-' + n, part, month, good ? 0 : 3]);
      }
    }
  }
}


/** Two quarters of training feedback, so KPI 2 has something to compare. */
async function seedFeedback() {
  const GOOD = ['Excellent', 'Relevant and useful', 'Excellent', 'Good',
                'Very helpful', 'Much more confident', 'Appropriate'];
  const MIXED = ['Average', 'Somewhat relevant', 'Excellent', 'Good',
                 'Very helpful', 'Much more confident', 'Appropriate'];
  let n = 0;
  for (const [month, answers] of [[QUARTER_MONTH, GOOD],
                                  [QUARTER_MONTH, MIXED],
                                  [QUARTER2_MONTH, GOOD],
                                  [QUARTER2_MONTH, GOOD]]) {
    n++;
    await db.query(
      `INSERT INTO training (response_id, month, session_date, module,
                             session_title, trainer, plant, employee_id,
                             employee_name, q1_overall, q2_relevance,
                             q3_knowledge, q4_explanation, q5_materials,
                             q6_confidence, q7_duration, source_file, zone,
                             uploaded_at)
       VALUES ($1, $2, ($2 || '-15 10:00+06')::timestamptz,
               'Inventory Management', 'TEST-CMP session', '', '', '', '',
               $3,$4,$5,$6,$7,$8,$9, 'TEST-CMP feedback.xlsx', 'KEPZ', now())`,
      ['TEST-CMP-r' + n, month, answers[0], answers[1], answers[2],
       answers[3], answers[4], answers[5], answers[6]]);
  }
  // An upload that owns the file, so nothing here reads as an orphan.
  await db.query(
    `INSERT INTO upload_run (upload_id, uploaded_by, file_names, report_types,
                             departments, rows_in_file, rows_added, notes)
     VALUES ('UPL-TEST-CMP', 'TEST-CMP', 'TEST-CMP feedback.xlsx',
             'FEEDBACK', 'MM', 4, 4, 'complete')`);
}


/**
 * Records what the screen asks Chart.js to draw, whether or not Chart.js
 * is there.
 *
 * THE FIRST VERSION ONLY WORKED WHERE THE CDN WAS BLOCKED, which is to say
 * it only worked in the sandbox. It replaced a missing `Chart` with a stub
 * that recorded its config - so on a machine with internet, where the real
 * library loads, nothing was recorded and every chart assertion failed
 * reading `labels` of null. A test that passes only where a dependency is
 * unreachable is not testing the thing it names.
 *
 * So the real library is WRAPPED rather than replaced. A Proxy with a
 * `construct` trap notes the config and then builds the genuine chart, and
 * because a Proxy forwards everything else to its target, Chart.register
 * and the rest keep working. Where there is no library at all, the stub
 * stands in and records the same way. Both machines now assert on the same
 * thing: what the screen asked for.
 */
async function provideChartJs(p) {
  const real = await p.evaluate(function () { return typeof Chart !== 'undefined'; });

  await p.addInitScript(function () {
    function remember(ctx, config) {
      try {
        window.__charts = window.__charts || {};
        const canvas = ctx && (ctx.canvas || ctx);
        if (canvas && canvas.id) window.__charts[canvas.id] = config;
      } catch (e) { /* recording must never break the page */ }
    }

    function Stub(ctx, config) {
      remember(ctx, config);
      this.config = config;
      this.ctx = ctx;
      this.scales = {};
      this.destroy = function () {};
    }

    function install() {
      if (window.__chartsWrapped) return;
      if (typeof window.Chart === 'undefined') {
        window.Chart = Stub;
        window.__chartsWrapped = true;
        return;
      }
      const Real = window.Chart;
      window.Chart = new Proxy(Real, {
        construct: function (target, args) {
          remember(args[0], args[1]);
          return new target(args[0], args[1]);
        }
      });
      window.__chartsWrapped = true;
    }

    // Once as soon as this runs, in case the library is already there, and
    // again at DOMContentLoaded for the case where its <script> has not
    // executed yet.
    install();
    window.addEventListener('DOMContentLoaded', install);
  });

  return { real: real };
}

async function chartFor(p, id) {
  return p.evaluate(function (want) {
    const c = (window.__charts || {})[want];
    if (!c) return null;
    return {
      type: c.type,
      labels: c.data.labels,
      datasets: c.data.datasets.map(function (d) {
        return { label: d.label, data: d.data, type: d.type,
                 axis: d.yAxisID || '' };
      }),
      target: ((c.options.plugins || {}).targetLine || {}).value,
      min: ((c.options.scales || {}).y || {}).min,
      rateMin: ((c.options.scales || {}).yRate || {}).min
    };
  }, id);
}


async function open(p, role) {
  await p.goto(PAGE);
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                   signToken('20990' + (role === 'USER' ? '771' : '770'), role));
  await p.evaluate(function () {
    // Start from a known standard rather than from whatever a previous run
    // of another suite left in sessionStorage.
    try { sessionStorage.removeItem('easKpi1Filters'); } catch (e) { /* fine */ }
  });
  await p.goto(PAGE);
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(400);
}

async function compareShown(p) {
  await p.waitForFunction(function () {
    return !document.getElementById('cmpOverallCard').hidden;
  }, null, { timeout: 20000 });
  await p.waitForTimeout(250);
}

async function tableOf(p, selector) {
  return p.evaluate(function (sel) {
    const head = Array.prototype.slice.call(
      document.querySelectorAll(sel + ' thead th'))
      .map(function (th) { return th.textContent.trim(); });
    const rows = Array.prototype.slice.call(
      document.querySelectorAll(sel + ' tbody tr'))
      .map(function (tr) {
        return Array.prototype.slice.call(tr.querySelectorAll('td'))
          .map(function (td) { return td.textContent.trim(); });
      });
    return { head: head, rows: rows };
  }, selector);
}

async function dialogText(p) {
  return p.evaluate(function () {
    const back = document.getElementById('modalBackdrop');
    if (!back || back.hidden) return null;
    return {
      title: (document.getElementById('modalTitle') || {}).textContent || '',
      body: (document.getElementById('modalBody') || {}).textContent || ''
    };
  });
}

async function closeDialog(p) {
  await p.click('#modalConfirm');
  await p.waitForFunction(function () {
    const back = document.getElementById('modalBackdrop');
    return !back || back.hidden;
  }, null, { timeout: 20000 });
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
  await seedTickets();
  await seedFeedback();

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

  await p.goto(PAGE);
  const charts = await provideChartJs(p);
  await open(p, 'ADMIN');

  console.log('');
  console.log('  Charting with ' + (charts.real
    ? 'the real Chart.js, loaded from the CDN'
    : 'a stand-in that records what it was asked to draw'));


  // =======================================================================
  console.log('');
  console.log('  The screen itself');
  // =======================================================================
  check('it opens for any signed-in person',
        await p.isVisible('#page') && await p.isHidden('#signinCard'));
  check('the shell lights Comparison',
        await p.evaluate(function () {
          const lit = document.querySelector('.nav-item.is-active');
          return lit && lit.getAttribute('data-view') === 'compare';
        }));
  check('ALL FOUR INDICATORS ARE OFFERED, including the two with no ingest',
        await p.evaluate(function () {
          return Array.prototype.slice
            .call(document.querySelectorAll('#cmpKpi option'))
            .map(function (o) { return o.value; }).join(',');
        }) === 'KPI1,KPI2,KPI3,KPI4');
  check('and the two without data say so in the option itself',
        await p.evaluate(function () {
          return Array.prototype.slice
            .call(document.querySelectorAll('#cmpKpi option'))
            .filter(function (o) { return /awaiting data/.test(o.textContent); })
            .map(function (o) { return o.value; }).join(',');
        }) === 'KPI3,KPI4');
  check('the hint names the target and the SLA layer',
        /Target \u2265 90% \u00b7 Layer 3: Service Requests/
          .test(await p.textContent('#cmpKpiHint')),
        await p.textContent('#cmpKpiHint'));


  // =======================================================================
  console.log('');
  console.log('  Comparing months');
  // =======================================================================
  await p.selectOption('#cmpM1', '2099-03');
  await p.selectOption('#cmpM2', '2099-02');
  await p.selectOption('#cmpM3', '2099-01');
  await p.click('#cmpRun');
  await compareShown(p);

  const overall = await tableOf(p, '#cmpOverall');
  check('the overall table has one row per month',
        overall.rows.length === 3, JSON.stringify(overall.rows.length));
  /*
    OLDEST FIRST, WHATEVER ORDER THEY WERE PICKED IN. getKpiComparison in
    Kpi.gs sorts: `periods: (months || []).slice().sort()`, and the port
    does the same. It has to - the Change column reads each row against the
    one above it, so a table in picking order would compute change against
    whichever month somebody happened to choose second.
  */
  check('OLDEST FIRST, whatever order they were picked in',
        overall.rows[0][0] === 'January 2099' &&
        overall.rows[2][0] === 'March 2099',
        JSON.stringify(overall.rows.map(function (r) { return r[0]; })));
  check('THE COLUMNS ARE THE ONES THE SERVER NAMED, Open included',
        overall.head.indexOf('Open') !== -1 &&
        overall.head.indexOf('Received') !== -1 &&
        overall.head.indexOf('Successful') !== -1,
        JSON.stringify(overall.head));

  /*
    THE CHANGE COLUMN, which is the only thing on this screen about the
    relationship BETWEEN two periods. 100% after 90% is 10 percentage
    points up; the first row has nothing above it, so it is a dash.
  */
  const change = overall.rows.map(function (r) { return r[r.length - 1]; });
  check('the first row has no change to report',
        change[0] === '\u2014', JSON.stringify(change));
  check('AND THE REST ARE PERCENTAGE POINTS AGAINST THE ROW ABOVE, ' +
        'with a direction',
        /\u25b2\s*10\.00/.test(change[1]) && /\u25b2\s*10\.00/.test(change[2]),
        JSON.stringify(change));

  const sections = await tableOf(p, '#cmpSections');
  check('the section table puts the periods across the top',
        sections.head.length === 4 &&
        sections.head[1] === 'January 2099',
        JSON.stringify(sections.head));
  check('and one row per section',
        sections.rows.length === SECTIONS.length,
        JSON.stringify(sections.rows.map(function (r) { return r[0]; })));


  // =======================================================================
  console.log('');
  console.log('  The two charts');
  // =======================================================================
  const bar = await chartFor(p, 'chartCompare');
  check('the comparison chart is drawn', Boolean(bar));
  check('EAS OVERALL SITS BESIDE THE SECTIONS, not instead of them',
        bar.labels[0] === 'EAS overall' && bar.labels.length === 3,
        JSON.stringify(bar.labels));
  check('one dataset per period, labelled as a person reads it',
        bar.datasets.length === 3 &&
        bar.datasets[0].label === 'January 2099',
        JSON.stringify(bar.datasets.map(function (d) { return d.label; })));
  check('the target line is the target',
        bar.target === 90, String(bar.target));
  check('AND THE AXIS STARTS BELOW THE LOWEST BAR, not at zero',
        bar.min > 0 && bar.min < 90, String(bar.min));

  const trend = await chartFor(p, 'chartTrend');
  check('the trend is drawn too', Boolean(trend));
  check('IT IGNORES THE PICKERS AND PLOTS EVERY MONTH THERE IS - the ' +
        'selection narrows the comparison without losing the shape of the year',
        trend.labels.length === MONTHS.length,
        JSON.stringify(trend.labels));
  check('oldest first, because a trend reads left to right',
        trend.labels[0] === 'Jan 2099', JSON.stringify(trend.labels));
  check('a line of rates over bars of volume',
        trend.datasets.some(function (d) { return d.type === 'line'; }) &&
        trend.datasets.some(function (d) { return d.axis === 'yVolume'; }),
        JSON.stringify(trend.datasets.map(function (d) {
          return d.type + '/' + d.axis; })));


  // =======================================================================
  console.log('');
  console.log('  Which of KPI 1\'s two targets');
  // =======================================================================
  const febCompany = (await tableOf(p, '#cmpOverall')).rows[1].join(' ');

  check('the standard toggle is shown for KPI 1',
        await p.isVisible('#cmpStandardWrap'));
  check('and it names the document the figures answer to',
        /TVL-KPI-001/.test(await p.textContent('#cmpStandardNote')),
        await p.textContent('#cmpStandardNote'));

  await p.click('.standard-opt[data-standard="EAS"]');
  await p.waitForFunction(function () {
    const h = document.getElementById('cmpKpiHint');
    return h && /99\.5/.test(h.textContent);
  }, null, { timeout: 20000 });
  check('SWITCHING IT MOVES THE CAPTION TOO - the screen must not say 90% ' +
        'over a chart drawn against 99.5%',
        /Target \u2265 99\.5%/.test(await p.textContent('#cmpKpiHint')),
        await p.textContent('#cmpKpiHint'));

  await compareShown(p);
  const strict = await chartFor(p, 'chartCompare');
  check('and the chart is redrawn against the stricter target',
        strict.target === 99.5, String(strict.target));

  /*
    THE BANDS ARE RESCORED, and February is the month that proves it: 90%
    clears the company's 90.00 target and does not clear the team's 99.50,
    so the same stored tickets are GREEN under one and YELLOW under the
    other. March (100%) and January (80%) band the same way under both and
    would prove nothing.
  */
  const strictTable = await tableOf(p, '#cmpOverall');
  const febStrict = strictTable.rows[1].join(' ');
  check('AND THE BANDS ARE RESCORED - the same 90% month is GREEN against ' +
        'the company target and YELLOW against the team\'s',
        febCompany.indexOf('GREEN') !== -1 &&
        febStrict.indexOf('YELLOW') !== -1,
        febCompany + '  ||  ' + febStrict);

  check('the choice is remembered where the KPI 1 screen looks for it',
        await p.evaluate(function () {
          try {
            return (JSON.parse(sessionStorage.getItem('easKpi1Filters') || '{}')
                   ).fKpi1Standard;
          } catch (e) { return ''; }
        }) === 'EAS');

  await p.click('.standard-opt[data-standard="COMPANY"]');
  await p.waitForFunction(function () {
    const h = document.getElementById('cmpKpiHint');
    return h && /90%/.test(h.textContent);
  }, null, { timeout: 20000 });


  // =======================================================================
  console.log('');
  console.log('  Switching to the KPI that counts quarters');
  // =======================================================================
  await p.selectOption('#cmpKpi', 'KPI2');
  await p.waitForFunction(function () {
    const h = document.getElementById('cmpHeading');
    return h && /Quarter/.test(h.textContent);
  }, null, { timeout: 20000 });
  await p.waitForTimeout(300);

  check('THE WHOLE PICKER IS RETITLED - leaving "First Month" over a list ' +
        'of quarters is how you pick the wrong thing',
        (await p.textContent('#cmpHeading')) === 'Quarter Comparison' &&
        /First Quarter/.test(await p.textContent('#cmpM1Label')),
        await p.textContent('#cmpHeading') + ' / ' +
        await p.textContent('#cmpM1Label'));

  check('and the boxes now hold quarters, not months',
        await p.evaluate(function () {
          return Array.prototype.slice
            .call(document.querySelectorAll('#cmpM1 option'))
            .map(function (o) { return o.value; })
            .filter(Boolean)
            .every(function (v) { return /^\d{4}-Q[1-4]$/.test(v); });
        }));

  check('THE RESULTS FROM THE OTHER KPI ARE GONE, not left under the new ' +
        'name',
        await p.isHidden('#cmpOverallCard') &&
        await p.isHidden('#cmpChartCard'));

  check('the standard toggle goes with them - KPI 2 has one target',
        await p.isHidden('#cmpStandardWrap'));

  check('AND THE HINT MARKS IT AS AN INTERNAL MEASURE',
        /internal measure/.test(await p.textContent('#cmpKpiHint')),
        await p.textContent('#cmpKpiHint'));

  /*
    NO TWO BOXES ON THE SAME PERIOD. App.html records what this used to do:
    the first box lost its month, fell back to the newest, which the second
    box already held - so both read the same and Compare refused to run.
  */
  check('the two required boxes landed on different quarters',
        (await p.inputValue('#cmpM1')) !== (await p.inputValue('#cmpM2')) &&
        Boolean(await p.inputValue('#cmpM1')) &&
        Boolean(await p.inputValue('#cmpM2')),
        (await p.inputValue('#cmpM1')) + ' / ' + (await p.inputValue('#cmpM2')));

  await p.click('#cmpRun');
  await compareShown(p);

  const q = await tableOf(p, '#cmpOverall');
  check('A QUARTER COMPARISON CAME BACK, with quarters down the side',
        /Quarter \d \(2099\)/.test(q.rows[0][0]), JSON.stringify(q.rows[0]));
  check('AND NAMED THE WAY THE KPI 2 SCREEN NAMES THEM, months and all',
        /Quarter \d \(2099\) \u00b7 \w{3}\u2013\w{3}/.test(q.rows[0][0]),
        q.rows[0][0]);
  check('and the columns are KPI 2\'s, not KPI 1\'s',
        q.head.indexOf('Received') === -1 &&
        q.head.join(' ').length > 0,
        JSON.stringify(q.head));
  check('THE CARD TITLE SAYS KPI 2, so a figure cannot be read as KPI 1\'s',
        /^KPI 2/.test(await p.textContent('#cmpOverallTitle')),
        await p.textContent('#cmpOverallTitle'));

  const qSections = await tableOf(p, '#cmpSections');
  check('and the breakdown is by whatever KPI 2 calls its sections',
        qSections.head.length >= 2 && qSections.rows.length >= 1,
        JSON.stringify(qSections.head));


  // =======================================================================
  console.log('');
  console.log('  The four refusals');
  // =======================================================================
  await p.selectOption('#cmpKpi', 'KPI1');
  await p.waitForFunction(function () {
    return /Month/.test(document.getElementById('cmpHeading').textContent);
  }, null, { timeout: 20000 });

  await p.selectOption('#cmpM2', '');
  await p.selectOption('#cmpM3', '');
  await p.selectOption('#cmpM4', '');
  await p.click('#cmpRun');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 20000 });
  let dlg = await dialogText(p);
  check('one period is refused, by name',
        /Two months are needed/.test(dlg.title), JSON.stringify(dlg.title));
  await closeDialog(p);
  check('AND THE PROMPT IS PUT BACK, rather than leaving a blank screen',
        await p.isVisible('#cmpEmpty') &&
        /Pick two different months/.test(await p.textContent('#cmpEmpty')),
        (await p.textContent('#cmpEmpty')).slice(0, 80));

  await p.selectOption('#cmpM1', '2099-03');
  await p.selectOption('#cmpM2', '2099-03');
  await p.click('#cmpRun');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 20000 });
  check('THE SAME MONTH TWICE IS ONE MONTH, not two columns of it',
        /Two months are needed/.test((await dialogText(p)).title));
  await closeDialog(p);

  await p.selectOption('#cmpKpi', 'KPI3');
  await p.waitForTimeout(250);
  await p.click('#cmpRun');
  await p.waitForFunction(function () {
    return /has no data yet/.test(document.getElementById('cmpEmpty').textContent);
  }, null, { timeout: 20000 });
  const pending = await p.textContent('#cmpEmpty');
  check('AN INDICATOR WITH NO INGEST EXPLAINS ITSELF rather than failing',
        /Incident Notification Timeliness has no data yet/.test(pending),
        pending.slice(0, 90));
  check('and prints its definition, so the screen is still useful',
        /Layer 1/.test(pending) && /Formula:/.test(pending),
        pending.slice(0, 200));
  check('with no results left on screen from the KPI before it',
        await p.isHidden('#cmpOverallCard'));


  // =======================================================================
  console.log('');
  console.log('  Clear');
  // =======================================================================
  await p.selectOption('#cmpKpi', 'KPI1');
  await p.waitForTimeout(250);
  await p.click('#cmpRun');
  await compareShown(p);
  await p.click('#cmpClear');
  await p.waitForTimeout(250);
  check('Clear takes the results away',
        await p.isHidden('#cmpOverallCard') &&
        await p.isHidden('#cmpChartCard'));
  check('AND PUTS THE FIRST TWO BACK rather than emptying them - they are ' +
        'required, so empty is never a useful state',
        Boolean(await p.inputValue('#cmpM1')) &&
        Boolean(await p.inputValue('#cmpM2')) &&
        !(await p.inputValue('#cmpM3')));
  check('and the prompt is the prompt again, not a stale warning',
        /Nothing compared yet/.test(await p.textContent('#cmpEmpty')),
        (await p.textContent('#cmpEmpty')).slice(0, 60));

  check('THE TREND SURVIVED ALL OF THAT - it is not part of the comparison',
        await p.isVisible('#cmpTrendCard'));


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
                        " WHERE ticket_id LIKE 'TEST-CMP-%'"))[0].n === 0);
  check('no test responses are left behind',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-CMP%'"))[0].n === 0);

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
