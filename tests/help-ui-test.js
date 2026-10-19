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
    badge === '3', badge + ', expected 3');

  const cards = await p.$$eval('#inboxList .thread', (ns) => ns.map((n) => ({
    unverified: n.classList.contains('is-unverified'),
    text: n.textContent
  })));
  check('every conversation is on the screen', cards.length === 4,
    cards.length + ' of 4');

  // -------------------------------------------------------------------------
  // a stack, not a wall
  // -------------------------------------------------------------------------
  // Every conversation used to be drawn out in full, one under another. With
  // two that reads as a page; with twenty it is a wall, and finding the one
  // somebody is waiting on means scrolling past everything already dealt with.
  check('nothing is opened until it is asked for',
    (await p.$$eval('#inboxList .thread-open:not([hidden])', (n) => n.length)) === 0,
    'three closed rows');
  const ayesha = cards.filter((c) => /Ayesha Rahman/.test(c.text))[0] || { text: '' };
  check('but a closed row still says who, what about, and the last thing said',
    /KPI 1/.test(ayesha.text) && /delayed ticket/.test(ayesha.text),
    'enough to triage without opening anything');

  await p.click('#inboxList .thread:nth-child(2) .thread-row');
  await p.waitForTimeout(350);
  check('clicking a row opens that conversation',
    (await p.$$eval('#inboxList .thread-open:not([hidden])', (n) => n.length)) === 1);
  check('and the reply box lands under the one you opened',
    await p.$eval('#inboxList .thread:nth-child(2) [data-reply]',
                  (el) => !el.closest('.thread-open').hidden));

  await p.click('#inboxList .thread:nth-child(3) .thread-row');
  await p.waitForTimeout(350);
  const openNow = await p.$$eval('#inboxList .thread.is-open',
    (ns) => ns.map((n) => n.getAttribute('data-thread')));
  check('opening another closes the first - one reply box at a time',
    openNow.length === 1, openNow.join(', ') + ' open');

  await p.click('#inboxList .thread:nth-child(3) .thread-row');
  await p.waitForTimeout(350);
  check('and clicking the open one closes it again',
    (await p.$$eval('#inboxList .thread.is-open', (n) => n.length)) === 0);

  // The bin sits inside the row and means something else entirely.
  await p.click('#inboxList .thread:nth-child(2) [data-del]');
  await p.waitForTimeout(400);
  check('the delete control does not count as opening the conversation',
    (await p.$$eval('#inboxList .thread.is-open', (n) => n.length)) === 0 &&
    await p.$eval('#modalBackdrop', (el) => !el.hidden),
    'it asks to delete instead');
  await p.$eval('#modalCancel, #modal button', (el) => el.click());
  await p.waitForTimeout(350);
  const waitingFlags = cards.map((c) => /WAITING/.test(c.text));
  check('the ones waiting on us are at the top',
    waitingFlags.indexOf(false) === -1 ||
    waitingFlags.slice(waitingFlags.indexOf(false)).every((w) => !w),
    waitingFlags.map((w) => (w ? 'waiting' : 'answered')).join(', '));

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
    'the label alone would be read as decoration - it is in the card, ready ' +
    'the moment the conversation is opened');
  check('and it says a reply will not reach them',
    /cannot see a reply/.test(first.text),
    'otherwise somebody types one and assumes it landed');
  check('a verified conversation carries no such warning',
    !cards.filter((c) => !c.unverified)
          .some((c) => /Do not reset/.test(c.text)),
    'a warning on everything is a warning on nothing');

  // replying
  await p.click('#inboxList .thread:not(.is-unverified) .thread-row');
  await p.waitForTimeout(350);
  const box = await p.$('#inboxList .thread:not(.is-unverified) textarea');
  check('each conversation has somewhere to reply, once opened', Boolean(box));
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
    check('and the conversation stays open across the redraw',
      (await p.$$eval('#inboxList .thread.is-open', (n) => n.length)) === 1,
      'having it snap shut would mean reopening it to read what you just wrote');
  }

  // -------------------------------------------------------------------------
  // who replied
  // -------------------------------------------------------------------------
  const inboxBylines = await p.$$eval('#inboxList .bubble-mine time',
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
  check('every conversation has a delete control for a MASTER',
    delButtons === 4, delButtons + ' of 4');
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

  // AND SAY YES. This suite only ever cancelled, so the success path was
  // never run once - and it called a toast() that did not exist. The server
  // deleted the conversation, the page threw "toast is not defined" before
  // reaching the refresh, and the row sat there under an error looking like a
  // delete that had failed.
  // The UNVERIFIED one, deliberately: it is the conversation this screen most
  // wants rid of, and deleting it leaves the verified ones that later
  // assertions here are about.
  const doomed = await p.$eval('#inboxList .thread.is-unverified',
                               (el) => el.getAttribute('data-thread'));
  await p.$eval('#inboxList .thread.is-unverified [data-del]', (el) => el.click());
  await p.waitForTimeout(400);
  await p.$eval('#modalGo, #modal .btn-danger, #modal button:last-of-type',
                (el) => el.click());
  await p.waitForTimeout(900);

  check('saying yes actually removes it from the screen',
    (await p.$$eval('#inboxList .thread', (ns) => ns.length)) === cardsBefore - 1,
    cardsBefore + ' -> ' +
    (await p.$$eval('#inboxList .thread', (ns) => ns.length)));
  check('and the one that went is the one that was asked about',
    !(await p.$$eval('#inboxList .thread',
      (ns) => ns.map((n) => n.getAttribute('data-thread')))).includes(doomed),
    doomed + ' is gone');
  check('with a word to say so, since the proof is an absence',
    await p.$eval('#noticeBox', (el) => !el.hidden) &&
    /deleted/i.test(await p.$eval('#noticeText', (el) => el.textContent)),
    await p.$eval('#noticeText', (el) => el.textContent));
  check('and no error banner anywhere near it',
    await p.$eval('#errorBox', (el) => el.hidden),
    await p.$eval('#errorText', (el) => el.textContent) || 'clean');

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

  // -------------------------------------------------------------------------
  // the panel is a stack too
  // -------------------------------------------------------------------------
  // It used to be a single endless thread - every question anybody ever asked,
  // in one run, with no way to tell where one ended and the next began.
  const queries = await p.$$eval('#msgrList .msgr-q', (ns) => ns.map((n) => ({
    text: n.textContent, unread: n.classList.contains('is-unread')
  })));
  check('the panel opens on a LIST of their queries, not one long thread',
    queries.length === 2, queries.length + ' queries');
  // Order-independent, and no assumption about WHO spoke last: this suite
  // replies into one of these queries earlier on, which changes that.
  const rowText = queries.map((q) => q.text).join(' | ');
  check('each row says what it is about',
    /Affiliate table/.test(rowText) && /September export/.test(rowText),
    rowText.slice(0, 90));
  check('and who spoke last on it',
    queries.every((q) => /^(You|.+\(\d{6,}\))/.test(
      (q.text.split(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)[1] || '').trim())),
    queries.map((q) =>
      (q.text.split(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)[1] || '').trim().slice(0, 30)
    ).join('  |  '));
  check('with a dot only on the one that has something unread',
    queries.filter((q) => q.unread).length === 1,
    queries.map((q) => (q.unread ? 'unread' : 'read')).join(', '));

  // Opening the PANEL is seeing a list, not reading it. Clearing every dot at
  // once would hide a reply nobody has looked at.
  check('and opening the panel does not mark everything read',
    await p.$eval('#msgrDot', (el) => !el.hidden),
    'a list of queries is not a read receipt for all of them');

  check('no conversation is shown until one is chosen',
    await p.$eval('#msgrOne', (el) => el.hidden));

  await p.click('#msgrList .msgr-q:nth-child(2)');
  await p.waitForTimeout(500);
  check('clicking a query opens that conversation',
    await p.$eval('#msgrOne', (el) => !el.hidden) &&
    await p.$eval('#msgrList', (el) => el.hidden));
  check('headed by its subject, with a way back',
    /September export/.test(await p.$eval('#msgrOneTitle', (el) => el.textContent)));
  check('and THAT is what clears the mark',
    await p.$eval('#msgrDot', (el) => el.hidden),
    'the one they opened, not the three they did not');
  check('the subject box goes, because a reply belongs to the subject above it',
    await p.$eval('#msgrSubjectWrap', (el) => el.hidden));

  await p.click('#msgrBack');
  await p.waitForTimeout(400);
  check('the back button returns to the list',
    await p.$eval('#msgrList', (el) => !el.hidden) &&
    await p.$eval('#msgrOne', (el) => el.hidden));
  check('and the subject box comes back with it, ready for a new query',
    await p.$eval('#msgrSubjectWrap', (el) => !el.hidden));

  await p.click('#msgrList .msgr-q:nth-child(2)');
  await p.waitForTimeout(500);

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
  const panelReply = await p.$eval('#msgrThread .bubble-theirs time',
                                   (el) => el.textContent);
  check('and the person who asked sees who answered them, in their own panel',
    /Pritam Saha \(20467174\)/.test(panelReply), panelReply.trim());

  // WHICH SIDE IS MINE DEPENDS ON WHO IS LOOKING. The same two messages are on
  // both screens and have to sit on OPPOSITE sides of each. One renderer
  // served both for a while, with the inbox's answer, so people watched their
  // own words arrive from the other side of their own screen.
  check('in their own panel, their message is theirs and sits on the right',
    thread.length === 2 &&
    /bubble-mine/.test(thread[0].side) && /bubble-theirs/.test(thread[1].side),
    thread.map((t) => t.side.replace('bubble ', '')).join(' then '));

  const inboxSides = await p.$$eval('#inboxList .thread:last-child .bubble',
    (ns) => ns.map((n) => (n.className.match(/bubble-\w+/) || [''])[0]));
  check('and on the team\'s screen the same exchange is the other way round',
    inboxSides.length >= 2 &&
    inboxSides[0] === 'bubble-theirs' && inboxSides[1] === 'bubble-mine',
    inboxSides.join(' then '));
  check('so nobody ever sees their own words coming in from the other side',
    thread[0].side.indexOf('bubble-mine') !== -1 &&
    inboxSides[0] === 'bubble-theirs',
    'same message, opposite sides, because "us" is a different person');
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
  // Two requests that pull against each other, so both are written down:
  // big enough to write a sentence in, and small enough that the conversation
  // is still the thing you are looking at. It was one line, then three; the
  // second ate a third of a short panel.
  const compose = await p.evaluate(() => {
    const box = document.getElementById('msgrText').getBoundingClientRect();
    const whole = document.querySelector('.msgr-compose').getBoundingClientRect();
    const panel = document.getElementById('msgrPanel').getBoundingClientRect();
    return { box: Math.round(box.height),
             share: Math.round(100 * whole.height / panel.height) };
  });
  check('the message box holds a couple of lines without being typed into',
    compose.box >= 44 && compose.box <= 80, compose.box + 'px tall');
  check('and the whole compose block stays a minority of the panel',
    compose.share <= 30, compose.share + '% of the panel');
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
  // an admin, who answers but does not erase
  // -------------------------------------------------------------------------
  await p.close();
  p = await open('?view=help&role=ADMIN');

  check('an admin still gets the inbox and can reply',
    (await p.$$eval('#inboxList .thread', (n) => n.length)) === 4 &&
    (await p.$$eval('#inboxList [data-reply-go]', (n) => n.length)) === 4,
    'answering queries is the job');
  check('but is offered no delete control at all',
    (await p.$$eval('#inboxList [data-del]', (n) => n.length)) === 0,
    'it destroys the conversation for the person who wrote it too');

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

  // -------------------------------------------------------------------------
  // signing in through the form
  // -------------------------------------------------------------------------
  // THE PATH EVERY OTHER TEST SKIPPED. They all arrive with a token already in
  // hand, which goes through onSession - and the message panel was loaded
  // from onSession only. Signing in through the FORM lands in startApp()
  // without passing back through it, so the panel kept the anonymous version
  // it had loaded before the sign-in: an employee ID box, no history, and
  // "you are not signed in" under a masthead naming the person.
  await p.close();
  p = await open('?signin=1');

  check('the sign-in card comes up when nobody is signed in',
    await p.$eval('#loginScreen', (el) => !el.hidden));
  check('and the panel is the anonymous one, correctly',
    await p.$eval('#msgrIdWrap', (el) => !el.hidden),
    'nobody is signed in yet, so it asks who this is');

  await p.fill('#loginUser', '20536723');
  await p.fill('#loginPass', 'whatever');
  await p.click('#loginGo');
  await p.waitForTimeout(2500);

  check('signing in opens the dashboard',
    await p.$eval('#appRoot', (el) => !el.hidden));
  check('AND the panel stops asking who they are',
    await p.$eval('#msgrIdWrap', (el) => el.hidden),
    'they just typed an employee ID to get in');
  check('and stops telling them they are not signed in',
    !/not signed in/.test(await p.$eval('#msgrNote', (el) => el.textContent)),
    'the masthead says their ID; the panel must not disagree with it');

  await p.click('#msgrBar');
  await p.waitForTimeout(700);
  check('and their queries are in it',
    (await p.$$eval('#msgrList .msgr-q', (n) => n.length)) > 0,
    (await p.$$eval('#msgrList .msgr-q', (n) => n.length)) + ' queries');

  await p.click('#msgrList .msgr-q');
  await p.waitForTimeout(500);
  check('and opening one shows the conversation',
    (await p.$$eval('#msgrThread .bubble', (n) => n.length)) > 0,
    (await p.$$eval('#msgrThread .bubble', (n) => n.length)) + ' messages');

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
