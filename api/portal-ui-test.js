/**
 * THE PORTAL, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node portal-ui-test.js
 *
 * The front door: Home, About us, Customers, Projects and Links, in the
 * portal's own shell with its own stylesheet.
 *
 * WHAT IS ACTUALLY AT RISK HERE, which is not what it looks like.
 *
 * The pages are mostly written words, and a check that an <h1> still says
 * "About us" proves very little. What can really go wrong on this screen
 * is the SEAM: two shells, one session, one token, and a router that has
 * to put the right page on screen, light the right tab, move the address
 * with it, and leave the browser's own Back working across a hop into the
 * other shell. Most of what follows is about that.
 *
 * And two numbers are worth their checks. The plant count is ADDED UP, not
 * written down - Config.gs records what happened when it was written down:
 * "Left off this list, the page said 22 and the team supports 23." The
 * pillar counts are the same rule.
 *
 * NOTHING HERE DEPENDS ON THE DATABASE. The portal's content comes from
 * api/portal-content.js and api/content.js, so the figures are the same on
 * every machine - which is why this suite may assert them directly, and
 * does so against the modules rather than against numbers typed in here.
 */
require('dotenv').config();
const { signToken } = require('./auth');
const browser = require('../tests/harness/browser');
const portalContent = require('./portal-content');
const content = require('./content');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PAGE = BASE + '/portal.html';

const ADMIN_ID = '20990770';
const VIEWER_ID = '20990771';

/* The pages this file has, and the three tabs that are still to come. */
const PORTED = ['home', 'about', 'partners', 'projects', 'links'];
const SOON = ['team', 'learnings', 'objective'];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++;
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


async function open(p, role) {
  const id = role === 'USER' ? VIEWER_ID : ADMIN_ID;
  await p.goto(PAGE);
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                   signToken(id, role || 'ADMIN'));
  await p.goto(PAGE);
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(350);
}

/** Which page is open, how the shell says so, and which tab is lit. */
async function where(p) {
  return p.evaluate(function () {
    const root = document.getElementById('portalRoot');
    const shown = Array.prototype.slice.call(root.querySelectorAll('.view'))
      .filter(function (s) { return !s.hidden; })
      .map(function (s) { return s.id.replace(/^view-/, ''); });
    const lit = Array.prototype.slice.call(
      document.querySelectorAll('.portal-tab.is-on'))
      .map(function (t) { return t.dataset.view; });
    return {
      shown: shown,
      dataPage: root.dataset.page,
      lit: lit,
      sky: getComputedStyle(document.querySelector('.portal-sky')).height,
      back: !document.getElementById('portalBack').hidden,
      backTitle: document.getElementById('portalBack').title,
      scrollY: window.scrollY
    };
  });
}

