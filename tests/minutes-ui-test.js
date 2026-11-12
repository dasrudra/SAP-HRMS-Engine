// The Minutes page, in a browser.
//
// WHY THIS EXISTS
// minutes-test.js proves the server. This proves the page draws what the
// server sent and sends back what it shows - which is the half the server
// suite cannot see, and where almost everything on this screen can go wrong,
// because the page and the server have to agree about the SHAPE of a meeting
// and neither of them can check that alone.
//
// WHAT IT GUARDS, worst first:
//
//   the cell sends what it shows      somebody types into a table and presses
//                                     Save. The page then redraws from the
//                                     server's answer, so a page that sent
//                                     the OLD text still looks right. Checked
//                                     by reading the store back, never the
//                                     redrawn cell
//   a multi-line cell survives        SCA's findings column is seven numbered
//                                     lines in ONE cell. Read with
//                                     textContent they run together and the
//                                     slide is quietly ruined
//   the merges are real               a group cell spans its rows. Drawn
//                                     without the rowspan the table still
//                                     renders - just with the zone repeated
//                                     six times, which is not the deck
//   the tones are PAINTED             read off getComputedStyle, not off a
//                                     class name, and with the alpha. The
//                                     pips on the Objectives page went grey
//                                     for a fortnight while a test asserting
//                                     the class name passed
//   half-written work survives        tabbing to Objectives to look something
//                                     up is the obvious thing to do on this
//                                     screen, and it used to throw the
//                                     typing away without a word
//   no cell that cannot be typed in   another section's minutes are readable
//                                     and not editable, and the page says
//                                     which section they are
//   a new meeting is a copy           the thing the sections asked for, and
//                                     the one behaviour a page could undo by
//                                     helpfully clearing the form
//
//   node tests/harness/build.js && node tests/minutes-ui-test.js
const path = require('path'), fs = require('fs');

const PAGE = process.env.EAS_PAGE ||
             path.join(__dirname, 'harness', 'page.html');
const BROWSER = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

/*
  EITHER PACKAGE. The other browser suites ask for playwright-core and skip
  when it is missing - and a machine with the full `playwright` installed
  and not the core package skips every one of them while reporting nothing
  wrong. A skipped suite that looks like a passing suite is the worst of
  both, so this one takes whichever is there.
*/
let chromium = null;
['playwright-core', 'playwright'].forEach(function (pkg) {
  if (chromium) return;
  try { chromium = require(pkg).chromium; } catch (e) { /* try the next */ }
});

