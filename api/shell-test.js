/**
 * THE SHELL, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node shell-test.js
 *
 * The sidebar and the top bar are the one piece of this front end that every
 * screen shows, so a mistake in them is a mistake on every page at once.
 * Three kinds of check:
 *
 *   STRUCTURAL. The nav is read out of src/Index.html - every button, its
 *     order, its label, its icon's path data, its role gate - and compared
 *     with what shell.js builds. Not a screenshot and not a guess: the
 *     original markup is the fixture. Edit the sidebar in Index.html and
 *     this says exactly which item drifted.
 *
 *   BEHAVIOURAL. Signed in as each of the three roles in turn, in a real
 *     browser: who sees which items, which item is lit, where a click
 *     actually lands, what a not-ported screen says, whether the collapse
 *     survives walking to another page, and whether Sign out signs out.
 *
 *   THE HANDOVER. Open Dashboard on the Uploads screen, which is the only
 *     place one screen sends you to another with something to say - the
 *     period - and the two receiving screens, which have to open on the
 *     period they were handed and fall back gracefully on one they cannot
 *     honour.
 *
 * ITS FIXTURE IS ITS OWN. Three tickets and one response, all in 2099, all
 * named TEST-SHELL, swept at both ends. Nothing here asserts a figure, so
 * nothing here cares what else is in the database - but a month and a
 * quarter have to EXIST before a picker can be asked to open on one.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { signToken } = require('./auth');
const browser = require('../tests/harness/browser');
const shell = require('./public/shell.js');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';

const MONTH = '2099-02';
const QUARTER = '2099-Q1';
const STALE_MONTH = '1999-01';
const STALE_QUARTER = '1999-Q1';

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


// ===========================================================================
// READING THE ORIGINAL
// ===========================================================================

function readSource(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
}

/** The handful of HTML entities Index.html's nav actually uses. */
function unentity(text) {
  return String(text)
    .replace(/&#xB7;/gi, '\u00b7')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

/**
 * The sidebar nav out of Index.html, in order.
 *
 * ANCHORED ON THE <nav class="nav"> BLOCK, not on the whole file: Portal.html
 * is included into the same document and has nav-items of its own, and a
 * regex let loose on the lot would compare this sidebar against the portal's
 * tabs and report a drift that is not one.
 *
 * Each entry is { kind: 'group'|'item', view, label, icon, gate }.
 */
function navFromIndex() {
  const source = readSource('Index.html');

  const start = source.indexOf('<nav class="nav">');
  const end = source.indexOf('</nav>', start);
  if (start === -1 || end === -1) {
    throw new Error('could not find <nav class="nav"> in src/Index.html - ' +
                    'the sidebar has been restructured, and this suite is ' +
                    'reading the wrong thing rather than nothing');
  }
  const nav = source.slice(start, end);

  const out = [];
  /*
    ONE PASS, BOTH SHAPES, SO THE ORDER IS THE FILE'S ORDER. Two separate
    scans would hand back every group and then every button, and the order
    of the sidebar - which is the thing most likely to be got wrong in a
    hand-written copy - would go untested.
  */
  const pattern = new RegExp(
    '<div class="nav-group-label"([^>]*)>([^<]*)</div>' +
    '|' +
    '<button class="nav-item[^"]*"([^>]*)>([\\s\\S]*?)</button>', 'g');

  let m;
  while ((m = pattern.exec(nav)) !== null) {
    if (m[2] !== undefined) {
      out.push({ kind: 'group', label: unentity(m[2]).trim(),
                 gate: gateOf(m[1]) });
      continue;
    }

    const attrs = m[3];
    const inner = m[4];

    const view = (attrs.match(/data-view="([^"]*)"/) || [])[1] || '';
    const label = unentity(
      (inner.match(/<span class="nav-text">([\s\S]*?)<\/span>/) || [])[1] || ''
    ).trim();
    const icon = ((inner.match(/<svg viewBox="0 0 16 16">([\s\S]*?)<\/svg>/) ||
                  [])[1] || '').trim();

    out.push({ kind: 'item', view: view, label: label, icon: icon,
               gate: gateOf(attrs) });
  }
  return out;
}

function gateOf(attrs) {
  const text = String(attrs || '');
  if (/data-master-only/.test(text)) return 'MASTER';
  if (/data-admin-only/.test(text)) return 'ADMIN';
  return '';
}

/** What shell.js's SCREENS table says, in the same shape. */
function navFromShell() {
  return shell.SCREENS.map(function (entry) {
    if (entry.group) {
      return { kind: 'group', label: entry.group, gate: entry.needs || '' };
    }
    return { kind: 'item', view: entry.view, label: entry.label,
             gate: entry.needs || '' };
  });
}


// ===========================================================================
// THE FIXTURE
// ===========================================================================

async function sweep() {
  await db.query("DELETE FROM ticket WHERE ticket_id LIKE 'TEST-SHELL-%'");
  await db.query("DELETE FROM training WHERE response_id LIKE 'TEST-SHELL%'");
  await db.query("DELETE FROM upload_run WHERE upload_id LIKE 'UPL-TEST-SHELL%'");
}

async function fixture() {
  /*
    THREE TICKETS IN ONE MONTH. Enough that 2099-02 exists in KPI 1's month
    picker, which is all this suite needs of them - it asserts about the
    picker, never about a rate.
  */
  for (let i = 1; i <= 3; i++) {
    await db.query(
      `INSERT INTO ticket (ticket_id, in_charge, service, part, department,
                           affiliate, request_date, completion_date,
                           delay_days, in_dept, in_overall, source_files,
                           last_updated)
       VALUES ($1, 'TEST-SHELL in charge', 'SAP', 'MM', 'MM', 'TEST-SHELL-AFF',
               ($2 || '-10 09:00+06')::timestamptz,
               ($2 || '-10 11:00+06')::timestamptz,
               0, true, true, 'TEST-SHELL overall.xlsx', now())`,
      ['TEST-SHELL-' + i, MONTH]);
  }

  /* One response, so 2099-Q1 exists in KPI 2's quarter picker. */
  await db.query(
    `INSERT INTO training (response_id, month, session_date, module,
                           session_title, trainer, plant, employee_id,
                           employee_name, q1_overall, q2_relevance,
                           q3_knowledge, q4_explanation, q5_materials,
                           q6_confidence, q7_duration, source_file, zone,
                           uploaded_at)
     VALUES ('TEST-SHELL-r1', $1, ($1 || '-15 10:00+06')::timestamptz,
             'Inventory Management', 'TEST-SHELL session', '', '', '', '',
             'Excellent', 'Relevant and useful', 'Excellent', 'Good',
             'Very helpful', 'Much more confident', 'Appropriate',
             'TEST-SHELL Q1-2099 Inventory.xlsx', 'KEPZ', now())`,
    [MONTH]);

  /*
    TWO HISTORY ROWS, one per indicator, each covering exactly one period -
    which is the case where Open Dashboard has a period to hand over. The
    spanning case is covered purely in uploads-ui-test.js; what is being
    tested here is that the handover arrives.
  */
  await db.query(
    `INSERT INTO upload_run (upload_id, uploaded_by, file_names, report_types,
                             departments, rows_in_file, rows_added,
                             date_from, date_to, notes)
     VALUES ('UPL-TEST-SHELL-T', 'TEST-SHELL', 'TEST-SHELL overall.xlsx',
             'OVERALL', 'MM', 3, 3, ($1 || '-01')::date, ($1 || '-28')::date,
             'complete')`,
    [MONTH]);
  await db.query(
    `INSERT INTO upload_run (upload_id, uploaded_by, file_names, report_types,
                             departments, rows_in_file, rows_added,
                             date_from, date_to, notes)
     VALUES ('UPL-TEST-SHELL-F', 'TEST-SHELL',
             'TEST-SHELL Q1-2099 Inventory.xlsx',
             'FEEDBACK', 'MM', 1, 1, ($1 || '-01')::date, ($1 || '-28')::date,
             'complete')`,
    [MONTH]);
}


// ===========================================================================
// DRIVING IT
// ===========================================================================

/** Opens a page already signed in as `role`. */
async function open(p, file, role) {
  const token = signToken('TEST-SHELL-' + role.toLowerCase(), role);
  await p.goto(BASE + '/' + file.split('?')[0]);
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); }, token);
  await p.goto(BASE + '/' + file);
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(250);
}