function viewOf(url) {
  const q = url.split('?')[1] || '';
  const m = q.match(/(?:^|&)view=([^&]*)/);
  return m ? decodeURIComponent(m[1]) : '';
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

  const b = await browser.launch();
  const context = await b.newContext();
  const p = await context.newPage();

  const thrown = [];
  const badRequests = [];
  p.on('pageerror', function (e) { thrown.push(String(e.message || e)); });
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

  await open(p, 'ADMIN');
  const boot = await (await fetch(BASE + '/api/portal/boot', {
    headers: { Authorization: 'Bearer ' + signToken(ADMIN_ID, 'ADMIN') }
  })).json();

  console.log('');
  console.log('  ' + boot.portfolio.pillars.length + ' pillars, ' +
              boot.partners.zones.length + ' zones, ' +
              portalContent.plantCount() + ' plants, ' +
              boot.links.length + ' links.');


  // =======================================================================
  console.log('');
  console.log('  The front door');
  // =======================================================================
  check('the portal is served at portal.html',
        /\/portal\.html$/.test(p.url().split('?')[0]), p.url());
  check('AND IT OPENS ON HOME, which is what a front door is',
        (await where(p)).dataPage === 'home');
  check('it carries its own stylesheet as well as the dashboard\'s',
        await p.evaluate(function () {
          const hrefs = Array.prototype.slice.call(
            document.querySelectorAll('link[rel="stylesheet"]'))
            .map(function (l) { return l.getAttribute('href'); });
          return hrefs.indexOf('app.css') !== -1 &&
                 hrefs.indexOf('portal.css') !== -1 &&
                 hrefs.indexOf('app.css') < hrefs.indexOf('portal.css');
        }));
  check('AND NOT THE DASHBOARD\'S SIDEBAR - it is the other shell, not a ' +
        'screen inside this one',
        (await p.evaluate(function () {
          return document.querySelectorAll('.sidebar, #appRoot').length;
        })) === 0);
  check('the signed-in person is named in the top bar',
        (await p.textContent('#portalWho')) === ADMIN_ID,
        await p.textContent('#portalWho'));
  check('the mark and the mailbox are siblings, not one inside the other',
        await p.evaluate(function () {
          const brand = document.querySelector('.portal-brand');
          const mail = document.querySelector('.portal-mail');
          return Boolean(brand && mail) && !brand.contains(mail) &&
                 mail.getAttribute('href').indexOf('mailto:') === 0;
        }));
  /*
    PRESENCE IS NOT PORTED, and half of it would be worse than none.
    Portal.html on the dot: "a dot reading OFFLINE because nothing updates
    it is a lie about a colleague."
  */
  check('the presence dot and the Away toggle stay hidden, since nothing ' +
        'updates them yet',
        await p.isHidden('#portalPresDot') && await p.isHidden('#portalAway'));


  // =======================================================================
  console.log('');
  console.log('  The tabs');
  // =======================================================================
  const tabs = await p.evaluate(function () {
    return Array.prototype.slice.call(document.querySelectorAll('.portal-tab'))
      .map(function (t) {
        return { view: t.dataset.view, label: t.textContent.trim(),
                 off: t.disabled, title: t.title };
      });
  });
  check('every tab the original has is here, in the original\'s order',
        JSON.stringify(tabs.map(function (t) { return t.view; })) ===
        JSON.stringify(['home', 'about', 'team', 'kpi1', 'partners',
                        'learnings', 'projects', 'objective', 'links']),
        JSON.stringify(tabs.map(function (t) { return t.view; })));
  /*
    CUSTOMERS ON THE TAB, `partners` IN THE data-view. Portal.html: "The
    word people read changed; the name the screen is addressed by did not,
    so a bookmarked ?view=partners still lands here."
  */
  check('CUSTOMERS IS THE WORD AND `partners` IS STILL THE NAME, so an old ' +
        'bookmark lands',
        (tabs.filter(function (t) { return t.view === 'partners'; })[0] || {})
          .label === 'Customers');
  check('the tabs that have no page yet are shown, disabled, and say why',
        SOON.every(function (view) {
          const tab = tabs.filter(function (t) { return t.view === view; })[0];
          return tab && tab.off && /not ported yet/.test(tab.title);
        }),
        JSON.stringify(tabs.filter(function (t) { return t.off; })));
  check('AND THE ONES THAT DO ARE NOT',
        PORTED.every(function (view) {
          const tab = tabs.filter(function (t) { return t.view === view; })[0];
          return tab && !tab.off;
        }));
  check('KPI Engine is a tab like its neighbours, with the destination on ' +
        'the hover - a white pill here reads as "you are here"',
        (tabs.filter(function (t) { return t.view === 'kpi1'; })[0] || {})
          .title === 'Open the TVL-EAS Database dashboard');


  // =======================================================================
  console.log('');
  console.log('  Home');
  // =======================================================================
  check('the headline is the team\'s own line, the one the sign-in card uses',
        /Data\.\s*Insight\.\s*Performance\./
          .test((await p.textContent('.portal-hero-title')).replace(/\s+/g, ' ')),
        JSON.stringify(await p.textContent('.portal-hero-title')));
  /*
    COUNTED AS DRAWN, NOT AS PRESENT. querySelectorAll answers for a card
    with `hidden` on it just as happily as for one somebody can see, so
    the first version of this counted five while one of them was gone.
  */
  check('THE FIVE CARDS ARE A COLLAGE, not a row of four equal rectangles',
        (await p.evaluate(function () {
          return Array.prototype.slice.call(document.querySelectorAll('.ptile'))
            .filter(function (t) { return t.offsetParent !== null; }).length;
        })) === 5);
  /*
    INLINE SVG, NOT CHART.JS. Portal.html: "Here the chart IS the card, and
    a front page whose cards are empty rectangles because a network
    somewhere said no is not a front page."
  */
  check('and they are drawn by hand, so a blocked CDN cannot empty them',
        (await p.evaluate(function () {
          return document.querySelectorAll('.ptile svg').length;
        })) > 0 &&
        (await p.evaluate(function () {
          return typeof window.Chart;
        })) === 'undefined');
  check('the sky is a hero\'s worth on Home',
        (await where(p)).sky === '672px', (await where(p)).sky);

  const hero = await p.evaluate(function () {
    const top = document.getElementById('heroSapLink');
    return {
      topHidden: top.hidden,
      topText: top.textContent.trim(),
      topHref: top.getAttribute('href'),
      topTarget: top.getAttribute('target'),
      topView: top.dataset.view || null,
      more: Array.prototype.slice.call(
        document.querySelectorAll('#heroMore a'))
        .map(function (a) {
          return { text: a.textContent.trim(), href: a.getAttribute('href'),
                   target: a.getAttribute('target'),
                   view: a.dataset.view || null };
        }),
      moreHidden: document.getElementById('heroMore').hidden
    };
  });
  const heroLinks = boot.links.filter(function (l) { return l.url && l.hero; });
  const row1 = heroLinks.filter(function (l) { return Number(l.row) === 1; });
  const rest = heroLinks.filter(function (l) { return Number(l.row) !== 1; });
  check('the first hero button is the row-1 link from the server',
        !hero.topHidden && hero.topText === row1[0].hero &&
        hero.topHref === row1[0].url,
        JSON.stringify([hero.topText, hero.topHref]));
  check('and the rest go on the line below',
        !hero.moreHidden && hero.more.length === rest.length &&
        hero.more.every(function (a, i) { return a.text === rest[i].hero; }),
        JSON.stringify(hero.more.map(function (a) { return a.text; })));
  /*
    ANCHORS WITH NO data-view, which is the whole reason these are drawn
    rather than written: a link that leaves the app must not also change
    the screen behind the tab it opens.
  */
  check('EVERY HERO LINK LEAVES THE APP AND CARRIES NO data-view, so none ' +
        'of them can quietly change the screen behind the tab it opened',
        hero.topView === null && hero.topTarget === '_blank' &&
        hero.more.every(function (a) {
          return a.view === null && a.target === '_blank';
        }));


  // =======================================================================
  console.log('');
  console.log('  Moving between pages');
  // =======================================================================
  await p.click('.portal-tab[data-view="about"]');
  await p.waitForTimeout(300);
  let at = await where(p);
  check('a tab opens its page and hides the others',
        JSON.stringify(at.shown) === JSON.stringify(['about']),
        JSON.stringify(at.shown));
  check('the tab lights, and only it',
        JSON.stringify(at.lit) === JSON.stringify(['about']),
        JSON.stringify(at.lit));
  /*
    CSS HAS NO WAY TO ASK WHAT IS OPEN. applyShell writes the page onto the
    element so the stylesheet can read it - a hero's worth of sky on Home,
    a header band everywhere else.
  */
  check('THE PAGE IS WRITTEN ONTO THE SHELL so the stylesheet can read it',
        at.dataPage === 'about');
  check('the address moves with the page, so it can be sent to somebody',
        viewOf(p.url()) === 'about', p.url());

  await p.click('.portal-tab[data-view="links"]');
  await p.waitForTimeout(300);
  check('and again',
        viewOf(p.url()) === 'links' && (await where(p)).dataPage === 'links');

  /*
    AND THE SKY IS A DIFFERENT HEIGHT ON EACH, which is the only thing
    data-page is for: "CSS has no way to ask what is open, and the blue sky
    behind the top of the portal is a hero's worth of it on Home and a
    header band everywhere else."

    THREE HEIGHTS, NOT TWO, and the first version of this check assumed
    two - that anything which was not Home would be SHORTER. About is
    taller: portal.css gives it height:100% so the written pages sit on
    blue all the way down. Projects has no rule of its own and gets the
    232px band the stylesheet defaults to. Asserted as the three distinct
    cases they are.
  */
  const skies = {};
  for (const view of ['home', 'projects', 'about']) {
    await p.goto(view === 'home' ? PAGE : PAGE + '?view=' + view);
    await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
    await p.waitForTimeout(250);
    skies[view] = await p.evaluate(function () {
      return {
        sky: getComputedStyle(document.querySelector('.portal-sky')).height,
        root: getComputedStyle(document.getElementById('portalRoot')).height
      };
    });
  }
  check('HOME GETS A HERO\'S WORTH OF SKY',
        skies.home.sky === '672px', JSON.stringify(skies.home));
  check('a page with no rule of its own gets the header band the stylesheet ' +
        'defaults to',
        skies.projects.sky === '232px', JSON.stringify(skies.projects));
  check('AND A WRITTEN PAGE SITS ON BLUE ALL THE WAY DOWN - height:100%, ' +
        'which is taller than Home and not shorter',
        skies.about.sky === skies.about.root &&
        parseInt(skies.about.sky, 10) > 672,
        JSON.stringify(skies.about));
  check('so the three of them are three different heights, which could only ' +
        'have come from data-page',
        new Set([skies.home.sky, skies.projects.sky, skies.about.sky]).size === 3,
        JSON.stringify([skies.home.sky, skies.projects.sky, skies.about.sky]));

  await p.goto(PAGE + '?view=links');
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(250);
  await p.click('.portal-tab[data-view="about"]');
  await p.waitForTimeout(300);
  await p.click('.portal-tab[data-view="links"]');
  await p.waitForTimeout(300);

  /*
    THE BROWSER'S OWN BACK. The original cannot have this - an Apps Script
    web app owns its query string, so Back there leaves the app - and it
    is the one thing the port can give the portal for free by making the
    address real.
  */
  /*
    FROM A HISTORY THIS CHECK OWNS. The first version just pressed Back
    after a couple of clicks, and the entries behind it were pages an
    earlier section had opened with goto - so a portal that only ever
    REPLACED the address still went "back" to a portal page, and the
    mutation that drops pushState passed. Starting from a blank page
    makes the entries below these three this suite's own, and the last
    Back leaves the portal entirely, which is the thing being asserted.
  */
  await p.goto('about:blank');
  await p.goto(PAGE);
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(250);
  await p.click('.portal-tab[data-view="about"]');
  await p.waitForTimeout(300);
  await p.click('.portal-tab[data-view="links"]');
  await p.waitForTimeout(300);

  await p.goBack();
  await p.waitForTimeout(450);
  check('THE BROWSER\'S BACK WALKS BACK THROUGH THE PAGES, which the ' +
        'single-document original could not do',
        viewOf(p.url()) === 'about' && (await where(p)).dataPage === 'about',
        p.url());
  await p.goBack();
  await p.waitForTimeout(450);
  check('AND ONE STEP PER PAGE, not one for the whole visit - three pages ' +
        'opened, three entries to walk back through',
        viewOf(p.url()) === '' && (await where(p)).dataPage === 'home',
        p.url());
  await p.goBack();
  await p.waitForTimeout(450);
  check('and the step before that leaves the portal, because that is where ' +
        'the suite came in',
        p.url().indexOf('portal.html') === -1, p.url());
  await p.goForward();
  await p.waitForTimeout(450);
  await p.goForward();
  await p.waitForTimeout(450);
  check('Forward walks on again',
        viewOf(p.url()) === 'about' && (await where(p)).dataPage === 'about',
        p.url());

  /* The portal's own Back, which is a trail and not the browser's. */
  await p.goto(PAGE);
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(300);
  check('the in-app Back is hidden until there is somewhere to go back to',
        !(await where(p)).back);
  await p.click('.portal-tab[data-view="projects"]');
  await p.waitForTimeout(300);
  at = await where(p);
  check('it appears once there is, and says where it goes',
        at.back && /Back to Home/.test(at.backTitle), at.backTitle);
  await p.click('#portalBack');
  await p.waitForTimeout(300);
  at = await where(p);
  check('and it goes there',
        at.dataPage === 'home' && viewOf(p.url()) === '');
  check('AND THEN HIDES ITSELF, rather than becoming a toggle between two ' +
        'pages for ever',
        !at.back);

  /* A bookmark lands where it says. */
  await p.goto(PAGE + '?view=partners');
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(300);
  check('A SAVED ADDRESS OPENS ITS PAGE, which is the whole point of the ' +
        'name not having changed when the word did',
        (await where(p)).dataPage === 'partners');
  await p.goto(PAGE + '?view=nothing-like-this');
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(300);
  check('and a name nobody knows falls back to Home rather than to a blank ' +
        'screen',
        (await where(p)).dataPage === 'home');
  await p.goto(PAGE + '?view=team');
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(300);
  check('so does a page that is real but not ported yet',
        (await where(p)).dataPage === 'home');
  /*
    AND SO DOES A NAME HANDED STRAIGHT TO THE ROUTER. Reading it off the
    address already clamps it, so the clamp inside showView is only
    reachable by calling it - which is what a stray data-view does, and
    what every control on this page goes through. Removing it survived a
    whole run before this check existed.
  */
  check('AND A NAME HANDED STRAIGHT TO THE ROUTER LANDS ON HOME TOO, rather ' +
        'than hiding every page and leaving a blank screen',
        await p.evaluate(function () {
          const s = window.__portalScreen;
          s.showView('nothing-like-this');
          const root = document.getElementById('portalRoot');
          const shown = Array.prototype.slice.call(root.querySelectorAll('.view'))
            .filter(function (v) { return !v.hidden; })
            .map(function (v) { return v.id; });
          return root.dataset.page === 'home' &&
                 shown.length === 1 && shown[0] === 'view-home';
        }));


  // =======================================================================
  console.log('');
  console.log('  About us');
  // =======================================================================
  await p.goto(PAGE + '?view=about');
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(300);
  const about = await p.evaluate(function () {
    return {
      words: Array.prototype.slice.call(document.querySelectorAll('.pillar-word'))
        .map(function (w) { return w.textContent.trim(); }),
      counts: Array.prototype.slice.call(document.querySelectorAll('.pillar-count'))
        .map(function (w) { return Number(w.textContent); }),
      items: Array.prototype.slice.call(document.querySelectorAll('.pillar'))
        .map(function (c) { return c.querySelectorAll('.pillar-list li').length; }),
      lede: (document.querySelector('.pcontent-lede') || {}).textContent || '',
      band: Array.prototype.slice.call(
        document.querySelectorAll('.pcontent-band b'))
        .map(function (bold) { return bold.textContent.trim(); })
    };
  });
  const pillars = boot.portfolio.pillars;
  check('the three pillars are the server\'s, in the server\'s order',
        JSON.stringify(about.words) ===
        JSON.stringify(pillars.map(function (x) { return x.word; })),
        JSON.stringify(about.words));
  check('and the lede is too',
        about.lede === boot.portfolio.intro);
  /*
    THE COUNT IS WORKED OUT, NOT WRITTEN DOWN. "A number beside a list goes
    wrong the first time somebody adds to the list and does not look up."
  */
  check('EACH COUNT IS THE LENGTH OF THE LIST UNDER IT, not a number typed ' +
        'beside it',
        JSON.stringify(about.counts) === JSON.stringify(about.items) &&
        JSON.stringify(about.counts) ===
        JSON.stringify(pillars.map(function (x) { return x.items.length; })),
        JSON.stringify([about.counts, about.items]));
  /*
    AND THE CLOSING BAND IS BUILT FROM THE SAME THREE WORDS, "so it cannot
    end up naming a pillar that is no longer there".
  */
  check('the closing band names the same pillars the cards are headed with',
        JSON.stringify(about.band) === JSON.stringify(about.words),
        JSON.stringify(about.band));


  // =======================================================================
  console.log('');
  console.log('  Customers');
  // =======================================================================
  await p.goto(PAGE + '?view=partners');
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(300);
  const cust = await p.evaluate(function () {
    return {
      codes: Array.prototype.slice.call(document.querySelectorAll('.zone-code'))
        .map(function (z) { return z.textContent.trim(); }),
      counts: Array.prototype.slice.call(document.querySelectorAll('.zone-count'))
        .map(function (z) { return z.textContent.trim(); }),
      chips: Array.prototype.slice.call(document.querySelectorAll('.zone'))
        .map(function (z) { return z.querySelectorAll('.plant').length; }),
      total: (document.querySelector('.vendor-count') || {}).textContent || '',
      vendor: (document.querySelector('.vendor-name') || {}).textContent || '',
      mark: (document.querySelector('.vendor-mark') || {}).textContent || ''
    };
  });
  const zones = boot.partners.zones;
  check('the three zones are the server\'s',
        JSON.stringify(cust.codes) ===
        JSON.stringify(zones.map(function (z) { return z.code; })),
        JSON.stringify(cust.codes));
  check('each zone draws a chip per plant',
        JSON.stringify(cust.chips) ===
        JSON.stringify(zones.map(function (z) { return z.plants.length; })),
        JSON.stringify(cust.chips));
  /*
    AND ITS CAPTION COUNTS THOSE CHIPS. This was captured and never
    asserted, so a caption reading the number of ZONES rather than the
    number of plants in one went unnoticed - three cards all saying
    "3 plants" over six, thirteen and four chips.
  */
  check('AND SAYS SO IN ITS OWN CAPTION, in its own units',
        JSON.stringify(cust.counts) ===
        JSON.stringify(zones.map(function (z) {
          return z.plants.length +
            (z.plants.length === 1 ? ' plant' : ' plants');
        })),
        JSON.stringify(cust.counts));
  /*
    THE TOTAL IS ADDED UP. Config.gs records what happened when it was
    written down: TVL was left off the list and "the page said 22 and the
    team supports 23".
  */
  check('AND THE TOTAL IS ADDED UP FROM THEM, which is how TVL stopped ' +
        'being missed',
        cust.total.replace(/\s+/g, ' ').trim() ===
        portalContent.plantCount() + ' plants served',
        JSON.stringify([cust.total, portalContent.plantCount()]));
  check('Tekvision\'s own plant is on the list, since it runs on the same ' +
        'S/4HANA',
        await p.evaluate(function () {
          return Array.prototype.slice.call(document.querySelectorAll('.plant'))
            .some(function (c) { return c.textContent.trim() === 'TVL'; });
        }));
  check('and the vendor strip names the vendor',
        cust.vendor === boot.partners.vendor &&
        cust.mark === boot.partners.vendorShort,
        JSON.stringify([cust.vendor, cust.mark]));


  // =======================================================================
  console.log('');
  console.log('  Links');
  // =======================================================================
  await p.goto(PAGE + '?view=links');
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(300);
  const cards = await p.evaluate(function () {
    return Array.prototype.slice.call(document.querySelectorAll('.link-card'))
      .map(function (c) {
        return {
          tag: c.tagName,
          name: (c.querySelector('strong') || {}).textContent || '',
          href: c.getAttribute('href'),
          target: c.getAttribute('target'),
          rel: c.getAttribute('rel'),
          view: c.dataset.view || null,
          off: Boolean(c.disabled)
        };
      });
  });
  check('every address the server sent has a card',
        cards.length === boot.links.length &&
        cards.map(function (c) { return c.name; }).join('|') ===
        boot.links.map(function (l) { return l.name; }).join('|'),
        JSON.stringify(cards.map(function (c) { return c.name; })));
  check('the ones that leave the app are anchors, in a new tab, with rel set',
        cards.filter(function (c) { return !c.view; }).every(function (c) {
          return c.tag === 'A' && /^https?:\/\//.test(c.href) &&
                 c.target === '_blank' && /noopener/.test(c.rel);
        }),
        JSON.stringify(cards.filter(function (c) {
          return !c.view && c.tag !== 'A'; })));
  /*
    ONE ENTRY GOES NOWHERE. By-Weekly Meetings opens a page inside the
    portal, so it is a button carrying a data-view and not an anchor with
    nothing in its href. That page is not ported, so it says so.
  */
  check('AND THE ONE THAT STAYS INSIDE IS A BUTTON, not an anchor with an ' +
        'empty href',
        cards.filter(function (c) { return c.view; }).length === 1 &&
        cards.filter(function (c) { return c.view; })[0].tag === 'BUTTON' &&
        cards.filter(function (c) { return c.view; })[0].href === null,
        JSON.stringify(cards.filter(function (c) { return c.view; })));
  check('and it says it is not ported yet rather than doing nothing',
        cards.filter(function (c) { return c.view; })[0].off === true &&
        await p.evaluate(function () {
          const el = document.querySelector('.link-card[data-view]');
          return /not ported yet/.test(el.title);
        }));


  // =======================================================================
  console.log('');
  console.log('  The seam between the two shells');
  // =======================================================================
  await p.goto(PAGE);
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  await p.click('.portal-cta[data-view="kpi1"]');
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  check('OPEN THE KPI ENGINE HANDS OVER TO THE DASHBOARD',
        /\/kpi1\.html$/.test(p.url().split('?')[0]), p.url());
  check('AND THE SESSION WENT WITH IT - one token, two shells, no second ' +
        'sign-in',
        (await p.textContent('#operatorName')) === ADMIN_ID,
        await p.textContent('#operatorName'));
  await p.click('.nav-item[data-view="home"]');
  await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
  check('and the sidebar\'s Home hands back',
        /\/portal\.html$/.test(p.url().split('?')[0]) &&
        (await p.textContent('#portalWho')) === ADMIN_ID,
        p.url());
  check('the tab bar is the portal\'s again, and the sidebar is gone',
        (await p.evaluate(function () {
          return document.querySelectorAll('.portal-tab').length;
        })) === 9 &&
        (await p.evaluate(function () {
          return document.querySelectorAll('.nav-item').length;
        })) === 0);


  // =======================================================================
  console.log('');
  console.log('  What a viewer sees');
  // =======================================================================
  await open(p, 'USER');
  check('THE PORTAL IS EVERYBODY\'S - it is the front door, and nothing on ' +
        'it names a person or says anything that is not on the slide deck',
        (await where(p)).dataPage === 'home' &&
        (await p.evaluate(function () {
          return document.querySelectorAll('.ptile').length;
        })) === 5);
  check('a viewer reads About and Customers like anybody else',
        await (async function () {
          await p.goto(PAGE + '?view=about');
          await p.waitForSelector('#portalRoot:not([hidden])', { timeout: 20000 });
          await p.waitForTimeout(250);
          const n = await p.evaluate(function () {
            return document.querySelectorAll('.pillar').length;
          });
          return n === boot.portfolio.pillars.length;
        }()));
  check('and the boot refuses them nothing, because there is nothing on it ' +
        'to refuse',
        await (async function () {
          const r = await fetch(BASE + '/api/portal/boot', {
            headers: { Authorization: 'Bearer ' + signToken(VIEWER_ID, 'USER') }
          });
          const d = await r.json();
          return r.status === 200 && d.ok === true &&
                 d.portfolio.pillars.length === boot.portfolio.pillars.length &&
                 d.links.length === boot.links.length;
        }()));


  // =======================================================================
  console.log('');
  console.log('  Signing out');
  // =======================================================================
  await open(p, 'ADMIN');
  await p.click('#portalSignOut');
  await p.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  check('signing out puts the sign-in card back and takes the portal away',
        await p.isHidden('#portalRoot') && await p.isVisible('#signinCard'));
  check('and the token is gone, so the dashboard will not open either',
        (await p.evaluate(function () {
          return sessionStorage.getItem('easToken');
        })) === null);


  // =======================================================================
  console.log('');
  console.log('  Nothing on fire in the console');
  // =======================================================================
  check('the page threw nothing', thrown.length === 0, thrown.join(' | '));
  const unexpected = badRequests.filter(function (r) {
    return !/cdnjs\.cloudflare\.com/.test(r);
  });
  check('every file the portal asked for was served',
        unexpected.length === 0, unexpected.slice(0, 4).join(' | '));
  check('AND THE PORTAL\'S OWN STYLESHEET AMONG THEM - 818 rules that no ' +
        'dashboard page loads, and a 404 on it would leave the front page ' +
        'as unstyled text',
        await p.evaluate(async function () {
          const res = await fetch('portal.css');
          const text = await res.text();
          return res.ok && text.indexOf('.portal-tiles') !== -1;
        }));

  await context.close();
  await b.close();

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  recap();
  console.log('');
  process.exit(fail ? 1 : 0);
}


main().catch(function (err) {
  console.error('\n  Failed: ' + err.message + '\n' + err.stack + '\n');
  recap();
  process.exit(1);
});