if (!chromium || !fs.existsSync(BROWSER)) {
  console.log('SKIP  browser tests - ' +
    (chromium ? 'no Chromium at ' + BROWSER
              : 'neither playwright-core nor playwright is installed'));
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

function lum(rgb) {
  const c = rgb.slice(0, 3).map(function (v) {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/*
  ALPHA MATTERS, and leaving it out cost a mutant.

  An unpainted cell computes to rgba(0, 0, 0, 0). Dropping the alpha turns
  that into pure black - so "these two rows are painted differently" was
  true of a row with a tint beside a row with no background at all, which
  is exactly the state the assertion existed to catch.
*/
function parseRgb(text) {
  const hit = /rgba?\(([^)]+)\)/.exec(String(text || ''));
  if (!hit) return null;
  const n = hit[1].split(',').map(function (x) { return parseFloat(x); });
  return [n[0], n[1], n[2], n.length > 3 ? n[3] : 1];
}
function painted(c) { return Boolean(c) && c[3] > 0.05; }
function apart(a, b) {
  if (!a || !b) return 0;
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

(async function () {
  const b = await chromium.launch({ executablePath: BROWSER });
  const errors = [];

  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });

  /** What the fixture's sheet actually holds for a meeting. */
  const stored = (id) => p.evaluate((want) => {
    const row = window.__MINUTES__.read().filter(function (m) {
      return m.id === want;
    })[0];
    if (!row) return null;
    return { id: row.id, section: row.section, date: row.date, time: row.time,
             host: row.host, attendees: row.attendees, status: row.status,
             by: row.by, body: JSON.parse(row.body || '{}') };
  }, id);

  const rowsOf = (meeting, blockId) => {
    const hit = ((meeting && meeting.body && meeting.body.blocks) || [])
      .filter(function (x) { return x.id === blockId; })[0];
    return (hit && hit.rows) || [];
  };

  const openSection = async (code) => {
    await p.click('[data-mn-section="' + code + '"]');
    await p.waitForTimeout(700);
  };

  await p.goto(FILE);
  await p.waitForTimeout(1200);
  await p.click('.portal-tab[data-view="minutes"]');
  await p.waitForTimeout(1100);

  // =========================================================================
  // 1. the page, and that it is the light one
  // =========================================================================
  check('the Minutes tab opens the Minutes page',
    await p.isVisible('#view-minutes') && await p.isVisible('.mn-band'));
  check('and the router recorded the decision',
    await p.evaluate(() => window.__SHOWN_VIEW__) === 'minutes');

  const bandBg = parseRgb(await p.$eval('.mn-band', (n) =>
    getComputedStyle(n).backgroundColor));
  const bodyBg = parseRgb(await p.$eval('#view-minutes', (n) =>
    getComputedStyle(n).backgroundColor));
  check('the band is dark and the page under it is light',
    lum(bandBg) < 0.12 && lum(bodyBg) > 0.8,
    'band ' + lum(bandBg).toFixed(3) + ' body ' + lum(bodyBg).toFixed(3));

  /*
    THE ONE THAT WOULD BE INVISIBLE. Every other portal page is white text
    on blue, and anything on this one that inherits that is white on white.
  */
  const sideInk = parseRgb(await p.$eval('.mn-mtg b', (n) =>
    getComputedStyle(n).color));
  check('the meeting list is not white text on a white page',
    lum(sideInk) < 0.3, 'ink ' + lum(sideInk).toFixed(3));

  check('all four sections have a tab', (await p.$$('.mn-tab')).length === 4);
  check('and the one that is open is marked',
    await p.$eval('.mn-tab.is-on', (n) => n.getAttribute('data-mn-section')) === 'SCA');

  // =========================================================================
  // 2. the list, and what opens
  // =========================================================================
  const dates = await p.$$eval('.mn-mtg b', (ns) => ns.map((n) => n.textContent));
  check('the meetings are newest first',
    dates.join(' | ') === '10 Nov 2026 | 27 Oct 2026', dates.join(' | '));
  check('the newest is the one open',
    await p.$eval('.mn-mtg.is-on b', (n) => n.textContent) === '10 Nov 2026');

  await p.click('.mn-mtg:nth-of-type(2)');
  await p.waitForTimeout(700);
  check('clicking an older meeting opens it',
    await p.$eval('#mnDate', (n) => n.value) === '2026-10-27',
    await p.$eval('#mnDate', (n) => n.value));
  await p.click('.mn-mtg:nth-of-type(1)');
  await p.waitForTimeout(700);

  // =========================================================================
  // 3. the slide is the section's own, not a house style
  // =========================================================================
  check('Supply Chain draws its two bordered panels',
    (await p.$$('#mnStage .mn-col.is-panel')).length === 2);
  check('and its blocks, in order',
    (await p.$$eval('#mnStage [data-mn-block]', (ns) =>
      ns.map((n) => n.getAttribute('data-mn-block')))).join(',') ===
    'mdIssue,mdWeight,mdOther,mmFind,mmObj,action,knowledge');

  /*
    THE TABLE HEADER IS THE DECK'S DARK TEAL, read off the rendered cell
    rather than off a class. The pips on the Objectives page were grey for a
    fortnight while a test asserting their class name passed the whole time.
  */
  const headBg = parseRgb(await p.$eval('#mnStage .mn-tbl th', (n) =>
    getComputedStyle(n).backgroundColor));
  check('its table headers are painted the deck\'s teal, not left default',
    painted(headBg) && apart(headBg, [16, 72, 98]) < 12,
    'rgba(' + headBg.join(',') + ')');
  const headInk = parseRgb(await p.$eval('#mnStage .mn-tbl th', (n) =>
    getComputedStyle(n).color));
  check('with light text on it', lum(headInk) > 0.8);

  // =========================================================================
  // 4. the merges are real
  // =========================================================================
  const spans = await p.$$eval('#mnStage [data-mn-block="mmFind"] td[rowspan]',
    (ns) => ns.map((n) => Number(n.getAttribute('rowspan'))));
  check('a group cell spans the rows it covers',
    spans.length === 1 && spans[0] === 3, JSON.stringify(spans));

  const cells = await p.$$eval(
    '#mnStage [data-mn-block="mmFind"] tr:nth-of-type(3) td', (ns) => ns.length);
  check('and the rows under it carry one cell fewer',
    cells === 3 + 1, cells + ' cells (3 plus the row control)');

  // =========================================================================
  // 5. a multi-line cell
  // =========================================================================
  const lines = await p.$eval(
    '#mnStage [data-mn-block="mmFind"] td[rowspan]',
    (n) => n.innerText.split('\n').filter((s) => s.trim()).length);
  check('a multi-line cell is drawn with its lines', lines === 5, lines + ' lines');

  /*
    AND THE RULE THAT KEEPS THEM, MEASURED WHERE IT ACTUALLY MATTERS.

    Asked of an editable cell this proves nothing: Chrome's own stylesheet
    forces white-space: pre-wrap on anything contenteditable, so the answer
    is pre-wrap whatever this project's CSS says. Deleting the rule changed
    nothing a test could see.

    The rule exists for the cells the browser is NOT styling - another
    section's minutes, and every cell in present mode - so it is read with
    the editing turned off, which is the state it is there for.
  */
  const wrap = await p.evaluate(() => {
    const el = document.querySelector('#mnStage [data-mn-block="mmFind"] td[rowspan]');
    const had = el.getAttribute('contenteditable');
    el.removeAttribute('contenteditable');
    const got = getComputedStyle(el).whiteSpace;
    if (had !== null) el.setAttribute('contenteditable', had);
    return got;
  });
  check('and the rule that keeps them holds when the cell is read-only',
    /pre/.test(wrap), wrap);

  // =========================================================================
  // 6. editing, and what reaches the sheet
  // =========================================================================
  check('a cell in your own section is typeable',
    await p.$eval('#mnStage [data-mn-block="mdIssue"] td[data-mn-c="1"]',
      (n) => n.getAttribute('contenteditable')) !== null);

  const saveWanted = () => p.$eval('#mnSave',
    (n) => n.classList.contains('is-wanted'));
  check('and Save does not look wanted before anything is typed',
    (await saveWanted()) === false);

  const cell = '#mnStage [data-mn-block="mdIssue"] tr[data-mn-row="0"] td[data-mn-c="1"]';

  /*
    THE TEXT CARRIES AN & AND A <, deliberately. A cell read back out of
    innerHTML instead of innerText looks identical for ordinary words and
    comes back as "GR &amp; GI" the moment somebody types an ampersand -
    which, on a page full of "RMG & MG", is the first day it is used.
  */
  const saidBefore = await p.$eval('#mnSaid', (n) => n.textContent);
  await p.click(cell);
  await p.keyboard.type('Vendor master <duplicated> GR & GI');
  await p.keyboard.press('Enter');
  await p.keyboard.type('Raised with the zone');
  await p.waitForTimeout(150);

  check('typing marks Save as wanted', (await saveWanted()) === true);

  await p.click('[data-mn-save]');
  await p.waitForTimeout(1200);

  const after = await stored('SCA-20261110');
  const issue = rowsOf(after, 'mdIssue')[0][1];
  check('what was typed reached the sheet',
    issue.indexOf('Vendor master <duplicated> GR & GI') === 0,
    JSON.stringify(issue));
  check('with its angle brackets and ampersand as typed, not as entities',
    issue.indexOf('&amp;') === -1 && issue.indexOf('&lt;') === -1,
    JSON.stringify(issue));
  check('including the line break',
    issue === 'Vendor master <duplicated> GR & GI\nRaised with the zone',
    JSON.stringify(issue));

  check('Save stops looking wanted once it is saved',
    (await saveWanted()) === false);

  /*
    AND THE PAGE RE-READ THE MEETING, rather than keeping its own copy of
    what it just sent. The server trims, caps and rebuilds every cell, so a
    page that believed its own draft would be showing something the sheet
    does not hold - and the first sign of it is two people disagreeing about
    what the meeting says.
  */
  const saidAfter = await p.$eval('#mnSaid', (n) => n.textContent);
  check('and the page says who saved it',
    /Saved by Signed In Person/.test(saidAfter), saidAfter);
  check('and the saved line moved on, so the meeting was re-read',
    saidAfter !== saidBefore, saidBefore + '  ->  ' + saidAfter);

  /*
    NOTHING ELSE MOVED. A collect that mis-indexed one block would write the
    typed text into the right cell and quietly blank another.
  */
  check('and no other cell was disturbed',
    rowsOf(after, 'mdIssue')[1][0] === 'CEPZ' &&
    rowsOf(after, 'mmObj')[0][2] === 'Follow-up by responsible person',
    JSON.stringify(rowsOf(after, 'mdIssue')[1]));

  /*
    THE CONTRACT minRead HAS TO MEET, tested directly.

    Typing cannot produce this state on this browser - pre-wrap makes Chrome
    insert a plain newline even for contenteditable="true" - so the markup
    is put into the cell as a browser without plaintext-only would leave it.
    Read with textContent that comes back as "First lineSecond line": one
    line, no error, and a slide quietly ruined.
  */
  const plain = '#mnStage [data-mn-block="mdWeight"] tr[data-mn-row="0"] td[data-mn-c="1"]';
  const broke = await p.$eval(plain, (n) => {
    n.innerHTML = 'First line<br>Second line';
    return { text: n.textContent, inner: n.innerText };
  });
  check('a cell broken with markup reads as one line through textContent',
    broke.text === 'First lineSecond line', JSON.stringify(broke.text));
  check('and as two through innerText',
    broke.inner.replace(/\r/g, '') === 'First line\nSecond line',
    JSON.stringify(broke.inner));

  await p.evaluate(() => {
    // The page only knows it is dirty when something is typed, and this was
    // written straight into the DOM.
    document.getElementById('mnStage')
      .dispatchEvent(new Event('input', { bubbles: true }));
  });
  await p.click('[data-mn-save]');
  await p.waitForTimeout(1200);
  const fallback = rowsOf(await stored('SCA-20261110'), 'mdWeight')[0][1];
  check('and the sheet got the two lines, not the run-on one',
    fallback === 'First line\nSecond line', JSON.stringify(fallback));

  // The header fields are editable too, and go to their own columns.
  await p.click('#mnStage [data-mn-head="host"]');
  await p.keyboard.type('The section lead');
  await p.click('[data-mn-save]');
  await p.waitForTimeout(1200);
  const withHost = await stored('SCA-20261110');
  check('the host goes into its own column, not into the body',
    withHost.host === 'The section lead', withHost.host);

  // =========================================================================
  // 6b. half-written, and tabbed away from
  // =========================================================================
  /*
    THE OBVIOUS THING TO DO ON THIS SCREEN. A meeting is about the objectives
    on the tab next door, so somebody fills in two cells, goes to look one
    up, and comes back. The page re-reads on every visit - which is right
    while two people are writing the same meeting, and wrong when one of them
    is you, mid-sentence. It threw the typing away without a word.
  */
  await p.click(cell);
  await p.keyboard.press('End');
  await p.keyboard.type(' STILL BEING WRITTEN');
  await p.waitForTimeout(150);

  await p.click('.portal-tab[data-view="objective"]');
  await p.waitForTimeout(900);
  await p.click('.portal-tab[data-view="minutes"]');
  await p.waitForTimeout(1300);

  const kept = await p.$eval(cell, (n) => n.innerText);
  check('an unsaved meeting survives a trip to another tab',
    kept.indexOf('STILL BEING WRITTEN') !== -1, JSON.stringify(kept));
  check('and Save still knows there is something to save',
    (await saveWanted()) === true);

  await p.click('[data-mn-save]');
  await p.waitForTimeout(1200);
  check('and saving it afterwards reaches the sheet',
    rowsOf(await stored('SCA-20261110'), 'mdIssue')[0][1]
      .indexOf('STILL BEING WRITTEN') !== -1,
    JSON.stringify(rowsOf(await stored('SCA-20261110'), 'mdIssue')[0][1]));

  // =========================================================================
  // 7. adding and removing a row
  // =========================================================================
  const before = rowsOf(await stored('SCA-20261110'), 'mdWeight').length;
  await p.click('[data-mn-block="mdWeight"] [data-mn-addrow]');
  await p.waitForTimeout(200);
  await p.keyboard.type('DEPZ-2');
  await p.click('[data-mn-save]');
  await p.waitForTimeout(1200);

  const grew = rowsOf(await stored('SCA-20261110'), 'mdWeight');
  check('a row added on the page is saved', grew.length === before + 1,
    before + ' -> ' + grew.length);
  check('and the typing landed in it', grew[grew.length - 1][0] === 'DEPZ-2',
    JSON.stringify(grew[grew.length - 1]));

  await p.hover('[data-mn-block="mdWeight"] tr[data-mn-row="3"]');
  await p.click('[data-mn-block="mdWeight"] tr[data-mn-row="3"] [data-mn-delrow]');
  await p.waitForTimeout(250);
  await p.click('[data-mn-save]');
  await p.waitForTimeout(1200);

  const shrank = rowsOf(await stored('SCA-20261110'), 'mdWeight');
  check('and removing it takes it away again', shrank.length === before,
    before + ' -> ' + shrank.length);
  check('leaving the rows that were there',
    shrank.map(function (r) { return r[0]; }).join(',') === 'DEPZ,CEPZ,KEPZ',
    shrank.map(function (r) { return r[0]; }).join(','));

  // =========================================================================
  // 8. the row tones, on the sections that colour-code
  // =========================================================================
  await openSection('PP');
  check('PP has no meetings yet, and says so plainly',
    await p.isVisible('#mnStage .mn-empty'));

  await openSection('FICO');
  await p.waitForTimeout(400);
  check('FI/CO draws one wide table', (await p.$$('#mnStage .mn-flow')).length === 1);
  const ficoHead = parseRgb(await p.$eval('#mnStage .mn-tbl th', (n) =>
    getComputedStyle(n).backgroundColor));
  check('and its header is the deck\'s brown',
    painted(ficoHead) && apart(ficoHead, [124, 52, 20]) < 12,
    'rgba(' + ficoHead.join(',') + ')');
  check('with its band text light enough to read on it',
    lum(parseRgb(await p.$eval('#mnStage .mn-band-slide h1', (n) =>
      getComputedStyle(n).color))) > 0.8);

  /*
    FI/CO BANDS RMG AGAINST MG inside each zone, and that banding is how
    somebody reads a twelve-row table across a room. A zebra that stopped
    being painted would leave a perfectly tidy table nobody can scan.
  */
  const rowA = parseRgb(await p.$eval(
    '#mnStage [data-mn-block="ops"] tr[data-mn-row="0"] td[data-mn-c="3"]',
    (n) => getComputedStyle(n).backgroundColor));
  const rowB = parseRgb(await p.$eval(
    '#mnStage [data-mn-block="ops"] tr[data-mn-row="1"] td[data-mn-c="3"]',
    (n) => getComputedStyle(n).backgroundColor));
  check('and consecutive rows are BOTH painted, and differently',
    painted(rowA) && painted(rowB) && apart(rowA, rowB) > 20,
    'rgba(' + rowA.join(',') + ') vs rgba(' + rowB.join(',') + ')');

  check('its first two columns both merge downward',
    (await p.$$('#mnStage [data-mn-block="ops"] td[rowspan]')).length === 8,
    String((await p.$$('#mnStage [data-mn-block="ops"] td[rowspan]')).length));

  /*
    'Status' IS ONE HEADING OVER TWO COLUMNS. Reading the deck's XML it looks
    like a header row that slipped; the rendered slide shows a merged cell.
    Getting that wrong puts the word over the wrong column.
  */
  check('and Status is one heading spanning two columns',
    await p.$eval('#mnStage [data-mn-block="ops"] th:last-of-type',
      (n) => n.getAttribute('colspan')) === '2');

  // =========================================================================
  // 9. somebody else's section
  // =========================================================================
  check('another section\'s cells are not typeable',
    (await p.$$('#mnStage [contenteditable]')).length === 0,
    String((await p.$$('#mnStage [contenteditable]')).length));
  check('there is no Save button on it',
    (await p.$$('[data-mn-save]')).length === 0);
  check('no New meeting button either',
    await p.$eval('#mnNew', (n) => n.hidden) === true);
  check('and the page says whose minutes they are',
    /Financial Applications/.test(
      await p.$eval('#mnSideNote', (n) => n.hidden ? '' : n.textContent)),
    await p.$eval('#mnSideNote', (n) => n.textContent));

  // =========================================================================
  // 10. a new meeting is a copy of the last one
  // =========================================================================
  await openSection('SCA');
  await p.waitForTimeout(400);

  /*
    MINUTES BY IS SET FIRST, through the endpoint the page uses. Asserting
    that a new meeting does not carry it over is vacuous while the source
    meeting's is empty - a mutant that carried it over survived exactly that
    way.
  */
  await p.evaluate(() => new Promise((done) => {
    google.script.run.withSuccessHandler(done).withFailureHandler(done)
      .saveMinutes('t', 'SCA-20261110', { minutesBy: 'Whoever wrote that one' });
  }));
  await p.click('.mn-mtg[data-mn-open="SCA-20261110"]');
  await p.waitForTimeout(900);

  const was = await stored('SCA-20261110');
  check('the source meeting now names who minuted it',
    (was.body.head || {}).minutesBy === 'Whoever wrote that one',
    JSON.stringify((was.body.head || {}).minutesBy));

  await p.click('#mnNew');
  await p.waitForTimeout(1500);

  const list = await p.$$eval('.mn-mtg b', (ns) => ns.map((n) => n.textContent));
  check('a new meeting appears at the top', list.length === 3, list.join(' | '));

  const madeId = await p.$eval('.mn-mtg.is-on',
    (n) => n.getAttribute('data-mn-open'));
  const made = await stored(madeId);
  check('and it carries the edited cell forward, not the seeded one',
    rowsOf(made, 'mdIssue')[0][1] === rowsOf(was, 'mdIssue')[0][1],
    JSON.stringify(rowsOf(made, 'mdIssue')[0][1]));
  check('and the host with it', made.host === was.host, made.host);
  check('but not who minuted the last one',
    (made.body.head || {}).minutesBy === '',
    JSON.stringify((made.body.head || {}).minutesBy));
  check('it is a draft', made.status === 'DRAFT');

  // =========================================================================
  // 11. presenting
  // =========================================================================
  const frameWide = () => p.$eval('#mnFrame', (n) =>
    Math.round(n.getBoundingClientRect().width));
  const normal = await frameWide();

  /*
    A SHORT WINDOW, deliberately. At 1500x1000 the width is what limits a
    16:9 slide anyway, so scaling to the width alone and scaling to fit give
    the same answer and the difference between them is invisible. A wide,
    short window - a laptop with a browser's chrome taking a third of it,
    which is what these meetings are actually run from - is where a slide
    scaled to the width runs off the bottom.
  */
  await p.setViewportSize({ width: 1500, height: 620 });
  await p.waitForTimeout(300);

  await p.click('[data-mn-present]');
  await p.waitForTimeout(600);
  check('presenting hides the band', await p.isVisible('.mn-band') === false);
  check('and the meeting list', await p.isVisible('.mn-side') === false);
  check('and gives the slide the width', (await frameWide()) > normal,
    normal + ' -> ' + (await frameWide()));

  const fit = await p.evaluate(() => {
    const s = document.getElementById('mnStage');
    const f = document.getElementById('mnFrame');
    const box = f.getBoundingClientRect();
    const m = /scale\(([\d.]+)\)/.exec(s.style.transform || '');
    return { scale: m ? Number(m[1]) : 0,
             roomW: Math.round(box.width), roomH: Math.round(box.height),
             full: document.fullscreenElement === f };
  });

  /*
    THE SLIDE FITS THE ROOM, both ways. Asserting only the width was wrong:
    this harness is not in an iframe, so requestFullscreen SUCCEEDS and the
    frame becomes the whole display - where a slide scaled to the width alone
    runs off the bottom. The requirement is the same either way, so the
    assertion is the same either way.
  */
  check('the slide is scaled to fit the room it is in',
    fit.scale > 0 &&
    1280 * fit.scale <= fit.roomW + 2 &&
    720 * fit.scale <= fit.roomH + 2,
    'scale ' + fit.scale.toFixed(3) + ' in ' + fit.roomW + 'x' + fit.roomH +
    (fit.full ? ' (fullscreen)' : ''));
  check('and as large as that room allows',
    Math.abs(fit.scale - Math.min(fit.roomW / 1280, fit.roomH / 720)) < 0.02,
    'scale ' + fit.scale.toFixed(3) + ' of a possible ' +
    Math.min(fit.roomW / 1280, fit.roomH / 720).toFixed(3));

  /*
    THE BROWSER'S OWN WAY OUT, tested before the page's.

    In real fullscreen the browser takes Escape before any listener sees it,
    so the page's own key handler never runs. A page that only listened for
    the key would come out of fullscreen with its band and its meeting list
    still hidden and nothing on screen to get them back - and pressing
    Escape again would do nothing, because there is no fullscreen left to
    leave.
  */
  const wasFull = await p.evaluate(() => Boolean(document.fullscreenElement));
  if (wasFull) {
    await p.evaluate(() => document.exitFullscreen());
    await p.waitForTimeout(600);
    check('leaving fullscreen leaves present mode with it',
      await p.isVisible('.mn-band') === true);
    await p.click('[data-mn-present]');
    await p.waitForTimeout(600);
  } else {
    check('leaving fullscreen leaves present mode with it',
      true, 'skipped - this browser refused fullscreen');
  }

  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);
  check('and Escape comes back out', await p.isVisible('.mn-band') === true);
  await p.setViewportSize({ width: 1500, height: 1000 });

  // =========================================================================
  check('nothing threw while all that happened',
    errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();

  console.log('');
  const bad = out.filter((x) => !x).length;
  console.log((out.length - bad) + '/' + out.length + ' passed' +
              (bad ? ', ' + bad + ' failed' : ''));
  process.exit(bad ? 1 : 0);
})();
