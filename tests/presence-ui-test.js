// The green dot and the Away button, in a real browser.
//
// The server half of this feature is covered by presence-test.js, which runs
// the real Presence.gs against a fake cache and a clock it can wind. This
// suite is about the other half, and the two do not overlap: the harness
// behind this page answers presenceTick and getPresence out of a fixture, so
// nothing here proves anything about how a state is DECIDED, only about what
// the page does with one.
//
// WHAT IT IS REALLY GUARDING
//
//   the repaint does not close an open section
//                     The dots refresh every sixty seconds. The cheap way to
//                     write that is to call renderTeam() again, which would
//                     shut whichever section the person was reading - once a
//                     minute, forever. The paint walks [data-pres] instead,
//                     and this suite is the only thing that would notice if
//                     somebody simplified it back.
//
//   the beat runs for everybody
//                     The obvious place to hang a heartbeat is the existing
//                     badge poll, which returns early unless canAdmin(). A
//                     beat riding on it would leave every viewer in the team
//                     permanently grey, and would look perfect to whoever
//                     built it, because they are an admin.
//
//   both bars agree   The dot is drawn in the portal bar and the dashboard
//                     bar. They are never on screen together, which is
//                     exactly why they would be allowed to disagree
//                     unnoticed.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/presence-ui-test.js
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

  // The state of a dot, as the page has it. Returned as the attribute rather
  // than as a colour: reading the computed box-shadow would be testing the
  // stylesheet, and the stylesheet is not where this can go wrong.
  const dotState = (p, id) =>
    p.$eval('#' + id, (n) => n.getAttribute('data-state'));

  const button = (p, id) => p.$eval('#' + id, (n) => ({
    text: n.textContent.trim(),
    pressed: n.getAttribute('aria-pressed'),
    hidden: n.hidden
  }));

  // ---------------------------------------------------------------------------
  // before anybody is signed in
  // ---------------------------------------------------------------------------
  // A dot beside a name that is still an em dash would be claiming something
  // about nobody, and the Away button would have nothing to toggle.
  {
    const p = await open('?signin=1');
    const hidden = await p.evaluate(() =>
      ['presDot', 'portalPresDot', 'awayBtn', 'portalAway']
        .map((id) => document.getElementById(id))
        .every((n) => n && n.hidden));
    check('the dots and both Away buttons are hidden until somebody signs in',
      hidden === true,
      'they travel with Sign out, which is hidden here too');
    await p.close();
  }

  // ---------------------------------------------------------------------------
  // signing in makes you active
  // ---------------------------------------------------------------------------
  const p = await open();

  check('signing in shows the portal dot, glowing green',
    (await dotState(p, 'portalPresDot')) === 'ACTIVE' &&
    (await p.$eval('#portalPresDot', (n) => !n.hidden)) === true,
    await dotState(p, 'portalPresDot'));

  check('and the dashboard dot says the same thing',
    (await dotState(p, 'presDot')) === 'ACTIVE',
    'both bars, one value - they are never on screen together');

  let bt = await button(p, 'portalAway');
  check('the button offers Away, because you are not away yet',
    bt.text === 'Away' && bt.pressed === 'false' && bt.hidden === false,
    bt.text + ', aria-pressed=' + bt.pressed);

  check('and the server was actually told, not just the page',
    (await p.evaluate(() => (window.__calls || {}).presenceTick || 0)) >= 1,
    (await p.evaluate(() => (window.__calls || {}).presenceTick || 0)) + ' beat(s)');

  // ---------------------------------------------------------------------------
  // pressing Away
  // ---------------------------------------------------------------------------
  await p.click('#portalAway');
  await p.waitForTimeout(500);

  check('pressing Away turns both dots amber',
    (await dotState(p, 'portalPresDot')) === 'AWAY' &&
    (await dotState(p, 'presDot')) === 'AWAY',
    'portal ' + (await dotState(p, 'portalPresDot')) +
      ', dashboard ' + (await dotState(p, 'presDot')));

  bt = await button(p, 'portalAway');
  check('and the button now offers Back, which is what pressing it would do',
    bt.text === 'Back' && bt.pressed === 'true',
    bt.text + ', aria-pressed=' + bt.pressed);

  const dash = await button(p, 'awayBtn');
  check('the dashboard button followed it without being pressed',
    dash.text === 'Back' && dash.pressed === 'true',
    dash.text + ' - one toggle behind both buttons');

  // THE STATE REACHED THE SERVER, not just the attribute. A toggle that
  // painted itself and told nobody is the most likely way for this to be
  // broken while looking entirely correct.
  check('the away state was sent to the server',
    (await p.evaluate(() => (window.__calls || {}).presenceTick || 0)) >= 2,
    'beats so far: ' +
      (await p.evaluate(() => (window.__calls || {}).presenceTick || 0)));

  await p.click('#portalAway');
  await p.waitForTimeout(500);

  check('pressing Back goes green again',
    (await dotState(p, 'portalPresDot')) === 'ACTIVE' &&
    (await button(p, 'portalAway')).text === 'Away',
    await dotState(p, 'portalPresDot'));

  // ---------------------------------------------------------------------------
  // pressing Away while a beat is already in the air
  // ---------------------------------------------------------------------------
  // The beat goes out every three minutes and takes a moment to come back.
  // Press Away inside that moment and the reply - which says ACTIVE, because
  // that was true when it was sent - lands afterwards. Without a guard it
  // repaints the dot green and the press looks like it did nothing, roughly
  // once in every few hundred presses.
  //
  // __slowNext holds the next dispatch open, which is the only way to put a
  // call in that state on purpose.
  {
    await p.evaluate(() => { window.__slowNext = 1500; window.__easBeatNow(); });
    await p.waitForTimeout(150);          // the slow beat is now in the air

    await p.click('#portalAway');         // and this one overtakes it
    await p.waitForTimeout(300);

    check('(mid-flight) the press paints immediately',
      (await dotState(p, 'portalPresDot')) === 'AWAY',
      await dotState(p, 'portalPresDot'));

    await p.waitForTimeout(1800);         // the overtaken reply lands here

    check('an overtaken reply does not undo the press',
      (await dotState(p, 'portalPresDot')) === 'AWAY' &&
      (await button(p, 'portalAway')).text === 'Back',
      'dot ' + (await dotState(p, 'portalPresDot')) +
        ', button ' + (await button(p, 'portalAway')).text);

    await p.click('#portalAway');         // back to active for what follows
    await p.waitForTimeout(500);
  }

  // ---------------------------------------------------------------------------
  // the directory
  // ---------------------------------------------------------------------------
  await p.click('.portal-tab[data-view="team"]');
  await p.waitForTimeout(900);

  // The fixture has all three states on it plus one person with no cache
  // entry at all, which is what the server really returns for somebody who
  // has never signed in.
  const states = await p.evaluate(() => {
    const got = {};
    document.querySelectorAll('#teamBody [data-pres]').forEach(function (n) {
      got[n.getAttribute('data-pres')] = n.getAttribute('data-state');
    });
    return got;
  });

  check('every person on the directory carries a dot',
    Object.keys(states).length >= 5,
    Object.keys(states).length + ' dots: ' + JSON.stringify(states));

  check('Carim, who pressed Away, is amber rather than green',
    states['20000002'] === 'AWAY',
    'he reads ' + states['20000002']);

  check('Bilal, who is not signed in, is grey',
    states['20000003'] === 'OFFLINE',
    'he reads ' + states['20000003']);

  check('and somebody the server returned no entry for at all is grey too',
    states['20000004'] === 'OFFLINE',
    'a missing key is not the string OFFLINE, and must not read as ACTIVE');

  check('the signed-in person is green on their own card',
    states['20000000'] === 'ACTIVE',
    'me, as the department head in the fixture: ' + states['20000000']);

  // ---------------------------------------------------------------------------
  // the repaint does not close what you were reading
  // ---------------------------------------------------------------------------
  // The one that matters. Open a section, force a repaint, and the section
  // has to still be open - a dot refresh is not a re-render.
  await p.click('.team-sec[data-section="1"] .team-sec-card');
  await p.waitForTimeout(500);

  const openedBefore = await p.$eval('#teamSecBody1', (n) => !n.hidden);

  await p.evaluate(() => window.__easRefreshPresence());
  await p.waitForTimeout(600);

  check('a dot refresh leaves the open section open',
    openedBefore === true &&
    (await p.$eval('#teamSecBody1', (n) => !n.hidden)) === true,
    'was open: ' + openedBefore + ', still open: ' +
      (await p.$eval('#teamSecBody1', (n) => !n.hidden)));

  // And it really did repaint, rather than doing nothing at all - otherwise
  // the assertion above would pass for the wrong reason.
  check('and the refresh really happened',
    (await p.evaluate(() => (window.__calls || {}).getPresence || 0)) >= 2,
    (await p.evaluate(() => (window.__calls || {}).getPresence || 0)) +
      ' calls to getPresence');

  // ---------------------------------------------------------------------------
  // pressing Away while looking at your own card
  // ---------------------------------------------------------------------------
  // The one dot the person is certain to be watching is their own, so it may
  // not wait for the next poll.
  await p.click('#portalAway');
  await p.waitForTimeout(700);

  check('pressing Away updates my own card in the directory at once',
    (await p.evaluate(() => {
      const n = document.querySelector('#teamBody [data-pres="20000000"]');
      return n && n.getAttribute('data-state');
    })) === 'AWAY',
    'not left green until the next sixty-second poll');

  await p.click('#portalAway');
  await p.waitForTimeout(400);
  await p.close();

  // ---------------------------------------------------------------------------
  // the beat runs for people who are not admins
  // ---------------------------------------------------------------------------
  // The trap this feature was most likely to fall into. The badge poll next
  // door returns early unless canAdmin(), so a beat hung on it would have
  // worked perfectly for whoever built it and left everybody else grey.
  {
    const viewer = await open('?role=USER');
    check('a USER beats too, so a viewer is not permanently offline',
      (await viewer.evaluate(() => (window.__calls || {}).presenceTick || 0)) >= 1,
      (await viewer.evaluate(() => (window.__calls || {}).presenceTick || 0)) +
        ' beat(s) as a plain USER');

    check('and a USER gets a working Away button',
      (await viewer.$eval('#portalAway', (n) => !n.hidden)) === true,
      'presence is not an admin feature');
    await viewer.close();
  }

  // ---------------------------------------------------------------------------
  // the paint poll only runs where there is something to paint
  // ---------------------------------------------------------------------------
  {
    const q = await open();
    const before = await q.evaluate(() => (window.__calls || {}).getPresence || 0);
    check('sitting on Home does not poll for everybody else\'s dots',
      before === 0,
      before + ' calls to getPresence before the team page was opened');

    await q.click('.portal-tab[data-view="team"]');
    await q.waitForTimeout(900);
    const onTeam = await q.evaluate(() => (window.__calls || {}).getPresence || 0);

    await q.click('.portal-tab[data-view="home"]');
    await q.waitForTimeout(900);

    check('opening the team page starts the poll, and leaving it stops it',
      onTeam >= 1 &&
      (await q.evaluate(() => window.__easPresencePolling())) === false,
      onTeam + ' call(s) while open; still polling after leaving: ' +
        (await q.evaluate(() => window.__easPresencePolling())));
    await q.close();
  }

  // ---------------------------------------------------------------------------
  // signing out
  // ---------------------------------------------------------------------------
  {
    const s = await open();
    await s.click('#portalSignOut');
    await s.waitForTimeout(900);

    check('signing out tells the server to take the dot off the page',
      (await s.evaluate(() => (window.__calls || {}).presenceClear || 0)) >= 1,
      'otherwise the person stays green for eight minutes after leaving');

    check('and the beat stops rather than carrying on without a session',
      (await s.evaluate(() => window.__easPresenceBeating())) === false,
      'a stopped beat is also one that cannot print a session-ended dialog');
    await s.close();
  }

  // ---------------------------------------------------------------------------
  // you cannot stay green overnight by leaving the tab open
  // ---------------------------------------------------------------------------
  // The beat is a server call every three minutes, and the obvious hazard is
  // that it reads as somebody working - which would quietly disable the
  // hour-idle sign-out this app has always had, and leave a row of green dots
  // on an empty office. It does not, because the idle clock is moved by mouse
  // and keyboard events and nothing else; this is that property, held down.
  {
    const idle = await open();
    check('(before) the beat is running',
      (await idle.evaluate(() => window.__easPresenceBeating())) === true);

    // An hour of nothing, without waiting an hour. The handle ages the clock
    // backwards, so the code that runs is the real code.
    await idle.evaluate(() => {
      window.__setIdleAge(2 * 60 * 60 * 1000);
      window.__checkIdleNow();
    });
    await idle.waitForTimeout(700);

    check('an hour idle ends the session and stops the beat with it',
      (await idle.evaluate(() => window.__easPresenceBeating())) === false,
      'otherwise a tab left open all night keeps somebody green in an empty office');
    await idle.close();
  }

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
