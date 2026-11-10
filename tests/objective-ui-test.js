// The Objectives page, in a browser.
//
// WHY THIS EXISTS
// objective-test.js proves the arithmetic. This proves the page shows it,
// and that pressing things on the page actually records something - which
// is the half the server suite cannot see.
//
// WHAT IT GUARDS, worst first:
//
//   the counter sends what it shows   somebody steps to 2 and presses Save;
//                                     if the page sends the old value the
//                                     card redraws with 2 anyway, because
//                                     the fixture answers with what it was
//                                     told. Checked by reading the store
//                                     back, not the card
//   a note survives a redraw          the counter rebuilds the card on every
//                                     press. A note typed first and lost on
//                                     the second press is a bug nobody
//                                     reports, they just stop writing notes
//   no button that does nothing       a KPI, and somebody else's module,
//                                     must not offer a tick. The server
//                                     refuses both, so a button there is a
//                                     promise the page cannot keep
//   not past the month it is          February cannot be recorded against in
//                                     November, so the arrow is dead
//   the light page is legible         this is the one page in the portal
//                                     with dark text on white. If any of it
//                                     is inherited from the blue shell it is
//                                     white on white and invisible
//   the weighting sentence is true    it names the chosen category's own
//                                     weight and milestone count, and has to
//                                     follow the picker
//
//   node tests/harness/build.js && node tests/objective-ui-test.js
const path = require('path'), fs = require('fs');

const PAGE = process.env.EAS_PAGE ||
             path.join(__dirname, 'harness', 'page.html');
const BROWSER = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* below */ }

if (!chromium || !fs.existsSync(BROWSER)) {
  console.log('SKIP  browser tests - ' +
    (chromium ? 'no Chromium at ' + BROWSER : 'playwright-core is not installed'));
  console.log('\n0/0 passed');
  process.exit(0);
}
if (!fs.existsSync(PAGE)) {
  console.log('FAIL  tests/harness/page.html is missing - run: node tests/harness/build.js');
  console.log('\n0/1 passed');
  process.exit(1);
}

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

const FILE = 'file://' + PAGE;

