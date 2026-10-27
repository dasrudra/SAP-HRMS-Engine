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

  // The list Nasir sent, in his order. Asserted as a whole rather than by
  // counting, so a tab quietly dropped or reordered is caught by name.
  const WANTED = ['Home', 'About us', 'EAS Team', 'KPI Engine', 'Partners',
                  'Contact us', 'Learnings', 'Projects', 'Objective', 'Links'];
  check('all ten tabs are there, in the order they were given',
    JSON.stringify(tabs.map((t) => t.label)) === JSON.stringify(WANTED),
    tabs.map((t) => t.label).join(' | '));

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

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
