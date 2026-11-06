// Knowledge Share, in a real browser - and the one-at-a-time filter next door.
//
// WHAT IS AT RISK, and none of it is layout.
//
//   THE UPLOAD IS THE WHOLE FEATURE. A file is read in the browser, cut into
//   pieces, base64'd and sent one call at a time. Every one of those steps
//   can lose bytes quietly: a chunk boundary off by one, a base64 helper
//   that blows the stack on a big array, pieces sent in parallel and
//   arriving out of order. The fixture reassembles them the way the server
//   does and hands the text back, so this suite compares what came out with
//   what went in rather than counting calls.
//
//   THE WORDS MUST SURVIVE A FAILED ATTACHMENT. createKnowledge is called
//   before any upload starts, on purpose. If that order is ever reversed, a
//   flaky connection loses ten minutes of somebody's typing.
//
//   THE BODY IS SOMEBODY ELSE'S TEXT. It is escaped and then given its line
//   breaks back, in that order. The other order would let a colleague write
//   markup into a page everybody reads.
//
//   ONE FILTER AT A TIME, on Learnings. Pressing SOP and then MM used to
//   leave both on; at 250 documents the chip still lit is off the side of
//   where the eye is, so four results read as a broken filter.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/knowledge-ui-test.js
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

  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  await p.goto(FILE);
  await p.waitForTimeout(1500);

  // =========================================================================
  // 1. ONE FILTER AT A TIME, on Learnings
  // =========================================================================
  await p.click('.portal-tab[data-view="learnings"]');
  await p.waitForTimeout(700);

  const cards = () => p.$$eval('#lrnGrid .lrn-card', (ns) => ns.map((n) =>
    n.querySelector('.lrn-card-title').textContent.trim()));
  const lit = () => p.$$eval('#lrnChips .lrn-chip.is-on', (ns) => ns.map((n) =>
    n.getAttribute('data-group') + ':' + (n.getAttribute('data-value') || 'all')));

  await p.click('#lrnChips .lrn-chip[data-group="type"][data-value="SOP"]');
  await p.waitForTimeout(200);
  const sops = await cards();
  check('pressing SOP narrows to the SOPs',
    sops.length === 3, sops.length + ' cards');

  check('and SOP is the only chip lit',
    (await lit()).join(' ') === 'type:SOP', (await lit()).join(' ') || 'none');

  // THE CHANGE. A chip from another group REPLACES rather than adds.
  await p.click('#lrnChips .lrn-chip[data-group="module"][data-value="MM"]');
  await p.waitForTimeout(200);

  check('pressing MM then replaces SOP rather than narrowing inside it',
    (await lit()).join(' ') === 'module:MM', (await lit()).join(' ') || 'none');

  const mm = await cards();
  check('so every MM document is shown, not just the MM ones that are SOPs',
    mm.length === 4 && mm.indexOf('SAP S4HANA MM Purchase Cycle') !== -1,
    mm.length + ': ' + mm.join(' | '));

  // Pressing the lit one still turns it off.
  await p.click('#lrnChips .lrn-chip[data-group="module"][data-value="MM"]');
  await p.waitForTimeout(200);
  check('pressing the lit chip turns it off and goes back to everything',
    (await cards()).length === 7 && (await lit()).join(' ') === 'all:all',
    (await cards()).length + ' cards, lit: ' + ((await lit()).join(' ') || 'none'));

  // Across all three groups, never two at once.
  await p.click('#lrnChips .lrn-chip[data-group="biz"][data-value="RMG"]');
  await p.waitForTimeout(150);
  await p.click('#lrnChips .lrn-chip[data-group="type"][data-value="Policy"]');
  await p.waitForTimeout(150);
  check('type, module and business are one choice between them, not three',
    (await lit()).join(' ') === 'type:Policy', (await lit()).join(' ') || 'none');

  await p.click('#lrnChips .lrn-chip[data-group="all"]');
  await p.waitForTimeout(200);

  // =========================================================================
  // 2. THE WAY ACROSS
  // =========================================================================
  const bar = await p.evaluate(() => {
    const el = document.querySelector('.kn-portal');
    const search = document.querySelector('.lrn-search');
    if (!el || !search) return null;
    const r = el.getBoundingClientRect(), s = search.getBoundingClientRect();
    return {
      text: el.querySelector('strong').textContent.trim(),
      view: el.getAttribute('data-view'),
      aboveSearch: r.bottom <= s.top + 1,
      width: Math.round(r.width), searchWidth: Math.round(s.width),
      border: getComputedStyle(el).borderTopColor
    };
  });

  check('the Knowledge Share portal sits just above the search bar',
    bar && bar.aboveSearch && /Knowledge Share/i.test(bar.text),
    bar ? '"' + bar.text + '", above=' + bar.aboveSearch : '(missing)');

  check('and spans the same width, so it reads as part of the same column',
    bar && Math.abs(bar.width - bar.searchWidth) <= 2,
    bar ? bar.width + ' vs ' + bar.searchWidth : '(missing)');

  /*
    ITS OWN COLOUR, and not one of the four the rest of the portal uses.

    The whole reason this bar is a different colour is that a colleague's
    note must not be mistaken for an approved document. So the assertion
    is against the WHOLE accent set, read off the page rather than written
    out here - a first version compared the bar with whichever chip
    happened to be lit, which was the white All chip, and passed with the
    bar painted in Learnings cyan.
  */
  const tones = await p.evaluate(() => {
    const num = (c) => (String(c).match(/[\d.]+/g) || []).map(Number)
      .slice(0, 3).join(',');
    const probe = document.createElement('span');
    document.getElementById('view-learnings').appendChild(probe);
    const accents = [0, 1, 2, 3].map(function (i) {
      probe.setAttribute('data-accent', String(i));
      // The variable is a hex; paint it onto something to get the rgb.
      probe.style.color = getComputedStyle(probe).getPropertyValue('--lrn-accent');
      return num(getComputedStyle(probe).color);
    });
    probe.remove();

    const bar = document.querySelector('.kn-portal');
    const kn = bar.style.color;
    bar.style.color = getComputedStyle(bar).getPropertyValue('--kn');
    const portal = num(getComputedStyle(bar).color);
    bar.style.color = kn;

    return { portal: portal, accents: accents };
  });

  check('the portal bar is painted in none of the Learnings accents',
    tones.portal && tones.accents.indexOf(tones.portal) === -1,
    'portal ' + tones.portal + ' vs accents ' + tones.accents.join(' / '));

  await p.click('.kn-portal');
  await p.waitForTimeout(800);

  const landed = await p.evaluate(() => ({
    knowledge: !document.getElementById('view-knowledge').hidden,
    learnings: !document.getElementById('view-learnings').hidden,
    page: document.getElementById('portalRoot').getAttribute('data-page')
  }));
  check('pressing it opens Knowledge Share and closes Learnings',
    landed.knowledge && !landed.learnings && landed.page === 'knowledge',
    'knowledge=' + landed.knowledge + ' learnings=' + landed.learnings +
      ' page=' + landed.page);

  /*
    THE NAVY HAS TO COVER THIS PAGE TOO - every surface on it is glass,
    and glass over the portal's light page surface is a grey slab.

    MEASURED AGAINST THE VIEWPORT AND AFTER SCROLLING, not against the
    bottom of the content. .portal is position:fixed at viewport height
    and the content scrolls INSIDE it, so the sky is a backdrop that
    stays put rather than a band as long as the page. Comparing it with
    the content's height reported a failure on a page that renders
    correctly - and would have gone on passing on a short page even if
    the backdrop were broken, which is the wrong answer twice.
  */
  const skyCovers = async (where) => await p.evaluate(() => {
    const s = document.querySelector('.portal-sky').getBoundingClientRect();
    return { top: Math.round(s.top), bottom: Math.round(s.bottom),
             fold: window.innerHeight };
  });

  const skyTop = await skyCovers();
  check('the navy covers the whole window on the Knowledge page',
    skyTop.top <= 0 && skyTop.bottom >= skyTop.fold,
    skyTop.top + ' to ' + skyTop.bottom + ' of ' + skyTop.fold);

  // And still does once somebody has scrolled past the first screenful,
  // which is where a backdrop that is only as tall as its first paint
  // would come apart.
  await p.evaluate(() => {
    const all = Array.from(document.querySelectorAll('#portalRoot *'));
    const scroller = all.filter(function (n) {
      return n.scrollHeight > n.clientHeight + 40;
    })[0] || document.scrollingElement;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await p.waitForTimeout(250);

  const skyDown = await skyCovers();
  check('and still does after scrolling to the bottom of it',
    skyDown.top <= 0 && skyDown.bottom >= skyDown.fold,
    skyDown.top + ' to ' + skyDown.bottom + ' of ' + skyDown.fold);

  // =========================================================================
  // 3. THE FEED
  // =========================================================================
  const items = () => p.$$eval('#knList .kn-item', (ns) => ns.map((n) =>
    n.querySelector('strong').textContent.trim()));

  check('the feed is drawn from the server, newest first',
    (await items()).length === 2 &&
    /Two screenshots/.test((await items())[0]) &&
    /GRN posts/.test((await items())[1]),
    (await items()).join(' | '));

  // The GRN one: words, no attachments, and not written by the signed-in
  // person - which is three of the four cases this pane has to draw.
  const openAt = async (n) => {
    await p.click('#knList .kn-item:nth-child(' + n + ')');
    await p.waitForTimeout(400);
  };
  await openAt(2);

  const open = await p.evaluate(() => ({
    title: document.getElementById('knTitle').textContent.trim(),
    meta: document.getElementById('knMeta').textContent.trim(),
    html: document.getElementById('knView').innerHTML,
    text: document.getElementById('knView').textContent,
    avatar: document.getElementById('knAvatar').textContent.trim(),
    attach: document.querySelectorAll('#knAttachments .kn-file').length
  }));

  check('opening one shows its words in the middle pane',
    /movement type is set before the plant/.test(open.text), open.title);

  // The body is typed into a textarea, so its line breaks are the only
  // structure it has. Collapsing them turns a numbered list into a run-on.
  check('and keeps the line breaks the author typed',
    (open.html.match(/<br>/g) || []).length >= 3,
    (open.html.match(/<br>/g) || []).length + ' breaks');

  check('the author and date are on the line under the title',
    /Bilal Hossain/.test(open.meta) && /2 Nov 2026/.test(open.meta), open.meta);

  check('and the author gets initials rather than a blank circle',
    open.avatar === 'BH', open.avatar);

  // =========================================================================
  // 3b. WHOSE SHARE IT IS, AND WHAT EVERYBODY ELSE GETS INSTEAD
  // =========================================================================
  // Remove is the author's alone, an admin included. Everybody else gets
  // Download. Hidden rather than greyed: a disabled button says "there is
  // something here you may not do", and the truth is that it is simply
  // not their share.
  const onTheirs = await p.evaluate(() => ({
    del: !document.getElementById('knDelete').hidden,
    get: !document.getElementById('knDownload').hidden,
    getOff: document.getElementById('knDownload').classList.contains('is-off')
  }));
  check('somebody else\'s share offers no Remove at all',
    onTheirs.del === false, onTheirs.del ? 'Remove was offered' : 'hidden');

  // This one has no attachments, so Download is drawn and dead rather
  // than absent - the button belongs to the share, its state to the files.
  check('and its Download is shown but dead, because it has nothing attached',
    onTheirs.get && onTheirs.getOff,
    'shown=' + onTheirs.get + ' dead=' + onTheirs.getOff);

  // =========================================================================
  // 3c. TWO ATTACHMENTS, AND A WAY TO THE SECOND
  // =========================================================================
  await openAt(1);

  const carousel = async () => await p.evaluate(() => {
    const bar = document.querySelector('#knView .kn-frame-bar');
    const frame = document.querySelector('#knView .kn-frame');
    return {
      name: bar ? bar.querySelector('.kn-frame-name').textContent.trim() : '',
      of: bar && bar.querySelector('.kn-frame-of')
        ? bar.querySelector('.kn-frame-of').textContent.trim() : '',
      arrows: bar ? bar.querySelectorAll('.kn-arrow').length : 0,
      src: frame ? frame.getAttribute('src') : '',
      lit: Array.from(document.querySelectorAll('#knAttachments .kn-file'))
             .map((n) => n.classList.contains('is-on') ? 1 : 0).join('')
    };
  });

  const first = await carousel();
  check('a share with two attachments previews the first of them',
    first.name === 'before.png' && /FA1/.test(first.src),
    first.name + ' / ' + first.src);

  check('and says which of how many, with an arrow each way',
    first.of === '1 / 2' && first.arrows === 2,
    '"' + first.of + '", ' + first.arrows + ' arrows');

  check('the attachment list marks the one on show',
    first.lit === '10', first.lit);

  // THE WHOLE POINT. The second attachment used to be unreachable without
  // opening Drive in another tab.
  await p.click('#knView .kn-arrow[data-step="1"]');
  await p.waitForTimeout(300);
  const second = await carousel();
  check('the forward arrow shows the second attachment, in the page',
    second.name === 'after.png' && /FA2/.test(second.src) &&
    second.of === '2 / 2' && second.lit === '01',
    second.name + ' / ' + second.of + ' / lit ' + second.lit);

  // Wrapping, so Next and Back are the same control for a list of two.
  await p.click('#knView .kn-arrow[data-step="1"]');
  await p.waitForTimeout(300);
  check('and wraps round to the first rather than stopping dead',
    (await carousel()).of === '1 / 2', (await carousel()).of);

  await p.click('#knView .kn-arrow[data-step="-1"]');
  await p.waitForTimeout(300);
  check('the back arrow wraps the other way',
    (await carousel()).of === '2 / 2', (await carousel()).of);

  // Pressing an attachment shows it here rather than opening Drive, which
  // is what it used to do and is how the second one became unreachable.
  await p.click('#knAttachments .kn-file:nth-child(1)');
  await p.waitForTimeout(300);
  const picked = await carousel();
  check('pressing an attachment previews it instead of leaving for Drive',
    picked.name === 'before.png' && picked.of === '1 / 2',
    picked.name + ' / ' + picked.of);

  check('the attachment rows are buttons, not links out',
    (await p.$$eval('#knAttachments a', (ns) => ns.length)) === 0,
    (await p.$$eval('#knAttachments a', (ns) => ns.length)) + ' anchors left');

  // The way to Drive is kept, demoted to one icon on the bar.
  check('the way out to Drive is still there, once, on the bar',
    (await p.$$eval('#knView .kn-frame-out', (ns) => ns.length)) === 1 &&
    /FA1/.test(await p.$eval('#knView .kn-frame-out', (n) => n.href)),
    await p.$eval('#knView .kn-frame-out', (n) => n.getAttribute('href')));

  // The arrow keys, because somebody comparing two screenshots will try.
  await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(300);
  check('the arrow keys move the preview too',
    (await carousel()).of === '2 / 2', (await carousel()).of);

  // Download is live here, and says how many it will fetch.
  const getBtn = await p.evaluate(() => {
    const n = document.getElementById('knDownload');
    return { hidden: n.hidden, off: n.classList.contains('is-off'),
             text: n.textContent.trim() };
  });
  check('Download is live on a share that has attachments, and counts them',
    !getBtn.hidden && !getBtn.off && /2 files/.test(getBtn.text),
    '"' + getBtn.text + '" off=' + getBtn.off);

  // Pressing it must not navigate the portal away. An <a download> would:
  // the attribute is ignored across origins, so the browser follows the
  // link and the page is replaced by Drive.
  const before = p.url();
  await p.click('#knDownload');
  await p.waitForTimeout(900);
  check('and pressing it does not navigate the page away',
    p.url() === before &&
    (await p.evaluate(() => !document.getElementById('view-knowledge').hidden)),
    p.url() === before ? 'still on the portal' : 'NAVIGATED to ' + p.url());

  check('it fetches one hidden frame per attachment rather than opening tabs',
    (await p.$$eval('body > iframe', (ns) => ns.length)) === 2,
    (await p.$$eval('body > iframe', (ns) => ns.length)) + ' frames');

  // Opening a different share starts at its first attachment again.
  await openAt(2);
  await openAt(1);
  check('opening another share and coming back starts at the first again',
    (await carousel()).of === '1 / 2', (await carousel()).of);

  // =========================================================================
  // 4. POSTING - the words, then the file, in pieces
  // =========================================================================
  await p.click('#knNew');
  await p.waitForTimeout(350);

  check('New Share opens the composer',
    (await p.$eval('#knSheet', (n) => !n.hidden)));

  // Refusing an empty one is worth more than it looks: a feed of blank
  // titles is a feed nobody scrolls.
  await p.click('#knPost');
  await p.waitForTimeout(250);
  check('posting with no title is refused, with a reason',
    /title/i.test(await p.$eval('#knNote', (n) => n.textContent)) &&
    (await p.$eval('#knSheet', (n) => !n.hidden)),
    await p.$eval('#knNote', (n) => n.textContent.trim()));

  await p.fill('#knFTitle', 'Movement type 311 needs the plant first');
  await p.click('#knPost');
  await p.waitForTimeout(250);
  check('and so is one with a title and nothing else in it',
    /attach something/i.test(await p.$eval('#knNote', (n) => n.textContent)),
    await p.$eval('#knNote', (n) => n.textContent.trim()));

  await p.fill('#knFBody', 'Line one.\nLine two.\n\nAnd a <b>bold</b> attempt.');
  await p.fill('#knFTags', ' MM , 311 ');

  // A FILE BIG ENOUGH FOR BOTH THINGS THAT CAN GO WRONG.
  //
  // The harness cuts at 64KB, so 300,000 bytes is five pieces - that
  // exercises the ordering. And 300,000 is well past what
  // String.fromCharCode.apply takes in one call, so it also exercises the
  // blocked base64 helper: a version that does the whole array at once
  // throws "Maximum call stack size exceeded" here.
  //
  // The first draft of this used 500 bytes, which proved the ordering and
  // silently let the unblocked version pass - 500 arguments is nothing.
  //
  // The contents are a known repeating pattern, so the fixture can be
  // asked whether what it reassembled is byte for byte what went in.
  const SENT = Array.from({ length: 300000 },
    (_, i) => String.fromCharCode(33 + (i % 90))).join('');

  await p.setInputFiles('#knFFiles', {
    name: 'walkthrough.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from(SENT, 'binary')
  });
  await p.waitForTimeout(250);

  check('a picked file is listed before it is sent',
    (await p.$$eval('#knPicked .kn-chip', (ns) => ns.length)) === 1,
    await p.$eval('#knPicked', (n) => n.textContent.trim()));

  await p.click('#knPost');
  await p.waitForTimeout(2500);

  check('the composer closes once it is shared',
    (await p.$eval('#knSheet', (n) => n.hidden)) === true);

  const after = await items();
  check('the new share is at the top of the feed, newest first',
    after.length === 3 && /Movement type 311/.test(after[0]),
    after.join(' | '));

  const posted = await p.evaluate(() => ({
    title: document.getElementById('knTitle').textContent.trim(),
    html: document.getElementById('knView').innerHTML,
    text: document.getElementById('knView').textContent,
    tags: Array.from(document.querySelectorAll('#knView .lrn-tag'))
            .map((n) => n.textContent.trim()),
    attach: Array.from(document.querySelectorAll('#knAttachments .kn-file'))
              .map((n) => n.querySelector('strong').textContent.trim())
  }));

  check('and is the one open, without having to be clicked',
    /Movement type 311/.test(posted.title), posted.title);

  check('its tags were split and trimmed',
    posted.tags.join('|') === 'MM|311', posted.tags.join('|'));

  // ESCAPED FIRST, LINE BREAKS SECOND. The other order lets a colleague
  // write their own markup into a page the whole team reads.
  check('a colleague cannot put markup into the feed',
    posted.html.indexOf('<b>bold</b>') === -1 &&
    /&lt;b&gt;bold&lt;\/b&gt;/.test(posted.html) &&
    /bold/.test(posted.text),
    posted.html.indexOf('<b>bold</b>') === -1 ? 'escaped' : 'RAW HTML GOT THROUGH');

  check('the attachment is on the share',
    posted.attach.length === 1 && posted.attach[0] === 'walkthrough.pdf',
    posted.attach.join(', ') || 'none');

  // THE BYTES. The fixture joined the pieces by index the way the server
  // does and kept the result; this is the only assertion that proves the
  // upload did not quietly lose or reorder anything.
  const got = await p.evaluate(() => {
    const api = window.google.script.run;
    void api;
    return null;
  });
  void got;

  const roundTrip = await p.evaluate(() => {
    // The store lives in the harness stub's closure; it is reachable
    // through the one thing the stub exposes - another call.
    return new Promise(function (resolve) {
      window.google.script.run
        .withSuccessHandler(function (d) { resolve(d); })
        .withFailureHandler(function () { resolve(null); })
        .getKnowledge('harness');
    });
  });

  const file = roundTrip && roundTrip.shares
    .filter(function (s) { return /Movement type 311/.test(s.title); })[0].files[0];

  check('every byte arrived, in order, across five separate calls',
    file && file.__text === SENT,
    file ? (file.__text === SENT
      ? file.__text.length + ' bytes identical'
      : 'got ' + file.__text.length + ' of ' + SENT.length + ', differs at ' +
        (function () {
          for (let i = 0; i < Math.max(file.__text.length, SENT.length); i++) {
            if (file.__text[i] !== SENT[i]) return i;
          }
          return '(nowhere)';
        })())
      : '(no file)');

  // =========================================================================
  // 5. REMOVING
  // =========================================================================
  p.on('dialog', (d) => d.accept());

  const canRemove = await p.$eval('#knDelete', (n) => !n.hidden);
  check('the Remove button is offered on a share you can remove', canRemove);

  await p.click('#knDelete');
  await p.waitForTimeout(900);

  check('removing takes it out of the feed',
    (await items()).length === 2 &&
    !(await items()).some((t) => /Movement type 311/.test(t)),
    (await items()).join(' | '));

  check('and the pane goes back to its waiting state',
    /Nothing open/i.test(await p.$eval('#knTitle', (n) => n.textContent)),
    await p.$eval('#knTitle', (n) => n.textContent.trim()));

  // =========================================================================
  // 6. THE WAY BACK, AND NO BROWSER DEFAULTS ANYWHERE
  // =========================================================================
  await p.click('.kn-back');
  await p.waitForTimeout(500);
  check('the back link returns to Learnings',
    (await p.evaluate(() => !document.getElementById('view-learnings').hidden &&
                            document.getElementById('view-knowledge').hidden)));

  await p.click('.kn-portal');
  await p.waitForTimeout(600);
  await p.click('#knNew');
  await p.waitForTimeout(300);

  // The .portal-cta bug: `font: 600 14px/1 inherit` is invalid CSS, the
  // whole declaration is dropped, and a control silently falls back to
  // 13.3px Arial. A form is nothing but controls.
  const fonts = await p.evaluate(() => {
    const body = getComputedStyle(document.body).fontFamily;
    const of = (s) => {
      const n = document.querySelector(s);
      return n ? getComputedStyle(n).fontFamily : '(missing)';
    };
    return {
      body: body, title: of('#knFTitle'), area: of('#knFBody'),
      tags: of('#knFTags'), post: of('#knPost'), newBtn: of('#knNew'),
      portal: of('.kn-portal'), item: of('.kn-item')
    };
  });
  const strayed = Object.keys(fonts).filter(function (k) {
    return k !== 'body' && fonts[k] !== fonts.body;
  });
  check('no control on the composer has fallen back to the browser default font',
    strayed.length === 0,
    strayed.map((k) => k + '=' + fonts[k]).join(', ') || 'all match the page');

  // Escape closes it, which is the one keyboard convention a modal has.
  await p.keyboard.press('Escape');
  await p.waitForTimeout(250);
  check('Escape closes the composer',
    (await p.$eval('#knSheet', (n) => n.hidden)) === true);

  // =========================================================================
  // 7. NOTHING THREW
  // =========================================================================
  check('no uncaught error anywhere in the run',
    errors.length === 0, errors.slice(0, 3).join(' | ') || 'clean');

  await b.close();

  const passed = out.filter(Boolean).length;
  console.log('\n' + passed + '/' + out.length + ' passed');
  process.exit(passed === out.length ? 0 : 1);
})();
