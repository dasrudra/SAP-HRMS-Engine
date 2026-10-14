// The Help & FAQ screen, driven in a real browser.
//
// This is the first screen in the dashboard that shows one person's typed words
// to another person. Everything else on it renders numbers that came out of a
// spreadsheet; this renders a sentence somebody wrote. So the assertions below
// care about two things above all:
//
//   1. WHAT SOMEBODY TYPES IS SHOWN AS TEXT. If a question containing
//      <img src=x onerror=...> reaches an admin's inbox as markup, the person
//      who asked it runs code in the browser of the person with every
//      permission on the system. A question is data. It gets escaped.
//
//   2. A VIEWER DOES NOT GET THE INBOX. Hiding it is a courtesy - the server
//      guards the endpoints, which questions-test.js covers - but the courtesy
//      has to work, or a viewer sees a box that errors when they use it.
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

  // -------------------------------------------------------------------------
  // getting there
  // -------------------------------------------------------------------------
  let p = await open('?view=help');

  check('the Help screen is reachable and visible',
    await p.$eval('#view-help', (el) => el.classList.contains('is-on') ||
                                        getComputedStyle(el).display !== 'none'));

  const badge = await p.$eval('#helpBadge', (el) => el.textContent.trim());
  check('the nav badge shows how many questions are waiting', badge === '1', badge);

  // -------------------------------------------------------------------------
  // the FAQ
  // -------------------------------------------------------------------------
  const faq = await p.$$eval('#faqList details', (ds) => ds.map((d) => ({
    open: d.open,
    q: (d.querySelector('summary') || {}).textContent || '',
    a: d.textContent
  })));
  check('every seeded FAQ entry is on the screen', faq.length === 2,
    faq.length + ' entries');
  check('and they start closed, so the screen is a list and not a wall',
    faq.every((f) => !f.open));
  check('the question is the part you see first',
    /How do I sign in/.test(faq[0].q), faq[0].q.trim().slice(0, 40));

  await p.click('#faqList details:first-child summary');
  await p.waitForTimeout(150);
  const afterClick = await p.$$eval('#faqList details', (ds) => ds.map((d) => d.open));
  check('clicking one opens it', afterClick[0] === true);
  check('and leaves the others alone', afterClick[1] === false,
    'an accordion that closes your place is worse than no accordion');

  // -------------------------------------------------------------------------
  // asking
  // -------------------------------------------------------------------------
  const note = () => p.$eval('#askNote', (el) => el.textContent.trim());

  await p.fill('#askText', 'hi');
  await p.click('#askGo');
  await p.waitForTimeout(400);
  check('a question too short to answer is refused, by the server\'s own words',
    /a few words at least/.test(await note()), await note());

  const before = await p.$$eval('#myQList .q-item', (n) => n.length);

  await p.fill('#askTopic', 'KPI 1');
  await p.fill('#askText', 'Why does August show 12 delayed tickets for Sales?');
  await p.click('#askGo');
  await p.waitForTimeout(600);

  const mine = await p.$$eval('#myQList .q-item', (ns) => ns.map((n) => n.textContent));
  check('a real question is accepted', /Sent\.|Saved\./.test(await note()), await note());
  check('and appears under My questions without a reload',
    mine.length === before + 1 &&
    mine.some((t) => /12 delayed tickets/.test(t)),
    before + ' -> ' + mine.length);
  check('with the box emptied, so it is not sent twice',
    (await p.$eval('#askText', (el) => el.value)) === '');
  check('and it is marked as waiting, not silently filed',
    /waiting|NEW/i.test(mine.find((t) => /12 delayed/.test(t)) || ''),
    'the person needs to know nobody has replied yet');

  // -------------------------------------------------------------------------
  // THE ONE THAT MATTERS: a question is data, not markup
  // -------------------------------------------------------------------------
  const NASTY = '<img src=x onerror="window.__owned=1"><b>bold</b> & "quoted" <script>';
  await p.fill('#askText', NASTY);
  await p.click('#askGo');
  await p.waitForTimeout(600);

  const owned = await p.evaluate(() => window.__owned === 1);
  check('a question containing an <img onerror> does not run it',
    owned === false, 'window.__owned is ' + owned);

  const shown = await p.$$eval('#myQList .q-item', (ns) => ns.map((n) => ({
    text: n.textContent, html: n.innerHTML
  })));
  const nastyRow = shown.find((r) => /bold/.test(r.text));
  check('it is shown literally, angle brackets and all',
    Boolean(nastyRow) && nastyRow.text.indexOf('<img src=x') !== -1 &&
    nastyRow.text.indexOf('<b>bold</b>') !== -1,
    nastyRow ? nastyRow.text.replace(/\s+/g, ' ').slice(0, 72) : 'row not found');
  check('and no tag from it was ever built',
    Boolean(nastyRow) && nastyRow.html.indexOf('<img') === -1 &&
    nastyRow.html.indexOf('<b>') === -1 &&
    nastyRow.html.indexOf('&lt;img') !== -1,
    'escaped on the way in, not stripped');
  check('an ampersand and a quote survive as themselves',
    Boolean(nastyRow) && nastyRow.text.indexOf('& "quoted"') !== -1,
    'over-escaping is a bug too - people write & in sentences');

  // -------------------------------------------------------------------------
  // the admin inbox
  // -------------------------------------------------------------------------
  // Three exist by now: the one in the fixture and the two just asked. The
  // inbox used to show only the fixture's, because asking refreshed My
  // questions and nothing else - so an admin's own question was invisible to
  // them until they reloaded the page.
  const inbox = await p.$$eval('#inboxList .q-item', (ns) => ns.length);
  check('an admin sees every question in the inbox, including ones they just asked',
    inbox === 3, inbox + ' of 3 rows');

  const badgeBeforeAnswer = await p.$eval('#helpBadge', (el) => el.textContent.trim());
  check('and the badge counts all of them, not the number it was handed at sign-in',
    badgeBeforeAnswer === '3', badgeBeforeAnswer + ', expected 3');

  const asked = await p.$$eval('#inboxList .q-item', (ns) =>
    ns.map((n) => n.textContent).join(' | '));
  check('including who asked each one, which is the point of an inbox',
    /20000042/.test(asked), 'employee ID shown to the admin only');
  check('and the untrusted one is escaped in the inbox too',
    (await p.$eval('#inboxList', (el) => el.innerHTML)).indexOf('<img src=x') === -1,
    'the inbox is the dangerous screen - it is read by the account that can delete things');

  // answering
  const answerBox = await p.$('#inboxList .q-reply textarea, #inboxList textarea');
  check('each unanswered question has somewhere to type the answer',
    Boolean(answerBox));
  if (answerBox) {
    // The answer gets markup in it too. An admin is trusted, but an answer is
    // often pasted out of an email, and it is rendered in the ASKER's browser,
    // not only the admin's - so the person who types it is not the person who
    // would pay for it not being escaped.
    const REPLY = 'Four were logged against the wrong <section> & fixed. ' +
                  '<img src=y onerror="window.__owned2=1">';
    await answerBox.fill(REPLY);
    await p.click('#inboxList button');
    await p.waitForTimeout(600);
    const answeredNow = await p.$$eval('#inboxList .q-item', (ns) =>
      ns.map((n) => n.textContent).join(' | '));
    check('answering it shows the answer on the question',
      /wrong <section> & fixed/.test(answeredNow), 'without a page reload');
    check('and an answer is escaped on the way in as well',
      (await p.evaluate(() => window.__owned2 === 1)) === false &&
      (await p.$eval('#inboxList', (el) => el.innerHTML)).indexOf('<img src=y') === -1,
      'the asker reads this, so it is their browser at stake');
    // Deliberately not "the badge changed". It changed before this fix too -
    // it changed UPWARDS, from a stale 1 to a true 2, which is exactly the
    // thing a weak assertion waves through.
    const badgeNow = await p.$eval('#helpBadge', (el) => el.textContent.trim());
    check('and the waiting badge comes DOWN by one',
      Number(badgeNow) === Number(badgeBeforeAnswer) - 1,
      badgeBeforeAnswer + ' -> ' + (badgeNow || '(empty)'));
  }

  // -------------------------------------------------------------------------
  // a viewer
  // -------------------------------------------------------------------------
  await p.close();
  p = await open('?view=help&role=USER');

  check('a viewer still gets the FAQ',
    (await p.$$eval('#faqList details', (ds) => ds.length)) === 2);
  check('and can still ask a question',
    await p.$eval('#askGo', (el) => getComputedStyle(el).display !== 'none'));
  check('and no waiting-count badge, which means nothing to them',
    await p.$eval('#helpBadge', (el) => el.hidden ||
                                        getComputedStyle(el).display === 'none'),
    'a viewer cannot answer anything, so a queue length is just a leak');
  check('but the admin inbox is not on their screen',
    await p.$eval('#inboxList', (el) => {
      const box = el.closest('[data-admin-only]') || el;
      return getComputedStyle(box).display === 'none' || box.hidden ||
             el.children.length === 0;
    }),
    'the server refuses them anyway - this is so they never see the box');

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
