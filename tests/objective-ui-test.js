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
  // 2b. the weight belongs in a filter, not on every card
  // =========================================================================
  const chipText = () => p.$$eval('#objFilters .obj-filter',
    (ns) => ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()));

  check('the SMART Objective side filters by weight',
    (await chipText()).join(' | ') ===
      'All 10 | Weight 20 \u00B7 3 | Weight 10 \u00B7 5 | Weight 5 \u00B7 2',
    (await chipText()).join(' | '));

  // It used to be printed on all twenty-nine cards - the same three numbers
  // down the page, describing the category rather than the milestone.
  check('and is not printed on the cards any more',
    !/weight \d/i.test(await p.$eval('#objList', (n) => n.textContent)),
    (await p.$eval('#objList', (n) => n.textContent)).slice(0, 80));

  await p.click('#objFilters [data-weight="20"]');
  await p.waitForTimeout(300);
  check('pressing a weight narrows the list to it',
    (await cards()) === 3, (await cards()) + ' cards');
  check('and only that chip is lit',
    (await p.$$eval('#objFilters .obj-filter.is-on',
      (ns) => ns.map((n) => n.getAttribute('data-weight')))).join(',') === '20');

  await p.click('#objFilters [data-weight="5"]');
  await p.waitForTimeout(300);
  check('the next weight replaces it rather than narrowing inside it',
    (await cards()) === 2, (await cards()) + ' cards');

  await p.click('#objFilters [data-weight="ALL"]');
  await p.waitForTimeout(300);
  check('All brings the twenty-nine back', (await cards()) === planCards);

  // The caption that described the button beside it.
  check('the instruction to press Update is gone',
    !(await p.$eval('#objHint', (n) => n.textContent)).match(/Press Update/i) &&
    await p.$eval('#objHint', (n) => n.hidden),
    JSON.stringify(await p.$eval('#objHint', (n) => n.textContent)));

  // =========================================================================
  // 2c. the counted milestone counts what is due
  // =========================================================================
  // "30 of 85 on schedule" counted the thirty whose slot had not arrived as
  // wins, and put a milestone at 35% in a month where nothing was recorded.
  const op = await p.$eval('#objList .obj-card', (n) =>
    n.textContent.replace(/\s+/g, ' '));
  check('the counted milestone says what is due, not what is merely not late',
    /of \d+ due so far/.test(op) && !/on schedule/.test(op),
    op.slice(0, 160));
  check('and says separately how many are not due yet',
    /not due yet/.test(op), op.slice(0, 160));

  // =========================================================================
  // 3. the counter sends what it shows
  // =========================================================================
  await p.click('[data-obj-open="OBJ-002"]');
  await p.waitForTimeout(300);
  check('pressing Update opens the card in place',
    await p.isVisible('.obj-card.is-open [data-obj-save]'));

  const shown = () => p.$eval('.obj-step-v', (n) => n.textContent.trim());
  check('the counter opens on what was last recorded', (await shown()) === '1');

  await p.click('[data-obj-step="1"]');
  await p.waitForTimeout(250);

  check('the counter steps up', (await shown()) === '2');
  check('the shortfall line goes when the target is met',
    !(await p.$eval('.obj-step-of', (n) => n.textContent)).match(/more to meet/),
    await p.$eval('.obj-step-of', (n) => n.textContent.replace(/\s+/g, ' ')));

  /*
    THE SMART OBJECTIVE IS MONITORED TOO.

    A milestone is recorded once a month, so a month is its monitoring
    period - and it now carries the same four colours the ninety do:
    recorded while the month ran, written up after it closed, a month that
    ended with nothing, a month that has not come round. Before this, a
    figure typed in January for November was indistinguishable from one
    typed in November.
  */
  const months = () => p.$$eval('.obj-card.is-open .obj-days.is-months > *',
    (ns) => ns.map((n) => ({
      t: n.textContent.trim(),
      cls: n.className.replace('obj-day is-week', '').trim(),
      dead: Boolean(n.disabled),
      note: n.classList.contains('has-note')
    })));
  const mo = await months();
  check('a milestone shows its six months as squares, like the ninety',
    mo.length === 6 && mo[0].t === 'Oct' && mo[5].t === 'Mar',
    mo.map((x) => x.t).join(','));
  check('October was recorded in November, so it is yellow and not green',
    /is-l/.test(mo[0].cls), mo[0].cls);
  check('November was recorded inside November, so it is green',
    /is-y/.test(mo[1].cls), mo[1].cls);
  check('and the months still to come are blank and cannot be written on',
    mo[3].cls === '' && mo[3].dead === true && mo[5].dead === true,
    JSON.stringify(mo[3]));

  const mpanel = () => p.$eval('.obj-card.is-open .obj-np',
    (n) => n.textContent);
  check('a month that carries a note says so before it is opened',
    mo[1].note === true && mo[0].note === false,
    JSON.stringify(mo.map((x) => x.note)));

  await p.click('.obj-days.is-months > *:nth-child(2)');
  await p.waitForTimeout(300);
  check('clicking a month opens the note kept against it',
    /RCA done for the repeated GI posting failure/.test(await mpanel()),
    await mpanel());
  check('and names the month it belongs to',
    /November 2026/.test(await mpanel()), await mpanel());

  /*
    OCTOBER'S NOTE, READ IN NOVEMBER. The note used to live in one box on
    the recording form, so the only way to read what was written against
    October was to step the whole page back to October.
  */
  await p.click('.obj-days.is-months > *:nth-child(1)');
  await p.waitForTimeout(300);
  check('another month opens its own note without leaving this one',
    /October 2026/.test(await mpanel()) &&
    (await p.$eval('#objMonth', (n) => n.textContent)).indexOf('November') !== -1,
    await p.$eval('#objMonth', (n) => n.textContent));
  await p.fill('[data-obj-nbox]', 'Closed late - the FI sign-off came in ' +
    'on the 2nd of November.');
  await p.click('[data-obj-note-keep]');
  await p.waitForTimeout(700);
  const octNote = await p.evaluate(() =>
    window.__OBJ_LOG__['2026-10|PLAN|OBJ-002'].notes['0']);
  check('and it saves against THAT month, not the one on screen',
    octNote && /FI sign-off/.test(octNote.t), JSON.stringify(octNote));

  await p.click('[data-obj-save="OBJ-002"]');
  await p.waitForTimeout(600);

  // READ THE STORE, not the card. The fixture answers with whatever it was
  // sent, so a card showing 2 proves only that the page can draw a 2.
  const stored = await p.evaluate(() =>
    JSON.parse(JSON.stringify(window.__OBJ_LOG__['2026-11|PLAN|OBJ-002'])));
  check('Save sends the figure the counter was showing',
    stored.value === 2, 'stored ' + stored.value);
  check('and recording it marks the month it was recorded in',
    stored.marks === 'Y' && stored.markedAt['0'] > 0,
    JSON.stringify({ m: stored.marks, at: stored.markedAt }));
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

  /*
    A MONTHLY OBJECTIVE OPENS LIKE EVERY OTHER ONE.

    It used to carry a Mark done button that marked it and nothing else -
    no note, no way to change your mind, no record of when - which is a
    worse deal than the daily ones got for no reason but having one slot
    instead of twenty-six.
  */
  await p.click('[data-obj-open="OJT-005"]');
  await p.waitForTimeout(400);
  check('a monthly objective opens onto a panel rather than marking itself',
    await p.isVisible('.obj-card.is-open .obj-days') &&
    await p.isVisible('.obj-card.is-open .obj-np'));
  check('and its one slot is named for the month, not numbered W1',
    (await p.$$eval('.obj-card.is-open .obj-day',
      (ns) => ns.map((n) => n.textContent.trim()))).join(',') === 'Nov',
    (await p.$$eval('.obj-card.is-open .obj-day',
      (ns) => ns.map((n) => n.textContent.trim()))).join(','));

  await p.click('.obj-card.is-open .obj-day');
  await p.waitForTimeout(700);
  await p.click('[data-obj-close]');
  await p.waitForTimeout(400);

  // Its one slot does not count as elapsed until the month is out, so the
  // count that scores it is zero all month - the card used to print that
  // as "0 of 0 done" directly above a green button saying Done.
  const monthly = await p.$eval('#objList', (n) => {
    const r = Array.prototype.slice.call(n.querySelectorAll('.obj-card'))
      .filter((x) => x.textContent.indexOf('OJT-005') === 0)[0];
    return r ? r.textContent.replace(/\s+/g, ' ') : '';
  });
  check('a monthly objective marked this month says so, not "0 of 0 done"',
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

  /*
    THE WHOLE MONTH, BY DATE.

    It used to draw one cell per working day - 22 of them numbered 1 to 22
    - under a line saying Friday and Saturday were not counted. The numbers
    were working-day ordinals rather than dates, so the cell labelled 8 was
    the 11th and not one of them could be checked against a calendar.

    November 2026 opens on a Sunday: 30 days, 8 of them weekend.
  */
  const cells = () => p.$$eval('.obj-days > *', (ns) => ns.map((n) => ({
    day: n.textContent.trim(),
    off: n.classList.contains('is-off'),
    dead: Boolean(n.disabled),
    y: n.classList.contains('is-y'),
    nn: n.classList.contains('is-n'),
    late: n.classList.contains('is-l'),
    title: n.getAttribute('title') || '',
    now: n.classList.contains('is-now')
  })));
  const all = await cells();

  check('a daily objective opens onto the whole month, not its working days',
    all.length === 30, all.length + ' cells');
  check('and the cells are dates, so they can be checked against a calendar',
    all[0].day === '1' && all[29].day === '30',
    all.slice(0, 3).map((c) => c.day).join(','));

  const off = all.filter((c) => c.off).map((c) => Number(c.day));
  // Only Friday. Saturday is a working day here, which is the office's own
  // arrangement rather than the one a calendar would guess.
  check('Friday alone is shown as the day that does not count',
    off.join(',') === '6,13,20,27', off.join(','));
  check('and cannot be pressed, which is what "not counted" means',
    all.filter((c) => c.off).every((c) => !c.y && !c.nn));

  check('a day already missed shows as missed on its own date',
    all[2].nn === true && all[2].day === '3', JSON.stringify(all[2]));
  check('today is marked out, on the 10th',
    all[9].now === true && all[9].day === '10', JSON.stringify(all[9]));
  /*
    AND TODAY IS NOT ALREADY A MISS.

    The ring used to sit on the last ELAPSED slot, and elapsed counted the
    day in progress - so at one minute past midnight the 10th was drawn
    red, the Behind card counted it, and somebody with the whole day ahead
    of them was already being told they had failed it. A square you can
    still mark on time cannot also be a square you have missed.
  */
  check('and it is still blank rather than red, with the day not over',
    all[9].nn === false && all[9].y === false && all[9].dead === false,
    JSON.stringify(all[9]));
  check('while yesterday, unmarked, is a miss',
    all[8].day === '9' && all[8].nn === true, JSON.stringify(all[8]));
  check('the days still to come cannot be pressed',
    all[10].dead === true && all[7].dead === false,
    '11th dead ' + all[10].dead + ', 8th dead ' + all[7].dead);
  check('the caption about Friday and Saturday is gone',
    !/Friday and Saturday/.test(
      await p.$eval('.obj-card.is-open', (n) => n.textContent)));

  /*
    PRESSING ONLY EVER MARKS OR CLEARS.

    There used to be a third press that set a square red. Nobody records
    "we did not do this" - a miss is what a period that came and went
    without a mark IS - so the cycle is marked and not marked, and red
    arrives on its own.

    The 3rd starts as an 'N' written by the version that had that button,
    which still has to read as not done.
  */
  check('a legacy missed mark still reads as not done',
    all[2].nn === true, JSON.stringify(all[2]));

  await p.click('.obj-day:nth-child(3)');
  await p.waitForTimeout(700);
  const after = await p.evaluate(() =>
    window.__OBJ_LOG__['2026-11|TASK|OJT-007'].marks);
  check('one press marks it, rather than cycling through a red',
    after.charAt(2) === 'Y', 'marks now ' + after.slice(0, 10));

  /*
    AND IT IS YELLOW, NOT GREEN. The 3rd of November has been and gone, so
    this is work being caught up on - which is neither a miss nor on time,
    and the square says which with the date it was marked.
  */
  const third = (await cells())[2];
  check('a square marked after its day had passed is yellow, not green',
    third.late === true && third.y === false && third.day === '3',
    JSON.stringify(third));
  check('and it carries the date it was marked',
    /^Marked \d+ \w+ \d{4}\b/.test(third.title), third.title);

  await p.click('.obj-day:nth-child(3)');
  await p.waitForTimeout(700);
  const after2 = await p.evaluate(() =>
    window.__OBJ_LOG__['2026-11|TASK|OJT-007'].marks);
  check('pressing it again clears it rather than setting it red',
    after2.charAt(2) === '.', 'marks now ' + after2.slice(0, 10));
  check('and the square goes back to being a plain miss',
    (await cells())[2].nn === true && (await cells())[2].late === false,
    JSON.stringify((await cells())[2]));

  /*
    A GREEN SQUARE CLEARS THE SAME WAY.

    The yellow square above is only half the cycle: the press that matters
    most is the one on a square that is done ON TIME, because that is the
    one the old third state used to turn red. Taking a mark back is '.' -
    whether the mark was green or yellow - and 'N' here would be the
    removed button wearing the clear press"s clothes.
  */
  const firstWas = (await cells())[0];
  check('the 1st is green, so this is a press on an on-time mark',
    firstWas.y === true && firstWas.late === false, JSON.stringify(firstWas));

  await p.click('.obj-day:nth-child(1)');
  await p.waitForTimeout(700);
  const cleared = await p.evaluate(() =>
    window.__OBJ_LOG__['2026-11|TASK|OJT-007'].marks);
  check('clearing a done square unmarks it rather than recording a miss',
    cleared.charAt(0) === '.', 'marks now ' + cleared.slice(0, 10));
  // It reads red all the same, because the 1st has been and gone - but
  // that is the day having passed, not anything written down.
  check('and it reads as a miss only because that day is behind us',
    (await cells())[0].nn === true && (await cells())[0].late === false,
    JSON.stringify((await cells())[0]));

  await p.click('.obj-day:nth-child(3)');
  await p.waitForTimeout(700);

  /*
    A PRESS IS NOT A PAGE RELOAD.

    It used to call getObjectives again after every tick - six tab reads
    and the whole ninety scored - to change one square's colour, and it
    refused to accept another press while that was out. So marking three
    rows in a row recorded the first and silently dropped the other two.
  */
  const loadsBefore = await p.evaluate(() => window.__calls.getObjectives || 0);
  await p.click('.obj-day:nth-child(2)');
  await p.waitForTimeout(500);
  const loadsAfter = await p.evaluate(() => window.__calls.getObjectives || 0);
  check('ticking does not reload the whole page',
    loadsAfter === loadsBefore,
    loadsBefore + ' -> ' + loadsAfter + ' getObjectives calls');

  /*
    TWO PRESSES IN A ROW BOTH LAND.

    There used to be one OBJ.busy for the whole screen, so a press made
    while another was still out was dropped without a word. With a slow
    first call that is most of them, and it is why marking a backlog of
    days recorded the first and lost the rest.

    Counted rather than read back: these squares have been pressed earlier
    in the suite, so where they END depends on where they started. What
    matters is that BOTH presses reached the server.
  */
  const sent = () => p.evaluate(() => window.__calls.tickObjTask || 0);
  const sentBefore = await sent();

  await p.evaluate(() => { window.__slowNext = 900; });
  await p.click('.obj-day:nth-child(1)');
  await p.click('.obj-day:nth-child(2)');
  await p.waitForTimeout(1800);

  check('a press made while another is still out is not dropped',
    (await sent()) - sentBefore === 2,
    (await sent()) - sentBefore + ' of 2 presses reached the server');

  /*
    THE SAME SQUARE TWICE IS NOT TWO PRESSES - IT IS A DOUBLE-CLICK.

    Which is how a note is opened, so the mark must not happen at all: a
    second press would otherwise send the mark the button was drawn with
    and undo the first, and somebody double-clicking a green square to
    read its note would clear it and, on re-marking, turn it yellow. So
    the first click is painted at once and HELD, and the second takes it
    back rather than sending anything.
  */
  const sameBefore = await sent();
  const marksNow = () => p.evaluate(() =>
    window.__OBJ_LOG__['2026-11|TASK|OJT-007'].marks);
  // The colour and nothing else: is-reading only says which square's note
  // is open, which is the whole point of the press being tested.
  const classOf = (nth) => p.$eval('.obj-day:nth-child(' + nth + ')',
    (n) => n.className.replace(/\bis-reading\b/g, '')
            .replace(/\s+/g, ' ').trim());
  const wasMarks = await marksNow();
  const wasClass = await classOf(4);

  await p.dblclick('.obj-day:nth-child(4)');
  await p.waitForTimeout(900);
  check('a double-click on a square sends no mark at all',
    (await sent()) - sameBefore === 0,
    (await sent()) - sameBefore + ' calls for a double-click');
  check('and leaves what was recorded exactly as it was',
    (await marksNow()) === wasMarks,
    wasMarks + ' -> ' + (await marksNow()));
  /*
    AND THE SQUARE LOOKS UNTOUCHED TOO.

    The first click paints before it sends - that is what makes marking
    feel instant - so taking it back has to put the colour back as well as
    cancel the call. Reading only the store would miss a square left
    sitting green over a server that never heard about it.
  */
  check('and the square itself goes back to the colour it had',
    (await classOf(4)) === wasClass,
    wasClass + ' -> ' + (await classOf(4)));

  /*
    AT THE SPEED A PERSON ACTUALLY DOUBLE-CLICKS.

    Playwright's dblclick fires both clicks about as fast as the machine
    can, which a mark held for even a moment would survive. A person
    takes a tenth of a second or so, and in that gap a hold that is too
    short lets the first click reach the server - so the note opens AND
    the square is toggled behind it.
  */
  const humanBefore = await sent();
  const wasClass5 = await classOf(5);
  // Driven through the mouse rather than two clicks, because Playwright
  // puts the click count in the event itself: two page.click calls are
  // two FIRST clicks however close together, which is not what a person
  // does. This is one click, a pause, then a second click that says it is
  // the second - which is exactly what the browser reports.
  await p.hover('.obj-day:nth-child(5)');
  await p.mouse.down({ clickCount: 1 });
  await p.mouse.up({ clickCount: 1 });
  await p.waitForTimeout(130);
  await p.mouse.down({ clickCount: 2 });
  await p.mouse.up({ clickCount: 2 });
  await p.waitForTimeout(900);
  check('two clicks a tenth of a second apart are still one double-click',
    (await sent()) - humanBefore === 0 && (await classOf(5)) === wasClass5,
    (await sent()) - humanBefore + ' sent, ' + wasClass5 +
      ' -> ' + (await classOf(5)));

  /*
    A NOTE PER PERIOD, which is the unit the thing is actually about.

    One note for the whole month was the wrong size: twenty-six squares
    shared a single box, so the sentence explaining the 3rd and the
    sentence explaining the 19th had to be written into the same
    paragraph. A square that is red says nobody recorded that day; the
    reason belongs against THAT day.
  */
  const panel = () => p.$eval('.obj-card.is-open .obj-np',
    (n) => n.textContent);
  check('double-clicking a square opens the note for that one period',
    await p.isVisible('.obj-card.is-open .obj-np'));
  /*
    AND THE COLUMN IT OPENS IN IS FOR NOTES, not for the objective's own
    description. The description lives in the spreadsheet and never
    changes; printing it beside the squares filled the one piece of room
    the panel has with something nobody at this screen can act on.
  */
  const card = await p.$eval('.obj-card.is-open', (n) => n.textContent);
  // What the fixture's OJT-007 carries in its Description column.
  const desc = 'Checks proof of delivery (pod) vs. billing.';
  check('and the panel is about notes rather than the sheet"s description',
    card.indexOf(desc) === -1, card.slice(0, 120));
  check('and the panel names the period, not the month',
    /Thursday 5 November 2026/.test(await panel()), await panel());

  /*
    THE SQUARE THAT ALREADY HAS ONE. The 3rd was missed and somebody wrote
    down why - which is the whole point of the feature, so it has to come
    back with who wrote it and when.
  */
  await p.dblclick('.obj-day:nth-child(3)');
  await p.waitForTimeout(400);
  check('a square with a note shows what was written against it',
    /POD report did not generate/.test(await panel()), await panel());
  check('and who saved it, and when',
    /Saved by Bilal Hossain on \d+ \w+ \d{4}/.test(await panel()),
    await panel());
  check('a saved note is read first and edited on purpose',
    !(await p.isVisible('.obj-card.is-open [data-obj-nbox]')) &&
    await p.isVisible('[data-obj-note-edit]'));

  // WHICH SQUARES HAVE ONE, without opening any of them.
  const dotted = await p.$$eval('.obj-card.is-open .obj-day.has-note',
    (ns) => ns.map((n) => n.textContent.trim()));
  check('the square carrying it is marked, so it can be found',
    dotted.join(',') === '3', dotted.join(','));

  await p.click('[data-obj-note-edit]');
  await p.waitForTimeout(250);
  await p.fill('[data-obj-nbox]', 'POD report did not generate. SD raised ' +
    'INC-4471; cleared on the 4th.');
  await p.click('[data-obj-note-keep]');
  await p.waitForTimeout(800);

  const slotNote = () => p.evaluate(() =>
    window.__OBJ_LOG__['2026-11|TASK|OJT-007'].notes['2']);
  check('an edit saves against the slot it was opened on',
    /cleared on the 4th/.test((await slotNote()).t), (await slotNote()).t);
  check('and the first time it was written is not lost to the edit',
    (await slotNote()).made < (await slotNote()).at,
    JSON.stringify(await slotNote()));
  check('and it is counted as an edit, by whoever made it',
    (await slotNote()).n === 2 && (await slotNote()).by === 'Utpal Biswas',
    JSON.stringify(await slotNote()));
  check('the panel says it has been edited since it was written',
    /edited once/.test(await panel()), await panel());

  /*
    A NOTE ON A SQUARE THAT HAS NONE, which is the ordinary case: an empty
    box, and nothing in the store until it is saved.
  */
  await p.dblclick('.obj-day:nth-child(9)');
  await p.waitForTimeout(400);
  check('an empty period opens straight into a box to write in',
    await p.isVisible('[data-obj-nbox]') &&
    (await p.$eval('[data-obj-nbox]', (n) => n.value)) === '');
  await p.fill('[data-obj-nbox]', 'Out at the Chittagong site; no access.');
  await p.click('[data-obj-note-keep]');
  await p.waitForTimeout(800);
  const ninth = await p.evaluate(() =>
    window.__OBJ_LOG__['2026-11|TASK|OJT-007'].notes['7']);
  check('a note on a missed day saves without marking the day',
    ninth && /Chittagong/.test(ninth.t), JSON.stringify(ninth));
  check('and writing one marks nothing',
    (await marksNow()).charAt(7) !== 'Y', await marksNow());

  /*
    IT SURVIVES A TICK NEXT TO IT. The list is rebuilt from innerHTML on
    every mark, so a half-written note living only in the textarea would
    be thrown away by somebody pressing the square beside it.
  */
  await p.dblclick('.obj-day:nth-child(10)');
  await p.waitForTimeout(400);
  await p.fill('[data-obj-nbox]', 'Half a sentence so far');
  await p.click('.obj-day:nth-child(1)');
  await p.waitForTimeout(900);
  check('what is half-written survives a mark made beside it',
    (await p.$eval('[data-obj-nbox]', (n) => n.value)) ===
      'Half a sentence so far',
    await p.$eval('[data-obj-nbox]', (n) => n.value));

  await p.click('[data-obj-note-shut]');
  await p.waitForTimeout(250);
  check('and the panel closes without saving it',
    !(await p.isVisible('.obj-card.is-open .obj-np.is-edit')) &&
    !(await p.evaluate(() =>
      window.__OBJ_LOG__['2026-11|TASK|OJT-007'].notes['8'])));

  await p.click('[data-obj-close]');
  await p.waitForTimeout(300);
  await p.click('[data-obj-open="OJT-007"]');
  await p.waitForTimeout(450);
  await p.dblclick('.obj-day:nth-child(3)');
  await p.waitForTimeout(400);
  check('a saved note is still there when the panel is opened again',
    /cleared on the 4th/.test(await panel()), await panel());

  await p.click('[data-obj-close]');
  await p.waitForTimeout(300);

  // =========================================================================
  // 6b. a refused tick puts the square back and says why
  // =========================================================================
  {
    const q = await b.newPage({ viewport: { width: 1500, height: 1000 } });
    await q.goto(FILE + '?view=objective&refuse=tick');
    await q.waitForTimeout(1300);
    await q.click('#objTabTask');
    await q.waitForTimeout(500);

    check('the warning strip is out of the way until there is something to say',
      await q.$eval('#objWarn', (n) => n.hidden));

    // The monthly one opens onto its panel, like every other frequency.
    await q.click('[data-obj-open="OJT-005"]');
    await q.waitForTimeout(400);
    await q.click('.obj-card.is-open .obj-day');
    await q.waitForTimeout(700);

    check('a refused tick says so where it can be seen',
      !(await q.$eval('#objWarn', (n) => n.hidden)) &&
      /FI module/.test(await q.$eval('#objWarn', (n) => n.textContent)),
      await q.$eval('#objWarn', (n) => n.textContent));
    check('and the square goes back to what it was',
      await q.$eval('.obj-card.is-open .obj-day',
        (n) => !n.classList.contains('is-y') &&
               !n.classList.contains('is-l')),
      await q.$eval('.obj-card.is-open .obj-day', (n) => n.className));
    await q.close();
  }

  // =========================================================================
  // 6c. frequency narrows the list
  // =========================================================================
  await p.click('#objFilters [data-freq="Daily"]');
  await p.waitForTimeout(350);
  check('a frequency chip narrows the list to that frequency',
    (await cards()) === 2, (await cards()) + ' cards');

  await p.click('#objFilters [data-group="MM"]');
  await p.waitForTimeout(350);
  check('module and frequency narrow each other rather than replacing',
    (await cards()) === 0 || (await cards()) === 1,
    (await cards()) + ' cards for MM + Daily');

  await p.click('#objFilters [data-freq="Weekly"]');
  await p.waitForTimeout(350);
  check('MM and Weekly together is one objective',
    (await cards()) === 1, (await cards()) + ' cards');

  await p.click('#objFilters [data-freq="ALL"]');
  await p.click('#objFilters [data-group="ALL"]');
  await p.waitForTimeout(350);
  check('and clearing both brings everything back', (await cards()) === 12);

  // =========================================================================
  // 7. the module chips
  // =========================================================================
  // The card was closed back in section 6, before the two-presses check.
  const chips = () => p.$$eval('#objFilters .obj-filter', (ns) =>
    ns.map((n) => n.textContent.trim()));
  // Module chips only - the frequency row has its own lit chip and the two
  // narrow each other rather than replacing each other.
  const lit = () => p.$$eval('#objFilters .obj-filter.is-on[data-group]',
    (ns) => ns.map((n) => n.getAttribute('data-group')));

  // The exact list, not a pattern. The fixture names six groups and only
  // four of them have anything filed under them this month; a pattern like
  // "no chip ending in 0" passed happily on chips reading "PP undefined".
  check('a module with nothing in it this month gets no chip at all',
    (await chips()).join(' | ') ===
      'All 12 | EAS 7 | KPI 4 | SD 5 | MM 2 | CO 1 | ' +
      'Any frequency | Daily 2 | Weekly 3 | Monthly 6 | Quarterly 1',
    (await chips()).join(' | '));

  // It said "Mine", which on this page means "whatever module is against
  // your name" - and for the department head that is nearly all ninety.
  check('the personal chip says EAS, not Mine',
    (await chips()).some((c) => /^EAS /.test(c)) &&
    !(await chips()).some((c) => /^Mine /.test(c)));

  // A quarterly objective has no slot in November, so it is not offered as
  // a frequency to filter by - a chip that empties the page when pressed.
  /*
    QUARTERLY IS OFFERED EVEN THOUGH NOTHING IS DUE THIS MONTH.

    It used to be left out of the row whenever nothing was due, which meant
    the quarterly chip vanished for two months out of three - and a filter
    that disappears is worse than one that shows four objectives saying
    "due in December".
  */
  check('every frequency is offered, due this month or not',
    (await chips()).filter((c) => /^(Daily|Weekly|Monthly|Quarterly) /.test(c))
      .join(',') === 'Daily 2,Weekly 3,Monthly 6,Quarterly 1',
    (await chips()).join(' | '));

  await p.click('#objFilters [data-freq="Quarterly"]');
  await p.waitForTimeout(350);
  check('and pressing it shows what is not due yet, with when it is',
    (await cards()) === 1 &&
    /due in December 2026/.test(await p.$eval('#objList', (n) => n.textContent)),
    (await p.$eval('#objList', (n) => n.textContent)).slice(0, 120));
  await p.click('#objFilters [data-freq="ALL"]');
  await p.waitForTimeout(300);
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

  /*
    THE FORM IS IN THE PAGE, NOT FIXED TO A VIEWPORT.

    The app runs in an Apps Script iframe inside a Blogger post, and that
    iframe is taller than the browser window - the window scrolls the
    Blogger page, not the iframe. A position:fixed modal is therefore
    pinned to the middle of a box nobody can see all of: it opened with its
    top half above the visible area and drifted as the page scrolled.
  */
  const sheetPos = await p.$eval('#objSheet', (n) =>
    getComputedStyle(n).position);
  check('the form is laid out in the page, not fixed to the window',
    sheetPos === 'static', sheetPos);

  // And it sits above the list rather than on top of it, so nothing it
  // covers has to be scrolled past to reach it.
  const order = await p.evaluate(() => {
    const s = document.getElementById('objSheet');
    const l = document.getElementById('objList');
    return s.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING
      ? 'before' : 'after';
  });
  check('and it comes before the list it is adding to', order === 'before');

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
