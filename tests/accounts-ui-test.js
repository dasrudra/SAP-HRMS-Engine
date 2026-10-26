// The Accounts table, driven in a real browser.
//
// The question this table gets asked is "who has been in recently", and for a
// while it answered a different one: it listed employee IDs in whatever order
// the sheet held them, with a sign-in COUNT at the end. A total of 29 since
// October tells you nothing you can act on; "was here this morning" does.
//
// So: newest sign-in at the top, and the count is gone. Two rows have to be
// handled on purpose rather than by accident -
//
//   somebody who has never signed in, whose empty date would otherwise sort
//   as though they had been here in 1970, and
//
//   the shared starting login, which is not a person, has no sign-in of its
//   own, and belongs at the bottom whatever else is going on.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/accounts-ui-test.js
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

(async () => {
  const b = await chromium.launch({ executablePath: BROWSER });
  const errors = [];
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  // A page of its own, for the checks that have to start from a clean one -
  // signing out cannot be undone on the page it happened to.
  const open = async (query) => {
    const page = await b.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
      errors.push('console: ' + m.text());
    });
    await page.goto('file://' + PAGE + (query || ''));
    await page.waitForTimeout(2000);
    return page;
  };

  await p.goto('file://' + PAGE + '?view=master');
  await p.waitForTimeout(2000);

  // ---------------------------------------------------------------------------
  // what the table shows
  // ---------------------------------------------------------------------------
  const heads = await p.$$eval('#masterTable thead th',
                               (ts) => ts.map((t) => t.textContent.trim()));
  check('the sign-in count column is gone',
    !heads.some((h) => /sign-ins/i.test(h)), heads.join(' | '));
  check('and the columns that are left still line up with the header',
    (await p.$$eval('#masterTable tbody tr:not(:last-child) td',
                    (ts) => ts.length)) % heads.length === 0,
    heads.length + ' columns');

  // ---------------------------------------------------------------------------
  // the order
  // ---------------------------------------------------------------------------
  const rows = await p.$$eval('#masterTable tbody tr', (rs) => rs.map((r) => ({
    id: r.cells[0].textContent.trim(),
    last: r.cells[5] ? r.cells[5].textContent.trim() : ''
  })));

  check('the person here most recently is at the top',
    rows[0].id === '20536723', rows[0].id + ' (' + rows[0].last + ')');

  const dated = rows.filter((r) => /\d{4}-\d{2}-\d{2}/.test(r.last));
  const inOrder = dated.every(function (r, i) {
    return i === 0 || dated[i - 1].last >= r.last;
  });
  check('and the rest follow, newest to oldest',
    inOrder && dated.length === 4,
    dated.map((r) => r.id + ' ' + r.last).join('  >  '));

  // The two that have to be handled rather than left to chance.
  const never = rows.findIndex((r) => r.id === '20900001');
  const shared = rows.findIndex((r) => r.id === 'user');
  check('somebody who has never signed in sorts below everybody who has',
    never === dated.length,
    'row ' + (never + 1) + ' of ' + rows.length);
  check('and the shared starting login is last, being nobody',
    shared === rows.length - 1, 'row ' + (shared + 1) + ' of ' + rows.length);

  // ---------------------------------------------------------------------------
  // the sign-in log is capped
  // ---------------------------------------------------------------------------
  // It gains a row on every sign-in, so left to its own height it becomes the
  // longest thing on this screen within a fortnight and pushes everything
  // else out of reach.
  const log = await p.evaluate(() => {
    const wrap = document.querySelector('#masterLog').closest('.table-wrap');
    const head = document.querySelector('#masterLog thead th');
    return {
      rows: document.querySelectorAll('#masterLog tbody tr').length,
      box: Math.round(wrap.getBoundingClientRect().height),
      content: wrap.scrollHeight,
      sticky: getComputedStyle(head).position
    };
  });
  check('a long log is loaded in full', log.rows >= 100, log.rows + ' rows');
  check('but the box it sits in stays a normal size',
    log.box > 0 && log.box <= 420, log.box + 'px tall for ' + log.content + 'px of rows');
  check('and scrolls inside itself rather than down the page',
    log.content > log.box + 100,
    log.content + 'px of content in a ' + log.box + 'px box');
  check('with the headings staying put while it scrolls',
    log.sticky === 'sticky',
    'a column of dates with no headings above it is worse than a long table');

  const scrolled = await p.evaluate(() => {
    const wrap = document.querySelector('#masterLog').closest('.table-wrap');
    wrap.scrollTop = 250;
    const head = document.querySelector('#masterLog thead th').getBoundingClientRect();
    return Math.round(head.top - wrap.getBoundingClientRect().top);
  });
  check('which it demonstrably does', Math.abs(scrolled) <= 2,
    'heading sits ' + scrolled + 'px from the top of the box after scrolling');

  check('and the screen says how long the log is kept',
    /30 days/.test(await p.$eval('#view-master', (el) => el.textContent)),
    'otherwise a missing row looks like a bug rather than the rule');

  // ---------------------------------------------------------------------------
  // the message bar
  // ---------------------------------------------------------------------------
  const bar = await p.$eval('#msgrBar', (el) => {
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    return {
      width: Math.round(r.width), height: Math.round(r.height),
      gap: Math.round(window.innerHeight - r.bottom),
      radius: css.borderRadius,
      blur: css.backdropFilter || css.webkitBackdropFilter || '',
      background: css.backgroundImage,
      shadow: css.boxShadow,
      transition: css.transitionDuration
    };
  });
  check('the bar is wide enough to read as a bar', bar.width >= 250,
    bar.width + ' x ' + bar.height);

  // THE ROUNDING IS THE SHAPE. A pill flush against the bottom edge would have
  // half of it cut off by the edge it sits on, so the bar floats clear.
  check('it is a full pill, not a rounded rectangle',
    parseFloat(bar.radius) >= bar.height / 2,
    bar.radius + ' on a ' + bar.height + 'px bar');
  check('and floats clear of the bottom edge rather than sitting on it',
    bar.gap >= 10 && bar.gap <= 30, bar.gap + 'px of air beneath');

  check('it is frosted glass rather than a flat panel',
    /blur/.test(bar.blur), bar.blur || '(no backdrop-filter)');
  check('tinted, because clear glass on a white page is invisible',
    /gradient/.test(bar.background), bar.background.slice(0, 60));
  check('with an inset highlight and a glow outside it',
    bar.shadow.split('rgb').length - 1 >= 3,
    (bar.shadow.split('rgb').length - 1) + ' layers');
  check('and it moves slowly enough to be felt rather than noticed',
    parseFloat(bar.transition) >= 0.25,
    bar.transition);

  const before = await p.$eval('#msgrBar', (el) => getComputedStyle(el).transform);
  await p.hover('#msgrBar');
  await p.waitForTimeout(600);
  const after = await p.$eval('#msgrBar', (el) => getComputedStyle(el).transform);
  check('hovering lifts it', after !== before, before + '  ->  ' + after);

  // The open panel reaches the floor; only the collapsed pill floats. If both
  // floated, the panel would sit on a shelf of empty page.
  await p.click('#msgrBar');
  await p.waitForTimeout(500);
  const panelGap = await p.$eval('#msgrPanel', (el) =>
    Math.round(window.innerHeight - el.getBoundingClientRect().bottom));
  check('but the open panel still reaches the bottom edge', panelGap === 0,
    panelGap + 'px of gap under the panel');
  await p.click('#msgrClose');
  await p.waitForTimeout(400);

  // ---------------------------------------------------------------------------
  // the mark
  // ---------------------------------------------------------------------------
  const mark = await p.$eval('#msgrBar .msgr-bar-icon', (el) => {
    const css = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const text = document.getElementById('msgrBarLabel').getBoundingClientRect();
    return { image: css.backgroundImage.slice(0, 40),
             width: Math.round(r.width), height: Math.round(r.height),
             textHeight: Math.round(text.height),
             label: el.getAttribute('aria-label') };
  });
  check('the message icon is the avatar, carried inside the page',
    /^url\("data:image\//.test(mark.image), mark.image + '...');

  // A whole standing figure is about 3 wide to 4 high. Squashing it to the
  // square an icon slot usually wants would be the one thing that cannot be
  // done to a photograph of somebody.
  check('at the shape a standing figure actually is, not squashed to a square',
    Math.abs(mark.width / mark.height - 121 / 162) < 0.08,
    mark.width + 'x' + mark.height + ' is ' +
    (mark.width / mark.height).toFixed(2) + ':1, drawn at 0.75:1');
  // Not "taller than the bar" - the bar grows to hold it, so that compares a
  // thing to itself. The property that matters is that a whole standing figure
  // got room to be one, which means much taller than the word beside it.
  check('and given real height, so a whole figure is legible at all',
    mark.height >= mark.textHeight * 2.5,
    mark.height + 'px tall beside ' + mark.textHeight + 'px text');
  check('and it is named for anybody who cannot see it',
    mark.label === 'Messages', mark.label);

  // It has to actually decode. A data URI that is one character short is a
  // broken image, and a background-image that fails leaves no trace in the DOM.
  const decoded = await p.evaluate(() => new Promise((done) => {
    const css = getComputedStyle(document.querySelector('.msgr-bar-icon'));
    const url = css.backgroundImage.slice(5, -2);
    const img = new Image();
    img.onload = () => done(img.naturalWidth + 'x' + img.naturalHeight);
    img.onerror = () => done('FAILED TO DECODE');
    img.src = url;
  }));
  check('and the browser can actually decode it', /^\d+x\d+$/.test(decoded),
    decoded);

  // ---------------------------------------------------------------------------
  // the name, and the address a query is emailed to
  // ---------------------------------------------------------------------------
  // Both are typed straight into the table. This is the screen the master
  // comes to in order to CHANGE them, so the test drives them the way a
  // person would: type, leave the box, and see what came back.
  const headRow = await p.$$eval('#masterTable thead th',
                                 (ts) => ts.map((t) => t.textContent.trim()));
  check('the table has a Name column and an Email column',
    headRow.some((h) => /^name$/i.test(h)) &&
    headRow.some((h) => /email/i.test(h)),
    headRow.join(' | '));

  const boxFor = (id, field) =>
    p.locator('input[data-detail="' + field + '"][data-id="' + id + '"]');

  check('a name already on an account is shown in its row',
    (await boxFor('20536723', 'name').inputValue()) === 'Rudra Das',
    await boxFor('20536723', 'name').inputValue());
  check('and an account with none shows that it has none',
    (await boxFor('20217474', 'name').inputValue()) === '' &&
    /not given/i.test(await boxFor('20217474', 'name').getAttribute('placeholder')),
    await boxFor('20217474', 'name').getAttribute('placeholder'));

  // ---- setting one ----
  // THE ADDRESS FIRST, then the name. In the other order the last assertion
  // here proves nothing: a save that wrongly carried the whole row would
  // blank a field that had not been filled in yet.
  //
  // And each one checks the box is NOT marked, because the box keeps whatever
  // was typed into it either way - asking it what it holds asks what the test
  // just typed, not what the server did with it.
  const marked = (id, field) =>
    boxFor(id, field).evaluate((el) => el.classList.contains('is-bad'));

  await boxFor('20217474', 'email').fill('shahriar@youngone.com');
  await boxFor('20217474', 'email').blur();
  await p.waitForTimeout(600);
  check('an address typed into the table is stored',
    (await boxFor('20217474', 'email').inputValue()) === 'shahriar@youngone.com' &&
    !(await marked('20217474', 'email')),
    await boxFor('20217474', 'email').inputValue());

  await boxFor('20217474', 'name').fill('  Shahriar   Kabir  ');
  await boxFor('20217474', 'name').blur();
  await p.waitForTimeout(600);
  check('and so is a name, tidied on the way',
    (await boxFor('20217474', 'name').inputValue()) === 'Shahriar Kabir' &&
    !(await marked('20217474', 'name')),
    'the screen shows what was stored, not what was typed');

  // ONE FIELD AT A TIME. Saving the name must not carry the email box along
  // with it - that is how correcting one quietly blanks the other.
  check('saving the name leaves the address beside it alone',
    (await boxFor('20217474', 'email').inputValue()) === 'shahriar@youngone.com',
    await boxFor('20217474', 'email').inputValue() || '(blanked)');

  // ---- what is refused ----
  await boxFor('20217474', 'email').fill('shahriar.at.work');
  await boxFor('20217474', 'email').blur();
  await p.waitForTimeout(600);
  const badClass = await boxFor('20217474', 'email').getAttribute('class');
  check('something that is not an address is marked, not stored',
    /is-bad/.test(badClass || ''), badClass);

  // ---- a viewer's address is stored and not used ----
  const viewerRow = await p.$$eval('#masterTable tbody tr', (rs) => {
    const hit = rs.filter((r) => r.cells[0].textContent.trim() === '20217450')[0];
    return hit ? hit.textContent : '';
  });
  check('a viewer carrying an address is told it is not written to',
    /viewers are not emailed/i.test(viewerRow),
    'otherwise somebody fills it in and waits for email that was never coming');

  // ---- and the shared login is still nobody ----
  const sharedCells = await p.$$eval('#masterTable tbody tr', (rs) => {
    const hit = rs.filter((r) => r.cells[0].textContent.trim() === 'user')[0];
    return hit ? Array.from(hit.cells).map((c) => c.textContent.trim()) : [];
  });
  check('the shared starting login is given no name box to fill in',
    sharedCells.length > 1 && sharedCells[1] === '\u2014',
    'it is a door, not a person');

  // ---------------------------------------------------------------------------
  // the door everybody comes in by
  // ---------------------------------------------------------------------------
  // There used to be a shared login - one username and one password the whole
  // team was given - whose only job was to open the card that creates an
  // account. Its password sat in a public repository. People create their own
  // login directly now, and the master shuts the door once everybody is in.
  check('the Accounts screen carries a switch for new logins',
    await p.$eval('#signupState', (n) => n.textContent.trim()) === 'Open',
    await p.$eval('#signupNote', (n) => n.textContent.trim()));
  check('and says how many of the team are in so far',
    /of 37/.test(await p.$eval('#signupNote', (n) => n.textContent)),
    await p.$eval('#signupNote', (n) => n.textContent.trim()));

  // CLOSING NEEDS NO CEREMONY. It is the safe direction.
  await p.click('#signupToggle');
  await p.waitForTimeout(600);
  check('closing it takes one click',
    await p.$eval('#signupState', (n) => n.textContent.trim()) === 'Closed',
    await p.$eval('#signupNote', (n) => n.textContent.trim()));
  check('and the note then says what the only way in is',
    /employee ID you add/i.test(await p.$eval('#signupNote', (n) => n.textContent)),
    'the master writing an ID down is the invitation');

  // OPENING DOES. It puts the dashboard back to anybody-with-the-URL being
  // able to claim an employee ID that has not been used yet.
  await p.click('#signupToggle');
  await p.waitForTimeout(400);
  const asked = await p.$eval('#modalBackdrop', (n) => !n.hidden);
  check('opening it again asks first', asked, 'closing did not, and should not');
  check('and says plainly what being open costs',
    /create a login for any employee ID/i.test(
      await p.$eval('#modalBody', (n) => n.textContent)),
    await p.$eval('#modalBody', (n) => n.textContent.trim().slice(0, 62)));

  await p.click('#modalCancel');
  await p.waitForTimeout(500);
  check('and cancelling leaves it shut',
    await p.$eval('#signupState', (n) => n.textContent.trim()) === 'Closed',
    'the question was real, not a formality');

  // ---------------------------------------------------------------------------
  // signing out, and being signed out
  // ---------------------------------------------------------------------------
  // These are two different things and the card used to say the same sentence
  // about both: "Your session ended after an hour with nothing happening."
  // Pressing Sign out is not an hour of nothing happening - and the reason it
  // appeared is that this page keeps two polls on timers, one of which is
  // usually in flight when the button is pressed. It lands a moment later
  // holding a token the server has just forgotten, and its refusal was
  // written over the top of the card.
  let q = await open('?view=master');
  await q.click('#signOut');
  await q.waitForTimeout(900);

  check('signing out puts the sign-in card back',
    await q.$eval('#loginScreen', (n) => !n.hidden) &&
    await q.$eval('#appRoot', (n) => n.hidden));
  check('and says nothing about an hour of inactivity',
    await q.$eval('#loginAlert', (n) => n.hidden) ||
    (await q.$eval('#loginAlert', (n) => n.textContent.trim())) === '',
    await q.$eval('#loginAlert', (n) => n.textContent.trim()) || '(nothing, correctly)');

  await q.close();

  // ---- THE SEQUENCE THAT PRODUCED THE COMPLAINT ----
  // A call already in flight when Sign out is pressed, landing a moment
  // afterwards with a token the server has just forgotten. Its refusal used
  // to be written over the top of the card as a sentence about an hour of
  // inactivity that had not happened.
  q = await open('?view=master');
  await q.evaluate(() => { window.__slowNext = 1500; });
  await q.click('.nav-item[data-view="kpi1"]');          // dispatched, answers in 1.5s
  await q.waitForTimeout(120);
  await q.click('#signOut');                     // pressed while it is in flight
  await q.waitForTimeout(2200);                  // long enough for it to land

  check('a call in flight when you sign out does not talk over the card',
    (await q.evaluate(() => (window.__calls || {}).getKpi1 > 0)) &&
    ((await q.$eval('#loginAlert', (n) => n.hidden)) ||
     (await q.$eval('#loginAlert', (n) => n.textContent.trim())) === ''),
    await q.$eval('#loginAlert', (n) => n.textContent.trim()) || '(nothing, correctly)');
  await q.close();

  // ---- and the other way round: a token refused with nobody pressing anything ----
  q = await open('?view=master');
  await q.evaluate(() => window.__expireSession());
  // Through the page's own callServer, which is where the decision lives.
  await q.click('.nav-item[data-view="kpi1"]');
  await q.waitForTimeout(1100);

  const note = await q.$eval('#loginAlert', (n) => n.textContent.trim());
  check('a session refused on its own DOES say so',
    (await q.$eval('#loginAlert', (n) => !n.hidden)) && /session has ended/i.test(note),
    note);
  check('without claiming a reason it cannot know',
    !/hour/i.test(note) && !/nothing happening/i.test(note),
    'an account removed or a role changed refuses a token too, and telling ' +
    'that person they were idle is a confident answer to a question nobody asked');
  await q.close();

  // ---- and signing back in makes it mean something again ----
  // The flag says "this person pressed Sign out". If it is never cleared,
  // the next session they start inherits it, and the day that one really
  // does run out they are put back at the sign-in card with no idea why.
  q = await open('?view=master');
  await q.click('#signOut');
  await q.waitForTimeout(900);
  await q.fill('#loginUser', '20536723');
  await q.fill('#loginPass', 'whatever');
  await q.click('#loginGo');
  await q.waitForTimeout(1600);
  check('signing back in works', await q.$eval('#appRoot', (n) => !n.hidden));

  await q.evaluate(() => window.__expireSession());
  await q.click('.nav-item[data-view="kpi1"]');
  await q.waitForTimeout(1100);
  const second = await q.$eval('#loginAlert', (n) => n.textContent.trim());
  check('and the NEXT session ending does say so',
    /session has ended/i.test(second), second || '(said nothing)');
  await q.close();

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
