/**
 * THE KPI 1 SCREEN, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node kpi1-ui-test.js
 *
 * kpi-read-test.js proves the figures. This proves the screen that prints
 * them: that the tiles say what the figures say, that the two charts are
 * built from the right rows with the right colours and the right target
 * line, that every filter narrows what it claims to narrow, and that the
 * standard toggle changes the judgement without changing the counts.
 *
 * THE FIXTURE IS BUILT SO THE TWO STANDARDS DISAGREE. Fifteen tickets
 * scoring 92.86% is GREEN against the company's 90% and YELLOW against the
 * EAS team's 99.50% - same tickets, same arithmetic, different verdict.
 * A toggle that did nothing would pass a fixture where both agreed.
 *
 * ON CHART.JS. The page loads it from the CDN. Where that is unreachable
 * the suite puts a stand-in in its place which records the config it was
 * given - which is the half worth asserting anyway: the labels, the
 * numbers, the band colours and the target line are ours, and the drawing
 * is Chart.js's problem.
 *
 * Every row it makes is named 'TEST-K1-...' and swept at both ends.
 */
require('dotenv').config();
const db = require('./db');
const { signToken } = require('./auth');
const browser = require('../tests/harness/browser');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PAGE = BASE + '/kpi1.html';

const RUN = String(Math.floor(Math.random() * 90) + 10);
const P1 = 'Test Kpione ' + RUN;        // invented; not on the real chart
const P2 = 'Test Kpitwo ' + RUN;
const MFG = 'Manufacturing Applications';
const SLS = 'Sales Applications';

const MAY = '2099-05';
const JUN = '2099-06';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name); return; }
  failed++;
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
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K1-%'");
  await db.query("DELETE FROM roster WHERE display_name LIKE 'Test Kpi%'");
}