/* sRGB luminance, for the contrast ratios below. */
function lum(rgb) {
  const c = rgb.map(function (v) {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function parseRgb(text) {
  const hit = /rgba?\(([^)]+)\)/.exec(String(text || ''));
  if (!hit) return null;
  const n = hit[1].split(',').map(function (x) { return parseFloat(x); });
  return [n[0], n[1], n[2]];
}

(async () => {
  const b = await chromium.launch({ executablePath: BROWSER });
  const errors = [];

  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });

  await p.goto(FILE);
  await p.waitForTimeout(1200);
  await p.click('.portal-tab[data-view="objective"]');
  await p.waitForTimeout(900);

  // =========================================================================
  // 1. the page is there, and it is the light one
  // =========================================================================
  check('the Objectives tab opens the Objectives page',
    await p.isVisible('#view-objective') &&
    await p.isVisible('.obj-band'));

  const bandBg = parseRgb(await p.$eval('.obj-band', (n) =>
    getComputedStyle(n).backgroundColor));
  const bodyBg = parseRgb(await p.$eval('#view-objective', (n) =>
    getComputedStyle(n).backgroundColor));

  check('the band is dark and the page under it is light',
    lum(bandBg) < 0.12 && lum(bodyBg) > 0.8,
    'band ' + lum(bandBg).toFixed(3) + ' body ' + lum(bodyBg).toFixed(3));

  // THE ONE THAT WOULD BE INVISIBLE. Every other portal page is white text
  // on blue; anything on this one that inherits that is white on white.
  const inkOn = async (sel) => {
    const col = parseRgb(await p.$eval(sel, (n) => getComputedStyle(n).color));
    return ratio(col, bodyBg);
  };
  check('a milestone title is legible against the light page',
    (await inkOn('.obj-card-t')) >= 4.5,
    (await inkOn('.obj-card-t')).toFixed(2) + ':1');
  check('the smaller line under it clears 4.5:1 as well',
    (await inkOn('.obj-card-s')) >= 4.5,
    (await inkOn('.obj-card-s')).toFixed(2) + ':1');
  check('the month picker is legible',
    (await inkOn('#objMonth')) >= 4.5,
    (await inkOn('#objMonth')).toFixed(2) + ':1');

  const bandInk = parseRgb(await p.$eval('.obj-h1', (n) =>
    getComputedStyle(n).color));
  check('and the title on the band is legible against the band',
    ratio(bandInk, bandBg) >= 4.5, ratio(bandInk, bandBg).toFixed(2) + ':1');

  // =========================================================================
  // 2. the two-sheet toggle
  // =========================================================================
  const cards = () => p.$$eval('#objList .obj-card', (ns) => ns.length);
  const onTab = () => p.$eval('.obj-tab.is-on', (n) =>
    n.getAttribute('data-sheet'));

  check('it opens on the SMART Objective side', (await onTab()) === 'plan');
  check('the toggle carries the count of each sheet',
    (await p.$eval('#objCountPlan', (n) => n.textContent)) === '10' &&
    (await p.$eval('#objCountTask', (n) => n.textContent)) === '12');

  const planCards = await cards();
  await p.click('#objTabTask');
  await p.waitForTimeout(400);
  check('pressing Unique Roles swaps the list for the ninety',
    (await onTab()) === 'task' && (await cards()) === 12,
    (await cards()) + ' cards');

  check('and the stats strip changes with it',
    /On schedule/.test(await p.$eval('#objStats', (n) => n.textContent)));

  await p.click('#objTabPlan');
  await p.waitForTimeout(400);
  check('and back again',
    (await onTab()) === 'plan' && (await cards()) === planCards);

  // =========================================================================
  // 3. the counter sends what it shows
  // =========================================================================
  await p.click('[data-obj-open="OBJ-002"]');
  await p.waitForTimeout(300);
  check('pressing Update opens the card in place',
    await p.isVisible('.obj-card.is-open [data-obj-save]'));

  const shown = () => p.$eval('.obj-step-v', (n) => n.textContent.trim());
  check('the counter opens on what was last recorded', (await shown()) === '1');

  // A note typed BEFORE the counter is pressed. The press redraws the card.
  await p.fill('[data-obj-note]', 'Second RCA closed with the FI team.');
  await p.click('[data-obj-step="1"]');
  await p.waitForTimeout(250);

  check('the counter steps up', (await shown()) === '2');
  check('and the note typed before the press is still there',
    (await p.$eval('[data-obj-note]', (n) => n.value)) ===
      'Second RCA closed with the FI team.',
    await p.$eval('[data-obj-note]', (n) => n.value));
  check('the shortfall line goes when the target is met',
    !(await p.$eval('.obj-step-of', (n) => n.textContent)).match(/more to meet/),
    await p.$eval('.obj-step-of', (n) => n.textContent.replace(/\s+/g, ' ')));

  await p.click('[data-obj-save="OBJ-002"]');
  await p.waitForTimeout(600);

  // READ THE STORE, not the card. The fixture answers with whatever it was
  // sent, so a card showing 2 proves only that the page can draw a 2.
  const stored = await p.evaluate(() =>
    JSON.parse(JSON.stringify(window.__OBJ_LOG__['2026-11|PLAN|OBJ-002'])));
  check('Save sends the figure the counter was showing',
    stored.value === 2, 'stored ' + stored.value);
  check('and the note with it',
    stored.note === 'Second RCA closed with the FI team.', stored.note);
  check('and the figure it replaced is kept as history',
    (stored.history || []).length >= 1 && stored.history[0].value === 1,
    JSON.stringify((stored.history || [])[0] || {}));

  check('the card closes and shows the new figure',
    !(await p.isVisible('.obj-card.is-open')) &&
    /2 of 2/.test(await p.$eval('#objList', (n) => n.textContent)));

  // =========================================================================
  // 4. the milestone that is counted, not typed
  // =========================================================================
  const op1 = await p.$eval('#objList .obj-card', (n) => n.textContent);
  check('the counted milestone says where its figure comes from',
    /counted automatically/.test(op1) && /Unique Roles/.test(op1));
  check('and offers no way to type one in',
    await p.$eval('#objList .obj-card', (n) =>
      !n.querySelector('[data-obj-open]')));
  check('it offers the way down to the ninety instead',
    await p.isVisible('#objList .obj-card [data-obj-sheet="task"]'));

  // THE PIPS, on the counted milestone, which is where they are easiest to
  // get wrong. Nothing has elapsed in February, so nothing in February can
  // be late, so the ninety score a clean 1 there - and a pip painted from
  // the score alone would show next February green in November.
  const pips = await p.$$eval('#objList .obj-card:first-child .obj-pips i',
    (ns) => ns.map((n) => n.className || '-'));
  check('the six pips run October to March',
    pips.length === 6, pips.length + ' pips');
  check('the month being looked at is marked out, and the ones after it ' +
    'are blank rather than green',
    pips[1] === 'is-now' && pips.slice(2).every((c) => c === '-'),
    pips.join(' | '));
  check('and a month that has been and gone is coloured',
    pips[0] !== '-' && pips[0] !== 'is-now', pips[0]);

  await p.click('#objList .obj-card [data-obj-sheet="task"]');
  await p.waitForTimeout(400);
  check('and pressing it crosses to the Unique Roles sheet',
    (await onTab()) === 'task');

  // =========================================================================
  // 5. no button that does nothing
  // =========================================================================
  const btnFor = (id) => p.$eval('#objList', (n, k) => {
    const rows = Array.prototype.slice.call(n.querySelectorAll('.obj-card'));
    const hit = rows.filter((r) => r.textContent.indexOf(k) === 0 ||
      r.textContent.trim().indexOf(k) === 0)[0];
    if (!hit) return 'NO CARD';
    const live = hit.querySelector(
      '[data-obj-tick]:not([disabled]), [data-obj-open]');
    return live ? 'LIVE' : 'DEAD';
  }, id);

  check('a KPI offers no tick - its figure is the engine"s',
    (await btnFor('OJT-001')) === 'DEAD', await btnFor('OJT-001'));
  check('somebody else"s module offers no tick either',
    (await btnFor('OJT-012')) === 'DEAD', await btnFor('OJT-012'));
  check('your own module does',
    (await btnFor('OJT-005')) === 'LIVE', await btnFor('OJT-005'));

  // A MONTHLY OBJECTIVE, TICKED, IN THE MONTH IT IS TICKED IN. Its one slot
  // does not count as elapsed until the month is out, so the count that
  // scores it is zero all month - and the card used to print that as
  // "0 of 0 done" directly above a green button saying Done.
  await p.click('[data-obj-tick="OJT-005"]');
  await p.waitForTimeout(700);
  const monthly = await p.$eval('#objList', (n) => {
    const r = Array.prototype.slice.call(n.querySelectorAll('.obj-card'))
      .filter((x) => x.textContent.indexOf('OJT-005') === 0)[0];
    return r ? r.textContent.replace(/\s+/g, ' ') : '';
  });
  check('a monthly objective ticked this month says so, not "0 of 0 done"',
    /Marked done for Nov/.test(monthly) && !/0 of 0/.test(monthly),
    monthly.slice(-60));

  const textOf = (id) => p.$eval('#objList', (n, k) => {
    const r = Array.prototype.slice.call(n.querySelectorAll('.obj-card'))
      .filter((x) => x.textContent.indexOf(k) === 0)[0];
    return r ? r.textContent.replace(/\s+/g, ' ') : '';
  }, id);

  check('and it says whose it is rather than just being dead',
    /CO module/.test(await textOf('OJT-012')),
    (await textOf('OJT-012')).slice(0, 90));

  // A KPI and somebody else's module are both dead, for DIFFERENT reasons,
  // and the button has to give the right one. "All module" on a KPI would
  // be a true-looking sentence that is the wrong explanation.
  check('a KPI says its figure comes from the engine, not that it is ' +
    'somebody else"s module',
    /From the engine/.test(await textOf('OJT-001')) &&
    !/module/.test(await textOf('OJT-001')),
    (await textOf('OJT-001')).slice(-40));

  // =========================================================================
  // 6. ticking a day
  // =========================================================================
  await p.click('[data-obj-open="OJT-007"]');
  await p.waitForTimeout(350);

  const days = () => p.$$eval('.obj-day', (ns) => ns.map((n) =>
    (n.disabled ? 'x' : '') + n.className.replace(/obj-day\s*/, '').trim()));
  const all = await days();
  check('a daily objective opens onto November"s working days',
    all.length === 22, all.length + ' days');
  check('the days that have not happened yet cannot be pressed',
    all.slice(8).every((c) => c.indexOf('x') === 0) &&
    all.slice(0, 8).every((c) => c.indexOf('x') !== 0),
    all.slice(6, 10).join(' | '));
  check('a day already missed shows as missed',
    all[2].indexOf('is-n') !== -1, all[2]);
  check('and today is marked out',
    all[7].indexOf('is-now') !== -1, all[7]);

  // Press the missed day. It cycles missed -> pending.
  await p.click('.obj-day:nth-child(3)');
  await p.waitForTimeout(600);
  const after = await p.evaluate(() =>
    window.__OBJ_LOG__['2026-11|TASK|OJT-007'].marks);
  check('pressing a day sends the slot and the mark to the server',
    after.charAt(2) === '.', 'marks now ' + after.slice(0, 10));

  await p.click('.obj-day:nth-child(3)');
  await p.waitForTimeout(600);
  const after2 = await p.evaluate(() =>
    window.__OBJ_LOG__['2026-11|TASK|OJT-007'].marks);
  check('pressing it again marks it done',
    after2.charAt(2) === 'Y', 'marks now ' + after2.slice(0, 10));

  check('and the count under it follows',
    /7 of 8/.test(await p.$eval('.obj-card.is-open', (n) => n.textContent)),
    (await p.$eval('.obj-card.is-open', (n) => n.textContent))
      .replace(/\s+/g, ' ').slice(0, 120));

  // =========================================================================
  // 7. the module chips
  // =========================================================================
  await p.click('[data-obj-close]');
  await p.waitForTimeout(300);

  const chips = () => p.$$eval('#objFilters .obj-filter', (ns) =>
    ns.map((n) => n.textContent.trim()));
  const lit = () => p.$$eval('#objFilters .obj-filter.is-on', (ns) =>
    ns.map((n) => n.getAttribute('data-group')));

  // The exact list, not a pattern. The fixture names six groups and only
  // four of them have anything filed under them this month; a pattern like
  // "no chip ending in 0" passed happily on chips reading "PP undefined".
  check('a module with nothing in it this month gets no chip at all',
    (await chips()).join(' | ') === 'All 12 | Mine 7 | KPI 4 | SD 5 | MM 2 | CO 1',
    (await chips()).join(' | '));
  check('the four KPIs are not a second chip called All',
    (await chips()).filter((c) => /^All /.test(c)).length === 1,
    (await chips()).join(' | '));

  await p.click('#objFilters [data-group="MM"]');
  await p.waitForTimeout(300);
  check('a chip narrows the list to that module',
    (await cards()) === 2 && (await lit()).join(',') === 'MM',
    (await cards()) + ' cards');

  await p.click('#objFilters [data-group="SD"]');
  await p.waitForTimeout(300);
  check('and the next chip replaces it rather than narrowing inside it',
    (await lit()).join(',') === 'SD' && (await cards()) === 5,
    (await lit()).join(',') + ' / ' + (await cards()) + ' cards');

  await p.click('#objFilters [data-group="ALL"]');
  await p.waitForTimeout(300);
  check('All brings everything back', (await cards()) === 12);

  // =========================================================================
  // 8. the month picker
  // =========================================================================
  check('it cannot step past the month it actually is',
    await p.$eval('#objNext', (n) => n.disabled));

  await p.click('#objPrev');
  await p.waitForTimeout(700);
  check('stepping back asks the server for that month',
    (await p.$eval('#objMonth', (n) => n.textContent)) === 'October 2026',
    await p.$eval('#objMonth', (n) => n.textContent));
  check('and the next arrow comes alive once there is a month ahead',
    !(await p.$eval('#objNext', (n) => n.disabled)));
  check('but the back arrow dies at the start of the period',
    await p.$eval('#objPrev', (n) => n.disabled));

  // LOOKING BACK AT OCTOBER, November has still happened. The pips are
  // blanked past the month it IS, not past the month being looked at, and
  // the two are only different from here - which is why this assertion
  // cannot live in the November block above.
  await p.click('#objTabPlan');
  await p.waitForTimeout(400);
  const octPips = await p.$$eval('#objList .obj-card:first-child .obj-pips i',
    (ns) => ns.map((n) => n.className || '-'));
  check('from October, November is still a month that has happened',
    octPips[0] === 'is-now' && octPips[1] !== '-' &&
    octPips.slice(2).every((c) => c === '-'),
    octPips.join(' | '));
  await p.click('#objTabTask');
  await p.waitForTimeout(350);

  await p.click('#objNext');
  await p.waitForTimeout(700);
  check('and forward again', (await p.$eval('#objMonth', (n) =>
    n.textContent)) === 'November 2026');

  // =========================================================================
  // 9. adding an objective
  // =========================================================================
  await p.click('#objTabPlan');
  await p.waitForTimeout(350);
  check('the New objective button is there for an admin',
    await p.isVisible('#objNew'));

  await p.click('#objNew');
  await p.waitForTimeout(300);
  check('it opens the form', await p.isVisible('#objSheet'));

  const note = () => p.$eval('#objFNote', (n) =>
    n.textContent.replace(/\s+/g, ' ').trim());
  check('the weighting sentence names the chosen category"s own numbers',
    /Operation is worth 20, shared across 2 milestones today and 3 after/
      .test(await note()), await note());

  await p.selectOption('#objFRow', 'COM');
  await p.waitForTimeout(250);
  check('and follows the picker',
    /Commercial is worth 20, shared across 1 milestone today and 2 after/
      .test(await note()), await note());

  check('the total is said to stay at 100',
    /Weighting stays at 100/.test(await note()));

  // Done / not done has no target to type.
  await p.click('#objFType [data-type="DONE"]');
  await p.waitForTimeout(200);
  check('a done/not-done objective has nothing to put in the target box',
    await p.$eval('#objFTarget', (n) => n.disabled && n.value === '1'));

  await p.click('#objFType [data-type="PERCENT"]');
  await p.waitForTimeout(200);
  check('a percentage sets its own target of 100',
    await p.$eval('#objFTarget', (n) => !n.disabled && n.value === '100'));

  // The server refuses a milestone with no measure, and the page says so
  // rather than closing as though it worked.
  await p.click('#objFCreate');
  await p.waitForTimeout(500);
  check('creating without a measure is refused, and the form stays open',
    await p.isVisible('#objSheet') &&
    /needs its measure/.test(await p.$eval('#objSheetSay', (n) => n.textContent)),
    await p.$eval('#objSheetSay', (n) => n.textContent));

  await p.fill('#objFMilestone', 'Attend one reputable SAP training.');
  await p.click('#objFCreate');
  await p.waitForTimeout(800);
  check('a complete one is created and the form closes',
    !(await p.isVisible('#objSheet')));
  check('and the new milestone is on the page',
    /Attend one reputable SAP training/.test(
      await p.$eval('#objList', (n) => n.textContent)));
  check('the sheet count went up with it',
    (await p.$eval('#objCountPlan', (n) => n.textContent)) === '11',
    await p.$eval('#objCountPlan', (n) => n.textContent));

  // =========================================================================
  check('no page errors along the way',
    errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();

  console.log('');
  const bad = out.filter((x) => !x).length;
  // run.js scans for "N/N passed", so the tally has to be in that shape or
  // the suite shows up in the summary as "(no result)" while quietly passing.
  console.log((out.length - bad) + '/' + out.length + ' passed' +
              (bad ? ', ' + bad + ' failed' : ''));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.log('FAIL  the suite threw: ' + (e && e.message || e));
  console.log('\n0/1 passed');
  process.exit(1);
});
