// The portal - the front door - driven in a real browser.
//
// Phase 1 is the SHELL: a top bar of ten tabs, nine pages behind them, and
// one tab that is not a page at all but a door into the dashboard. None of it
// reads live data yet; what is being tested here is that the two shells take
// turns correctly and that nothing which used to work stopped.
//
// THE ONE IDEA WORTH KNOWING BEFORE READING ANY ASSERTION
// There is no list of portal views anywhere in the code. showView() decides
// which shell to raise by asking where the section lives - inside #portalRoot
// or not - so "KPI Engine opens the dashboard" is not a special case that was
// written, it is a consequence of #view-kpi1 living in the other shell. A
// good few of the assertions below exist to hold that property down, because
// the obvious way to "fix" a future bug here is to add the list back.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/portal-test.js
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

const FILE = 'file://' + PAGE;

(async () => {
  const b = await chromium.launch({ executablePath: BROWSER });
  const errors = [];

  const open = async (query) => {
    const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
      errors.push('console: ' + m.text());
    });
    await p.goto(FILE + (query || ''));
    await p.waitForTimeout(1800);
    return p;
  };

  // Which shell is up. Both at once, or neither, is a failure in itself - so
  // this returns the pair rather than a boolean and the assertions say which
  // they wanted.
  const shells = (p) => p.evaluate(() => ({
    portal: !document.getElementById('portalRoot').hidden,
    dash: !document.getElementById('appRoot').hidden
  }));

  // ---------------------------------------------------------------------------
  // where you land
  // ---------------------------------------------------------------------------
  let p = await open();

  let at = await shells(p);
  check('with no view asked for, you land on the portal and not the dashboard',
    at.portal === true && at.dash === false,
    'portal ' + at.portal + ', dashboard ' + at.dash);

  check('and the page you land on is Home',
    (await p.$eval('#view-home', (n) => !n.hidden)) === true);

  // THE BOOKMARK CASE. The people who use this daily have ?view=kpi1 saved;
  // landing them on a welcome page every morning would be a regression dressed
  // as a feature.
  const direct = await open('?view=kpi1');
  at = await shells(direct);
  check('but a bookmarked ?view=kpi1 still opens straight onto the figures',
    at.dash === true && at.portal === false,
    'the front door is not made compulsory');
  await direct.close();

  // An address that names nothing falls back to the portal now, not to KPI 1.
  const nonsense = await open('?view=nosuchpage');
  check('and a view that does not exist falls back to Home',
    (await p.$eval('#view-home', (n) => !n.hidden)) === true &&
    (await nonsense.$eval('#view-home', (n) => !n.hidden)) === true,
    'rather than to a blank screen');
  await nonsense.close();

  // ---------------------------------------------------------------------------
  // the tabs
  // ---------------------------------------------------------------------------
  const tabs = await p.$$eval('.portal-tab', (ns) => ns.map((n) => ({
    label: n.textContent.trim(),
    view: n.getAttribute('data-view')
  })));

  // The list Nasir sent, in his order, less Contact us - which was dropped
  // because the Messages bubble in the corner already reaches the team from
  // every page and carries replies, which a page with an address on it does
  // not. Asserted as a whole rather than by counting, so a tab quietly
  // dropped or reordered is caught by name.
  const WANTED = ['Home', 'About us', 'EAS Team', 'KPI Engine', 'Partners',
                  'Learnings', 'Projects', 'Objective', 'Links'];
  check('all nine tabs are there, in the order they were given',
    JSON.stringify(tabs.map((t) => t.label)) === JSON.stringify(WANTED),
    tabs.map((t) => t.label).join(' | '));

  // A page left behind after its tab is removed is reachable by ?view= and
  // by the back trail, and is nobody's job to maintain.
  check('and Contact us left no orphan page behind it',
    (await p.evaluate(() => !document.getElementById('view-contact'))) === true,
    'the section went with the tab');

  // THE PROMISE THE SIDEBAR'S OWN COMMENT MAKES: a screen is a button plus a
  // section. A tab naming a view that does not exist would silently bounce the
  // visitor back to Home, which looks like the tab simply does not work.
  const orphans = await p.evaluate(() =>
    Array.from(document.querySelectorAll('.portal-tab'))
      .map((n) => n.getAttribute('data-view'))
      .filter((v) => !document.getElementById('view-' + v)));
  check('and every tab names a page that actually exists',
    orphans.length === 0, orphans.join(', ') || 'no tab leads nowhere');

  // ---------------------------------------------------------------------------
  // moving between pages, and between shells
  // ---------------------------------------------------------------------------
  await p.click('.portal-tab[data-view="about"]');
  await p.waitForTimeout(500);

  at = await shells(p);
  check('clicking a portal tab changes the page without leaving the portal',
    at.portal === true && at.dash === false &&
    (await p.$eval('#view-about', (n) => !n.hidden)) &&
    (await p.$eval('#view-home', (n) => n.hidden)),
    'About us is up, Home is not, and the dashboard never appeared');

  // THE HOOK THE SKY'S HEIGHT HANGS OFF.
  //
  // CSS cannot ask which view is open, so applyShell() writes the page name
  // onto the shell and the stylesheet reads it: a hero's worth of blue on
  // Home, a header band everywhere else. If this quietly stopped being set
  // the hero would collapse to a 232px strip with white text falling off the
  // bottom of it - a disfiguring break that no other assertion here would
  // notice, because every view would still route correctly.
  check('the shell records which portal page is open, for the stylesheet',
    (await p.$eval('#portalRoot', (n) => n.dataset.page)) === 'about',
    await p.$eval('#portalRoot', (n) => String(n.dataset.page)));

  check('and the tab that is open says so',
    (await p.$eval('.portal-tab[data-view="about"]',
                   (n) => n.classList.contains('is-on'))) === true &&
    (await p.$eval('.portal-tab[data-view="home"]',
                   (n) => n.classList.contains('is-on'))) === false);

  // ---- the handover ----
  await p.click('.portal-tab[data-view="kpi1"]');
  await p.waitForTimeout(1200);

  at = await shells(p);
  check('KPI Engine hands over to the dashboard',
    at.dash === true && at.portal === false,
    'portal ' + at.portal + ', dashboard ' + at.dash);

  // Left alone while the dashboard is up, deliberately: the sky's height is
  // a transition, and clearing it here would play that transition against a
  // hidden element and then again on the way back.
  check('and it keeps the page it had while the dashboard is up',
    (await p.$eval('#portalRoot', (n) => n.dataset.page)) === 'about',
    'the portal is not on screen to need changing');

  check('and it is the real dashboard, with its figures on it',
    (await p.$$eval('#kpi1AllPeople tbody tr', (n) => n.length)) > 0,
    'not an empty shell that merely looks like it');

  // The tab stays lit while the dashboard is up. The portal is not on screen
  // to see it, but it is what the person meets on the way back: a top bar
  // with nothing marked reads as though they arrived from nowhere.
  check('and the tab that opened it stays marked while it is open',
    (await p.$eval('.portal-tab[data-view="kpi1"]',
                   (n) => n.classList.contains('is-on'))) === true);

  // Nothing reloaded, so nothing was signed into twice. If the handover had
  // been a navigation this counter would have gone back to zero.
  check('without reloading the page, so the session is never re-established',
    (await p.evaluate(() => performance.getEntriesByType('navigation').length)) === 1,
    'one navigation for the whole journey');

  // ---- and back again ----
  await p.click('.nav-item[data-view="home"]');
  await p.waitForTimeout(800);

  at = await shells(p);
  check('and the sidebar Home button brings the portal back',
    at.portal === true && at.dash === false &&
    (await p.$eval('#view-home', (n) => !n.hidden)));

  check('and the marking follows, so Home is lit once Home is what is open',
    (await p.$eval('.portal-tab[data-view="home"]',
                   (n) => n.classList.contains('is-on'))) === true &&
    (await p.$eval('.portal-tab[data-view="kpi1"]',
                   (n) => n.classList.contains('is-on'))) === false);

  // ---------------------------------------------------------------------------
  // what has to work on the portal because it works everywhere else
  // ---------------------------------------------------------------------------
  check('the messenger is reachable from the portal',
    (await p.$eval('#msgr', (n) => !n.hidden)) === true,
    'it sits outside both shells precisely so that it is');

  await p.click('#msgrBar');
  await p.waitForTimeout(700);
  check('and it opens on top of the portal rather than behind it',
    (await p.$eval('#msgrPanel', (n) => !n.hidden)) === true);
  await p.click('#msgrClose');
  await p.waitForTimeout(400);

  check('the portal bar names who is signed in',
    (await p.$eval('#portalWho', (n) => n.textContent.trim())).length > 1 &&
    (await p.$eval('#portalWho', (n) => n.textContent.trim())) !== '\u2014',
    await p.$eval('#portalWho', (n) => n.textContent.trim()));

  // The two bars read one value. They are never both on screen, which is
  // exactly why they would be free to disagree without anybody noticing.
  const dashName = await p.$eval('#operatorName', (n) => n.textContent.trim());
  const portalName = await p.$eval('#portalWho', (n) => n.textContent.trim());
  check('and names the same person the dashboard bar does',
    dashName === portalName, dashName + ' / ' + portalName);

  await p.close();

  // ---- signing out from the portal ----
  // Not a second sign-out: the portal's button presses the dashboard's, so
  // there is still one path out and it cannot drift from the one that drops
  // the token and stops the polling.
  const q = await open();
  check('the portal offers a way out once somebody is signed in',
    (await q.$eval('#portalSignOut', (n) => !n.hidden)) === true);

  await q.click('#portalSignOut');
  await q.waitForTimeout(1500);

  check('and pressing it actually signs out',
    (await q.$eval('#loginScreen', (n) => !n.hidden)) === true &&
    (await q.$eval('#portalRoot', (n) => n.hidden)) === true,
    'the sign-in card is back over the portal');

  // The deliberate sign-out must still be silent about idling - the bug from
  // step 99, re-checked here because the portal added a second way to trigger
  // it and the fix lives behind only one of them.
  const note = await q.$eval('#loginError', (n) => n.hidden ? '' : n.textContent);
  check('without claiming the session timed out',
    !/inactiv|timed out|session has ended/i.test(note),
    note.trim() || 'nothing said');
  await q.close();

  // ---------------------------------------------------------------------------
  // the EAS Team page
  // ---------------------------------------------------------------------------
  // Thirty-seven colleagues' work email, extension and personal mobile. It is
  // drawn from a TEAM tab in the database and never from the source, because
  // this repository is public and a git history keeps what you delete from it.
  // Counted by what is ON SCREEN, not by what is in the DOM: the member
  // cards are built up front and hidden, so querySelectorAll finds them
  // whether or not anybody can see them. offsetParent is null for an element
  // inside a hidden container, which is the question being asked.
  const visibleCards = (page) => page.$$eval('.team-card',
    (ns) => ns.filter((n) => n.offsetParent !== null).length);

  const t = await open('?view=team');
  await t.waitForTimeout(900);

  // ---- the department head, above the sections and not one of them ----
  check('the department head is lifted out of the sections and put on top',
    (await t.$$eval('.team-lead', (n) => n.length)) === 1 &&
    /Utpal Biswas/.test(await t.$eval('.team-lead', (n) => n.textContent)) &&
    /Department Head/i.test(await t.$eval('.team-lead-flag', (n) => n.textContent)),
    'his row says ALL, which is not a section anybody is in');

  const names = await t.$$eval('.team-sec-name', (ns) => ns.map((n) => n.textContent.trim()));
  check('and the sections are the organogram\'s, in the organogram\'s order',
    // Read in the case the markup has them. The heading LOOKS uppercase
    // because text-transform makes it so, which changes the pixels and not
    // the text - asserting on the shouted version tests the stylesheet.
    names.join(' | ') === 'Supply Chain Applications | Sales Applications | Financial Applications',
    names.join(' | '));

  // THE INTERIM CASE, which is the one the data cannot state directly: he
  // leads Supply Chain while sitting in no section at all.
  const first = await t.evaluate(() => {
    const sec = document.querySelectorAll('.team-sec')[0];
    return {
      who: sec.querySelector('.team-sec-who strong').textContent.trim(),
      role: sec.querySelector('.team-sec-role').textContent.trim(),
      count: sec.querySelector('.team-sec-count').textContent.trim()
    };
  });
  check('a head who leads a section he is not in is marked interim',
    first.who === 'Utpal Biswas' && first.role === 'Section Head, Interim',
    first.who + ' - ' + first.role);

  const second = await t.$eval('.team-sec:nth-child(2) .team-sec-role', (n) => n.textContent.trim());
  check('and a head who leads their own section is not',
    second === 'Section Head', second);

  // ---- designation and module ----
  // The chart role used to REPLACE the designation, so the one card naming a
  // manager was the one that did not say they were a manager. Both now, on
  // two lines, plus the module beside the designation.
  const heads = await t.$$eval('.team-sec', (ns) => ns.map((sec) => ({
    role: sec.querySelector('.team-sec-role').textContent.trim(),
    sub: sec.querySelector('.team-sec-sub')
      ? sec.querySelector('.team-sec-sub').textContent.trim() : ''
  })));
  check('a section head keeps their designation under their chart role',
    heads[0].role === 'Section Head, Interim' &&
    heads[0].sub === 'Senior Manager \u00b7 EAS',
    heads[0].role + ' / ' + heads[0].sub);

  check('and each head shows their own module, not the same one',
    heads[1].sub === 'Manager \u00b7 SD',
    heads.map((h) => h.sub).join(' | '));

  // THE DEPARTMENT HEAD'S MODULE IS THE DEPARTMENT. His Module cell names a
  // module because the sheet has to put something there; he does not belong
  // to one, and the card saying MM would be the page inventing a fact.
  check('the department head reads EAS rather than the module in his row',
    heads[0].sub.indexOf('EAS') !== -1 && heads[0].sub.indexOf('MM') === -1,
    heads[0].sub);

  // Member cards carry it too.
  await t.click('.team-sec[data-section="0"] .team-sec-card');
  await t.waitForTimeout(500);
  const member = await t.$$eval('#teamSecBody0 .team-card', (ns) => ns.map((c) => ({
    name: c.querySelector('strong').textContent.trim(),
    flag: c.querySelector('.team-flag') ? c.querySelector('.team-flag').textContent.trim() : '',
    role: c.querySelector('.team-role').textContent.trim()
  })));
  const bilal = member.filter((m) => m.name.indexOf('Bilal') === 0)[0];
  check('an ordinary member card shows designation and module',
    bilal && bilal.role === 'Deputy Manager \u00b7 MM' && bilal.flag === '',
    bilal ? bilal.role : '(not found)');

  const inSection = member.filter((m) => m.name.indexOf('Utpal') === 0)[0];
  check('and the head inside the section keeps both as well',
    inSection && inSection.flag === 'Section Head, Interim' &&
    inSection.role === 'Senior Manager \u00b7 EAS',
    inSection ? inSection.flag + ' / ' + inSection.role : '(not found)');

  await t.click('.team-sec[data-section="0"] .team-sec-card');
  await t.waitForTimeout(400);

  // ---- closed until pressed ----
  check('every section starts closed, so the page opens readable',
    (await visibleCards(t)) === 0 &&
    (await t.$$eval('.team-sec-card[aria-expanded="true"]', (n) => n.length)) === 0,
    'thirty-seven cards at once is a page you scroll rather than read');

  await t.click('.team-sec:nth-child(1) .team-sec-card');
  await t.waitForTimeout(400);

  const opened = await t.evaluate(() => {
    const sec = document.querySelectorAll('.team-sec')[0];
    return {
      expanded: sec.querySelector('.team-sec-card').getAttribute('aria-expanded'),
      marked: sec.classList.contains('is-open'),
      cards: Array.from(sec.querySelectorAll('.team-card strong')).map((n) => n.textContent.trim())
    };
  });
  check('pressing one opens it, and says so to a screen reader too',
    opened.expanded === 'true' && opened.marked === true);

  // THE NUMBER ON THE CARD HAS TO BE THE NUMBER BEHIND IT. "1 member" over a
  // panel holding two people is the kind of small wrongness that makes
  // somebody stop trusting the figures on the rest of the site.
  check('and the count on the card is what opening it actually shows',
    opened.cards.length === Number(first.count.replace(/\D/g, '')),
    first.count + ' vs ' + opened.cards.length + ' cards');

  // The head appears inside their own section as well. The card you pressed
  // is a control; losing his extension by opening him would be odd.
  check('and it lists the head and the people under them',
    opened.cards.join(' | ') === 'Utpal Biswas | Bilal Hossain',
    opened.cards.join(' | '));

  check('while the other sections stay shut',
    (await t.$$eval('.team-sec-card[aria-expanded="true"]', (n) => n.length)) === 1);

  // ONE AT A TIME, AND WHY IT IS NOT A PREFERENCE.
  //
  // Every open panel is placed in the same cell of the grid - full width,
  // second row - so two of them land on top of each other and the one drawn
  // last wins. The reported symptom was three sections showing an open
  // chevron above a single list of people: the other two were not hidden,
  // they were underneath.
  await t.click('.team-sec:nth-child(2) .team-sec-card');
  await t.waitForTimeout(400);

  const afterSecond = await t.evaluate(() => ({
    open: Array.from(document.querySelectorAll('.team-sec-card'))
      .map((b, i) => (b.getAttribute('aria-expanded') === 'true' ? i : -1))
      .filter((i) => i !== -1),
    panels: Array.from(document.querySelectorAll('.team-sec-body'))
      .filter((p) => !p.hidden).length
  }));
  check('opening a second section closes the first',
    afterSecond.open.length === 1 && afterSecond.open[0] === 1 &&
    afterSecond.panels === 1,
    'open: [' + afterSecond.open.join(',') + '], panels showing: ' + afterSecond.panels);

  // The chevron has been pointing up; pressing it has to do what that says.
  await t.click('.team-sec:nth-child(2) .team-sec-card');
  await t.waitForTimeout(400);
  check('and pressing the open one shuts it',
    (await t.$$eval('.team-sec-card[aria-expanded="true"]', (n) => n.length)) === 0 &&
    (await visibleCards(t)) === 0);

  await t.click('.team-sec:nth-child(1) .team-sec-card');
  await t.waitForTimeout(400);

  // ---- the contact details, which are the reason this page exists ----
  const utpal = await t.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.team-card'))
      .filter((c) => /Utpal Biswas/.test(c.textContent))[0];
    return card ? {
      hrefs: Array.from(card.querySelectorAll('a.team-line')).map((a) => a.getAttribute('href')),
      lines: card.querySelectorAll('.team-line').length
    } : null;
  });
  check('a card turns the address and the mobile into things you can press',
    utpal && utpal.hrefs.indexOf('mailto:utpal@example.test') !== -1 &&
    utpal.hrefs.indexOf('tel:01700000000') !== -1,
    utpal ? utpal.hrefs.join(' ') : '(no card)');

  // An empty cell leaves its line out rather than printing a blank one.
  // Ayesha has no extension in the fixture; Carim has one.
  await t.click('.team-sec:nth-child(2) .team-sec-card');
  await t.waitForTimeout(400);
  const lineCounts = await t.evaluate(() => {
    const of = (name) => {
      const c = Array.from(document.querySelectorAll('.team-card'))
        .filter((x) => new RegExp(name).test(x.textContent))[0];
      return c ? c.querySelectorAll('.team-line').length : -1;
    };
    return { ayesha: of('Ayesha Rahman'), carim: of('Carim Uddin') };
  });
  check('a missing extension leaves the line out instead of printing an empty one',
    lineCounts.ayesha === 2 && lineCounts.carim === 3,
    'Ayesha ' + lineCounts.ayesha + ' lines, Carim ' + lineCounts.carim);

  check('and somebody with no photograph gets their initials',
    (await t.$eval('.team-lead .team-face', (n) => n.classList.contains('is-initials'))) === true &&
    (await t.$eval('.team-lead .team-face', (n) => n.textContent.trim())) === 'UB',
    await t.$eval('.team-lead .team-face', (n) => n.textContent.trim()));

  // A section nobody is marked as leading shows the department head covering
  // it, interim - which is the arrangement the team is actually in.
  const headless = await t.evaluate(() => {
    const sec = document.querySelectorAll('.team-sec')[2];
    return {
      who: sec.querySelector('.team-sec-who strong').textContent.trim(),
      role: sec.querySelector('.team-sec-role').textContent.trim()
    };
  });
  check('an unled section shows the department head covering it',
    headless.who === 'Utpal Biswas' && headless.role === 'Section Head, Interim',
    headless.who + ' - ' + headless.role);

  // The roster disagreement. Shown to an admin, because a viewer can do
  // nothing about it and would read it as the page being broken.
  check('an admin is told when the directory and the KPI roster disagree',
    (await t.$$eval('.team-drift', (n) => n.length)) === 1 &&
    /Nobody In Roster/.test(await t.$eval('.team-drift', (n) => n.textContent)),
    'the roster decides whose tickets count, so this matters');
  await t.close();

  const viewer = await open('?view=team&role=USER');
  await viewer.waitForTimeout(900);
  check('and a viewer is not, because it is not theirs to close',
    (await viewer.$$eval('.team-drift', (n) => n.length)) === 0 &&
    (await viewer.$$eval('.team-sec', (n) => n.length)) === 3,
    'they still see the whole directory');
  await viewer.close();

  // ---------------------------------------------------------------------------
  // and it has left the Summary screen
  // ---------------------------------------------------------------------------
  const sum = await open('?view=settings');
  await sum.waitForTimeout(900);
  check('the org carousel is gone from Summary, markup and all',
    (await sum.$$eval('#orgStage, .org-card, #orgRows', (n) => n.length)) === 0,
    'Summary is about the indicators now');
  check('and Summary still works without it',
    (await sum.$$eval('#settingsTable tbody tr', (n) => n.length)) > 0,
    'the thresholds table is still drawn');
  await sum.close();

  // ---------------------------------------------------------------------------
  // Back, which is not the browser's Back
  // ---------------------------------------------------------------------------
  // Every screen here is a .view being shown and hidden on one page, so the
  // browser's own Back leaves the app entirely - it goes to whatever was open
  // before the dashboard. Hence one of our own.
  const nav = await open();

  check('Back is not offered before there is anywhere to go back to',
    (await nav.$eval('#portalBack', (n) => n.hidden)) === true,
    'a dead control is worse than no control');

  await nav.click('.portal-tab[data-view="team"]');
  await nav.waitForTimeout(700);
  check('and appears once you have moved',
    (await nav.$eval('#portalBack', (n) => n.hidden)) === false);

  await nav.click('.portal-tab[data-view="links"]');
  await nav.waitForTimeout(700);
  await nav.click('#portalBack');
  await nav.waitForTimeout(700);
  check('pressing it goes back one screen, not home',
    (await nav.$eval('#view-team', (n) => !n.hidden)) === true &&
    (await nav.$eval('#view-home', (n) => n.hidden)) === true,
    'Home is a different button and goes somewhere else');

  await nav.click('#portalBack');
  await nav.waitForTimeout(700);
  check('and again goes back another, to where the trail started',
    (await nav.$eval('#view-home', (n) => !n.hidden)) === true &&
    (await nav.$eval('#portalBack', (n) => n.hidden)) === true,
    'the trail is spent, so the button goes away again');

  // It has to cross the two shells, because the dashboard is where somebody
  // is most likely to want it - and its own Back button is a second element.
  await nav.click('.portal-tab[data-view="team"]');
  await nav.waitForTimeout(700);
  await nav.click('.portal-tab[data-view="kpi1"]');
  await nav.waitForTimeout(1200);
  check('the dashboard has one too, and the trail crosses between shells',
    (await nav.$eval('#backBtn', (n) => n.hidden)) === false);

  await nav.click('#backBtn');
  await nav.waitForTimeout(900);
  check('and it comes back out of the dashboard to the portal page before it',
    (await nav.$eval('#view-team', (n) => !n.hidden)) === true &&
    (await nav.$eval('#portalRoot', (n) => n.hidden)) === false,
    'one trail, both shells');
  await nav.close();

  // ---------------------------------------------------------------------------
  // the SAP & HRMS link, which has moved
  // ---------------------------------------------------------------------------
  const lk = await open('?view=links');
  await lk.waitForTimeout(900);

  const card = await lk.evaluate(() => {
    const a = document.querySelector('.link-card');
    return a ? {
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
      text: a.textContent.replace(/\s+/g, ' ').trim()
    } : null;
  });

  check('the Links page carries the SAP & HRMS UserHub',
    card !== null && /SAP & HRMS UserHub/.test(card.text),
    card ? card.text.slice(0, 48) : '(no card)');

  // target and rel are required, not preferences: this page runs inside the
  // Apps Script sandbox iframe, where a same-frame navigation to another
  // origin is refused outright, and window.opener would otherwise let the
  // opened page redirect this tab.
  check('and opens in a new tab, with the opener closed off',
    card.target === '_blank' && /noopener/.test(card.rel) && /noreferrer/.test(card.rel),
    card.target + ' / ' + card.rel);

  check('pointing at the address in CONFIG rather than one typed into markup',
    card.href === 'https://sapuserhub.blogspot.com/', card.href);

  // It used to be a nav entry in the dashboard sidebar.
  await lk.click('.portal-tab[data-view="kpi1"]');
  await lk.waitForTimeout(1200);
  check('and is gone from the dashboard sidebar, where it used to live',
    (await lk.$$eval('.sidebar a[href^="http"]', (n) => n.length)) === 0,
    'nothing in that nav leaves the app any more');
  await lk.close();

  // ---------------------------------------------------------------------------
  // the hero button that leaves the app
  // ---------------------------------------------------------------------------
  const hero = await open();
  await hero.waitForTimeout(900);

  const cta = await hero.evaluate(() => {
    const a = document.getElementById('heroSapLink');
    return a ? {
      text: a.textContent.trim(),
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      view: a.getAttribute('data-view'),
      hidden: a.hidden
    } : null;
  });
  check('the hero offers SAP UserHub where it used to offer the team',
    cta !== null && cta.text === 'Open SAP UserHub' && cta.hidden === false &&
    cta.href === 'https://sapuserhub.blogspot.com/' && cta.target === '_blank',
    cta ? cta.text + ' -> ' + cta.href : '(missing)');

  // AN ANCHOR WEARING A BUTTON'S CLASS, which is where this went wrong once.
  // .portal-cta was written for a button, and a button is never underlined
  // and is inline-block; an anchor is both, by default. The class never said
  // so, so the SAP button shipped underlined and a shade shorter than the
  // one beside it. Styling by class rather than by tag means the class has
  // to state what the tag would have assumed.
  const pair = await hero.evaluate(() => {
    const read = (el) => {
      const css = getComputedStyle(el);
      return { line: css.textDecorationLine, h: Math.round(el.getBoundingClientRect().height),
               bg: css.backgroundColor, weight: css.fontWeight,
               size: css.fontSize, family: css.fontFamily };
    };
    return {
      kpi: read(document.querySelector('.portal-cta[data-view="kpi1"]')),
      sap: read(document.getElementById('heroSapLink'))
    };
  });
  check('it is not underlined, and is the same button as the one beside it',
    pair.sap.line === 'none' && pair.sap.h === pair.kpi.h &&
    pair.sap.bg === pair.kpi.bg,
    'decoration ' + pair.sap.line + ', ' + pair.sap.h + 'px vs ' + pair.kpi.h + 'px');

  // BOLD, and bold on BOTH. Four of these sit on a photographic blue hero
  // where semibold read as a caption. 700 is the heaviest weight the system
  // stack actually ships, so it is drawn rather than faked - and the pair has
  // to agree about it for the same reason it has to agree about the
  // underline: a button and an anchor wearing one class start from different
  // defaults, and anything a UA stylesheet sets on one of them only shows up
  // beside the other.
  check('and both are bold, not semibold, so the words carry on the hero',
    Number(pair.kpi.weight) >= 700 && pair.sap.weight === pair.kpi.weight,
    pair.kpi.weight + ' on the button, ' + pair.sap.weight + ' on the link');

  // THE SAME TYPE, not merely the same height - the assertion the check above
  // was missing. .portal-cta set its type with the `font` shorthand and named
  // `inherit` as the family, which is illegal inside that shorthand, so the
  // whole declaration was dropped: the three links inherited the page's 14px
  // because an anchor does, and this BUTTON fell back to the UA default of
  // 13.3px Arial. Two typefaces, two sizes, side by side on the hero, for
  // months - and invisible to a test that only asked whether the boxes were
  // the same height, which the padding made true anyway.
  check('and set in the same face at the same size, not just the same box',
    pair.sap.size === pair.kpi.size && pair.sap.family === pair.kpi.family &&
    /inherit|apple-system/.test(pair.kpi.family),
    pair.kpi.size + ' ' + pair.kpi.family.split(',')[0] + ' on the button, ' +
    pair.sap.size + ' ' + pair.sap.family.split(',')[0] + ' on the link');

  // THE TRAP THIS GUARDS. wireNavigation() binds every .portal-cta and calls
  // showView(dataset.view); an external link has none, showView falls back to
  // Home, and the screen changes behind the tab that just opened.
  check('and carries no data-view, so pressing it cannot also change the page',
    cta.view === null, 'the same trap the old sidebar link had a paragraph about');

  // PRESSED FROM ANOTHER SCREEN, which is the only way the trap is visible.
  //
  // The first version of this clicked the link while sitting on Home - where
  // a stray showView() falling back to Home changes precisely nothing, so it
  // passed whether the guard was there or not. Removing the guard did not
  // fail it, which is how that was found.
  //
  // The element is inside the hidden Home view here. A listener on a hidden
  // element still fires on a programmatic click, so this asks exactly the
  // question that matters: was one ever attached?
  await hero.click('.portal-tab[data-view="links"]');
  await hero.waitForTimeout(700);

  await hero.evaluate(() => {
    const a = document.getElementById('heroSapLink');
    a.removeAttribute('target');          // so the click does not open a tab
    a.setAttribute('href', 'javascript:void 0');
    a.click();
  });
  await hero.waitForTimeout(600);

  check('pressing it cannot navigate the page behind the tab it opens',
    (await hero.$eval('#view-links', (n) => !n.hidden)) === true &&
    (await hero.$eval('#view-home', (n) => n.hidden)) === true,
    'still on Links; without the guard this lands on Home');
  await hero.close();

  // ---------------------------------------------------------------------------
  // the rest of the links, and the second row of buttons
  // ---------------------------------------------------------------------------
  // Both the Links page and the hero are drawn from portalLinks() in
  // Config.gs, so what is asserted here is that the page matches the list -
  // not that it matches five addresses typed into a test, which would have
  // to be corrected every time a sixth is added.
  {
    const q = await open();
    await q.waitForTimeout(900);

    const wanted = await q.evaluate(() => window.__EAS_LINKS__ || []);
    check('(fixture check) the page was handed a list to draw from',
      wanted.length >= 5, wanted.length + ' links');

    // ---- the hero ----
    const buttons = await q.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.portal-hero-actions'))
        .filter((r) => !r.hidden);
      return rows.map((row) => Array.from(row.children).map((el) => ({
        tag: el.tagName,
        text: el.textContent.trim(),
        href: el.getAttribute('href'),
        target: el.getAttribute('target'),
        rel: el.getAttribute('rel'),
        view: el.getAttribute('data-view')
      })));
    });

    check('the hero has two rows of two',
      buttons.length === 2 && buttons[0].length === 2 && buttons[1].length === 2,
      buttons.map((r) => r.length).join(' + '));

    check('the first row is the KPI Engine and the SAP UserHub',
      buttons[0][0].text === 'Open the KPI Engine' &&
      buttons[0][1].text === 'Open SAP UserHub',
      buttons[0].map((x) => x.text).join(' | '));

    const wantSecond = wanted.filter((l) => l.hero && Number(l.row) !== 1);
    check('and the second row is every other hero link in Config.gs',
      JSON.stringify(buttons[1].map((x) => x.text)) ===
        JSON.stringify(wantSecond.map((l) => l.hero)) &&
      JSON.stringify(buttons[1].map((x) => x.href)) ===
        JSON.stringify(wantSecond.map((l) => l.url)),
      buttons[1].map((x) => x.text).join(' | '));

    // EVERY ONE OF THEM, not just the one that was there first. This page
    // runs inside the Apps Script sandbox iframe, where a same-frame
    // navigation to another origin is refused outright - so a link missing
    // target="_blank" does not open in the wrong place, it does nothing at
    // all. And a .portal-cta carrying a data-view would change the screen
    // behind the tab it just opened.
    const outward = buttons.reduce((all, r) => all.concat(r), [])
      .filter((x) => x.tag === 'A');
    const unsafe = outward.filter((x) =>
      x.target !== '_blank' || !/noopener/.test(x.rel || '') || x.view !== null);
    check('every hero link opens in a new tab and carries no data-view',
      outward.length === 3 && unsafe.length === 0,
      outward.length + ' links, ' + unsafe.length + ' of them wrong');

    // ---- the Links page ----
    await q.click('.portal-tab[data-view="links"]');
    await q.waitForTimeout(700);

    const cards = await q.$$eval('#linksBody .link-card', (ns) => ns.map((a) => ({
      name: a.querySelector('.link-card-text strong').textContent.trim(),
      href: a.getAttribute('href'),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel')
    })));

    check('the Links page lists every link in Config.gs, in order',
      JSON.stringify(cards.map((c) => c.name)) ===
        JSON.stringify(wanted.map((l) => l.name)),
      cards.map((c) => c.name).join(' | '));

    check('and each one points where Config.gs says',
      JSON.stringify(cards.map((c) => c.href)) ===
        JSON.stringify(wanted.map((l) => l.url)),
      cards.length + ' addresses');

    check('every card opens in a new tab, with opener and referrer closed off',
      cards.length > 0 && cards.every((c) =>
        c.target === '_blank' && /noopener/.test(c.rel || '') &&
        /noreferrer/.test(c.rel || '')),
      cards.filter((c) => c.target !== '_blank').length + ' without target');

    await q.close();
  }

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