let n = 0;
async function ticket(month, who, section, opts) {
  const o = opts || {};
  n++;
  await db.query(
    `INSERT INTO ticket (ticket_id, in_charge, service, part, department,
                         affiliate, request_date, completion_date, delay_days,
                         in_dept, in_overall, last_updated)
     VALUES ($1,$2,'SAP',$3,$4,$5,
             ($6 || '-05 09:00+06')::timestamptz, $7, $8, true, true, now())`,
    ['TEST-K1-' + n, who, o.part === undefined ? 'MM' : o.part, section,
     o.affiliate === undefined ? 'TEST-AFF' : o.affiliate, month,
     o.open ? null : (month + '-06 17:00+06'),
     o.delay === undefined ? 0 : o.delay]);
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

  // Two invented people on the roster, so the sections on screen are the
  // roster's answer rather than the Department column's.
  await db.query(
    `INSERT INTO roster (person_key, display_name, section, is_former) VALUES
       ($1,$2,$3,false), ($4,$5,$6,false)
     ON CONFLICT (person_key) DO NOTHING`,
    [P1.toLowerCase().replace(/[^a-z]/g, ''), P1, MFG,
     P2.toLowerCase().replace(/[^a-z]/g, ''), P2, SLS]);

  /*
    MAY, BUILT TO A KNOWN ANSWER.

      P1, Manufacturing: 10 received, 10 completed, 1 delayed -> 9 on time
      P2, Sales:          5 received,  4 completed, 0 delayed -> 4 on time,
                                                                 1 still open

      June adds three more of P1's, all on time.

      May alone:   15 received, 14 completed, 1 delayed, 13 successful
      All months:  18 received, 17 completed, 1 delayed, 16 successful
                   16/17 = 94.117... -> 94.12%

    THE SCREEN OPENS ON ALL MONTHS, so that is the figure the tiles show
    first - the one-month numbers are what the picker is asked for later.
    Writing these assertions as if the page opened on May was the first
    thing this suite got wrong.

    94.12% is GREEN against the company's 90.00 and YELLOW against the EAS
    team's 99.50 (floor 89.55), so the toggle has something to change. And
    at 17 completed the company target permits exactly one delay -
    ceil(0.9 x 17) is 16, and 16 succeeded - so the headroom is 0 and the
    tile has to say so rather than printing a bare zero.
  */
  for (let i = 0; i < 9; i++) await ticket(MAY, P1, MFG);
  await ticket(MAY, P1, MFG, { delay: 4 });
  for (let i = 0; i < 4; i++) await ticket(MAY, P2, SLS, { part: 'SD' });
  await ticket(MAY, P2, SLS, { part: 'SD', open: true });

  // A second month, so the picker has two and All months differs from one.
  for (let i = 0; i < 3; i++) await ticket(JUN, P1, MFG, { affiliate: 'TEST-OTHER' });

  const token = signToken('TEST-K1-admin', 'MASTER');

  const b = await browser.launch();
  const context = await b.newContext();
  const p = await context.newPage();

  const thrown = [];
  const badRequests = [];
  p.on('pageerror', function (err) { thrown.push(String(err.message || err)); });
  p.on('console', function (m) {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      thrown.push(m.text());
    }
  });
  p.on('response', function (r) {
    if (r.status() >= 400) badRequests.push(r.status() + ' ' + r.url());
  });
  p.on('requestfailed', function (r) {
    badRequests.push('could not be reached: ' + r.url());
  });

  await p.goto(BASE + '/kpi1.html');
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); }, token);
  // A filter left over from another run would change what this one sees.
  await p.evaluate(function () { sessionStorage.removeItem('easKpi1Filters'); });

  const charts = await provideChartJs(p);
  await p.goto(PAGE);
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await provideChartJs(p);
  await p.reload();
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await settled(p);

  console.log('');
  console.log('  Charting with ' + (charts.real
    ? 'the real Chart.js, loaded from the CDN'
    : 'a stand-in that records what it was asked to draw'));


  // =======================================================================
  console.log('');
  console.log('  The screen itself');
  // =======================================================================
  check('the page is served and the sign-in card is out of the way',
        await p.isHidden('#signinCard'));
  check('the heading is the one the old screen had',
        (await p.textContent('.page-head h1')).indexOf(
          'KPI 1: Error/Issue Resolution Time') === 0);
  check('the design system loaded',
        await p.evaluate(function () {
          return getComputedStyle(document.documentElement)
            .getPropertyValue('--navy-900').trim() !== '';
        }));
  check('THE FORMULA IS QUOTED, not paraphrased',
        /Ticket Resolution Success Rate/.test(await p.textContent('#kpi1Sub')),
        await p.textContent('#kpi1Sub'));

  /*
    THE COVERAGE LINE IS ABOUT THE DATABASE, not the month on screen.
    'January to September' does not say whether September is a whole month
    or the first four days of one, and that decides whether the period's
    rate means anything yet.
  */
  const coverage = await p.textContent('#kpi1Coverage');
  check('the coverage line says what the stored tickets cover, to the day',
        /Data loaded from .* to /.test(coverage) && /tickets/.test(coverage),
        coverage);


  // =======================================================================
  console.log('');
  console.log('  The six figures');
  // =======================================================================
  const tiles = await readTiles(p);
  check('five tiles are drawn', tiles.length === 5,
        String(tiles.length) + ': ' + tiles.map(function (t) { return t.label; }).join(', '));

  const rate = tiles.filter(function (t) { return t.label === 'Success Rate'; })[0];
  check('THE SUCCESS RATE IS THE ONE THE FIGURES SAY', rate && rate.value === '94.12%',
        rate && rate.value);
  check('and it is banded GREEN against the company target',
        rate && /GREEN/.test(rate.note), rate && rate.note);
  check('with the target and the gap beside it',
        rate && /target 90%/.test(rate.note) && /\+4\.12 pts/.test(rate.note),
        rate && rate.note);

  const received = tiles.filter(function (t) { return t.label === 'Received'; })[0];
  check('Received counts every ticket in scope', received && received.value === '18',
        received && received.value);
  check('and says so without claiming a month it is not showing',
        received && /across all months/.test(received.note),
        received && received.note);

  const completed = tiles.filter(function (t) { return t.label === 'Completed'; })[0];
  check('Completed counts the completed ones', completed && completed.value === '17',
        completed && completed.value);
  check('with the on-time and still-open counts under it',
        completed && /16 on time/.test(completed.note) &&
        /1 still open/.test(completed.note), completed && completed.note);

  const delayed = tiles.filter(function (t) { return t.label === 'Delayed'; })[0];
  check('Delayed shows the share, not the count, as its headline',
        delayed && /%$/.test(delayed.value), delayed && delayed.value);
  check('and the count underneath', delayed && /1 delayed/.test(delayed.note),
        delayed && delayed.note);

  const headroom = tiles.filter(function (t) { return t.label === 'Headroom'; })[0];
  /*
    ZERO HEADROOM IS A SENTENCE, NOT A NUMBER. ceil(0.9 x 17) is 16 and 16
    succeeded, so one more delay drops the band - and a tile reading a bare
    "0" says none of that.
  */
  check('Headroom says what no headroom means',
        headroom && /one more delay drops the band/.test(headroom.note),
        headroom && headroom.note);
  check('and draws the budget to scale',
        headroom && headroom.bar !== null, headroom && String(headroom.bar));


  // =======================================================================
  console.log('');
  console.log('  Switching the standard');
  // =======================================================================
  /*
    THE SAME TICKETS, THE SAME ARITHMETIC, A DIFFERENT VERDICT. Nothing
    about the data changes - no second upload, no second table. What moves
    is the target the rate is judged against.
  */
  check('both standards are offered, with their targets printed on them',
        await p.evaluate(function () {
          const text = document.getElementById('kpi1StandardWrap').textContent;
          return /90/.test(text) && /99\.5/.test(text);
        }));
  check('the sentence under it names the document being answered to',
        /TVL-KPI-001/.test(await p.textContent('#kpi1StandardNote')),
        await p.textContent('#kpi1StandardNote'));

  await p.click('.standard-opt[data-standard="EAS"]');
  await settled(p);
  const easTiles = await readTiles(p);
  const easRate = easTiles.filter(function (t) {
    return t.label === 'Success Rate';
  })[0];
  check('THE RATE DOES NOT MOVE, because the counts did not',
        easRate && easRate.value === '94.12%', easRate && easRate.value);
  check('BUT THE BAND DOES: GREEN at 90%, YELLOW at 99.50%',
        easRate && /YELLOW/.test(easRate.note), easRate && easRate.note);
  check('and the target printed beside it follows',
        easRate && /target 99\.5%/.test(easRate.note), easRate && easRate.note);
  check('the gap is now negative, and says so with a minus rather than a dash',
        easRate && /\u22125\.38 pts/.test(easRate.note), easRate && easRate.note);
  check('the sentence under the toggle changed with it',
        /EAS team holds itself to/.test(await p.textContent('#kpi1StandardNote')),
        await p.textContent('#kpi1StandardNote'));
  check('and the pill beside the heading says it is below target',
        (await p.textContent('#kpi1Track')).trim() === 'Below target',
        await p.textContent('#kpi1Track'));

  await p.click('.standard-opt[data-standard="COMPANY"]');
  await settled(p);
  check('switching back restores the company verdict',
        (await p.textContent('#kpi1Track')).trim() === 'On target',
        await p.textContent('#kpi1Track'));


  // =======================================================================
  console.log('');
  console.log('  By section');
  // =======================================================================
  const sections = await readTable(p, '#kpi1Table');
  check('one row per section', sections.length === 2,
        JSON.stringify(sections.map(function (r) { return r[0]; })));
  const mfg = sections.filter(function (r) { return r[0] === MFG; })[0];
  check('Manufacturing has its thirteen tickets across the two months',
        mfg && mfg[1] === '13' && mfg[2] === '13', mfg && mfg.join(' | '));
  check('one of them delayed, twelve on time',
        mfg && mfg[4] === '1' && mfg[5] === '12', mfg && mfg.join(' | '));
  check('scoring 92.31%', mfg && mfg[6] === '92.31%', mfg && mfg[6]);
  const sls = sections.filter(function (r) { return r[0] === SLS; })[0];
  check('Sales has four completed of five, and one still open',
        sls && sls[1] === '5' && sls[2] === '4' && sls[3] === '1',
        sls && sls.join(' | '));
  check('AN OPEN TICKET IS NOT A FAILURE - it scores 100.00%',
        sls && sls[6] === '100.00%', sls && sls[6]);

  await p.selectOption('#fSection', MFG);
  await settled(p);
  check('the section filter narrows to one row',
        (await readTable(p, '#kpi1Table')).length === 1);
  check('and says how many of how many',
        /1 of 2 sections/.test(await p.textContent('#cSection')),
        await p.textContent('#cSection'));
  await p.click('#fSectionReset');
  await settled(p);
  check('reset puts them back', (await readTable(p, '#kpi1Table')).length === 2);


  // =======================================================================
  console.log('');
  console.log('  By module, and by individual');
  // =======================================================================
  const modules = await readTable(p, '#kpi1Modules');
  check('the modules are listed', modules.length >= 2,
        JSON.stringify(modules.map(function (r) { return r[0]; })));
  check('and busiest first',
        modules.length < 2 ||
        Number(modules[0][1].replace(/,/g, '')) >=
        Number(modules[1][1].replace(/,/g, '')),
        JSON.stringify(modules.map(function (r) { return r[0] + ':' + r[1]; })));

  await p.fill('#fModuleK1Name', 'mm');
  await settled(p);
  const mmOnly = await readTable(p, '#kpi1Modules');
  check('searching a module name narrows the table',
        mmOnly.every(function (r) { return /mm/i.test(r[0]); }),
        JSON.stringify(mmOnly.map(function (r) { return r[0]; })));
  await p.click('#fModuleK1Reset');
  await settled(p);

  const people = await readTable(p, '#kpi1AllPeople');
  check('one row per individual', people.length === 2,
        JSON.stringify(people.map(function (r) { return r[0]; })));
  check('THE BUSIEST PERSON IS FIRST', people[0] && people[0][0] === P1,
        people.map(function (r) { return r[0] + ':' + r[2]; }).join(', '));
  check('each carries the section the roster puts them in',
        people.filter(function (r) { return r[0] === P1; })[0][1] === MFG,
        people.filter(function (r) { return r[0] === P1; })[0][1]);

  await p.selectOption('#fAllSection', SLS);
  await settled(p);
  const salesOnly = await readTable(p, '#kpi1AllPeople');
  check('the section filter leaves only that section\'s people',
        salesOnly.length === 1 && salesOnly[0][0] === P2,
        JSON.stringify(salesOnly.map(function (r) { return r[0]; })));
  /*
    AND THE FIGURES BESIDE THE NAME DO NOT MOVE. A section is a fact about
    a person, so filtering by it hides rows; it does not re-score them.
  */
  check('and their figures are unchanged by it, because a section only hides rows',
        salesOnly[0][2] === people.filter(function (r) {
          return r[0] === P2;
        })[0][2], salesOnly[0][2]);
  await p.selectOption('#fAllSection', '');
  await settled(p);


  // =======================================================================
  console.log('');
  console.log('  By affiliate, which is a different kind of filter');
  // =======================================================================
  /*
    AN AFFILIATE IS A FACT ABOUT A TICKET, NOT ABOUT A PERSON, so choosing
    one RECOMPUTES every figure in the table from that affiliate's tickets
    alone. That is the opposite of what the section filter does, and the
    screen has to say so while it is on.
  */
  check('the affiliates are offered',
        await p.evaluate(function () {
          return Array.prototype.slice.call(
            document.querySelectorAll('#fAllAffiliate option'))
            .map(function (o) { return o.value; }).indexOf('TEST-AFF') !== -1;
        }));

  await p.selectOption('#fAllAffiliate', 'TEST-OTHER');
  await settled(p);
  const otherOnly = await readTable(p, '#kpi1AllPeople');
  check('CHOOSING ONE RE-SCORES THE TABLE, it does not just hide rows',
        otherOnly.length === 1 && otherOnly[0][0] === P1 &&
        otherOnly[0][2] === '3',
        JSON.stringify(otherOnly.map(function (r) { return r[0] + ':' + r[2]; })));
  check('and the screen says so while it is on',
        await p.evaluate(function () {
          const note = document.getElementById('kpi1AllNote');
          return !note.hidden && /not a slice of the ones above/.test(note.textContent);
        }));
  await p.selectOption('#fAllAffiliate', '');
  await settled(p);
  check('clearing it puts the whole table back',
        (await readTable(p, '#kpi1AllPeople')).length === 2);
  check('and takes the note away',
        await p.isHidden('#kpi1AllNote'));


  // =======================================================================
  console.log('');
  console.log('  The month picker');
  // =======================================================================
  check('both months are offered, and All months',
        await p.evaluate(function () {
          return document.querySelectorAll('#monthPickerMenu .picker-option').length === 3;
        }));
  check('it opens on All months',
        /All months/.test(await p.textContent('#monthPickerLabel')),
        await p.textContent('#monthPickerLabel'));

  await p.click('#monthPicker');
  await p.click('#monthPickerMenu .picker-option[data-month="' + MAY + '"]');
  await settled(p);
  check('CHOOSING ONE MONTH SCORES ONLY THAT MONTH',
        await p.evaluate(function () {
          const tile = Array.prototype.slice.call(
            document.querySelectorAll('.tile')).filter(function (t) {
              const label = t.querySelector('.tile-label');
              return label && label.textContent === 'Received';
            })[0];
          return tile && tile.querySelector('.tile-value').textContent === '15';
        }));
  check('and the picker says which',
        (await p.textContent('#monthPickerLabel')).trim() === 'May 2099',
        await p.textContent('#monthPickerLabel'));
  check('and the Received tile stops saying "all months"',
        await p.evaluate(function () {
          const tile = Array.prototype.slice.call(
            document.querySelectorAll('.tile')).filter(function (t) {
              const label = t.querySelector('.tile-label');
              return label && label.textContent === 'Received';
            })[0];
          return /tickets this month/.test(tile.querySelector('.tile-note').textContent);
        }));

  await p.click('#monthPickerMenu .picker-option[data-month="' + JUN + '"]');
  await settled(p);
  check('TWO MONTHS AT ONCE IS A THING THE PICKER CAN SAY',
        /2 months selected/.test(await p.textContent('#monthPickerLabel')),
        await p.textContent('#monthPickerLabel'));
  check('and the figures are the sum of both, not an average of their rates',
        await p.evaluate(function () {
          const tile = Array.prototype.slice.call(
            document.querySelectorAll('.tile')).filter(function (t) {
              const label = t.querySelector('.tile-label');
              return label && label.textContent === 'Received';
            })[0];
          return tile.querySelector('.tile-value').textContent === '18';
        }));

  await p.click('#monthPickerMenu .picker-option[data-month="ALL"]');
  await settled(p);
  check('All months is exclusive - choosing it clears the rest',
        (await p.evaluate(function () {
          return document.querySelectorAll('#monthPickerMenu .picker-option.is-on').length;
        })) === 1);


  // =======================================================================
  console.log('');
  console.log('  The charts');
  // =======================================================================
  const rateChart = await chartConfig(p, 'chartRate');
  check('the rate chart is drawn from the sections', Boolean(rateChart));
  check('one bar per section, labelled short enough for an axis',
        rateChart && rateChart.labels.length === 2 &&
        rateChart.labels.indexOf('Manufacturing') !== -1,
        rateChart && JSON.stringify(rateChart.labels));
  check('with each section\'s rate on it',
        rateChart && rateChart.data.indexOf(92.31) !== -1 &&
        rateChart.data.indexOf(100) !== -1,
        rateChart && JSON.stringify(rateChart.data));
  check('COLOURED BY BAND, not by position in the list',
        rateChart && rateChart.colours.length === 2 &&
        rateChart.colours.every(function (c) { return /^#/.test(c); }),
        rateChart && JSON.stringify(rateChart.colours));
  check('AND THE TARGET LINE IS THE TARGET, drawn and labelled',
        rateChart && rateChart.targetLine &&
        rateChart.targetLine.value === 90 &&
        /Target 90%/.test(rateChart.targetLine.label),
        rateChart && JSON.stringify(rateChart.targetLine));
  /*
    THE AXIS DOES NOT START AT ZERO, and the note says so. Four sections
    between 98 and 100 against a 0-100 axis are four identical bars; the
    chart exists to show the difference between them.
  */
  check('the axis starts below the lowest bar, not at zero',
        rateChart && rateChart.yMin > 0 && rateChart.yMin < 92.31,
        rateChart && String(rateChart.yMin));
  check('and the note says so, so nobody reads the heights as proportions',
        /Axis starts at/.test(await p.textContent('#chartRateNote')),
        await p.textContent('#chartRateNote'));

  const delayChart = await chartConfig(p, 'chartDelay');
  check('the delay chart counts delays, one bar per section',
        delayChart && delayChart.data.length === 2 &&
        delayChart.data.indexOf(1) !== -1,
        delayChart && JSON.stringify(delayChart.data));
  check('and counts from zero, because a count is a count',
        delayChart && delayChart.beginAtZero === true);
  check('with no target line on it - there is no target for delays',
        delayChart && !delayChart.targetLine);


  // =======================================================================
  console.log('');
  console.log('  A month with nothing in it');
  // =======================================================================
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-K1-%'");
  await p.click('#refreshKpi1');
  await settled(p);
  check('THE TILES SAY SO RATHER THAN SHOWING THE LAST MONTH\'S',
        /No data/.test(await p.textContent('#kpi1Tiles')),
        (await p.textContent('#kpi1Tiles')).slice(0, 80));
  check('the tables empty out too',
        /Upload an ITSM export/.test(await p.textContent('#kpi1Table')),
        (await p.textContent('#kpi1Table')).slice(0, 80));
  check('and the pill beside the heading goes, rather than keeping a verdict',
        await p.isHidden('#kpi1Track'));


  // =======================================================================
  console.log('');
  console.log('  Nothing on fire in the console');
  // =======================================================================
  check('the page threw nothing', thrown.length === 0,
        thrown.slice(0, 3).join(' | '));
  const unexpected = badRequests.filter(function (r) {
    return !/cdnjs\.cloudflare\.com/.test(r);
  });
  check('every file the page asked for was served', unexpected.length === 0,
        unexpected.slice(0, 4).join(' | '));

  await p.close();
  await context.close();
  await b.close();

  await sweep();
  check('no test tickets are left behind',
        (await db.query("SELECT count(*)::int AS n FROM ticket" +
                        " WHERE ticket_id LIKE 'TEST-K1-%'"))[0].n === 0);

  console.log('');
  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  recap();
  console.log('');
  process.exit(failed ? 1 : 0);
}


// ---------------------------------------------------------------------------
// driving the page
// ---------------------------------------------------------------------------

/** Waits for the screen to stop moving: no pending fetch, tiles drawn. */
async function settled(p) {
  await p.waitForFunction(function () {
    return window.__kpi1Screen && document.getElementById('kpi1Tiles');
  }, null, { timeout: 20000 });
  // The renders are driven by awaited fetches; one animation frame after
  // the network is quiet is enough, and waiting on a spinner that does not
  // exist would be worse.
  await p.waitForTimeout(350);
}


async function readTiles(p) {
  return p.evaluate(function () {
    return Array.prototype.slice.call(document.querySelectorAll('.tile'))
      .filter(function (t) { return !t.classList.contains('tile-empty'); })
      .map(function (t) {
        const bar = t.querySelector('.tile-bar i');
        return {
          label: (t.querySelector('.tile-label') || {}).textContent || '',
          value: (t.querySelector('.tile-value') || {}).textContent || '',
          note: (t.querySelector('.tile-note') || {}).textContent || '',
          bar: bar ? bar.style.width : null
        };
      });
  });
}


async function readTable(p, selector) {
  return p.evaluate(function (sel) {
    const body = document.querySelector(sel + ' tbody');
    if (!body) return [];
    return Array.prototype.slice.call(body.querySelectorAll('tr'))
      .filter(function (tr) { return !tr.querySelector('.empty'); })
      .map(function (tr) {
        return Array.prototype.slice.call(tr.cells).map(function (td) {
          return td.textContent.trim();
        });
      });
  }, selector);
}


/** What a chart was actually asked to draw. */
async function chartConfig(p, canvasId) {
  return p.evaluate(function (id) {
    const chart = window.__kpi1Screen.chartOn(id);
    if (!chart) return null;
    const first = chart.config.data.datasets[0];
    const plugins = (chart.config.options || {}).plugins || {};
    const y = ((chart.config.options || {}).scales || {}).y || {};
    return {
      labels: chart.config.data.labels,
      data: first.data,
      colours: Array.isArray(first.backgroundColor) ? first.backgroundColor
                                                    : [first.backgroundColor],
      targetLine: plugins.targetLine || null,
      yMin: y.min,
      beginAtZero: y.beginAtZero === true
    };
  }, canvasId);
}


/**
 * Makes sure the page has a Chart to draw with, and records the configs.
 *
 * On a machine that can reach the CDN this leaves the real library in
 * place and only remembers what it was handed. Where it cannot, a
 * stand-in takes over - which is enough, because what this suite asserts
 * about a chart is the part that is ours: the labels, the numbers, the
 * band colours and the target line. Whether Chart.js can then paint them
 * is Chart.js's problem and is not improved by a test here.
 */
async function provideChartJs(p) {
  const real = await p.evaluate(function () { return typeof Chart !== 'undefined'; });

  await p.addInitScript(function () {
    function Stub(ctx, config) {
      this.config = config;
      this.ctx = ctx;
      this.scales = {};
      this.destroy = function () {};
    }
    // Only if the real one did not arrive. addInitScript runs before the
    // page's own scripts, so the CDN tag still gets its chance.
    window.addEventListener('DOMContentLoaded', function () {
      if (typeof window.Chart === 'undefined') window.Chart = Stub;
    });
    if (typeof window.Chart === 'undefined') window.Chart = Stub;
  });

  return { real: real };
}


main().catch(function (err) {
  console.error('');
  console.error('  The suite itself broke: ' + (err && err.stack || err));
  recap();
  console.error('');
  process.exit(1);
});
