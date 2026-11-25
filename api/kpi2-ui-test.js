/**
 * THE KPI 2 SCREEN, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node kpi2-ui-test.js
 *
 * kpi2-equivalence-test.js proves the arithmetic against the original over
 * 27,991 comparisons. kpi2-read-test.js proves the reading. This proves
 * the screen: that the tiles say what the figures say, that the three
 * tables and the two charts are built from the right rows, and that the
 * four notices appear when they should and stay quiet when they should not.
 *
 * THE FIXTURE IS SCOPED TO ITS OWN QUARTER. Everything with a number in it
 * asks for 2099-Q1, where nothing but this fixture can exist - the same
 * mistake the KPI 1 suite made first, where asserting against All quarters
 * was asserting about somebody's whole database.
 *
 * Every row it makes is named 'TEST-K2UI-...' and swept at both ends.
 */
require('dotenv').config();
const db = require('./db');
const { signToken } = require('./auth');
const browser = require('../tests/harness/browser');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PAGE = BASE + '/kpi2.html';

const QUARTER = '2099-Q1';
const MONTH = '2099-02';
const FILE_MM = 'TEST-K2UI Q1-2099 Inventory.xlsx';     // names a module and a quarter
const FILE_NONE = 'TEST-K2UI nothing in this name.xlsx'; // names neither

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
  await db.query("DELETE FROM training WHERE response_id LIKE 'TEST-K2UI%'");
  await db.query("DELETE FROM upload_run WHERE file_names LIKE '%TEST-K2UI%'");
}


let n = 0;
/**
 * One response.
 *
 * `answers` is the seven in order. '' is a question left blank, which
 * COUNT_NON_RESPONSES says is applicable and not positive.
 */
