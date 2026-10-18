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
      overhang: Math.round(r.bottom - window.innerHeight),
      blur: css.backdropFilter || css.webkitBackdropFilter || '',
      shadow: css.boxShadow,
      transition: css.transitionDuration
    };
  });
  check('the bar is a bar, not a pill', bar.width >= 250,
    bar.width + ' x ' + bar.height);
  check('it is frosted glass rather than a flat panel',
    /blur/.test(bar.blur), bar.blur || '(no backdrop-filter)');
  check('with a glow under it',
    /rgba?\(/.test(bar.shadow) && bar.shadow.split('rgb').length - 1 >= 2,
    'inset highlight plus two outward shadows');
  check('and it moves slowly enough to be felt rather than noticed',
    parseFloat(bar.transition) >= 0.25,
    bar.transition);

  // THE LIFT WITHOUT A GAP. The bar rests four pixels below the viewport edge
  // so that raising it on hover does not open a strip of page underneath.
  check('at rest it overhangs the bottom edge',
    bar.overhang >= 3 && bar.overhang <= 6, bar.overhang + 'px below');

  const before = await p.$eval('#msgrBar', (el) => getComputedStyle(el).transform);
  await p.hover('#msgrBar');
  await p.waitForTimeout(600);
  const after = await p.$eval('#msgrBar', (el) => {
    const r = el.getBoundingClientRect();
    return { transform: getComputedStyle(el).transform,
             overhang: Math.round(r.bottom - window.innerHeight) };
  });
  check('hovering lifts it', after.transform !== before,
    before + '  ->  ' + after.transform);
  check('exactly far enough to sit flush, not to float',
    Math.abs(after.overhang) <= 1,
    after.overhang + 'px below the edge once lifted');

  // A fixed element hanging past the bottom must not give the page a scrollbar.
  const scroll = await p.evaluate(() => {
    const doc = document.documentElement;
    const withBar = doc.scrollHeight;
    document.getElementById('msgr').style.display = 'none';
    const without = doc.scrollHeight;
    document.getElementById('msgr').style.display = '';
    return withBar - without;
  });
  check('and the overhang costs the page no scroll at all', scroll === 0,
    scroll + 'px added');

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
