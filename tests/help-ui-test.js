// The message bar and the team's inbox, driven in a real browser.
//
// Two screens share one set of data, and almost everything worth asserting is
// about who sees which half of it:
//
//   1. WHAT SOMEBODY TYPES IS SHOWN AS TEXT. A message containing
//      <img src=x onerror=...> must reach the inbox as characters, not markup.
//      The inbox is read by the account that can delete things, and the sender
//      is whoever found a public URL.
//
//   2. THE UNVERIFIED WARNING HAS TO BE ON THE CARD. A conversation from the
//      sign-in page proves nothing about who sent it. The moment that matters
//      is the moment somebody is reading a convincing request for a password
//      reset, so the warning has to be in front of them then - not only in an
//      email they read an hour ago.
//
//   3. A VIEWER HAS NO HELP SCREEN AT ALL, only the bar.
//
//   4. THE BAR WORKS ON THE SIGN-IN PAGE, which is a full-screen overlay. It
//      is the screen the bar exists for, and being invisible there would be a
//      perfectly tidy failure.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/help-ui-test.js
//
// Needs playwright-core and a Chromium. Skips, loudly and successfully, when
// they are not installed.
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
    const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
      // The stale-deployment probes at the end ask for functions that are not
      // there ON PURPOSE - that is the condition being tested. Scoped to those
      // two names so a genuinely missing stub anywhere else still fails.
      if (/no stub for google\.script\.run\.(myQuestions|listThreads)\b/.test(m.text())) return;
      errors.push('console: ' + m.text());
    });
    await p.goto(FILE + (query || ''));
    await p.waitForTimeout(1800);
    return p;
  };

  // -------------------------------------------------------------------------
  // the team's inbox
  // -------------------------------------------------------------------------
  let p = await open('?view=help');

  check('an admin lands on the Help screen',
    await p.$eval('#view-help', (el) => !el.hidden));

  const badge = await p.$eval('#helpBadge', (el) => el.textContent.trim());
  check('the nav badge counts conversations waiting on a reply',
    badge === '2', badge + ', expected 2');

  const cards = await p.$$eval('#inboxList .thread', (ns) => ns.map((n) => ({
    unverified: n.classList.contains('is-unverified'),
    text: n.textContent
  })));
  check('every conversation is on the screen', cards.length === 3,
    cards.length + ' of 3');
  check('the ones waiting on us are at the top',
    /WAITING/.test(cards[0].text) && /WAITING/.test(cards[1].text) &&
    !/WAITING/.test(cards[2].text),
    'an inbox sorted by nothing is a list');

  // Defaulted rather than indexed straight, so that a regression which loses
  // the marker reports ONE failure and lets the rest of the suite run. The
  // first version crashed here, which hid every assertion after it - exactly
  // when you most want to know what else broke.
  check('the card is headed "Queries by name"',
    /Queries by name/i.test(await p.$eval('#view-help', (el) => el.textContent)));
  check('and no conversation wears a "signed in" badge',
    (await p.$$eval('.thread-ok', (ns) => ns.length)) === 0,
    'a label on every card is furniture; only the unverified one earns one');

  check('a conversation is headed by the name, with the ID in brackets',
    /Rudra \(20536723\)/.test(cards.map((c) => c.text).join(' ')) &&
    /Ayesha Rahman \(20000042\)/.test(cards.map((c) => c.text).join(' ')),
    'the name is what to call somebody; the ID is the half that means anything');

  const flagged = cards.filter((c) => c.unverified);
  const first = flagged[0] || { text: '' };
  check('the sign-in-page conversation is marked on the card itself',
    flagged.length === 1 && /NOT VERIFIED/.test(first.text),
    flagged.length + ' flagged');
  check('with the warning spelled out, not just a label',
    /Do not reset a password/.test(first.text) &&
    /only what the sender typed/.test(first.text),
    'the label alone would be read as decoration');
  check('and it says a reply will not reach them',
    /cannot see a reply/.test(first.text),
    'otherwise somebody types one and assumes it landed');
  check('a verified conversation carries no such warning',
    !cards.filter((c) => !c.unverified)
          .some((c) => /Do not reset/.test(c.text)),
    'a warning on everything is a warning on nothing');

  // replying
  const box = await p.$('#inboxList .thread:not(.is-unverified) textarea');
  check('each conversation has somewhere to reply', Boolean(box));
  if (box) {
    const REPLY = 'Fixed - it was filed under <Sales> & re-run.' +
                  '<img src=y onerror="window.__owned2=1">';
    await box.fill(REPLY);
    // Named, not "the first button in the card" - the delete control sits in
    // the header and comes first in the DOM, so the loose selector started
    // clicking that instead the moment it was added.
    await p.click('#inboxList .thread:not(.is-unverified) [data-reply-go]');
    await p.waitForTimeout(700);
    const after = await p.$eval('#inboxList', (el) => el.textContent);
    check('replying adds it to the conversation without a reload',
      /filed under <Sales> & re-run/.test(after), 'and it reads as typed');
    check('and an admin\'s own words are escaped too',
      (await p.evaluate(() => window.__owned2 === 1)) === false &&
      (await p.$eval('#inboxList', (el) => el.innerHTML)).indexOf('<img src=y') === -1,
      'the person who typed it is not the person who would pay');
    const now = await p.$eval('#helpBadge', (el) => el.textContent.trim());
    check('and the waiting badge comes DOWN by one',
      Number(now) === Number(badge) - 1, badge + ' -> ' + (now || '(empty)'));
  }

  // -------------------------------------------------------------------------
  // who replied
  // -------------------------------------------------------------------------
  const inboxBylines = await p.$$eval('#inboxList .bubble-team time',
                                      (ns) => ns.map((n) => n.textContent.trim()));
  check('every reply says who wrote it, on the team\'s own screen',
    inboxBylines.length > 0 &&
    inboxBylines.every((t) => /\(\d{6,}\) \u00b7 /.test(t)),
    inboxBylines.join(' | '));
  check('including the one just sent, by whoever is signed in',
    inboxBylines.some((t) => /Rudra Das \(20000000\)/.test(t)),
    'so the next admin can see it is already in hand');
  check('and an older one still names the colleague who answered it',
    inboxBylines.some((t) => /Pritam Saha \(20467174\)/.test(t)),
    'the name is stamped when the reply is written, not looked up later');

  // -------------------------------------------------------------------------
  // deleting a conversation
  // -------------------------------------------------------------------------
  const delButtons = await p.$$eval('[data-del]', (ns) => ns.length);
  check('every conversation has a delete control', delButtons === 3,
    delButtons + ' of 3');
  check('which is quiet until the card is wanted',
    await p.$eval('[data-del]', (el) => Number(getComputedStyle(el).opacity) === 0),
    'the one control here that destroys something should not lead the eye');

  const cardsBefore = await p.$$eval('#inboxList .thread', (ns) => ns.length);
  await p.$eval('[data-del]', (el) => el.click());
  await p.waitForTimeout(400);

  check('it asks before deleting anything',
    await p.$eval('#modalBackdrop', (el) => !el.hidden),
    'there is nothing to undo it with');
  const asked = await p.$eval('#modal', (el) => el.textContent);
  check('and names who the conversation is with',
    /Rudra \(20536723\)/.test(asked), 'so you can see what you are about to lose');
  check('and says it goes from their panel too',
    /cannot be brought back/.test(asked) && /their message panel/.test(asked),
    'deleting it takes away what they were told, not just your copy');

  // Say no, and nothing happens.
  await p.$eval('#modalCancel, #modal button', (el) => el.click());
  await p.waitForTimeout(400);
  check('saying no leaves it alone',
    (await p.$$eval('#inboxList .thread', (ns) => ns.length)) === cardsBefore,
    cardsBefore + ' conversations still there');

  // -------------------------------------------------------------------------
  // THE ONE THAT MATTERS: a message is data, not markup
  // -------------------------------------------------------------------------
  check('the stranger\'s message is shown literally, angle brackets and all',
    first.text.indexOf('locked out') !== -1 &&
    (await p.$eval('#inboxList', (el) => el.innerHTML)).indexOf('&lt;') !== -1,
    'escaped on the way in, not stripped');

  // -------------------------------------------------------------------------
  // the message bar, signed in
  // -------------------------------------------------------------------------
  check('the bar is on the screen', await p.$eval('#msgr', (el) => !el.hidden));
  check('with an unread mark, because the team replied last',
    await p.$eval('#msgrDot', (el) => !el.hidden),
    'the fixture leaves one reply unread');
  check('and the panel starts closed',
    await p.$eval('#msgrPanel', (el) => el.hidden));

  await p.click('#msgrBar');
  await p.waitForTimeout(500);
  check('clicking the bar opens it',
    await p.$eval('#msgrPanel', (el) => !el.hidden));
  check('and opening it is reading it - the mark clears',
    await p.$eval('#msgrDot', (el) => el.hidden),
    'nobody wants to dismiss a badge twice');

  const docked = await p.evaluate(() => {
    const r = document.getElementById('msgrPanel').getBoundingClientRect();
    return { bottom: Math.round(r.bottom), right: Math.round(r.right),
             vh: window.innerHeight, vw: window.innerWidth };
  });
  check('the panel is docked to the bottom corner, not floating mid-screen',
    docked.bottom === docked.vh && docked.vw - docked.right < 40,
    JSON.stringify(docked));

  const thread = await p.$$eval('#msgrThread .bubble', (ns) => ns.map((n) => ({
    side: n.className, text: n.textContent
  })));
  const panelReply = await p.$eval('#msgrThread .bubble-team time',
                                   (el) => el.textContent);
  check('and the person who asked sees who answered them, in their own panel',
    /Pritam Saha \(20467174\)/.test(panelReply), panelReply.trim());

  check('their own conversation is in it, both sides',
    thread.length === 2 &&
    /bubble-user/.test(thread[0].side) && /bubble-team/.test(thread[1].side),
    thread.map((t) => t.side.replace('bubble ', '')).join(' then '));
  check('the FAQ is in the panel too, so a viewer still has it',
    (await p.$$eval('#msgrFaq details', (ns) => ns.length)) === 2,
    'they have no Help screen to read it on');
  check('and no employee ID field, because the server takes it from the token',
    await p.$eval('#msgrIdWrap', (el) => el.hidden),
    'a field for it would be a field to put somebody else in');

  // THE ONE THAT WAS WRONG ON THE LIVE SITE. The panel used to load from
  // DOMContentLoaded, which runs before the token has been read - loadToken is
  // asynchronous - so messengerBoot arrived with an empty token and everybody
  // signed in got the signed-OUT panel: asked for an employee ID they had
  // already typed to get in, under a masthead saying they were signed in.
  check('a signed-in person is not asked to prove who they are all over again',
    await p.$eval('#msgrIdWrap', (el) => el.hidden) &&
    await p.$eval('#msgrNote', (el) => !/not signed in/.test(el.textContent)),
    'the panel must load after the token, not beside it');

  check('the name box arrives already filled in',
    (await p.$eval('#msgrName', (el) => el.value)) === 'Rudra Das',
    'asked once, not every time');
  check('and the message box is big enough to write in',
    await p.$eval('#msgrText', (el) => el.getBoundingClientRect().height >= 60),
    await p.$eval('#msgrText', (el) =>
      Math.round(el.getBoundingClientRect().height) + 'px tall'));
  check('with nothing above it but the conversation',
    (await p.$eval('#msgrThread', (el) => el.textContent.trim()))
      .indexOf('Locked out') === -1,
    'the standing explanation is gone');

  await p.fill('#msgrText', 'One more thing - can I get October as well?');
  await p.click('#msgrSend');
  await p.waitForTimeout(700);
  const grown = await p.$$eval('#msgrThread .bubble', (ns) => ns.length);
  check('sending appends to the conversation without a reload',
    grown === 3, thread.length + ' -> ' + grown);
  check('and empties the box, so it is not sent twice',
    (await p.$eval('#msgrText', (el) => el.value)) === '');

  await p.click('#msgrClose');
  await p.waitForTimeout(300);
  check('the chevron closes it again',
    await p.$eval('#msgrPanel', (el) => el.hidden));

  // -------------------------------------------------------------------------
  // a viewer
  // -------------------------------------------------------------------------
  await p.close();
  p = await open('?view=kpi1&role=USER');

  check('a viewer has no Help & FAQ nav item at all',
    await p.$eval('[data-view="help"]', (el) => el.hidden),
    'that screen is the team\'s inbox now');
  check('but they do have the message bar',
    await p.$eval('#msgr', (el) => !el.hidden));

  await p.close();
  p = await open('?view=help&role=USER');
  check('and a bookmarked ?view=help sends them to the dashboard instead',
    await p.$eval('#view-help', (el) => el.hidden) &&
    await p.$eval('#view-kpi1', (el) => !el.hidden),
    'not a screen with one empty card and no explanation');

  // -------------------------------------------------------------------------
  // the sign-in page
  // -------------------------------------------------------------------------
  await p.close();
  p = await open('?signedout=1');

  // Put the real sign-in overlay up, the way doGet does for somebody with no
  // token. It is position:fixed over the whole viewport at z-index 200.
  await p.evaluate(() => {
    document.getElementById('loginScreen').hidden = false;
    document.getElementById('appRoot').hidden = true;
  });
  await p.waitForTimeout(300);

  const hit = await p.evaluate(() => {
    const bar = document.getElementById('msgrBar');
    const r = bar.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { reachable: bar === top || bar.contains(top),
             instead: top ? (top.id || top.className) : 'nothing' };
  });
  check('the bar is clickable over the sign-in overlay, not buried under it',
    hit.reachable === true,
    hit.reachable ? 'z-index 300 beats the overlay at 200'
                  : 'the click lands on ' + hit.instead);

  await p.click('#msgrBar');
  await p.waitForTimeout(400);
  check('signed out, the panel asks for an employee ID as well as a name',
    await p.$eval('#msgrIdWrap', (el) => !el.hidden) &&
    await p.$eval('#msgrName', (el) => !el.closest('label').hidden),
    'without a session there is no ID to take, and the team needs one');
  check('and nothing stands there explaining itself before anybody has typed',
    (await p.$eval('#msgrNote', (el) => el.textContent.trim())) === '',
    'a permanent explanation becomes part of the furniture');
  check('with no conversation shown, because there is nobody to have one with',
    (await p.$$eval('#msgrThread .bubble', (ns) => ns.length)) === 0);
  check('the FAQ is still there though',
    (await p.$$eval('#msgrFaq details', (ns) => ns.length)) === 2,
    'most people locked out are asking something already answered');

  await p.fill('#msgrText', 'I cannot sign in, my password stopped working.');
  await p.click('#msgrSend');
  await p.waitForTimeout(600);
  check('sending with no employee ID is refused, and says why',
    /employee ID/.test(await p.$eval('#msgrNote', (el) => el.textContent)),
    await p.$eval('#msgrNote', (el) => el.textContent.slice(0, 50)));

  await p.fill('#msgrId', '20536723');
  await p.click('#msgrSend');
  await p.waitForTimeout(600);
  const note = await p.$eval('#msgrNote', (el) => el.textContent);
  check('with one, it goes',
    /Sent to the EAS team/.test(note), note.slice(0, 48));
  // The standing note was removed, so this is now the ONLY place the person is
  // told a reply cannot come back here. It has to carry that weight, and this
  // is the better moment for it anyway: after they have sent something, rather
  // than before they have decided to.
  check('and that is where they are told a reply cannot come back here',
    /cannot come back to this box/.test(note) && /contact you directly/.test(note),
    'the one thing they must not do is sit and wait on this box');

  // -------------------------------------------------------------------------
  // a project whose files are from different versions
  // -------------------------------------------------------------------------
  // This is what a half-finished paste looks like from the page: the HTML asks
  // for a server function the deployed .gs files do not have. It used to
  // surface as "Cannot read properties of undefined (reading 'apply')", which
  // names nothing and suggests nothing. The person reading it has no way to
  // know a paste was missed.
  const stale = await p.evaluate(() => new Promise((done) => {
    const runner = google.script.run
      .withSuccessHandler(() => done('resolved, which it must not'))
      .withFailureHandler((e) => done(String(e && e.message || e)));
    // The old App.html called this; the new server does not have it.
    if (typeof runner.myQuestions !== 'function') {
      done('UNDEFINED:' + String(runner.myQuestions));
      return;
    }
    runner.myQuestions('token');
  }));
  check('a call to a function the deployed script lacks is undefined, as in production',
    /^UNDEFINED:undefined$/.test(stale), stale);

  const said = await p.evaluate(() => {
    try {
      const runner = google.script.run.withSuccessHandler(function () {});
      runner.myQuestions.apply(runner, ['t']);
      return 'no error';
    } catch (e) { return String(e.message || e); }
  });
  check('and calling it raw gives the unhelpful message the guard exists to replace',
    /Cannot read properties of undefined/.test(said), said.slice(0, 60));

  // And the whole way through: a real screen, a real call, the real banner.
  await p.close();
  p = await open('?view=help&drop=listThreads');
  const banner = await p.$eval('body', (el) => el.textContent);
  check('the error a person actually sees names the missing function',
    /listThreads/.test(banner), 'not "undefined (reading \'apply\')"');
  check('and tells them it is a half-pasted project, and what to do',
    /different versions/.test(banner) && /New version/.test(banner),
    banner.replace(/\s+/g, ' ').match(/This page asked[^.]*\.[^.]*\./) ?
      banner.replace(/\s+/g, ' ').match(/This page asked[^.]*\./)[0].slice(0, 90) : 'not found');

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
