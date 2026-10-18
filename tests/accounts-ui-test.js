// The Accounts table, driven in a real browser.
//
// The question this table gets asked is "who has been in recently", and for a
// while it answered a different one: it listed employee IDs in whatever order
// the sheet held them, with a sign-in COUNT at the end. A total of 29 since
// October tells you nothing you can act on; "was here this morning" does.
//
// So: newest sign-in at the top, and the count is gone. Two rows have to be
// handled on purpose rather than by accident -
//
//   somebody who has never signed in, whose empty date would otherwise sort
//   as though they had been here in 1970, and
//
//   the shared starting login, which is not a person, has no sign-in of its
//   own, and belongs at the bottom whatever else is going on.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/accounts-ui-test.js
const path = require('path'), fs = require('fs');

const PAGE = process.env.EAS_PAGE ||
             path.join(__dirname, 'harness', 'page.html');
const BROWSER = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* below */ }

if (!chromium || !fs.existsSync(BROWSER)) {
  console.log('SKIP  browser tests - ' +
    (chromium ? 'no Chromium at ' + BROWSER : 'playwright-core is not installed'));
  console.log('      npm install playwright-core, and set CHROMIUM_PATH if needed.');
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

(async () => {
  const b = await chromium.launch({ executablePath: BROWSER });
  const errors = [];
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  await p.goto('file://' + PAGE + '?view=master');
  await p.waitForTimeout(2000);

  // ---------------------------------------------------------------------------
  // what the table shows
  // ---------------------------------------------------------------------------
  const heads = await p.$$eval('#masterTable thead th',
                               (ts) => ts.map((t) => t.textContent.trim()));
  check('the sign-in count column is gone',
    !heads.some((h) => /sign-ins/i.test(h)), heads.join(' | '));
  check('and the columns that are left still line up with the header',
    (await p.$$eval('#masterTable tbody tr:not(:last-child) td',
                    (ts) => ts.length)) % heads.length === 0,
    heads.length + ' columns');

  // ---------------------------------------------------------------------------
  // the order
  // ---------------------------------------------------------------------------
  const rows = await p.$$eval('#masterTable tbody tr', (rs) => rs.map((r) => ({
    id: r.cells[0].textContent.trim(),
    last: r.cells[4] ? r.cells[4].textContent.trim() : ''
  })));

  check('the person here most recently is at the top',
    rows[0].id === '20536723', rows[0].id + ' (' + rows[0].last + ')');

  const dated = rows.filter((r) => /\d{4}-\d{2}-\d{2}/.test(r.last));
  const inOrder = dated.every(function (r, i) {
    return i === 0 || dated[i - 1].last >= r.last;
  });
  check('and the rest follow, newest to oldest',
    inOrder && dated.length === 4,
    dated.map((r) => r.id + ' ' + r.last).join('  >  '));

  // The two that have to be handled rather than left to chance.
  const never = rows.findIndex((r) => r.id === '20900001');
  const shared = rows.findIndex((r) => r.id === 'user');
  check('somebody who has never signed in sorts below everybody who has',
    never === dated.length,
    'row ' + (never + 1) + ' of ' + rows.length);
  check('and the shared starting login is last, being nobody',
    shared === rows.length - 1, 'row ' + (shared + 1) + ' of ' + rows.length);

  // ---------------------------------------------------------------------------
  // the message bar
  // ---------------------------------------------------------------------------
  const bar = await p.$eval('#msgrBar', (el) => {
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return {
      width: Math.round(r.width), height: Math.round(r.height),
      gap: Math.round(window.innerHeight - r.bottom),
      radius: css.borderRadius,
      blur: css.backdropFilter || css.webkitBackdropFilter || '',
      background: css.backgroundImage,
      shadow: css.boxShadow,
      transition: css.transitionDuration
    };
  });
  check('the bar is wide enough to read as a bar', bar.width >= 250,
    bar.width + ' x ' + bar.height);

  // THE ROUNDING IS THE SHAPE. A pill flush against the bottom edge would have
  // half of it cut off by the edge it sits on, so the bar floats clear.
  check('it is a full pill, not a rounded rectangle',
    parseFloat(bar.radius) >= bar.height / 2,
    bar.radius + ' on a ' + bar.height + 'px bar');
  check('and floats clear of the bottom edge rather than sitting on it',
    bar.gap >= 10 && bar.gap <= 30, bar.gap + 'px of air beneath');

  check('it is frosted glass rather than a flat panel',
    /blur/.test(bar.blur), bar.blur || '(no backdrop-filter)');
  check('tinted, because clear glass on a white page is invisible',
    /gradient/.test(bar.background), bar.background.slice(0, 60));
  check('with an inset highlight and a glow outside it',
    bar.shadow.split('rgb').length - 1 >= 3,
    (bar.shadow.split('rgb').length - 1) + ' layers');
  check('and it moves slowly enough to be felt rather than noticed',
    parseFloat(bar.transition) >= 0.25,
    bar.transition);

  const before = await p.$eval('#msgrBar', (el) => getComputedStyle(el).transform);
  await p.hover('#msgrBar');
  await p.waitForTimeout(600);
  const after = await p.$eval('#msgrBar', (el) => getComputedStyle(el).transform);
  check('hovering lifts it', after !== before, before + '  ->  ' + after);

  // The open panel reaches the floor; only the collapsed pill floats. If both
  // floated, the panel would sit on a shelf of empty page.
  await p.click('#msgrBar');
  await p.waitForTimeout(500);
  const panelGap = await p.$eval('#msgrPanel', (el) =>
    Math.round(window.innerHeight - el.getBoundingClientRect().bottom));
  check('but the open panel still reaches the bottom edge', panelGap === 0,
    panelGap + 'px of gap under the panel');
  await p.click('#msgrClose');
  await p.waitForTimeout(400);

  // ---------------------------------------------------------------------------
  // the mark
  // ---------------------------------------------------------------------------
  const mark = await p.$eval('#msgrBar .msgr-bar-icon', (el) => {
    const css = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const text = document.getElementById('msgrBarLabel').getBoundingClientRect();
    return { image: css.backgroundImage.slice(0, 40),
             width: Math.round(r.width), height: Math.round(r.height),
             textHeight: Math.round(text.height),
             label: el.getAttribute('aria-label') };
  });
  check('the message icon is the avatar, carried inside the page',
    /^url\("data:image\//.test(mark.image), mark.image + '...');

  // A whole standing figure is about 3 wide to 4 high. Squashing it to the
  // square an icon slot usually wants would be the one thing that cannot be
  // done to a photograph of somebody.
  check('at the shape a standing figure actually is, not squashed to a square',
    Math.abs(mark.width / mark.height - 121 / 162) < 0.08,
    mark.width + 'x' + mark.height + ' is ' +
    (mark.width / mark.height).toFixed(2) + ':1, drawn at 0.75:1');
  // Not "taller than the bar" - the bar grows to hold it, so that compares a
  // thing to itself. The property that matters is that a whole standing figure
  // got room to be one, which means much taller than the word beside it.
  check('and given real height, so a whole figure is legible at all',
    mark.height >= mark.textHeight * 2.5,
    mark.height + 'px tall beside ' + mark.textHeight + 'px text');
  check('and it is named for anybody who cannot see it',
    mark.label === 'Messages', mark.label);

  // It has to actually decode. A data URI that is one character short is a
  // broken image, and a background-image that fails leaves no trace in the DOM.
  const decoded = await p.evaluate(() => new Promise((done) => {
    const css = getComputedStyle(document.querySelector('.msgr-bar-icon'));
    const url = css.backgroundImage.slice(5, -2);
    const img = new Image();
    img.onload = () => done(img.naturalWidth + 'x' + img.naturalHeight);
    img.onerror = () => done('FAILED TO DECODE');
    img.src = url;
  }));
  check('and the browser can actually decode it', /^\d+x\d+$/.test(decoded),
    decoded);

  check('no JS errors across the whole run', errors.length === 0,
    errors.slice(0, 2).join(' / '));

  await b.close();

  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log('FAIL  the suite itself threw: ' + (e && e.message));
  console.log('\n0/1 passed');
  process.exit(1);
});
