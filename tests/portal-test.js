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
const path = require('path'), fs = require('fs'), vm = require('vm');

const PAGE = process.env.EAS_PAGE ||
             path.join(__dirname, 'harness', 'page.html');
const BROWSER = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

// The real Config.gs, read the same way the harness reads it into the page.
// The policy assertions near the end compare against CONFIG.POLICY rather
// than against a copy of the title written out here - a copy would go on
// passing after somebody corrected the document's name in Config.
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');
const cfgBox = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat
};
cfgBox.globalThis = cfgBox;
vm.createContext(cfgBox);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), cfgBox);
const CONFIG = vm.runInContext('CONFIG', cfgBox);

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

  const open = async (query, viewport) => {
    const p = await b.newPage({ viewport: viewport || { width: 1500, height: 1000 } });
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
  const WANTED = ['Home', 'About us', 'EAS Team', 'KPI Engine', 'Customers',
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

  // THE CHART DOES NOT EDITORIALISE ABOUT HOW SOMEBODY CAME TO LEAD.
  //
  // A head who leads a section he does not sit in used to be labelled
  // "Section Head, Interim" - a caveat printed on the card that carries the
  // most authority on the page, telling a team of thirty-seven something all
  // thirty-seven of them already knew. The arrangement has not changed and
  // the server still reports it: team-test.js checks `section.interim` is
  // true for exactly the sections it should be. The chart just says the role.
  const first = await t.evaluate(() => {
    const sec = document.querySelectorAll('.team-sec')[0];
    return {
      who: sec.querySelector('.team-sec-who strong').textContent.trim(),
      role: sec.querySelector('.team-sec-role').textContent.trim(),
      count: sec.querySelector('.team-sec-count').textContent.trim()
    };
  });
  check('a head who leads a section he is not in still reads Section Head',
    first.who === 'Utpal Biswas' && first.role === 'Section Head',
    first.who + ' - ' + first.role);

  const allRoles = await t.$$eval('.team-sec-role', (ns) => ns.map((n) => n.textContent.trim()));
  check('and so does every other head, so the row reads as one chart',
    allRoles.length >= 3 && allRoles.every((r) => r === 'Section Head'),
    allRoles.join(' | '));

  check('with the word Interim nowhere on the chart at all',
    !/interim/i.test(await t.$eval('#teamBody', (n) => n.textContent)),
    'including inside the sections, which have to be opened to be read');

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
    heads[0].role === 'Section Head' &&
    heads[0].sub === 'Senior Manager \u00b7 MM',
    heads[0].role + ' / ' + heads[0].sub);

  check('and each head shows their own module, not the same one',
    heads[1].sub === 'Manager \u00b7 SD',
    heads.map((h) => h.sub).join(' | '));

  // THE DEPARTMENT HEAD READS LIKE THE HEADS BESIDE HIM. His line used to be
  // overridden to the DEPARTMENT, on the reasoning that he heads all of it
  // and sits in no one module. On the page that came out as "Senior Manager
  // - EAS" at the head of a row reading "Manager - SD" and "Manager - FI/CO":
  // the one card in four that did not answer the question the line is there
  // to answer. The Module cell is where the sheet says which modules are
  // his, so the Module cell is what the card prints.
  check('the department head shows his module, like the heads beside him',
    heads[0].sub === 'Senior Manager \u00b7 MM' && heads[0].sub.indexOf('EAS') === -1,
    heads[0].sub + ' - the old override would put EAS here');

  // Member cards carry it too.
  await t.click('.team-sec[data-section="0"] .team-sec-open');
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

  // ONE CARD PER HEAD, NOT TWO. The head used to appear twice: on the card
  // above the section, and again as the first card inside it the moment you
  // opened it. The duplicate existed because the card above was a BUTTON -
  // the whole card was the control - and an email address inside a button
  // is not a link anybody can press, so the contact details lived on the
  // copy. The card is a plain div now, only its footer row opens the
  // section, and the details are where the name already was.
  const inSection = member.filter((m) => m.name.indexOf('Utpal') === 0)[0];
  check('the head is not repeated inside their own section',
    inSection === undefined,
    inSection ? 'still there: ' + inSection.name
              : member.length + ' cards inside, none of them the head');

  const headCard = await t.evaluate(() => {
    const card = document.querySelector('.team-sec[data-section="0"] .team-sec-card');
    if (!card) return null;
    const lines = Array.from(card.querySelectorAll('.team-line'));
    return {
      who: (card.querySelector('.team-sec-who strong') || {}).textContent || '',
      role: (card.querySelector('.team-sec-sub') || {}).textContent || '',
      lines: lines.map((l) => l.textContent.trim()),
      // The links have to be real links, which is the whole reason the
      // card stopped being a button.
      mailto: lines.filter((l) => /^mailto:/.test(l.getAttribute('href') || '')).length,
      tel: lines.filter((l) => /^tel:/.test(l.getAttribute('href') || '')).length,
      blood: (card.querySelector('.team-blood') || {}).textContent || ''
    };
  });
  check('and their card carries the details the duplicate used to',
    headCard && /Utpal/.test(headCard.who) &&
    headCard.role === 'Senior Manager \u00b7 MM' && headCard.lines.length === 3 &&
    /Blood group/.test(headCard.blood),
    headCard ? headCard.lines.join(' | ') : '(no card)');
  check('with the email and the mobile pressable, not text in a button',
    headCard && headCard.mailto === 1 && headCard.tel === 1,
    headCard ? headCard.mailto + ' mailto, ' + headCard.tel + ' tel' : '(none)');

  // ---- blood group ----
  // Everything else on these cards is a way of reaching somebody. This is
  // the one fact read ABOUT somebody, and read once: when there has been an
  // accident and a colleague is on the phone to a hospital.
  const blood = await t.$$eval('#teamSecBody0 .team-card', (ns) => ns.map((c) => ({
    name: c.querySelector('strong').textContent.trim(),
    // textContent, so the screen-reader prefix inside the pill comes with
    // it - that is the half of this assertion the eye cannot check.
    pill: c.querySelector('.team-blood')
      ? c.querySelector('.team-blood').textContent.trim() : null
  })));
  const bilalBlood = blood.filter((b) => b.name.indexOf('Bilal') === 0)[0];
  check('a card carries the blood group on the row it belongs to',
    bilalBlood && bilalBlood.pill === 'Blood group O+',
    bilalBlood ? String(bilalBlood.pill) : '(no card)');
  check('and says what the letters are, for a reader that cannot see red',
    bilalBlood && /^Blood group /.test(bilalBlood.pill),
    '"O+" on its own is not a sentence');

  // ---- the photograph ----
  // 42px was a thumbnail to squint at. Asserted as a relationship rather
  // than a number: the person card is the one being looked at, so its face
  // is the larger of the two, and both are big enough to be a face.
  const faces = await t.evaluate(() => {
    const one = (sel) => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().width) : 0;
    };
    return { card: one('#teamSecBody0 .team-card .team-face'),
             summary: one('.team-sec-card .team-face'),
             lead: one('.team-lead .team-face') };
  });
  // TWO SIZES, NOT THREE. The card at the top of the chart used to be the
  // biggest thing on the page - 380px wide over four cards of 268, with an
  // 88px face over their 58 - which read as a different kind of card
  // rather than as the top of the same chart. It matches them now. The
  // person card inside an opened section is the only one that is larger,
  // because it is the one being read rather than scanned past.
  // 84 as the floor, not 52. The size has been raised twice on the same
  // complaint - the faces are too small to tell who is who - and a floor
  // that still passes at the size being complained about is not a floor.
  check('the photo slot is big enough to recognise somebody by',
    faces.card >= 84 && faces.summary >= 84 && faces.lead >= 84,
    faces.lead + 'px lead, ' + faces.card + 'px card, ' +
    faces.summary + 'px summary');
  check('and every face on the page is the same size as every other',
    faces.lead === faces.summary && faces.card === faces.summary,
    faces.lead + ' lead, ' + faces.card + ' card, ' + faces.summary +
    ' summary - three sizes was a hierarchy nobody asked for, and the ' +
    'smallest was the one being squinted at');

  // THE HEAD CARD KEEPS ITS OWN WIDTH. It was briefly narrowed to one
  // column on a misreading - "match the section card" meant bring the
  // cards below UP to this one, and this assertion is here so the
  // misreading cannot come back quietly.
  const headWidth = await t.evaluate(() => {
    const lead = document.querySelector('.team-lead');
    const sec = document.querySelector('.team-sec-open');
    if (!lead || !sec) return null;
    return { lead: Math.round(lead.getBoundingClientRect().width),
             section: Math.round(sec.getBoundingClientRect().width) };
  });
  // EQUAL HEIGHTS. The four cards hold different numbers of contact rows -
  // not everybody has an extension - so at natural height they came out as
  // a row of cards of three different lengths, which reads as a layout
  // that has slipped rather than as a chart.
  const secHeights = await t.$$eval('.team-sec-card',
    (ns) => ns.map((n) => Math.round(n.getBoundingClientRect().height)));
  check('the section cards all end on the same line',
    secHeights.length >= 3 &&
    Math.max.apply(null, secHeights) === Math.min.apply(null, secHeights),
    secHeights.join(', ') + 'px');

  // And the chevrons with them, which is what makes the row read as one
  // control repeated rather than three placed by hand.
  const chevrons = await t.$$eval('.team-sec-open',
    (ns) => ns.map((n) => Math.round(n.getBoundingClientRect().top)));
  check('and their footers line up, so the chevrons sit on one line',
    chevrons.length >= 3 &&
    Math.max.apply(null, chevrons) === Math.min.apply(null, chevrons),
    chevrons.join(', '));

  // AND THE BLUE REACHES PAST THEM. These cards are real backdrop-filter
  // glass, and glass over the white page below is a grey box - so the band
  // has to finish under them, not through them. Its height was a
  // hard-coded 700px, which was right for the cards as they were and wrong
  // the day the heads' details moved onto them: the blue stopped halfway
  // down their footers and the bottom of each card sat on white.
  const sky = await t.evaluate(() => {
    const band = document.querySelector('.portal-sky');
    const cards = Array.from(document.querySelectorAll('.team-sec-card'));
    if (!band || !cards.length) return null;
    return {
      bottom: Math.round(band.getBoundingClientRect().bottom),
      cards: Math.round(Math.max.apply(null,
        cards.map((c) => c.getBoundingClientRect().bottom)))
    };
  });
  check('and the blue band finishes below the cards, not through them',
    sky && sky.bottom >= sky.cards,
    sky ? 'band ends at ' + sky.bottom + ', cards at ' + sky.cards +
          (sky.bottom >= sky.cards ? '' : ' - cut by ' + (sky.cards - sky.bottom))
        : '(not found)');

  check('while the head card stays wider than one section column',
    headWidth && headWidth.lead > headWidth.section + 40,
    headWidth ? headWidth.lead + 'px over a ' + headWidth.section + 'px column'
              : '(not found)');

  // NO BLOOD GROUP ON THE HEAD CARD. One person, alone at the top of the
  // page, where a red pill is not a detail on a card in a grid of
  // thirty-six - it is the second thing on the page. His group is on his
  // card inside Supply Chain, with everybody else's.
  const leadPill = await t.$$eval('.team-lead .team-blood', (ns) => ns.length);
  const anyPill = await t.$$eval('.team-blood', (ns) => ns.length);
  check('the head card carries no blood group, though the cards below do',
    leadPill === 0 && anyPill > 0,
    leadPill + ' on the head card, ' + anyPill + ' on the page');

  // A PHOTOGRAPH IS DRAWN WHEN THERE IS ONE, AND CHANGES NOTHING ELSE.
  // Every card in every suite rendered initials until the real photographs
  // arrived, so the <img> branch of teamCard() - the half that is on screen
  // now - had never been drawn in a browser. One fixture person has one.
  // Across the whole chart, not one open section: the head's duplicate card
  // went when the details moved onto the section card, so the open section
  // may hold a single person - and this needs one face of each kind to
  // compare. Every face on the page is the same size by design, which is
  // the thing being checked.
  const shot = await t.evaluate(() => {
    const faces = Array.from(document.querySelectorAll('#teamBody .team-face'));
    const imgFace = faces.filter((f) => f.tagName === 'IMG')[0];
    const initialsFace = faces.filter((f) => f.classList.contains('is-initials'))[0];
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    if (!imgFace || !initialsFace) return null;
    const withImg = imgFace.closest('.team-card, .team-sec-card, .team-lead');
    const img = imgFace;
    return {
      who: withImg.querySelector('strong').textContent.trim(),
      photo: box(imgFace), initials: box(initialsFace),
      // The rendered box, not the source: object-fit has to crop a portrait
      // to the circle rather than squash it into one.
      fit: getComputedStyle(img).objectFit,
      position: getComputedStyle(img).objectPosition,
      round: getComputedStyle(img).borderRadius,
      // Did it actually decode? A broken src still has a layout box.
      loaded: img.complete && img.naturalWidth > 0
    };
  });
  check('a card with a photograph draws the photograph',
    shot && shot.loaded === true,
    shot ? shot.who + ', decoded ' + shot.loaded : '(no card had an img)');
  check('and it fills the same circle the initials would have',
    shot && shot.photo.w === shot.initials.w && shot.photo.h === shot.initials.h &&
    shot.photo.w === shot.photo.h,
    shot ? JSON.stringify(shot.photo) + ' vs ' + JSON.stringify(shot.initials)
         : '(not found)');
  check('cropped to it rather than squashed into it',
    shot && shot.fit === 'cover' && /50%|9999px/.test(shot.round),
    shot ? shot.fit + ', radius ' + shot.round : '(not found)');

  // AND CROPPED TOWARDS THE HEAD. These are standing portraits - most show
  // somebody from the chest up - and a square taken from the centre of one
  // is mostly shirt, so a 76px avatar was showing a 25px face and no amount
  // of resolution was ever going to fix it.
  //
  // Asserted as the CSS value, which is what this is: a decision about
  // which band of the photograph the circle shows. Below 50% is above the
  // middle; the bound at 15% is there because a crop pinned to the very top
  // takes the chin off a photograph that was already framed on the face.
  const crop = shot ? /(-?[\d.]+)%\s*$/.exec(shot.position) : null;
  check('and cropped towards the head rather than the middle of the picture',
    crop !== null && Number(crop[1]) < 50 && Number(crop[1]) >= 15,
    shot ? shot.position + ' - 50% is the middle, which is a tie' : '(not found)');


  // WHAT A BIGGER CARD IS FOR, stated as the thing it fixes rather than as
  // a width. The email address is the only line long enough to matter, and
  // at 248px it was the one being cut - a thirty-character address trailing
  // off into an ellipsis on a card whose entire job is letting somebody
  // reach that person. The lines still ellipsis rather than wrap,
  // deliberately, so this asks whether the longest address the team has
  // actually fits inside one.
  // MEASURED ONLY IF THERE IS SOMETHING TO MEASURE. A hidden element
  // reports scrollWidth and clientWidth as 0, so "nothing is clipped" is
  // true of every closed section - which is how this assertion quietly
  // stopped testing anything the first time a later block closed section 0
  // ahead of it. `seen` is what makes the vacuous case fail.
  const clip = await t.$$eval('#teamSecBody0 .team-card .team-line', (ns) => {
    const out = { seen: 0, cut: [] };
    ns.forEach(function (line) {
      const box = line.querySelector('span');
      if (!box || box.clientWidth === 0) return;
      out.seen++;
      if (box.scrollWidth > box.clientWidth) out.cut.push(box.textContent.trim());
    });
    return out;
  });
  check('and nothing on a card is cut off, the long email addresses included',
    clip.seen >= 3 && clip.cut.length === 0,
    clip.cut.length ? 'cut: ' + clip.cut.join(' | ')
                    : clip.seen + ' lines measured, none clipped');

  // THE SECOND ADDRESS, WHICH IS THE WHOLE REASON THERE ARE TWO. lh3 is the
  // sharper route and the less documented one; if it ever stops serving, or
  // one file will not come from it, every face on this page becomes a
  // broken icon at the same moment. The fixture's Sales section has
  // somebody whose first address cannot load and whose second can.
  await t.click('.team-sec[data-section="1"] .team-sec-open');
  await t.waitForTimeout(700);
  const swapped = await t.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#teamSecBody1 .team-card'))
      .filter((c) => c.querySelector('strong').textContent.trim().indexOf('Carim') === 0)[0];
    if (!card) return null;
    const img = card.querySelector('img.team-face');
    if (!img) return { img: false };
    return { img: true, src: img.getAttribute('src').slice(0, 24),
             tried: img.getAttribute('data-tried'),
             loaded: img.complete && img.naturalWidth > 0 };
  });
  check('a photograph the first address cannot serve comes from the second',
    swapped && swapped.img === true && swapped.loaded === true &&
    swapped.tried === '1' && swapped.src.indexOf('image/svg') !== -1,
    swapped ? JSON.stringify(swapped) : '(card not found)');
  await t.click('.team-sec[data-section="1"] .team-sec-open');
  await t.waitForTimeout(400);

  // NOBODY'S CELL IS EMPTY BY ACCIDENT, so an empty one has to draw nothing
  // at all. An empty red pill reads as a blood group that failed to load,
  // and on this of all fields that is worse than silence.
  await t.click('.team-sec[data-section="2"] .team-sec-open');
  await t.waitForTimeout(500);
  const blank = await t.$$eval('#teamSecBody2 .team-card', (ns) => ns.map((c) => ({
    name: c.querySelector('strong').textContent.trim(),
    has: Boolean(c.querySelector('.team-blood'))
  })));
  const noGroup = blank.filter((b) => b.name.indexOf('Nobody') === 0)[0];
  check('and a person with no blood group gets no pill, not an empty one',
    noGroup && noGroup.has === false,
    noGroup ? noGroup.name + ' has a pill' : '(card not found)');

  // A PHOTOGRAPH THAT WILL NOT LOAD AND HAS NOWHERE TO GO lands on the
  // initials, which were a perfectly good answer before any of these
  // photographs existed. A broken-image icon on a directory card reads as
  // a broken page.
  const dead = await t.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#teamSecBody2 .team-card'))
      .filter((c) => c.querySelector('strong').textContent.trim().indexOf('Nobody') === 0)[0];
    if (!card) return null;
    return { img: Boolean(card.querySelector('img.team-face')),
             initials: (card.querySelector('.team-face.is-initials') || {}).textContent || '' };
  });
  check('a photograph that will not load falls back to initials, not a broken icon',
    dead && dead.img === false && dead.initials.length > 0,
    dead ? 'img ' + dead.img + ', initials "' + dead.initials + '"' : '(not found)');
  // Opening a section closes whichever one was open - see "one at a time"
  // below - so this does not close section 2, it reopens section 0 and
  // closes section 2 on the way. Section 0 has to be back open for the line
  // under it, whose job is to close it.
  await t.click('.team-sec[data-section="0"] .team-sec-open');
  await t.waitForTimeout(400);

  await t.click('.team-sec[data-section="0"] .team-sec-open');
  await t.waitForTimeout(400);

  // =========================================================================
  // THE ORGANOGRAM
  // =========================================================================
  // The second view of the same thirty-six people, and a different
  // question: the directory answers "how do I reach this person", this
  // answers "how is this team arranged". A shape cannot be read a quarter
  // at a time, so nothing here opens and nothing is hidden.
  // Counted off the line the SERVER writes - "36 people in 4 sections" -
  // rather than off the chart, so this compares what was drawn against
  // what readTeam found rather than the chart against itself.
  const teamCount = Number(
    (/(\d+)\s+people/.exec(await t.$eval('#teamSub', (n) => n.textContent)) ||
     [0, 0])[1]);
  check('(fixture check) the page says how many people there are',
    teamCount >= 3, teamCount + ' people');

  const switchState = await t.evaluate(() => {
    const list = document.getElementById('teamViewList');
    const chart = document.getElementById('teamViewChart');
    if (!list || !chart) return null;
    return {
      labels: [list.textContent.trim(), chart.textContent.trim()],
      on: list.classList.contains('is-on'),
      chartOn: chart.classList.contains('is-on'),
      bodyShown: !document.getElementById('teamBody').hidden,
      chartShown: !document.getElementById('teamChart').hidden
    };
  });
  check('the team screen offers both views, and opens on the directory',
    switchState && switchState.labels[0] === 'EAS Team' &&
    switchState.labels[1] === 'Organogram' &&
    switchState.on === true && switchState.chartOn === false &&
    switchState.bodyShown === true && switchState.chartShown === false,
    switchState ? JSON.stringify(switchState) : '(no switch)');

  await t.click('#teamViewChart');
  await t.waitForTimeout(500);

  const og = await t.evaluate(() => {
    const names = Array.from(document.querySelectorAll('#teamChart .og-person strong'))
      .map((n) => n.textContent.trim());
    return {
      bodyShown: !document.getElementById('teamBody').hidden,
      chartShown: !document.getElementById('teamChart').hidden,
      selected: document.getElementById('teamViewChart').getAttribute('aria-selected'),
      cols: document.querySelectorAll('#teamChart .og-col').length,
      sections: Array.from(document.querySelectorAll('#teamChart .og-section-name'))
        .map((n) => n.textContent.trim()),
      modules: Array.from(document.querySelectorAll('#teamChart .og-module-name'))
        .map((n) => n.textContent.trim()),
      names: names,
      heads: Array.from(document.querySelectorAll('#teamChart .og-person.is-head strong'))
        .map((n) => n.textContent.trim()),
      lead: (document.querySelector('#teamChart .og-lead strong') || {}).textContent || '',
      // Nothing on this view is a contact detail: it is a shape, not a
      // directory, and a telephone number on every node is forty numbers
      // nobody came here for.
      lines: document.querySelectorAll('#teamChart .team-line').length
    };
  });

  check('pressing Organogram swaps the views over',
    og.chartShown === true && og.bodyShown === false && og.selected === 'true',
    JSON.stringify({ chart: og.chartShown, list: og.bodyShown }));

  check('one column per section, in the order the chart has them',
    og.cols === og.sections.length && og.sections.length >= 3,
    og.sections.join(' | '));

  // AND THE COLUMNS FILL THE ROW. The grid was written as repeat(4, 1fr),
  // which draws four tracks whatever the department has: with three
  // sections that is three narrow columns and a column of nothing, and
  // the bar they hang from running out past the last of them into it.
  // renderOrganogram sets --og-cols from the sections it was given.
  const span = await t.evaluate(() => {
    const row = document.querySelector('#teamChart .og-cols');
    const cols = Array.from(document.querySelectorAll('#teamChart .og-col'));
    if (!row || !cols.length) return null;
    const r = row.getBoundingClientRect();
    const last = cols[cols.length - 1].getBoundingClientRect();
    const first = cols[0].getBoundingClientRect();
    return { rowLeft: Math.round(r.left), rowRight: Math.round(r.right),
             left: Math.round(first.left), right: Math.round(last.right) };
  });
  check('and they fill the row, leaving no empty track on the end',
    span && Math.abs(span.right - span.rowRight) <= 1 &&
    Math.abs(span.left - span.rowLeft) <= 1,
    span ? 'columns ' + span.left + '-' + span.right +
           ' in a row ' + span.rowLeft + '-' + span.rowRight : '(not found)');

  // THE ONE THAT MATTERS ON A CHART: everybody drawn. A person missing is
  // somebody the chart says does not work here.
  const distinct = og.names.filter((n, i) => og.names.indexOf(n) === i);
  check('every single person is on the chart',
    distinct.length === teamCount,
    distinct.length + ' of ' + teamCount);

  // AND NOBODY IS ON IT TWICE WITHOUT A REASON. The first version drew
  // each person exactly once, which is tidy and answers the wrong
  // question: the head of the department covers a section from outside
  // it, and a column whose head is missing does not say who runs it. So a
  // name may appear twice - once at the top or in their own module, once
  // as the head of a section - and only for that reason. Anyone else
  // repeated is a person the chart says sits in two places.
  const counted = {};
  og.names.forEach(function (n) { counted[n] = (counted[n] || 0) + 1; });
  const unexplained = Object.keys(counted).filter(function (n) {
    return counted[n] > 1 && og.heads.indexOf(n) === -1;
  });
  check('and nobody is repeated who does not run a section',
    unexplained.length === 0,
    unexplained.length ? unexplained.join(', ') + ' drawn twice for no reason'
                       : 'repeats are section heads, which is what a repeat means here');

  // The department head holds two jobs and the chart says both: he runs
  // the department, and he covers a section. Two facts about one person,
  // which is not the same as one fact said twice.
  const utpalAt = og.names.filter((n) => /Utpal/.test(n)).length;
  check('the department head is at the top AND over the section he covers',
    /Utpal/.test(og.lead) && utpalAt >= 1 &&
    og.heads.filter((h) => /Utpal/.test(h)).length >= 1,
    og.lead + ', in ' + utpalAt + ' section column(s), flagged as head in ' +
    og.heads.filter((h) => /Utpal/.test(h)).length);

  check('a section head sits under their own module, marked rather than moved',
    og.heads.length >= 1 && og.heads.every((h) => og.names.indexOf(h) !== -1),
    og.heads.join(', ') || '(none flagged)');

  check('and the chart carries no contact details, which is the other view',
    og.lines === 0, og.lines + ' contact lines');

  // THE EMPLOYEE ID, under the designation. It is what somebody types into
  // SAP, and the chart is where they are looking at the person.
  const ids = await t.$$eval('#teamChart .og-col .og-person', (ns) => ns.map((c) => ({
    who: c.querySelector('strong').textContent.trim(),
    id: (c.querySelector('.og-id') || {}).textContent || ''
  })));
  check('every card on the chart carries an employee ID',
    ids.length > 0 && ids.every((p) => /^\d{6,}$/.test(p.id)),
    ids.filter((p) => !/^\d{6,}$/.test(p.id)).map((p) => p.who).join(', ') ||
    ids.length + ' cards, all with one');

  // And it is THEIR id, not the one above or below. Checked against the
  // directory, which prints the same people from the same rows - an
  // off-by-one here would put somebody else's employee number under a
  // face, and nothing on the page would look wrong.
  // Built from the DIRECTORY, not from the chart. Both are drawn from the
  // same rows but by different code, so this compares one against the
  // other - where reading the chart's own dot would compare the chart
  // against itself and could not disagree, whatever either of them did.
  // The directory is hidden while the chart is up; its markup is still
  // there, which is the point.
  const fromList = await t.evaluate(() => {
    const out = {};
    document.querySelectorAll('#teamBody .pres-dot[data-pres]').forEach(function (dot) {
      const card = dot.closest('.team-card, .team-sec-card');
      const name = card && card.querySelector('strong');
      if (name) out[name.textContent.trim()] = dot.getAttribute('data-pres');
    });
    return out;
  });
  check('(fixture check) the directory has ids to compare the chart against',
    Object.keys(fromList).length >= 3,
    Object.keys(fromList).length + ' people found in the directory');
  const mismatched = ids.filter(function (p) {
    return fromList[p.who] && fromList[p.who] !== p.id;
  });
  check('and it is their own, not the row above or below',
    mismatched.length === 0,
    mismatched.length ? mismatched.map((p) => p.who + ' shows ' + p.id).join('; ')
                      : 'each id matches the person it sits under');

  // THE PRESENCE DOT SITS WITH THE DESIGNATION, NOT THE NAME. These cards
  // are a quarter of the row wide and some of these names are four words:
  // a name that wraps leaves a dot that will not fit on the second line
  // taking a third line of its own, and one card in a column of eleven
  // stands taller than the rest for no reason anybody can see.
  const dots = await t.evaluate(() => ({
    inName: document.querySelectorAll('#teamChart .og-person strong .pres-dot').length,
    inTitle: document.querySelectorAll('#teamChart .og-person .og-title .pres-dot').length
  }));
  check('the presence dot sits beside the designation, not the name',
    dots.inName === 0 && dots.inTitle > 0,
    dots.inTitle + ' with the designation, ' + dots.inName + ' stuck to a name');

  // NOT CREAM. The person cards started as the directory's cream card
  // reused, and thirty-six of them on a navy chart read as thirty-six
  // sticky notes - the eye went to the paper rather than to the faces.
  // They are translucent panes cut out of the same dark now, which is a
  // decision about what this view IS and not a preference about colour.
  //
  // Read as a pair: a pane has no opaque background colour of its own and
  // paints a gradient; a card has the reverse. Either half alone would
  // pass against the other kind of card.
  // AN ORDINARY PERSON IN A COLUMN, named precisely. ".og-person" alone
  // matches the lead card first - it wears the same class and carries its
  // own background and its own white - so the first version of this
  // measured the one card the mutants did not touch and passed against
  // both of them.
  const pane = await t.evaluate(() => {
    const card = document.querySelector(
      '#teamChart .og-col .og-person:not(.is-head)');
    const name = card && card.querySelector('strong');
    if (!card || !name) return null;
    const c = getComputedStyle(card);
    const light = getComputedStyle(name).color;
    const rgb = (/rgba?\(([^)]+)\)/.exec(light) || [0, '0,0,0'])[1]
      .split(',').map(Number);
    return {
      fill: c.backgroundColor,
      gradient: /gradient/.test(c.backgroundImage),
      // The name has to be light, because the pane is dark.
      ink: Math.round((rgb[0] + rgb[1] + rgb[2]) / 3)
    };
  });
  check('the cards on the chart are dark panes, not cream cards',
    pane && pane.gradient === true &&
    /rgba\(0, 0, 0, 0\)|transparent/.test(pane.fill) && pane.ink > 200,
    pane ? 'fill ' + pane.fill + ', gradient ' + pane.gradient +
           ', name brightness ' + pane.ink : '(no card)');

  // Glass again: the section headings and module panels are translucent,
  // and over the white page below they are grey boxes.
  const ogSky = await t.evaluate(() => {
    const band = document.querySelector('.portal-sky');
    const tree = document.querySelector('#teamChart .og');
    if (!band || !tree) return null;
    return { bottom: Math.round(band.getBoundingClientRect().bottom),
             tree: Math.round(tree.getBoundingClientRect().bottom) };
  });
  check('the blue reaches the bottom of the chart, which is glass all the way',
    ogSky && ogSky.bottom >= ogSky.tree,
    ogSky ? 'band ' + ogSky.bottom + ', chart ' + ogSky.tree : '(not found)');

  await t.click('#teamViewList');
  await t.waitForTimeout(400);
  check('and pressing EAS Team brings the directory back',
    (await t.evaluate(() => !document.getElementById('teamBody').hidden &&
                            document.getElementById('teamChart').hidden)) === true,
    'the switch goes both ways');

  // ---- closed until pressed ----
  check('every section starts closed, so the page opens readable',
    (await visibleCards(t)) === 0 &&
    (await t.$$eval('.team-sec-open[aria-expanded="true"]', (n) => n.length)) === 0,
    'thirty-seven cards at once is a page you scroll rather than read');

  await t.click('.team-sec:nth-child(1) .team-sec-open');
  await t.waitForTimeout(400);

  const opened = await t.evaluate(() => {
    const sec = document.querySelectorAll('.team-sec')[0];
    return {
      expanded: sec.querySelector('.team-sec-open').getAttribute('aria-expanded'),
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
  check('and it lists the people under the head, who is on the card above',
    opened.cards.join(' | ') === 'Bilal Hossain',
    opened.cards.join(' | '));

  check('while the other sections stay shut',
    (await t.$$eval('.team-sec-open[aria-expanded="true"]', (n) => n.length)) === 1);

  // ONE AT A TIME, AND WHY IT IS NOT A PREFERENCE.
  //
  // Every open panel is placed in the same cell of the grid - full width,
  // second row - so two of them land on top of each other and the one drawn
  // last wins. The reported symptom was three sections showing an open
  // chevron above a single list of people: the other two were not hidden,
  // they were underneath.
  await t.click('.team-sec:nth-child(2) .team-sec-open');
  await t.waitForTimeout(400);

  const afterSecond = await t.evaluate(() => ({
    open: Array.from(document.querySelectorAll('.team-sec-open'))
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
  await t.click('.team-sec:nth-child(2) .team-sec-open');
  await t.waitForTimeout(400);
  check('and pressing the open one shuts it',
    (await t.$$eval('.team-sec-open[aria-expanded="true"]', (n) => n.length)) === 0 &&
    (await visibleCards(t)) === 0);

  await t.click('.team-sec:nth-child(1) .team-sec-open');
  await t.waitForTimeout(400);

  // ---- the contact details, which are the reason this page exists ----
  // .team-card OR .team-sec-card: the head's details moved onto the
  // section card when the duplicate went, and these lines are the same
  // lines wherever they are drawn.
  const utpal = await t.evaluate(() => {
    const card = Array.from(document.querySelectorAll('.team-card, .team-sec-card'))
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
  await t.click('.team-sec:nth-child(2) .team-sec-open');
  await t.waitForTimeout(400);
  const lineCounts = await t.evaluate(() => {
    const of = (name) => {
      const c = Array.from(document.querySelectorAll('.team-card, .team-sec-card'))
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
    headless.who === 'Utpal Biswas' && headless.role === 'Section Head',
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

  // ---------------------------------------------------------------------------
  // THE APPROVED POLICY, beside the heading of the table it defines
  // ---------------------------------------------------------------------------
  // It used to be a document CODE at the far right of the bar - "TVL-KPI-001
  // v1.0" - which is the one string on that screen that means nothing to
  // anybody who has not already read the document it names. None of this was
  // covered by anything, which is how it sat there unread.
  const doc = await sum.evaluate(() => {
    const a = document.getElementById('kpiPolicyDoc');
    const note = document.getElementById('kpiTableNote');
    const head = a ? a.closest('.card-head') : null;
    if (!a || !head) return null;
    const t = head.getBoundingClientRect(), r = a.getBoundingClientRect();
    return {
      hidden: a.hidden, href: a.getAttribute('href'),
      text: a.textContent.trim(), title: a.getAttribute('title') || '',
      note: note ? note.textContent.trim() : '',
      // Where it sits in the bar: beside the heading, or off at the end.
      fromLeft: Math.round(r.left - t.left), barWidth: Math.round(t.width),
      // A long title set in the head's uppercase wide tracking is
      // unreadable, so the button has to opt out of both.
      caps: getComputedStyle(a).textTransform,
      glyph: a.querySelectorAll('svg').length
    };
  });

  check('the policy document is named on the Summary thresholds bar',
    doc && !doc.hidden && /^https?:\/\//.test(doc.href || ''),
    doc ? (doc.hidden ? 'hidden' : doc.href) : '(no element)');

  // THE TITLE, not the reference. This is the whole point of the change.
  check('and it is named by its title, not by its document code',
    doc && doc.text === CONFIG.POLICY.title && !/TVL-KPI-\d/.test(doc.text),
    doc ? '"' + doc.text + '"' : '(none)');

  check('the code and the version are still on the hover, for anybody checking',
    doc && doc.title.indexOf(CONFIG.POLICY.id) !== -1 &&
    doc.title.indexOf('v' + CONFIG.POLICY.version) !== -1,
    doc ? doc.title : '(none)');

  check('the code has gone from the count at the end of the bar',
    doc && !/TVL-KPI-\d/.test(doc.note) && /indicators/.test(doc.note),
    doc ? doc.note : '(none)');

  // Beside the heading is where it was asked for. "Beside" is a measured
  // position in the rendered bar, not an order in the markup.
  check('it sits beside the heading rather than at the far end of the bar',
    doc && doc.fromLeft < doc.barWidth / 2,
    doc ? doc.fromLeft + 'px into a ' + doc.barWidth + 'px bar' : '(none)');

  check('it is not set in the heading uppercase, which a title cannot survive',
    doc && doc.caps === 'none' && doc.glyph === 1,
    doc ? doc.caps + ', ' + doc.glyph + ' glyph' : '(none)');

  // A DOCUMENT BUTTON THAT OPENS NOTHING is worse than no button: it is a
  // thing people press once and then stop trusting. The address is a cell
  // in KPI_CONFIG and a constant in Config, and on a fresh installation
  // both can be empty - so this is a real state and not a hypothetical.
  //
  // ?nopolicy=1 empties the address in the harness bootstrap. Reaching the
  // state from outside was the only option: the page's code is inside a
  // closure, so there is no render function to call again from a test. The
  // first version of this assertion tried, found no window.state, and
  // reported itself as a PASS with the word SKIP in the detail - which is
  // the kind of green that is worse than a red.
  await sum.close();
  const bare = await open('?view=settings&nopolicy=1');
  await bare.waitForTimeout(900);

  const off = await bare.evaluate(() => {
    const a = document.getElementById('kpiPolicyDoc');
    return a ? { hidden: a.hidden, href: a.getAttribute('href'),
                 text: a.textContent.trim() } : null;
  });

  check('with no address configured the button is not drawn at all',
    off && off.hidden === true && !off.href,
    off ? 'hidden=' + off.hidden + ' href=' + off.href + ' text="' +
          off.text + '"' : '(element missing)');

  check('and the table beside it is unaffected',
    (await bare.$$eval('#settingsTable tbody tr', (n) => n.length)) === 4,
    'the thresholds still list every indicator');

  await bare.close();

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
  // FOUR BUTTONS, TWO ROWS, ONE PAIR OF COLUMNS.
  //
  // These were two centred flex rows. Each sized itself to its own two
  // labels and centred the result, so because "Open the KPI Engine" and
  // "Open SAP UserHub" are not as wide as "Open RMG PA Report" and "Open
  // Groupware & ITSM", the gap down the middle stepped sideways between the
  // rows - four buttons that look placed by hand and not quite straight.
  //
  // Asserted on EDGES rather than on the CSS, because the edges are what
  // anybody looking at the hero can see. Left edges must agree down each
  // column and right edges likewise, which together also mean every button
  // is the same width.
  const grid = await hero.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.portal-hero-actions'))
      .filter((r) => !r.hidden && r.querySelector('.portal-cta'));
    return rows.map((r) => Array.from(r.querySelectorAll('.portal-cta')).map((b) => {
      const box = b.getBoundingClientRect();
      return { left: Math.round(box.left), right: Math.round(box.right) };
    }));
  });
  const columns = grid.length >= 2 && grid[0].length === 2 && grid[1].length === 2;
  check('the four hero buttons line up in two columns, row to row',
    columns &&
    grid[0][0].left === grid[1][0].left && grid[0][0].right === grid[1][0].right &&
    grid[0][1].left === grid[1][1].left && grid[0][1].right === grid[1][1].right,
    columns
      ? 'row 1 ' + grid[0].map((b) => b.left + '-' + b.right).join(', ') +
        ' | row 2 ' + grid[1].map((b) => b.left + '-' + b.right).join(', ')
      : grid.map((r) => r.length).join('+') + ' buttons, expected 2+2');

  check('so the gap between them is one straight line down the hero',
    columns && (grid[0][1].left - grid[0][0].right) ===
               (grid[1][1].left - grid[1][0].right),
    columns ? 'gutter ' + (grid[0][1].left - grid[0][0].right) + 'px over ' +
              (grid[1][1].left - grid[1][0].right) + 'px' : 'rows not paired');

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

    // NAMED, NOT DERIVED. Everything above reads its expectation out of
    // the same list the page was drawn from, which proves the page draws
    // the list and nothing about whether the list is right: drop a link
    // from Config.gs and both sides move together, in silence. These are
    // the ones somebody asked for, so these are written down.
    const ON = cards.map((c) => c.name + ' ' + c.href).join(' | ');
    const WANTED = [
      ['Microsoft Office account', 'myaccount.microsoft.com'],
      ['YO OneDrive / SharePoint', 'youngone0-my.sharepoint.com'],
      ['Microsoft Forms', 'forms.cloud.microsoft'],
      ['LinkedIn', 'linkedin.com']
    ];
    const absent = WANTED.filter(function (pair) {
      return cards.filter(function (c) {
        return c.name === pair[0] && (c.href || '').indexOf(pair[1]) !== -1;
      }).length === 0;
    });
    check('and the Microsoft tenancy and LinkedIn are among them',
      absent.length === 0,
      absent.length ? 'missing: ' + absent.map((p) => p[0]).join(', ') : ON.slice(-90));

    // IN THE ORDER THEY WERE ASKED FOR. Nothing sorts this list, so the
    // order in Config.gs is the order on the page - which makes an
    // accidental reshuffle invisible without this.
    const at = (name) => cards.map((c) => c.name).indexOf(name);
    check('in the order they were given, after the ones already there',
      at('Microsoft Office account') > at('Tekvision') &&
      at('YO OneDrive / SharePoint') === at('Microsoft Office account') + 1 &&
      at('Microsoft Forms') === at('YO OneDrive / SharePoint') + 1 &&
      at('LinkedIn') === at('Microsoft Forms') + 1,
      cards.map((c) => c.name).join(' > '));

    await q.close();
  }

  // ===========================================================================
  // THE FRONT PAGE FITS ON THE SCREEN
  // ===========================================================================
  // The hero and the five cards under it are one thought: the team, and the
  // four figures it is measured on. Half a thought is worse than none - the
  // cards ran about sixty pixels past the fold on a 1920x1080 monitor, so
  // the first thing anybody did on the front page was scroll it, and the
  // card that got cut was the one naming the three service layers.
  //
  // Checked at two heights, because the fix is in two places: the base
  // measurements carry the desktop, and a height media query carries the
  // laptop. One assertion at one size would pass with either half missing.
  for (const size of [{ width: 1920, height: 930, what: 'a 1080p monitor' },
                      { width: 1440, height: 860, what: 'a laptop' }]) {
    const fit = await open('', { width: size.width, height: size.height });
    const box = await fit.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll('.ptile'));
      if (!tiles.length) return null;
      return {
        bottom: Math.round(Math.max.apply(null,
          tiles.map((t) => t.getBoundingClientRect().bottom))),
        vh: window.innerHeight,
        tiles: tiles.length,
        // Every card drawn, not just the ones that happen to be above the
        // fold - a layout that fits by dropping a card is not a fix.
        drawn: tiles.filter((t) => t.getBoundingClientRect().height > 40).length
      };
    });
    check('the whole front page is on screen at ' + size.what,
      box && box.bottom <= box.vh && box.drawn === 5,
      box ? box.drawn + ' cards, ending at ' + box.bottom + ' of ' + box.vh +
            (box.bottom <= box.vh ? '' : ' - over by ' + (box.bottom - box.vh))
          : '(no cards)');
    await fit.close();
  }

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
