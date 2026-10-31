// About us and Partners - the two pages that are almost entirely wording.
//
// WHAT IS ACTUALLY AT RISK HERE
// Not layout. These pages take a list out of Config.gs and draw it, and the
// way that goes wrong is quiet: a bullet that does not make it onto the page,
// or a count beside a list that no longer matches the list. Neither throws,
// neither looks broken, and both are the page telling somebody something
// untrue about the team.
//
// So the fixture is the REAL Config.gs, read here the same way the harness
// reads it into the page. Rewording a bullet moves this suite; dropping one
// fails it.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/content-pages-test.js
const path = require('path'), fs = require('fs'), vm = require('vm');

const PAGE = process.env.EAS_PAGE ||
             path.join(__dirname, 'harness', 'page.html');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');
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

// ---------------------------------------------------------------------------
// the wording, out of the real Config.gs
// ---------------------------------------------------------------------------
const box = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat
};
box.globalThis = box;
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), box);
const CONFIG = vm.runInContext('CONFIG', box);

const PORTFOLIO = CONFIG.PORTFOLIO;
const PARTNERS = CONFIG.PARTNERS;

const FILE = 'file://' + PAGE;

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
  await p.waitForTimeout(1800);

  // =========================================================================
  // ABOUT US
  // =========================================================================
  await p.click('.portal-tab[data-view="about"]');
  await p.waitForTimeout(700);

  check('the About us tab opens a page, not the empty placeholder',
    (await p.$eval('#view-about', (n) => !n.hidden)) === true &&
    (await p.$$eval('#aboutBody .portal-empty', (ns) => ns.length)) === 0,
    'the "waiting for its words" card is gone');

  check('and it stays in the portal shell rather than opening the dashboard',
    (await p.evaluate(() => !document.getElementById('portalRoot').hidden)) === true &&
    (await p.evaluate(() => document.getElementById('appRoot').hidden)) === true);

  const pillars = await p.$$eval('#aboutBody .pillar', (ns) => ns.map((n) => ({
    word: n.querySelector('.pillar-word').textContent.trim(),
    line: n.querySelector('.pillar-line').textContent.trim(),
    badge: Number(n.querySelector('.pillar-count').textContent.trim()),
    items: Array.from(n.querySelectorAll('.pillar-list li')).map((li) => li.textContent.trim())
  })));

  check('there is one card per pillar, headed with the team\'s own words',
    JSON.stringify(pillars.map((x) => x.word)) ===
      JSON.stringify(PORTFOLIO.pillars.map((x) => x.word)),
    pillars.map((x) => x.word).join(' | '));

  // THE ONE THAT MATTERS. Fourteen responsibilities went onto this page by
  // being distributed across three cards, and the quiet failure is one of
  // them not arriving. Compared as a set against Config.gs, so a line that
  // is dropped, duplicated or silently reworded is named.
  const wantedItems = PORTFOLIO.pillars.reduce((all, x) => all.concat(x.items), []);
  const gotItems = pillars.reduce((all, x) => all.concat(x.items), []);
  const missing = wantedItems.filter((t) => gotItems.indexOf(t) === -1);

  check('every responsibility in Config.gs is on the page, none dropped',
    missing.length === 0 && gotItems.length === wantedItems.length,
    missing.length ? 'missing: ' + missing.join(' / ')
                   : gotItems.length + ' of ' + wantedItems.length + ' shown');

  // A number beside a list has to equal the list. Same rule the team cards
  // follow, and the same reason: it is a small wrongness that makes somebody
  // distrust everything else on the page.
  const badBadge = pillars.filter((x) => x.badge !== x.items.length);
  check('each pillar\'s count equals the number of lines under it',
    badBadge.length === 0,
    badBadge.length
      ? badBadge.map((x) => x.word + ' says ' + x.badge + ' over ' + x.items.length).join(', ')
      : pillars.map((x) => x.word + '=' + x.badge).join(' '));

  check('each pillar carries its one-line summary',
    pillars.every((x, i) => x.line === PORTFOLIO.pillars[i].line),
    pillars.map((x) => x.line).join(' | '));

  // The closing line is built from the cards' own words, so it cannot end up
  // naming a pillar that is not there.
  const band = await p.$eval('#aboutBody .pcontent-band', (n) => n.textContent.replace(/\s+/g, ' ').trim());
  check('the closing line names exactly the pillars above it',
    PORTFOLIO.pillars.every((x) => band.indexOf(x.word) !== -1) &&
    band.indexOf('EAS Team') === 0,
    band);

  check('the page is headed Portfolio of the EAS Team',
    /Portfolio of\s*the EAS Team/.test(
      (await p.$eval('#aboutBody .pcontent-title', (n) => n.textContent)).replace(/\s+/g, ' ')),
    await p.$eval('#aboutBody .pcontent-title', (n) => n.textContent.replace(/\s+/g, ' ').trim()));

  // =========================================================================
  // PARTNERS
  // =========================================================================
  await p.click('.portal-tab[data-view="partners"]');
  await p.waitForTimeout(700);

  check('the Partners tab opens a page too',
    (await p.$eval('#view-partners', (n) => !n.hidden)) === true &&
    (await p.$$eval('#partnersBody .portal-empty', (ns) => ns.length)) === 0);

  const zones = await p.$$eval('#partnersBody .zone', (ns) => ns.map((n) => ({
    code: n.querySelector('.zone-code').textContent.trim(),
    name: n.querySelector('.zone-name').textContent.trim(),
    badge: n.querySelector('.zone-count').textContent.trim(),
    plants: Array.from(n.querySelectorAll('.plant')).map((c) => c.textContent.trim())
  })));

  check('there is one card per zone',
    JSON.stringify(zones.map((z) => z.code)) ===
      JSON.stringify(PARTNERS.zones.map((z) => z.code)),
    zones.map((z) => z.code).join(' | '));

  // Twenty-two plant codes, and a plant that is missing from this page is a
  // customer the page says is not served.
  const wantedPlants = PARTNERS.zones.reduce((all, z) => all.concat(z.plants), []);
  const gotPlants = zones.reduce((all, z) => all.concat(z.plants), []);
  const lost = wantedPlants.filter((t) => gotPlants.indexOf(t) === -1);

  check('every plant in Config.gs has a chip on the page',
    lost.length === 0 && gotPlants.length === wantedPlants.length,
    lost.length ? 'missing: ' + lost.join(', ')
                : gotPlants.length + ' of ' + wantedPlants.length + ' shown');

  check('each zone is in its own card, not pooled together',
    zones.every((z, i) =>
      JSON.stringify(z.plants) === JSON.stringify(PARTNERS.zones[i].plants)),
    zones.map((z) => z.code + ':' + z.plants.length).join(' '));

  // THE COUNTS ARE WORKED OUT, NOT COPIED. The slide says 6, 12 and 4 beside
  // the lists; this page counts the lists. Both assertions below would pass
  // against hard-coded numbers today and fail the day somebody adds a plant,
  // which is exactly the day they need to hold.
  const badZone = zones.filter((z) => z.badge !== z.plants.length +
                                      (z.plants.length === 1 ? ' plant' : ' plants'));
  check('each zone\'s count equals the chips in that card',
    badZone.length === 0,
    badZone.length ? badZone.map((z) => z.code + ' says "' + z.badge + '" over ' +
                                        z.plants.length).join(', ')
                   : zones.map((z) => z.code + ' ' + z.badge).join(', '));

  const strip = await p.$eval('#partnersBody .vendor-strip',
    (n) => n.textContent.replace(/\s+/g, ' ').trim());
  check('and the total served equals every chip on the page',
    strip.indexOf(String(wantedPlants.length) + ' plants served') !== -1,
    strip);

  check('the vendor is named',
    strip.indexOf(PARTNERS.vendor) !== -1 &&
    strip.indexOf(PARTNERS.vendorShort) !== -1,
    strip);

  // =========================================================================
  // both pages, as pages
  // =========================================================================
  // Every card here is glass, and glass over the light surface is a grey
  // box. The sky has to run the whole height - the same rule the Links page
  // already follows - or the cards below the fold look broken.
  for (const view of ['about', 'partners']) {
    await p.click('.portal-tab[data-view="' + view + '"]');
    await p.waitForTimeout(500);
    const covered = await p.evaluate(() => {
      const sky = document.querySelector('.portal-sky');
      const root = document.getElementById('portalRoot');
      return sky.getBoundingClientRect().height >= root.scrollHeight - 2;
    });
    check('the ' + view + ' page has blue behind every card on it', covered === true,
      'otherwise the glass cards past the fold sit on white and go grey');
  }

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