async function response(file, zone, answers, opts) {
  const o = opts || {};
  n++;
  await db.query(
    `INSERT INTO training (response_id, month, session_date, module,
                           session_title, trainer, plant, employee_id,
                           employee_name, q1_overall, q2_relevance,
                           q3_knowledge, q4_explanation, q5_materials,
                           q6_confidence, q7_duration, source_file, zone,
                           uploaded_at)
     VALUES ($1,$2,($2 || '-15 10:00+06')::timestamptz,$3,$4,'','',
             '','', $5,$6,$7,$8,$9,$10,$11, $12,$13, now())`,
    [file + '#' + n, o.month || MONTH, o.module || '',
     o.title || 'TEST-K2UI session',
     answers[0], answers[1], answers[2], answers[3], answers[4],
     answers[5], answers[6], file, zone]);
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

  /*
    EVERY WORDING HERE IS ONE THE FORM ACTUALLY OFFERS, taken from
    FEEDBACK_ANSWERS - except the one that is deliberately not. Invented
    ones ('Very clear', 'Just right') read as unrecognised, which turned a
    fixture meant to score 89.80% into one scoring 61.22% and made every
    tile assertion wrong for a reason that had nothing to do with the
    screen.
  */
  const GOOD = ['Excellent', 'Relevant and useful', 'Excellent', 'Good',
                'Very helpful', 'Much more confident', 'Appropriate'];
  const MIXED = ['Average', 'Somewhat relevant', 'Excellent', 'Good',
                 'Very helpful', 'Much more confident', 'Appropriate'];
  const POOR = ['Poor', 'Relevant and useful', 'Excellent', 'Good',
                'Very helpful', 'Much more confident', 'Appropriate'];
  const BLANK = ['Excellent', '', 'Excellent', 'Good',
                 'Very helpful', 'Much more confident', 'Appropriate'];
  // The one that is not on the form, on purpose.
  const ODD = ['Brilliant actually', 'Relevant and useful', 'Excellent',
               'Good', 'Very helpful', 'Much more confident', 'Appropriate'];

  /*
    FIVE ATTENDEES, THIRTY-FIVE ANSWERS, AND EVERY TIER REPRESENTED.

      3 all-positive  = 21 positive
      1 with one Average and one Not relevant (Poor)
      1 with a blank, and one wording nobody put on the form

    So the screen has something to say in every one of its four notices
    and every slice of the doughnut - which is the point: a fixture where
    all the answers are good leaves half the screen untested.
  */
  await response(FILE_MM, 'KEPZ', GOOD);
  await response(FILE_MM, 'KEPZ', GOOD);
  await response(FILE_MM, 'DEPZ', GOOD);
  await response(FILE_MM, 'DEPZ', MIXED);
  await response(FILE_MM, 'KEPZ', POOR);
  await response(FILE_MM, 'KEPZ', BLANK);
  await response(FILE_NONE, 'KEPZ', ODD);

  // An upload that owns both files, so nothing here reads as an orphan.
  await db.query(
    `INSERT INTO upload_run (upload_id, uploaded_by, file_names, report_types,
                             departments, rows_in_file, rows_added, notes)
     VALUES ('UPL-TEST-K2UI', 'TEST-K2UI', $1, 'FEEDBACK', 'MM', 7, 7, 'complete')`,
    [FILE_MM + ' | ' + FILE_NONE]);

  const token = signToken('TEST-K2UI-admin', 'MASTER');

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
    const why = (r.failure() || {}).errorText || '';
    if (/ERR_ABORTED/.test(why)) return;
    badRequests.push('could not be reached: ' + r.url() + ' (' + why + ')');
  });

  await p.goto(BASE + '/kpi2.html');
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); }, token);
  const charts = await provideChartJs(p);
  await p.goto(PAGE);
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
          'KPI 2: SAP User Training Satisfaction') === 0);
  check('THE CHART LIBRARY IS ASKED FOR BY THE NAME THE CDN USES',
        await p.evaluate(function () {
          return Array.prototype.slice.call(document.querySelectorAll('script'))
            .some(function (s) {
              return /cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\//.test(s.src);
            });
        }));
  /*
    THE LINE THAT KEEPS THIS FIGURE IN ITS PLACE.

    Config.gs: TVL-KPI-001 section 5.3 names three indicators for EAS and
    this is not one of them, so it "must never be presented as though it
    were". Without that sentence the screen looks exactly like KPI 1's,
    and a figure off it lands in a pack beside one that is a policy KPI.
  */
  const notPolicy = await p.textContent('#kpi2NotPolicy');
  check('THE SCREEN SAYS THIS IS NOT A POLICY KPI',
        /Not a policy KPI/.test(notPolicy) && /TVL-KPI-001/.test(notPolicy),
        notPolicy.slice(0, 120));
  check('and says what it is instead',
        /the team's own measure/.test(notPolicy), notPolicy.slice(-90));

  // Everything with a number in it is read for this quarter alone.
  await p.selectOption('#kpi2Month', QUARTER);
  await settled(p);
  check('the quarter can be chosen, and is named in full',
        /Quarter 1 \(2099\)/.test(await p.textContent('#kpi2Month')),
        await p.textContent('#kpi2Month'));


  // =======================================================================
  console.log('');
  console.log('  The five figures');
  // =======================================================================
  /*
    THE ARITHMETIC, WORKED OUT BY HAND.

      7 attendees x 7 questions          = 49 answers
      positive: 3x7 + 5 + 6 + 6 + 6      = 44
      average:  2  (MIXED's Average and Somewhat relevant)
      poor:     1  (the Poor)
      blank:    1  - applicable, not positive
      unknown:  1  - applicable, not positive
                     44 + 2 + 1 + 1 + 1  = 49
      applicable = 49 (blanks count), positive 44
      44/49 = 89.795... -> 89.80%, which is YELLOW at a 90% target
                           with an 81% floor.

    89.80% is deliberately just under: a fixture that scored GREEN would
    never exercise the band, and this is the KPI where "nearly there"
    is the interesting case.
  */
  const tiles = await readTiles(p);
  check('five tiles are drawn', tiles.length === 5,
        String(tiles.length) + ': ' + tiles.map(function (t) { return t.label; }).join(', '));

  const rate = tiles.filter(function (t) { return t.label === 'Success Rate'; })[0];
  check('THE RATE IS THE ONE THE ANSWERS GIVE', rate && rate.value === '89.80%',
        rate && rate.value);
  check('and it is banded YELLOW - under 90, over the 81 floor',
        rate && /YELLOW/.test(rate.note), rate && rate.note);
  check('with the target and the gap beside it',
        rate && /target 90%/.test(rate.note) && /\u22120\.20 pts/.test(rate.note),
        rate && rate.note);

  const attendees = tiles.filter(function (t) { return t.label === 'Attendees'; })[0];
  check('Attendees counts respondents, not answers',
        attendees && attendees.value === '7', attendees && attendees.value);

  const positive = tiles.filter(function (t) { return t.label === 'Positive'; })[0];
  check('Positive counts positive answers', positive && positive.value === '44',
        positive && positive.value);
  check('of all the applicable ones, blanks included',
        positive && /of 49 applicable responses/.test(positive.note),
        positive && positive.note);

  const notPositive = tiles.filter(function (t) {
    return t.label === 'Not Positive';
  })[0];
  check('Not Positive counts the average and poor ones',
        notPositive && notPositive.value === '3', notPositive && notPositive.value);
  check('and breaks them out, because 95% with three Poor answers is a ' +
        'different conversation from 95% with none',
        notPositive && /2 average/.test(notPositive.note) &&
        /1 poor/.test(notPositive.note), notPositive && notPositive.note);


  // =======================================================================
  console.log('');
  console.log('  The four things it warns about');
  // =======================================================================
  /*
    A BLANK ANSWER AND AN UNKNOWN WORDING BOTH LOWER THE RATE, which is
    the safe direction - but an unknown wording means the form has
    changed, and leaving it unknown means next quarter reads lower for a
    reason nobody will find.
  */
  const unknown = await p.textContent('#kpi2Unknown');
  check('AN ANSWER NOBODY PUT ON THE FORM IS NAMED',
        !(await p.isHidden('#kpi2Unknown')) &&
        /Brilliant actually/.test(unknown), unknown.slice(0, 160));
  check('and the screen says which way it moved the rate',
        /counted as applicable but not positive/.test(unknown));

  const unassigned = await p.textContent('#kpi2Unassigned');
  check('A FILE THE FILENAME COULD NOT PLACE IS NAMED',
        !(await p.isHidden('#kpi2Unassigned')) &&
        new RegExp(FILE_NONE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .test(unassigned), unassigned.slice(0, 200));
  check('and says its responses still count',
        /are counted in the KPI/.test(unassigned));

  check('a file that names its module is NOT in that list',
        unassigned.indexOf(FILE_MM) === -1, unassigned.slice(0, 200));

  const undated = await p.textContent('#kpi2Undated');
  check('A FILE THAT NAMES NO QUARTER IS NAMED TOO',
        !(await p.isHidden('#kpi2Undated')) &&
        new RegExp(FILE_NONE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .test(undated), undated.slice(0, 200));
  check('and the one that does name a quarter is not',
        undated.indexOf(FILE_MM) === -1, undated.slice(0, 200));

  /*
    THIS SUITE'S OWN RESPONSES ARE NOT ORPHANS, because the upload above
    names both their files. Asserting that the notice is HIDDEN asserts
    that nobody else's responses are orphaned either, which is a fact
    about somebody's database and not about this screen - and on a machine
    with real wreckage on it, it fails.
  */
  const orphanSql =
    "SELECT count(*)::int AS n FROM training t WHERE NOT EXISTS (" +
    " SELECT 1 FROM upload_run u," +
    "        unnest(string_to_array(u.file_names, ' | ')) AS f" +
    "  WHERE btrim(f) = btrim(t.source_file)" +
    "     OR left(t.response_id, length(btrim(f)) + 1) = btrim(f) || '#')";
  const mine = (await db.query(orphanSql +
    " AND t.response_id LIKE 'TEST-K2UI%'"))[0].n;
  check('this suite\'s responses are not orphans - their upload names them',
        mine === 0, String(mine));

  const allOrphans = (await db.query(orphanSql))[0].n;
  check('and the notice says whatever the true number is, or nothing at all',
        allOrphans === 0
          ? await p.isHidden('#kpi2Orphans')
          : !(await p.isHidden('#kpi2Orphans')) &&
            new RegExp(allOrphans.toLocaleString('en-US') + ' training response')
              .test(await p.textContent('#kpi2Orphans')),
        allOrphans + ' | ' +
        (await p.textContent('#kpi2Orphans')).slice(0, 90));


  // =======================================================================
  console.log('');
  console.log('  By module, by question, by zone');
  // =======================================================================
  const modules = await readTable(p, '#kpi2Modules');
  check('both modules are listed - the named one and (unassigned)',
        modules.length === 2,
        JSON.stringify(modules.map(function (r) { return r[0]; })));
  check('A FILE THE FILENAME COULD NOT PLACE GOES UNDER (unassigned)',
        modules.some(function (r) { return r[0] === '(unassigned)'; }),
        JSON.stringify(modules.map(function (r) { return r[0]; })));
  const mm = modules.filter(function (r) { return r[0] === 'MM'; })[0];
  check('the named module took the six responses from its file',
        mm && mm[1] === '6', mm && mm.join(' | '));

  await p.selectOption('#fModule', 'MM');
  await settled(p);
  check('the module filter narrows the table',
        (await readTable(p, '#kpi2Modules')).length === 1);
  check('and says how many of how many',
        /1 of 2 modules/.test(await p.textContent('#cModule')),
        await p.textContent('#cModule'));
  await p.click('#fModuleReset');
  await settled(p);

  const questions = await readTable(p, '#kpi2Questions');
  check('all seven questions are listed', questions.length === 7,
        String(questions.length));
  check('each one scored over its own answers',
        questions.every(function (r) { return /%$/.test(r[5]); }),
        JSON.stringify(questions.map(function (r) { return r[0] + ':' + r[5]; })));
  const q1 = questions[0];
  check('the first question carries the Average and the unknown wording',
        q1 && q1[1] === '7' && q1[3] === '1', q1 && q1.join(' | '));

  const zones = await readTable(p, '#kpi2Zones');
  check('the zones are listed', zones.length >= 2,
        JSON.stringify(zones.map(function (r) { return r[0]; })));
  /*
    A ZONE WITH NO TRAINING IN THE PERIOD SHOWS A DASH, NOT 0.00%.

    The zones are seeded, so an empty one is a real row with nothing in
    it. A rate of 0.00% against a 90% target would band it RED and read as
    a zone that did badly, when what happened is that nothing happened
    there.
  */
  const empty = zones.filter(function (r) { return r[2] === '0'; })[0];
  check('A ZONE WITH NO ATTENDEES SHOWS A DASH, NOT A FAILING RATE',
        !empty || (empty[7] === '\u2014' && empty[8] === '\u2014'),
        empty && empty.join(' | '));

  await p.selectOption('#fZone', zones[0][0]);
  await settled(p);
  check('the zone filter narrows the table',
        (await readTable(p, '#kpi2Zones')).length === 1);
  await p.click('#fZoneReset');
  await settled(p);


  // =======================================================================
  console.log('');
  console.log('  The charts');
  // =======================================================================
  const bars = await chartConfig(p, 'chartFeedbackModule');
  check('one bar per module for a single quarter',
        bars && bars.labels.length === 2, bars && JSON.stringify(bars.labels));
  check('the title says so',
        (await p.textContent('#kpi2ModuleTitle')) === 'Satisfaction by module',
        await p.textContent('#kpi2ModuleTitle'));
  check('with the target line drawn and labelled',
        bars && bars.targetLine && bars.targetLine.value === 90,
        bars && JSON.stringify(bars.targetLine));

  const mix = await chartConfig(p, 'chartFeedbackMix');
  check('the mix chart is a doughnut of the tiers',
        mix && mix.type === 'doughnut', mix && mix.type);
  /*
    EVERY TIER THAT OCCURRED, AND NONE THAT DID NOT. A legend entry for a
    tier nobody chose reads as a tier that exists in this data.
  */
  check('every tier that occurred is a slice',
        mix && ['Positive', 'Average', 'Poor', 'No response', 'Unrecognised']
          .every(function (label) { return mix.labels.indexOf(label) !== -1; }),
        mix && JSON.stringify(mix.labels));
  check('and the slices add up to every answer given',
        mix && mix.data.reduce(function (a, v) { return a + v; }, 0) === 49,
        mix && JSON.stringify(mix.data));

  await p.selectOption('#kpi2Month', 'ALL');
  await settled(p);
  check('ACROSS ALL QUARTERS THE BARS BECOME QUARTERS, not modules',
        (await p.textContent('#kpi2ModuleTitle')) === 'Satisfaction by quarter',
        await p.textContent('#kpi2ModuleTitle'));
  await p.selectOption('#kpi2Month', QUARTER);
  await settled(p);


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
  check('no test responses are left behind',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-K2UI%'"))[0].n === 0);

  console.log('');
  console.log('  ' + passed + ' passed, ' + failed + ' failed');
  recap();
  console.log('');
  process.exit(failed ? 1 : 0);
}


async function settled(p) {
  await p.waitForFunction(function () {
    return window.__kpi2Screen && document.getElementById('kpi2Tiles');
  }, null, { timeout: 20000 });
  await p.waitForTimeout(350);
}


async function readTiles(p) {
  return p.evaluate(function () {
    return Array.prototype.slice.call(document.querySelectorAll('.tile'))
      .filter(function (t) { return !t.classList.contains('tile-empty'); })
      .map(function (t) {
        return {
          label: (t.querySelector('.tile-label') || {}).textContent || '',
          value: (t.querySelector('.tile-value') || {}).textContent || '',
          note: (t.querySelector('.tile-note') || {}).textContent || ''
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


async function chartConfig(p, canvasId) {
  return p.evaluate(function (id) {
    const chart = window.__kpi2Screen.chartOn(id);
    if (!chart) return null;
    const first = chart.config.data.datasets[0];
    const plugins = (chart.config.options || {}).plugins || {};
    return {
      type: chart.config.type,
      labels: chart.config.data.labels,
      data: first.data,
      colours: Array.isArray(first.backgroundColor) ? first.backgroundColor
                                                    : [first.backgroundColor],
      targetLine: plugins.targetLine || null
    };
  }, canvasId);
}


async function provideChartJs(p) {
  const real = await p.evaluate(function () { return typeof Chart !== 'undefined'; });

  await p.addInitScript(function () {
    function Stub(ctx, config) {
      this.config = config;
      this.ctx = ctx;
      this.scales = {};
      this.destroy = function () {};
    }
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