/** The nav as the browser has it: order, label, gate, whether it is showing. */
async function navOnScreen(p) {
  return p.evaluate(function () {
    return Array.prototype.slice.call(
      document.querySelectorAll('.sidebar .nav > *')
    ).map(function (el) {
      const item = el.classList.contains('nav-item');
      return {
        kind: item ? 'item' : 'group',
        view: item ? el.getAttribute('data-view') : '',
        label: item
          ? (el.querySelector('.nav-text') || {}).textContent
          : el.textContent,
        gate: el.hasAttribute('data-master-only') ? 'MASTER'
            : el.hasAttribute('data-admin-only') ? 'ADMIN' : '',
        icon: item
          ? ((el.querySelector('svg') || {}).innerHTML || '').trim()
          : '',
        showing: !el.hidden,
        active: el.classList.contains('is-active'),
        soon: el.hasAttribute('data-soon'),
        title: el.getAttribute('title') || ''
      };
    });
  });
}

function shown(nav) {
  return nav.filter(function (e) { return e.showing; })
            .map(function (e) { return e.view || ('[' + e.label + ']'); });
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

  // =======================================================================
  console.log('');
  console.log('  The nav against the original markup');
  // =======================================================================
  const original = navFromIndex();
  const ported = navFromShell();

  check('the original sidebar was found and read',
        original.length > 0 && original.some(function (e) {
          return e.kind === 'item' && e.view === 'kpi1';
        }), JSON.stringify(original.slice(0, 2)));

  check('EVERY ITEM AND GROUP IS PORTED, IN THE ORIGINAL ORDER',
        JSON.stringify(original.map(function (e) {
          return e.kind + ':' + (e.view || e.label);
        })) ===
        JSON.stringify(ported.map(function (e) {
          return e.kind + ':' + (e.view || e.label);
        })),
        '\n    was:  ' + JSON.stringify(original.map(function (e) {
          return e.view || e.label; })) +
        '\n    now:  ' + JSON.stringify(ported.map(function (e) {
          return e.view || e.label; })));

  original.forEach(function (was, i) {
    const now = ported[i] || {};
    if (was.kind === 'group') {
      check('the "' + was.label + '" group label and its role gate',
            now.label === was.label && now.gate === was.gate,
            JSON.stringify(now));
      return;
    }
    check(was.view + ': the label still reads "' + was.label + '"',
          now.label === was.label, JSON.stringify(now.label));
    check(was.view + ': the same role is shown it',
          now.gate === was.gate, now.gate + ' vs ' + was.gate);
    check(was.view + ': the icon is the same path data',
          shell.SCREENS.some(function (s) {
            return s.view === was.view;
          }) && iconOf(was.view) === was.icon,
          '\n    was:  ' + was.icon + '\n    now:  ' + iconOf(was.view));
  });

  /*
    THE LABELS THE TOP BAR PRINTS came from a second table in App.html -
    `labels` inside showView - and the two were free to disagree. They are
    one table now, so this checks the merge did not lose a wording.
  */
  const appHtml = readSource('App.html');
  const labelBlock = appHtml.slice(appHtml.indexOf('const labels = {'),
                                   appHtml.indexOf('document.getElementById(\'viewLabel\')'));
  ['kpi1', 'kpi2', 'compare', 'uploads', 'settings', 'master'].forEach(function (view) {
    const found = labelBlock.match(
      new RegExp(view + ':\\s*\'([^\']*)\''));
    const was = found ? found[1].replace(/\\u00b7/g, '\u00b7') : '';
    check('the top bar still calls ' + view + ' "' + was + '"',
          Boolean(was) && shell.labelOf(view) === was,
          JSON.stringify(shell.labelOf(view)) + ' vs ' + JSON.stringify(was));
  });

  /*
    THE ONE NAME THE TWO TABLES DISAGREED ON.

    The nav button in Index.html says 'Help &amp; FAQ'. The labels table in
    showView says 'Help \u00b7 FAQ'. Nobody chose that - they are two
    hand-maintained copies of one name, which is the whole reason for
    merging them into one. The nav's wording won, because that is the one
    people read every day rather than once in a corner of the top bar.
    Asserted so it reads as a decision instead of a difference nobody
    noticed.
  */
  const helpInBar = ((labelBlock.match(/help:\s*'([^']*)'/) || [])[1] || '')
    .replace(/\\u00b7/g, '\u00b7');
  check('THE TWO TABLES DISAGREED ON EXACTLY ONE NAME, AND IT WAS HELP\'S',
        helpInBar === 'Help \u00b7 FAQ' && shell.labelOf('help') === 'Help & FAQ',
        JSON.stringify(helpInBar) + ' in the bar, ' +
        JSON.stringify(shell.labelOf('help')) + ' in the nav');

  /*
    THE SCREENS STILL TO COME, and the ones that have arrived. This list
    shrinks as the port goes on, and keeping it here rather than counting
    them is deliberate: when the last one lands, this check is what says
    so.
  */
  check('a screen with no page yet has no URL to offer',
        shell.urlFor('settings') === '' && shell.urlFor('help') === '' &&
        shell.urlFor('home') === '',
        JSON.stringify(['settings', 'help', 'home'].map(shell.urlFor)));
  check('AND THE ONES THAT HAVE ARRIVED DO',
        shell.urlFor('master') === 'master.html' &&
        shell.urlFor('compare') === 'compare.html' &&
        shell.urlFor('kpi1') === 'kpi1.html' &&
        shell.urlFor('kpi2') === 'kpi2.html' &&
        shell.urlFor('uploads') === 'uploads.html',
        JSON.stringify(['master', 'compare', 'kpi1', 'kpi2', 'uploads']
          .map(shell.urlFor)));
  check('and one that has a page carries the period into the query',
        shell.urlFor('kpi1', '2026-05') === 'kpi1.html?period=2026-05' &&
        shell.urlFor('kpi2', '2026-Q2') === 'kpi2.html?period=2026-Q2');
  check('A PERIOD IS ESCAPED ON THE WAY INTO THE URL',
        shell.urlFor('kpi1', 'a b&c') === 'kpi1.html?period=a%20b%26c',
        shell.urlFor('kpi1', 'a b&c'));


  await sweep();
  await fixture();

  const b = await browser.launch();
  const context = await b.newContext();
  const p = await context.newPage();

  const thrown = [];
  const badRequests = [];
  /*
    One block below breaks a call deliberately, to see what the top bar does
    about it. The watchers are told to look away for exactly that block -
    otherwise the suite's own fixture fails the suite's own network check.
  */
  let breakingOnPurpose = false;
  p.on('pageerror', function (err) { thrown.push(String(err.message || err)); });
  p.on('console', function (m) {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      thrown.push(m.text());
    }
  });
  p.on('response', function (r) {
    if (breakingOnPurpose) return;
    if (r.status() >= 400) badRequests.push(r.status() + ' ' + r.url());
  });
  p.on('requestfailed', function (r) {
    if (breakingOnPurpose) return;
    const why = (r.failure() || {}).errorText || '';
    if (/ERR_ABORTED/.test(why)) return;
    badRequests.push('could not be reached: ' + r.url() + ' (' + why + ')');
  });


  // =======================================================================
  console.log('');
  console.log('  Before anybody has signed in');
  // =======================================================================
  await p.goto(BASE + '/uploads.html');
  await p.evaluate(function () { sessionStorage.removeItem('easToken'); });
  await p.goto(BASE + '/uploads.html');
  await p.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });

  check('the sign-in card has the screen to itself',
        await p.isVisible('#signinCard') && await p.isHidden('#appRoot'));
  check('THE SIDEBAR IS BUILT BUT NOT SHOWN, as #appRoot is in Index.html',
        await p.evaluate(function () {
          return Boolean(document.querySelector('.sidebar .nav .nav-item'));
        }) && await p.isHidden('.sidebar'));
  check('and Sign out exists to be bound to, hidden with the rest of it',
        await p.evaluate(function () {
          return Boolean(document.getElementById('signOut'));
        }));

  /*
    AND THE ROOT GOES SOMEWHERE. The single-page original never had to
    answer what is at '/', because '/' was the whole app. homeView() in
    App.html answers it anyway - "the portal's Home when there is a portal,
    and KPI 1 when there is not" - and there is no portal yet.
  */
  await p.goto(BASE + '/');
  check('THE ROOT LANDS ON THE DASHBOARD, as homeView says it should when ' +
        'there is no portal',
        /\/kpi1\.html$/.test(p.url()), p.url());


  // =======================================================================
  console.log('');
  console.log('  While the server is still being asked who you are');
  // =======================================================================
  /*
    THE SHELL STAYS HIDDEN UNTIL BOOT ANSWERS, and the window is real: the
    token is in sessionStorage, so the page is going to come up, but nobody
    knows the role yet. Reveal the shell now and you get a sidebar with the
    admin items missing, a badge reading VIEWER and a name reading '-',
    for as long as the request takes - then it all rearranges itself.

    HOW THIS ASSERTION CAME TO EXIST. A mutation flipped `app.hidden = true`
    to false in mount() and the suite did not notice, because on the
    no-token path signedOut() hides it a moment later and covered the
    mutation up. The uncovered case is this one, and it needed the boot
    request held open to be looked at.
  */
  await p.route('**/api/uploads/boot', async function (route) {
    await new Promise(function (done) { setTimeout(done, 1500); });
    await route.continue();
  });

  const bootToken = signToken('TEST-SHELL-master', 'MASTER');
  await p.goto(BASE + '/uploads.html');
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                   bootToken);
  const navigating = p.goto(BASE + '/uploads.html');
  await p.waitForSelector('#appRoot', { state: 'attached', timeout: 20000 });
  check('THE SHELL DOES NOT APPEAR BEFORE THE SERVER HAS SAID WHO YOU ARE',
        await p.evaluate(function () {
          return document.getElementById('appRoot').hidden &&
                 document.getElementById('page').hidden;
        }));
  await navigating;
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('and then it does',
        await p.isVisible('#appRoot') && await p.isVisible('.sidebar'));
  await p.unroute('**/api/uploads/boot');


  // =======================================================================
  console.log('');
  console.log('  Signed in as MASTER');
  // =======================================================================
  await open(p, 'uploads.html', 'MASTER');

  check('THE PAGE NOW SITS INSIDE THE SHELL',
        await p.evaluate(function () {
          const page = document.getElementById('page');
          return Boolean(page.closest('.content')) &&
                 Boolean(page.closest('.main')) &&
                 Boolean(page.closest('#appRoot'));
        }));
  check('the brand block says which system and which version',
        (await p.textContent('#brandName')).length > 0 &&
        /^v/.test(await p.textContent('#brandVersion')),
        await p.textContent('#brandName') + ' / ' +
        await p.textContent('#brandVersion'));
  check('the top bar names who is signed in',
        (await p.textContent('#operatorName')) === 'TEST-SHELL-master',
        await p.textContent('#operatorName'));
  check('the badge says MASTER',
        (await p.textContent('#roleBadge')) === 'MASTER',
        await p.textContent('#roleBadge'));
  check('and it is marked as both, because MASTER outranks ADMIN',
        await p.evaluate(function () {
          const el = document.getElementById('roleBadge');
          return el.classList.contains('is-admin') &&
                 el.classList.contains('is-master');
        }));
  check('the top bar names the screen',
        (await p.textContent('#viewLabel')) === 'Data Uploads',
        await p.textContent('#viewLabel'));
  check('and the Data Uploads item is the lit one',
        await p.evaluate(function () {
          const lit = document.querySelectorAll('.nav-item.is-active');
          return lit.length === 1 && lit[0].getAttribute('data-view') === 'uploads';
        }));

  let nav = await navOnScreen(p);
  check('A MASTER IS SHOWN EVERY ITEM, Accounts and Administration included',
        JSON.stringify(shown(nav)) ===
        JSON.stringify(['home', '[Indicators]', 'kpi1', 'kpi2', 'compare',
                        '[Data]', 'uploads', 'settings', 'help',
                        '[Administration]', 'master']),
        JSON.stringify(shown(nav)));
  /*
    THE ICONS AS THE BROWSER ACTUALLY HAS THEM.

    Compared THROUGH THE DOM, not as text. '<path d="..."/>' goes in and
    '<path d="..."></path>' comes back out: the browser re-serialises the
    markup it parsed, so a string comparison fails on every single icon
    while every single icon is correct. Both sides are parsed by the same
    browser and the results compared, which is the only version of this
    question that has a meaningful answer.
  */
  const wrongIcons = await p.evaluate(function (want) {
    const NS = 'http://www.w3.org/2000/svg';
    return Object.keys(want).filter(function (view) {
      const item = document.querySelector('.nav-item[data-view="' + view + '"]');
      if (!item) return true;
      const expected = document.createElementNS(NS, 'svg');
      expected.innerHTML = want[view];
      return expected.innerHTML.trim() !==
             item.querySelector('svg').innerHTML.trim();
    });
  }, nav.filter(function (e) { return e.kind === 'item'; })
        .reduce(function (acc, e) { acc[e.view] = iconOf(e.view); return acc; }, {}));
  check('the icons in the browser are the ones the original drew',
        wrongIcons.length === 0, JSON.stringify(wrongIcons));
  check('every unported screen is shown, disabled, and says why on hover',
        nav.filter(function (e) { return e.soon; })
           .every(function (e) { return e.showing && /not ported yet/.test(e.title); }),
        JSON.stringify(nav.filter(function (e) { return e.soon; })
                          .map(function (e) { return e.view + ': ' + e.title; })));
  check('HOME SAYS IT IS THE PORTAL, rather than landing on a dashboard',
        nav.some(function (e) {
          return e.view === 'home' && e.soon && /portal/i.test(e.title);
        }),
        JSON.stringify((nav.filter(function (e) {
          return e.view === 'home'; })[0] || {}).title));


  // =======================================================================
  console.log('');
  console.log('  Clicking around');
  // =======================================================================
  await p.click('.nav-item[data-view="kpi1"]');
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('KPI 1 opens KPI 1',
        /\/kpi1\.html$/.test(p.url().split('?')[0]), p.url());
  check('and KPI 1 is now the lit item',
        await p.evaluate(function () {
          const lit = document.querySelector('.nav-item.is-active');
          return lit && lit.getAttribute('data-view') === 'kpi1';
        }));
  check('and the top bar changed with it',
        (await p.textContent('#viewLabel')) === 'KPI 1 \u00b7 ITSM',
        await p.textContent('#viewLabel'));

  await p.click('.nav-item[data-view="kpi2"]');
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('KPI 2 opens KPI 2',
        /\/kpi2\.html$/.test(p.url().split('?')[0]), p.url());

  /*
    THE BROWSER'S OWN BACK, which is the whole reason these are separate
    pages. In the original it would have left the app entirely.
  */
  await p.goBack();
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('AND THE BROWSER\'S BACK BUTTON WALKS BACK THROUGH THEM',
        /\/kpi1\.html$/.test(p.url().split('?')[0]), p.url());

  await p.click('.nav-item[data-view="compare"]');
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('Comparison opens Comparison',
        /\/compare\.html$/.test(p.url().split('?')[0]), p.url());

  /*
    AND A SCREEN THAT IS STILL TO COME SAYS SO. Summary is the one used
    here because it is visible to every role; Help is admin-only and Home
    belongs to the portal, so neither is a safe stand-in as this list
    shrinks.
  */
  const before = p.url();
  await p.click('.nav-item[data-view="settings"]');
  await p.waitForSelector('#shellSays:not([hidden])', { timeout: 5000 });
  check('a screen with no page says so instead of doing nothing',
        /not ported yet/.test(await p.textContent('#shellSays')),
        await p.textContent('#shellSays'));
  check('and it did not navigate anywhere', p.url() === before, p.url());


  // =======================================================================
  console.log('');
  console.log('  The collapse');
  // =======================================================================
  check('the sidebar starts at full width',
        await p.evaluate(function () {
          return !document.getElementById('appRoot').classList.contains('is-collapsed');
        }));
  await p.click('#collapseBtn');
  check('and collapses to an icon strip',
        await p.evaluate(function () {
          return document.getElementById('appRoot').classList.contains('is-collapsed');
        }));
  check('the labels go, the icons stay',
        await p.evaluate(function () {
          const item = document.querySelector('.nav-item[data-view="kpi1"]');
          return getComputedStyle(item.querySelector('.nav-text')).display === 'none' &&
                 getComputedStyle(item.querySelector('svg')).display !== 'none';
        }));

  await p.click('.nav-item[data-view="uploads"]');
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('IT IS STILL COLLAPSED ON THE NEXT SCREEN - every screen is a fresh ' +
        'document now, so this had to be remembered on purpose',
        await p.evaluate(function () {
          return document.getElementById('appRoot').classList.contains('is-collapsed');
        }));
  await p.click('#collapseBtn');
  check('and opening it again sticks too',
        await p.evaluate(function () {
          return !document.getElementById('appRoot').classList.contains('is-collapsed') &&
                 !sessionStorage.getItem('easNavCollapsed');
        }));


  // =======================================================================
  console.log('');
  console.log('  Open Dashboard, which is the handover');
  // =======================================================================
  const targets = await p.evaluate(function () {
    const rows = Array.prototype.slice.call(
      document.querySelectorAll('#uploadTable tbody tr'));
    const find = function (needle) {
      const row = rows.filter(function (tr) {
        return (tr.dataset.files || '').indexOf(needle) !== -1;
      })[0];
      return row ? window.__uploadsScreen.dashboardFor(row) : null;
    };
    return { tickets: find('TEST-SHELL overall'),
             feedback: find('TEST-SHELL Q1-2099') };
  });
  check('the ticket upload points at KPI 1, on the month it covers',
        targets.tickets && targets.tickets.view === 'kpi1' &&
        targets.tickets.key === MONTH,
        JSON.stringify(targets.tickets));
  check('THE KEY IS THE MACHINE FORM AND THE LABEL IS THE READABLE ONE',
        targets.tickets && targets.tickets.period === 'February 2099',
        JSON.stringify(targets.tickets));
  check('the feedback upload points at KPI 2, on the quarter its name gives',
        targets.feedback && targets.feedback.view === 'kpi2' &&
        targets.feedback.key === QUARTER,
        JSON.stringify(targets.feedback));

  await p.evaluate(function () {
    const rows = Array.prototype.slice.call(
      document.querySelectorAll('#uploadTable tbody tr'));
    const row = rows.filter(function (tr) {
      return (tr.dataset.files || '').indexOf('TEST-SHELL overall') !== -1;
    })[0];
    row.querySelector('[data-open]').click();
  });
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('AND CLICKING IT OPENS THE SCREEN ON THAT PERIOD, rather than ' +
        'describing where it would have gone',
        /\/kpi1\.html\?period=2099-02$/.test(p.url()), p.url());

  /*
    AND THE FEEDBACK ROW GOES SOMEWHERE ELSE.

    This one is here because a mutation put it here. Sending every upload
    to KPI 1 - ignoring the view dashboardFor worked out - survived a whole
    run, because the only button being clicked was the ticket row's, and
    the ticket row's answer IS kpi1. The pure check knew the answer was
    kpi2; nothing checked that the click acted on it.
  */
  await open(p, 'uploads.html', 'MASTER');
  await p.evaluate(function () {
    const rows = Array.prototype.slice.call(
      document.querySelectorAll('#uploadTable tbody tr'));
    const row = rows.filter(function (tr) {
      return (tr.dataset.files || '').indexOf('TEST-SHELL Q1-2099') !== -1;
    })[0];
    row.querySelector('[data-open]').click();
  });
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('A FEEDBACK UPLOAD OPENS KPI 2, on the quarter its filename names',
        /\/kpi2\.html\?period=2099-Q1$/.test(p.url()), p.url());

  // Back to KPI 1 on its period, for the two checks below.
  await open(p, 'kpi1.html?period=' + MONTH, 'MASTER');


  // =======================================================================
  console.log('');
  console.log('  A screen opened on a period');
  // =======================================================================
  check('KPI 1 opened on the month the URL named',
        /February 2099/.test(await p.textContent('#monthPickerLabel')),
        await p.textContent('#monthPickerLabel'));

  await open(p, 'kpi1.html?period=' + STALE_MONTH, 'MASTER');
  check('A MONTH WITH NO DATA FALLS BACK TO ALL MONTHS, not to an empty screen',
        /^All months/.test((await p.textContent('#monthPickerLabel')).trim()),
        await p.textContent('#monthPickerLabel'));

  /*
    AND THE URL BEATS THE REMEMBERED MONTH, which is the half of "the URL
    wins, and it wins last" that was not being tested.

    A mutation made the URL lose whenever a saved filter existed and nothing
    noticed, because nothing had put one there: the saved month is written
    when somebody changes the picker, and the suite never had. So one is
    planted here on purpose, set to every month, and the URL asked for one.
  */
  await p.goto(BASE + '/kpi1.html');
  await p.evaluate(function (t) {
    sessionStorage.setItem('easToken', t);
    sessionStorage.setItem('easKpi1Filters', JSON.stringify({ month: 'ALL' }));
  }, signToken('TEST-SHELL-master', 'MASTER'));
  await p.goto(BASE + '/kpi1.html?period=' + MONTH);
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(250);
  check('THE URL BEATS THE MONTH SOMEBODY WAS LAST LOOKING AT',
        /February 2099/.test(await p.textContent('#monthPickerLabel')),
        await p.textContent('#monthPickerLabel'));
  await p.evaluate(function () {
    sessionStorage.removeItem('easKpi1Filters');
  });

  await open(p, 'kpi2.html?period=' + QUARTER, 'MASTER');
  check('KPI 2 opened on the quarter the URL named',
        (await p.inputValue('#kpi2Month')) === QUARTER,
        await p.inputValue('#kpi2Month'));

  await open(p, 'kpi2.html?period=' + STALE_QUARTER, 'MASTER');
  check('and a quarter with no feedback falls back to all quarters',
        (await p.inputValue('#kpi2Month')) === 'ALL',
        await p.inputValue('#kpi2Month'));


  // =======================================================================
  console.log('');
  console.log('  Signed in as ADMIN');
  // =======================================================================
  await open(p, 'uploads.html', 'ADMIN');
  nav = await navOnScreen(p);
  check('an admin is shown Help, because the inbox is theirs',
        shown(nav).indexOf('help') !== -1, JSON.stringify(shown(nav)));
  check('AND IS NOT SHOWN ACCOUNTS, nor the group label above it',
        shown(nav).indexOf('master') === -1 &&
        shown(nav).indexOf('[Administration]') === -1,
        JSON.stringify(shown(nav)));
  check('the badge says ADMIN',
        (await p.textContent('#roleBadge')) === 'ADMIN',
        await p.textContent('#roleBadge'));


  // =======================================================================
  console.log('');
  console.log('  Signed in as a viewer');
  // =======================================================================
  await open(p, 'uploads.html', 'USER');
  nav = await navOnScreen(p);
  check('a viewer is shown the indicators and the data screens',
        shown(nav).indexOf('kpi1') !== -1 &&
        shown(nav).indexOf('uploads') !== -1,
        JSON.stringify(shown(nav)));
  check('AND NEITHER HELP NOR ACCOUNTS',
        shown(nav).indexOf('help') === -1 &&
        shown(nav).indexOf('master') === -1,
        JSON.stringify(shown(nav)));
  /*
    USER IS WHAT THE DATABASE CALLS THE ROLE; VIEWER IS WHAT THE BADGE SAYS.
    applyRole in App.html does the same translation, and for the same
    reason: "USER" beside somebody's own name tells them nothing.
  */
  check('the badge reads VIEWER rather than USER',
        (await p.textContent('#roleBadge')) === 'VIEWER',
        await p.textContent('#roleBadge'));
  check('and it is marked as neither admin nor master',
        await p.evaluate(function () {
          const el = document.getElementById('roleBadge');
          return !el.classList.contains('is-admin') &&
                 !el.classList.contains('is-master');
        }));


  // =======================================================================
  console.log('');
  console.log('  When a call does not come back');
  // =======================================================================
  /*
    THE DOT IN THE TOP BAR, which is the only thing on the screen whose job
    is to say that what you are reading might be wrong. onError in App.html
    ends with setLive(false) for every error but an expired session, and
    nothing anywhere calls setLive(true) - so it goes one way and stays
    there until the page is reloaded. A dot that always says Live is worse
    than no dot, because it is an assurance.

    The history call is refused and the boot call is not, so the screen
    comes up and then finds out. That is the shape of the real failure:
    figures on screen, and no way to know they are stale.
  */
  await open(p, 'uploads.html', 'MASTER');
  check('the dot says Live while the calls are coming back',
        (await p.textContent('#liveText')) === 'Live' &&
        !(await p.evaluate(function () {
          return document.getElementById('liveDot').classList.contains('is-busy');
        })));

  /*
    AND AN EXPIRED SESSION IS NOT A DEAD SERVER.

    onError in App.html opens with the exception before it does anything
    else: "A session that ran out is not an error to report, it is a
    sign-in to ask for." It matters because the two look identical from
    inside the page - both are a call that did not give you what you asked
    for - and they call for opposite things. One wants the password typed
    again. The other wants nobody to trust the figures on screen.

    Making the dot red for both survived a mutation run, so it is asserted
    now: the session ends, the sign-in card comes back, and the dot has
    nothing to say about it.
  */
  breakingOnPurpose = true;
  await p.route('**/api/uploads', function (route) {
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'Your session has ended.' })
    });
  });
  await p.goto(BASE + '/uploads.html');
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                   signToken('TEST-SHELL-master', 'MASTER'));
  await p.goto(BASE + '/uploads.html');
  await p.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  check('AN EXPIRED SESSION ASKS FOR THE PASSWORD, it does not blame the server',
        (await p.textContent('#liveText')) === 'Live' &&
        !(await p.evaluate(function () {
          return document.getElementById('liveDot').classList.contains('is-busy');
        })),
        await p.textContent('#liveText'));
  await p.unroute('**/api/uploads');

  await p.route('**/api/uploads', function (route) {
    route.abort('connectionrefused');
  });
  await open(p, 'uploads.html', 'MASTER');
  await p.waitForFunction(function () {
    return document.getElementById('liveText').textContent !== 'Live';
  }, null, { timeout: 20000 });
  check('AND SAYS ERROR WHEN ONE DOES NOT',
        (await p.textContent('#liveText')) === 'Error',
        await p.textContent('#liveText'));
  check('with the dot marked, so it reads at a glance',
        await p.evaluate(function () {
          return document.getElementById('liveDot').classList.contains('is-busy');
        }));
  check('and the screen is still up, rather than thrown away',
        await p.isVisible('#page'));
  await p.unroute('**/api/uploads');
  breakingOnPurpose = false;


  // =======================================================================
  console.log('');
  console.log('  Signing out, from the top bar');
  // =======================================================================
  await p.click('#signOut');
  await p.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  check('the shell goes and the sign-in card comes back',
        await p.isHidden('#appRoot') && await p.isVisible('#signinCard'));
  check('and the token is gone, so a reload does not walk straight back in',
        await p.evaluate(function () {
          return !sessionStorage.getItem('easToken');
        }));


  // =======================================================================
  console.log('');
  console.log('  Nothing on fire in the console');
  // =======================================================================
  check('the page threw nothing', thrown.length === 0, thrown.join(' | '));
  /*
    cdnjs is the one allowed exception, for the reason uploads-ui-test.js
    gives about the same line: this sandbox has no route to it, and on a
    machine with internet those requests succeed. Anything else here is a
    file a page expects and the server does not serve, which is how a
    screen quietly loses its stylesheet.
  */
  const unexpected = badRequests.filter(function (r) {
    return !/cdnjs\.cloudflare\.com/.test(r);
  });
  check('every file the shell asked for was served',
        unexpected.length === 0, unexpected.slice(0, 4).join(' | '));

  await context.close();
  await b.close();

  await sweep();
  check('no test tickets are left behind',
        (await db.query("SELECT count(*)::int AS n FROM ticket" +
                        " WHERE ticket_id LIKE 'TEST-SHELL-%'"))[0].n === 0);
  check('no test responses are left behind',
        (await db.query("SELECT count(*)::int AS n FROM training" +
                        " WHERE response_id LIKE 'TEST-SHELL%'"))[0].n === 0);
  check('no test uploads are left behind',
        (await db.query("SELECT count(*)::int AS n FROM upload_run" +
                        " WHERE upload_id LIKE 'UPL-TEST-SHELL%'"))[0].n === 0);
}


/** shell.js's icon for a view, as a string, for comparing. */
function iconOf(view) {
  const module = fs.readFileSync(path.join(__dirname, 'public', 'shell.js'),
                                 'utf8');
  const block = module.slice(module.indexOf('const ICONS = {'),
                             module.indexOf('};', module.indexOf('const ICONS = {')));
  const found = block.match(new RegExp(view + ':\\s*\'([^\']*)\''));
  return found ? found[1] : '';
}


main()
  .then(async function () {
    recap();
    console.log('');
    console.log('  ' + passed + ' passed, ' + failed + ' failed');
    console.log('');
    await db.pool.end();
    process.exit(failed ? 1 : 0);
  })
  .catch(async function (err) {
    recap();
    console.error('');
    console.error('  The suite itself fell over:');
    console.error('  ' + (err && err.stack ? err.stack : err));
    console.error('');
    try { await sweep(); } catch (e) { /* best effort */ }
    try { await db.pool.end(); } catch (e) { /* best effort */ }
    process.exit(1);
  });
