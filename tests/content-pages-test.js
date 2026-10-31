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
  // THE HOME CARDS
  // =========================================================================
  // Five cards in a collage. Four of them are invented shapes and there is
  // nothing to check in a made-up number; the fifth is read out of the live
  // KPI configuration, and that one has to be right.
  const tiles = await p.$$eval('#portalTiles .ptile', (ns) => ns.map((n) => ({
    cls: n.className,
    label: n.querySelector('.ptile-label').textContent.trim()
  })));

  check('the home page carries the five cards, in the order asked for',
    JSON.stringify(tiles.map((t) => t.label)) === JSON.stringify(
      ['Comparison', 'ITSM tickets', 'Help & FAQ', 'KPI 2', 'Service layers']),
    tiles.map((t) => t.label).join(' | '));

  // The collage is grid placement, not source order, so "below" and "beside"
  // are properties of the rendered box and not of the markup.
  const where = await p.evaluate(() => {
    const box = (s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { top: Math.round(r.top), left: Math.round(r.left), bottom: Math.round(r.bottom) };
    };
    return {
      compare: box('.ptile-compare'), itsm: box('.ptile-itsm'),
      faq: box('.ptile-faq'), kpi2: box('.ptile-kpi2'), layers: box('.ptile-layers')
    };
  });

  check('Help & FAQ sits below the ITSM chart, in the same column',
    where.faq.top >= where.itsm.bottom - 1 && where.faq.left === where.itsm.left,
    'faq top ' + where.faq.top + ' vs itsm bottom ' + where.itsm.bottom);

  check('the KPI 2 ring sits beside Help & FAQ, not below it',
    where.kpi2.left > where.faq.left && where.kpi2.top < where.faq.bottom,
    'kpi2 left ' + where.kpi2.left + ' vs faq left ' + where.faq.left);

  check('the comparison chart is the tall card on the left, and layers the last',
    where.compare.left < where.itsm.left &&
    where.layers.left > where.kpi2.left,
    'compare ' + where.compare.left + ', itsm ' + where.itsm.left +
      ', kpi2 ' + where.kpi2.left + ', layers ' + where.layers.left);

  // THE LAYERS CARD IS NOT TYPED. serviceLayers() groups the four KPIs by the
  // layer each one already carries, so the front page cannot end up
  // describing a service structure the engine behind it stopped using.
  const LAYERS = vm.runInContext('serviceLayers()', box);

  const shown = await p.$$eval('#layerStack .layer-row', (ns) => ns.map((n) => ({
    no: n.querySelector('.layer-no').textContent.trim(),
    title: n.querySelector('.layer-text b').textContent.trim(),
    kpis: Array.from(n.querySelectorAll('.layer-kpi')).map((k) => k.textContent.trim())
  })));

  check('the three service layers come from the KPI configuration',
    JSON.stringify(shown.map((l) => l.no + ':' + l.title)) ===
      JSON.stringify(LAYERS.map((l) => l.layer + ':' + l.title)),
    shown.map((l) => l.no + ' ' + l.title).join(' | '));

  check('and each layer lists the KPIs that answer for it',
    shown.every((l, i) =>
      JSON.stringify(l.kpis) === JSON.stringify(LAYERS[i].kpis.map((k) => k.name))),
    shown.map((l) => l.no + '=[' + l.kpis.join(',') + ']').join(' '));

  // THE TWO ABOVE COMPARE THE PAGE WITH serviceLayers(), WHICH IS HALF A
  // TEST. It catches a renderer that drops or reorders what it was handed,
  // and is blind to serviceLayers() itself being wrong - break that and both
  // sides of the comparison move together. Two mutations proved it: leaving
  // 'Layer 3: ' on the front of the title, and returning the layers in key
  // order instead of numeric order, both passed everything above.
  //
  // So these three check the page against the raw KPI definitions instead,
  // which is the thing neither the renderer nor serviceLayers() can move.
  const rawLayers = {};
  Object.keys(CONFIG.KPI).forEach(function (key) {
    const kpi = CONFIG.KPI[key];
    if (kpi && kpi.layer) rawLayers[kpi.layer] = kpi.slaLayer;
  });
  const rawNumbers = Object.keys(rawLayers).map(Number).sort((a, b) => a - b);

  check('the layers are numbered in order, starting at one',
    JSON.stringify(shown.map((l) => Number(l.no))) === JSON.stringify(rawNumbers),
    shown.map((l) => l.no).join(', ') + ' against ' + rawNumbers.join(', '));

  // The number is drawn in its own badge, so a title that still carries
  // "Layer 3:" prints it on the card twice.
  const doubled = shown.filter((l) => /layer\s*\d/i.test(l.title));
  check('no layer prints its own number twice',
    doubled.length === 0,
    doubled.map((l) => l.no + ' reads "' + l.title + '"').join('; ') || 'none');

  check('each title is the policy\'s own wording for that layer',
    shown.every((l) => {
      const full = rawLayers[Number(l.no)] || '';
      return full.indexOf(l.title) !== -1 && l.title.length > 0;
    }),
    shown.map((l) => '"' + l.title + '" from "' + rawLayers[Number(l.no)] + '"').join(' | '));

  // KPI 1 IS IN CONFIG.KPI TWICE - RESOLUTION and RESOLUTION_EAS are the same
  // indicator against two targets - so the obvious loop over the keys listed
  // it twice and the card claimed Layer 3 had three KPIs in it.
  const everyName = shown.reduce((all, l) => all.concat(l.kpis), []);
  check('no KPI is listed twice, though KPI 1 has two standards',
    everyName.length === new Set(everyName).size,
    everyName.join(', '));

  // KPI 2 is not in TVL-KPI-001. It is labelled INTERNAL on every other
  // screen that shows it and must not sit silently beside three that are
  // approved.
  const internalMarked = await p.$$eval('#layerStack .layer-kpi.is-internal',
    (ns) => ns.map((n) => n.textContent.trim()));
  check('the one measure outside the approved policy is marked internal',
    JSON.stringify(internalMarked) ===
      JSON.stringify(LAYERS.reduce((all, l) =>
        all.concat(l.kpis.filter((k) => !k.policy).map((k) => k.name)), [])),
    internalMarked.join(', ') || 'nothing marked');

  // The KPI Engine tab used to be a white pill, which is what "you are here"
  // looks like in this bar - so the one tab you were never on looked open.
  const tabSkins = await p.$$eval('.portal-tab', (ns) => ns.map((n) => ({
    view: n.getAttribute('data-view'),
    bg: getComputedStyle(n).backgroundColor,
    on: n.getAttribute('aria-current')
  })));
  const engine = tabSkins.filter((t) => t.view === 'kpi1')[0];
  const plain = tabSkins.filter((t) => t.view === 'partners')[0];
  check('the KPI Engine tab looks like its neighbours rather than a selected one',
    engine.bg === plain.bg,
    'engine ' + engine.bg + ' vs partners ' + plain.bg);

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
  // where the blue stops
  // =========================================================================
  // The two pages answer this differently and both answers are load-bearing.
  //
  // PARTNERS is glass all the way down, so the blue has to be too - a
  // frosted card over the light surface is a grey box.
  await p.click('.portal-tab[data-view="partners"]');
  await p.waitForTimeout(600);
  check('the partners page has blue behind every card on it',
    (await p.evaluate(() => {
      const sky = document.querySelector('.portal-sky');
      return sky.getBoundingClientRect().height >=
             document.getElementById('portalRoot').scrollHeight - 2;
    })) === true,
    'its cards are glass, and glass over white goes grey');

  // ABOUT US BREAKS, and the break has a window of about thirty pixels to
  // land in. Too high and it crosses the heading - which is white text, so
  // the bottom half of "the EAS Team" would vanish into the white below.
  // Too low and the cream cards start on blue. Neither throws, neither is
  // caught by any other assertion, and both are immediately visible to
  // anybody who opens the page.
  //
  // Checked at three widths because the head is a different height at each:
  // the lede sits beside the heading on a desktop and below it from 1080px
  // down, which moves the first card by most of a paragraph.
  for (const width of [1480, 1000, 420]) {
    const q = await b.newPage({ viewport: { width: width, height: 1000 } });
    q.on('pageerror', (e) => errors.push(String(e)));
    await q.goto(FILE);
    await q.waitForTimeout(1700);
    await q.click('.portal-tab[data-view="about"]');
    await q.waitForTimeout(600);

    const m = await q.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      return {
        sky: r('.portal-sky').bottom,
        head: r('#aboutBody .pcontent-headline').bottom,
        card: r('#aboutBody .pillar').top
      };
    });

    check('at ' + width + 'px the blue ends below the heading and above the cards',
      m.sky > m.head && m.sky < m.card,
      'heading ends ' + m.head.toFixed(0) + ', blue ends ' + m.sky.toFixed(0) +
        ', cards start ' + m.card.toFixed(0));
    await q.close();
  }

  // And the cards on it are solid, not glass - because they are on white
  // now. A frosted card there is a grey rectangle with white text in it,
  // which is to say an empty one.
  await p.click('.portal-tab[data-view="about"]');
  await p.waitForTimeout(600);
  const pillarSkin = await p.$eval('#aboutBody .pillar', (n) => {
    const s = getComputedStyle(n);
    return { filter: s.backdropFilter || s.webkitBackdropFilter, colour: s.color };
  });
  check('the About cards are solid rather than frosted',
    (pillarSkin.filter === 'none' || !pillarSkin.filter),
    'backdrop-filter is ' + pillarSkin.filter);

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
