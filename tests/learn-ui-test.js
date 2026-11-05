// The Learnings page, in a real browser.
//
// WHAT IS ACTUALLY AT RISK HERE, and it is not the colours.
//
//   THE TWO SCREENS CAN BOTH BE ON AT ONCE. They are two divs in one
//   section and the only thing keeping one of them away is a `hidden`
//   attribute set from JavaScript. Get that wrong and the reader renders
//   underneath the library, which looks like a page that has broken rather
//   than a page with a bug.
//
//   THE BUTTONS CAN LIE. Download and Open full document are dead until a
//   document is open, and "dead" has to mean no href - not grey paint over
//   a live link. A greyed button that still navigates is worse than one
//   that looks enabled.
//
//   THE FILTER CAN AGREE WITH ITSELF AND BE WRONG. Pressing SOP and getting
//   four cards proves nothing unless the four are the SOPs. Every filter
//   assertion here checks WHICH documents came back, not how many.
//
//   A HIDDEN ELEMENT MEASURES AS ZERO. scrollWidth and clientWidth on a
//   display:none subtree are both 0, so a clipping check against a closed
//   screen passes without looking at anything. Every measurement in here is
//   taken with the thing on screen, and the count of what was measured is
//   asserted alongside.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/learn-ui-test.js
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
    // about:blank in an iframe and the proxy's refusals are the fixture, not
    // the page. Everything else is a real error and fails the suite below.
    if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  await p.goto(FILE);
  await p.waitForTimeout(1500);

  // =========================================================================
  // 1. THE SECTION MAILBOXES ON THE ORGANOGRAM
  // =========================================================================
  await p.click('.portal-tab[data-view="team"]');
  await p.waitForTimeout(700);
  await p.click('#teamViewChart');
  await p.waitForTimeout(400);

  const bars = await p.$$eval('#teamChart .og-col', (ns) => ns.map((n) => {
    const mail = n.querySelector('.og-section-mail');
    const name = n.querySelector('.og-section-name');
    const r = mail ? mail.getBoundingClientRect() : null;
    return {
      section: name ? name.textContent.trim() : '',
      href: mail ? mail.getAttribute('href') : null,
      text: mail ? mail.querySelector('span').textContent.trim() : null,
      clipped: mail ? mail.querySelector('span').scrollWidth >
                      mail.querySelector('span').clientWidth + 1 : false,
      visible: r ? r.width > 0 && r.height > 0 : false
    };
  }));

  // THE HARNESS FIXTURE HAS THREE SECTIONS, not the real four - it has no
  // Manufacturing. So this does not assert a count: it asserts that every
  // column that IS drawn has a mailbox, and that each is the right one for
  // its own section name. That all four real sections resolve is proved
  // against CONFIG.ORG in learn-test.js, where the whole roster is in hand.
  const WANT = {
    'Supply Chain Applications': 'mailto:sca.eas@tekvision.com.bd',
    'Sales Applications': 'mailto:scua.eas@tekvision.com.bd',
    'Sales and Customer Applications': 'mailto:scua.eas@tekvision.com.bd',
    'Manufacturing Applications': 'mailto:ma.eas@tekvision.com.bd',
    'Financial Applications': 'mailto:fa.eas@tekvision.com.bd'
  };

  check('every section column on the chart carries its own mailbox',
    bars.length >= 3 && bars.every((s) => s.href),
    bars.map((s) => s.section + '=' + (s.href || 'NONE')).join(' '));

  const wrong = bars.filter((s) => s.href !== WANT[s.section]);
  check('and each one is the alias for that section, not a shared address',
    wrong.length === 0 && new Set(bars.map((s) => s.href)).size === bars.length,
    wrong.map((s) => s.section + ' got ' + s.href + ', wanted ' +
      WANT[s.section]).join('; ') ||
      bars.map((s) => s.section.slice(0, 12) + '=' +
        s.href.replace('mailto:', '')).join('  '));

  // MEASURED WITH THE CHART ON SCREEN. A hidden element reports both
  // scrollWidth and clientWidth as 0, so this assertion would pass on a
  // closed chart without looking at anything - which is exactly how a
  // clipping check went vacuous on this project once before. The count of
  // what was actually measured is asserted beside it, so a chart that
  // failed to open cannot read as a pass.
  check('no address is cut off in its column',
    bars.filter((s) => s.visible).length === bars.length &&
    bars.length >= 3 && !bars.some((s) => s.clipped),
    bars.filter((s) => s.visible).length + ' measured on screen, ' +
    bars.filter((s) => s.clipped).length + ' clipped');

  // =========================================================================
  // 2. THE LIBRARY
  // =========================================================================
  await p.click('.portal-tab[data-view="learnings"]');
  await p.waitForTimeout(700);

  const shown = await p.evaluate(() => ({
    library: !document.getElementById('lrnLibrary').hidden,
    reader: !document.getElementById('lrnReader').hidden,
    placeholder: /waiting for its words/i.test(
      document.getElementById('view-learnings').textContent)
  }));

  check('Learnings opens on the library and not on the reader',
    shown.library && !shown.reader,
    'library=' + shown.library + ' reader=' + shown.reader);

  check('and the Phase 5 placeholder is gone',
    !shown.placeholder);

  const stats = await p.$$eval('#lrnStats .lrn-stat', (ns) => ns.map((n) => ({
    n: n.querySelector('strong').textContent.trim(),
    label: n.querySelector('span').textContent.trim()
  })));
  check('the three figures are drawn from the library, not written in',
    stats.length === 3 && stats[0].n === '7' && stats[1].n === '3' &&
    stats[2].n === '3',
    stats.map((s) => s.n + ' ' + s.label).join(' | '));

  const cards = () => p.$$eval('#lrnGrid .lrn-card', (ns) => ns.map((n) =>
    n.querySelector('.lrn-card-title').textContent.trim()));

  const all = await cards();
  check('every document in the library has a card, with no folders in the way',
    all.length === 7, all.length + ' cards');

  // ---- the chips ----
  const chips = await p.$$eval('#lrnChips .lrn-chip', (ns) => ns.map((n) => ({
    label: n.textContent.replace(/\d+$/, '').trim(),
    group: n.getAttribute('data-group'),
    n: n.querySelector('.lrn-chip-n') ?
       n.querySelector('.lrn-chip-n').textContent.trim() : '',
    on: n.classList.contains('is-on')
  })));

  check('All is on to begin with, and nothing else is',
    chips[0].group === 'all' && chips[0].on &&
    chips.slice(1).every((c) => !c.on),
    chips.filter((c) => c.on).map((c) => c.label).join(',') || 'none');

  // A chip whose count is zero is a chip that says the page is broken.
  check('no chip offers a filter that would come back empty',
    chips.slice(1).every((c) => Number(c.n) > 0),
    chips.map((c) => c.label + ':' + c.n).join(' '));

  check('the chips cover type, module and business',
    ['type', 'module', 'biz'].every((g) =>
      chips.some((c) => c.group === g)),
    chips.map((c) => c.group).filter((v, i, a) => a.indexOf(v) === i).join(' '));

  // ---- filtering, checked by WHICH and not by how many ----
  await p.click('#lrnChips .lrn-chip[data-group="type"][data-value="SOP"]');
  await p.waitForTimeout(200);
  const sops = await cards();
  check('pressing SOP leaves the SOPs and only the SOPs',
    sops.length === 3 && sops.indexOf('Stock Transfer') !== -1 &&
    sops.indexOf('S4HANA Sales Overview') === -1,
    sops.join(' | '));

  const tally = await p.$eval('#lrnCount', (n) =>
    n.hidden ? '(hidden)' : n.textContent.trim());
  check('and the count says how much of the library is showing',
    tally === '3 of 7', tally);

  // ONE CHIP AT A TIME. These two used to assert the opposite - that a
  // second chip narrowed inside the first - and the behaviour was changed
  // deliberately: at 250 documents the chip still lit is off the side of
  // where the eye is, so four results read as a broken filter rather than
  // as an intersection nobody asked for. The depth of it is covered in
  // knowledge-ui-test, which drives the same row; this is the shape of it
  // where the row actually lives.
  await p.click('#lrnChips .lrn-chip[data-group="biz"][data-value="MG"]');
  await p.waitForTimeout(200);
  const both = await cards();
  check('a chip from another group replaces the first rather than narrowing it',
    both.length === 1 && both[0] === 'Stock Transfer' &&
    (await p.$$eval('#lrnChips .lrn-chip.is-on', (n) => n.length)) === 1,
    both.join(' | '));

  // Pressing the chip that is on turns it off, back to everything.
  await p.click('#lrnChips .lrn-chip[data-group="biz"][data-value="MG"]');
  await p.waitForTimeout(200);
  check('pressing a chip that is already on clears it',
    (await cards()).length === 7, (await cards()).length + ' cards');

  await p.click('#lrnChips .lrn-chip[data-group="type"][data-value="SOP"]');
  await p.waitForTimeout(150);
  await p.click('#lrnChips .lrn-chip[data-group="all"]');
  await p.waitForTimeout(200);
  check('All clears the chip that is on',
    (await cards()).length === 7 &&
    (await p.$eval('#lrnCount', (n) => n.hidden)) === true);

  // ---- the search box ----
  await p.fill('#lrnSearch', 'amortiz');
  await p.waitForTimeout(250);
  const searched = await cards();
  check('the search box finds a document by a word in its title',
    searched.length === 1 && searched[0] === 'Basic Principle of Amortization',
    searched.join(' | '));

  await p.fill('#lrnSearch', 'guideline');
  await p.waitForTimeout(250);
  check('and by its type, which is not in the title at all',
    (await cards()).join('') === 'SAP S4HANA MM Purchase Cycle',
    (await cards()).join(' | '));

  await p.fill('#lrnSearch', 'zzzz');
  await p.waitForTimeout(250);
  check('a search that matches nothing says so rather than going blank',
    (await p.$eval('#lrnGrid', (n) => /Nothing matches/.test(n.textContent))),
    (await p.$eval('#lrnGrid', (n) => n.textContent.trim().slice(0, 40))));

  await p.fill('#lrnSearch', '');
  await p.waitForTimeout(250);

  // =========================================================================
  // 3. FROM A CARD INTO THE READER
  // =========================================================================
  await p.click('#lrnGrid .lrn-card:nth-child(3)');
  await p.waitForTimeout(400);

  const reader = await p.evaluate(() => ({
    library: !document.getElementById('lrnLibrary').hidden,
    reader: !document.getElementById('lrnReader').hidden,
    title: document.getElementById('lrnDocTitle').textContent.trim(),
    meta: document.getElementById('lrnDocMeta').textContent.trim(),
    src: (document.querySelector('.lrn-frame') || {}).src || '',
    folder: (document.querySelector('.lrn-tree .lrn-folder.is-on') ||
             document.querySelector('.lrn-tree .lrn-sub.is-on') || {}).textContent || ''
  }));

  check('pressing a card opens the reader and closes the library',
    reader.reader && !reader.library,
    'library=' + reader.library + ' reader=' + reader.reader);

  check('with that document already up',
    reader.title === 'Basic Principle of Amortization', reader.title);

  check('and its preview in the frame, by the /preview address',
    /d3\/preview$/.test(reader.src), reader.src || '(no frame)');

  // EVERY KIND DRAWS A DIFFERENT SHAPE. The tiles used to carry three
  // letters, so "is a video marked as a video" was a string comparison.
  // They are glyphs now, and the one way they can be wrong that matters is
  // being the SAME glyph in a different colour - which is what a row of
  // tinted page outlines would have been, and is no better than the letters
  // it replaced. The signature is every shape's geometry in the tile.
  const glyphOf = (sel) => p.evaluate((s) => {
    const svg = document.querySelector(s + ' svg');
    if (!svg) return '';
    return Array.from(svg.children).map((n) =>
      n.tagName + ':' + (n.getAttribute('d') || n.getAttribute('width') ||
                         n.getAttribute('r') || '')).join('|');
  }, sel);

  const pdfGlyph = await glyphOf('#lrnDocIcon');
  const pdfTint = await p.$eval('#lrnDocIcon',
    (n) => getComputedStyle(n).backgroundColor);

  check('the meta line says where the document sits and how big it is',
    /MM/.test(reader.meta) && /RMG/.test(reader.meta) &&
    /SOP/.test(reader.meta) && /7\.2 MB/.test(reader.meta),
    reader.meta);

  // Landing in the reader with "All documents" selected would say nothing
  // about where the document actually lives.
  check('the tree opens at the folder the document came from',
    /RMG/.test(reader.folder), reader.folder.trim() || '(nothing selected)');

  // ---- the two buttons ----
  const acts = await p.evaluate(() => {
    const d = document.getElementById('lrnDownload');
    const o = document.getElementById('lrnOpen');
    return {
      label: o.textContent.trim(),
      dHref: d.getAttribute('href'), oHref: o.getAttribute('href'),
      dOff: d.classList.contains('is-off'), oOff: o.classList.contains('is-off')
    };
  });

  check('the second button says Open full document, not Open full screen',
    acts.label === 'Open full document', acts.label);

  check('both buttons are live once a document is open',
    !acts.dOff && !acts.oOff && acts.dHref && acts.oHref,
    'download=' + acts.dHref + ' open=' + acts.oHref);

  check('Open full document goes to Drive, not to the preview frame',
    /\/view$/.test(acts.oHref) && acts.oHref !== reader.src,
    acts.oHref);

  check('and Download is a third address again',
    /download$/.test(acts.dHref), acts.dHref);

  // =========================================================================
  // 4. THE TREE, AND THE LIST BESIDE THE DOCUMENT
  // =========================================================================
  const tree = await p.$$eval('#lrnTree .lrn-folder, #lrnTree .lrn-sub', (ns) =>
    ns.map((n) => ({
      cls: n.className.replace(/\s*is-on\s*/, ' ').trim(),
      label: n.textContent.replace(/\d+$/, '').trim(),
      mod: n.getAttribute('data-module'), biz: n.getAttribute('data-biz'),
      type: n.getAttribute('data-type')
    })));

  check('the tree lists the folders, with All documents at the top',
    tree[0].label === 'All documents' && tree[0].mod === '',
    tree.map((t) => t.label).join(' | '));

  check('and the modules under it, in the configured order',
    tree.filter((t) => t.mod && !t.biz && !t.type).map((t) => t.mod).join(' ') ===
      'Common MM SD',
    tree.filter((t) => t.mod && !t.biz && !t.type).map((t) => t.mod).join(' '));

  // RMG and MG are drawn only under the module being looked at.
  check('MG and RMG appear under the open module and nowhere else',
    tree.filter((t) => t.biz).length === 2 &&
    tree.filter((t) => t.biz).every((t) => t.mod === 'MM'),
    tree.filter((t) => t.biz).map((t) => t.mod + '/' + t.biz).join(' '));

  check('the by-type list is there as a second way through the same library',
    tree.filter((t) => t.type).length >= 3,
    tree.filter((t) => t.type).map((t) => t.type).join(' '));

  const files = () => p.$$eval('#lrnFiles .lrn-file', (ns) => ns.map((n) =>
    n.querySelector('strong').textContent.trim()));

  check('the list beside the document holds that folder, not the whole library',
    (await files()).length === 3 &&
    (await files()).indexOf('S4HANA Sales Overview') === -1,
    (await files()).join(' | '));

  const head = await p.$eval('.lrn-files-head', (n) => n.textContent.trim());
  check('and is headed with where you are',
    /MM/.test(head) && /RMG/.test(head), head);

  // ---- clicking a folder ----
  await p.click('#lrnTree .lrn-folder[data-module="SD"]');
  await p.waitForTimeout(300);

  check('picking another folder changes the list beside the document',
    (await files()).join('') === 'S4HANA Sales Overview',
    (await files()).join(' | '));

  // The document that was open is not in this folder, so leaving it up
  // would put it under a heading that does not contain it.
  const after = await p.evaluate(() => ({
    title: document.getElementById('lrnDocTitle').textContent.trim(),
    frame: Boolean(document.querySelector('.lrn-frame')),
    dOff: document.getElementById('lrnDownload').classList.contains('is-off'),
    oOff: document.getElementById('lrnOpen').classList.contains('is-off'),
    dHref: document.getElementById('lrnDownload').getAttribute('href')
  }));

  check('a document from another folder is closed rather than left up',
    after.title === 'Nothing open yet' && !after.frame, after.title);

  // THE WHOLE POINT OF is-off. A greyed button that still navigates is
  // worse than one that looks enabled.
  check('and the buttons go dead again - with no href, not just grey',
    after.dOff && after.oOff && after.dHref === null,
    'off=' + after.dOff + '/' + after.oOff + ' href=' + after.dHref);

  // ---- clicking a file in the list ----
  await p.click('#lrnFiles .lrn-file');
  await p.waitForTimeout(350);
  const vid = await p.evaluate(() => ({
    title: document.getElementById('lrnDocTitle').textContent.trim(),
    kind: document.getElementById('lrnDocIcon').getAttribute('data-kind'),
    // The accessible name, which is what somebody not seeing the glyph gets.
    mark: document.getElementById('lrnDocIcon').textContent.trim(),
    tint: getComputedStyle(document.getElementById('lrnDocIcon')).backgroundColor,
    src: (document.querySelector('.lrn-frame') || {}).src || '',
    on: document.querySelectorAll('#lrnFiles .lrn-file.is-on').length,
    live: !document.getElementById('lrnOpen').classList.contains('is-off')
  }));

  check('picking a file from the list opens it',
    vid.title === 'S4HANA Sales Overview' && vid.live, vid.title);

  const vidGlyph = await glyphOf('#lrnDocIcon');
  check('a video is marked as a video, not drawn as another PDF',
    vid.kind === 'video' && vid.mark === 'Video' &&
    vidGlyph && pdfGlyph && vidGlyph !== pdfGlyph,
    vid.kind + ' / "' + vid.mark + '" / glyph ' +
      (vidGlyph === pdfGlyph ? 'IDENTICAL to the PDF' : 'its own'));

  // A COLOUR PER FORMAT, AND NOT THE SAME ONE TWICE. Asserting only that
  // the tile has SOME background passes on the plain white-ish default
  // every .lrn-mark carries - so deleting the per-kind rules went through
  // untouched. What matters is that two formats do not look alike.
  const tints = await p.evaluate(() => {
    const seen = {};
    document.querySelectorAll('#lrnFiles .lrn-mark, #lrnDocIcon').forEach(function (n) {
      const k = n.getAttribute('data-kind');
      if (k && k !== 'none') seen[k] = getComputedStyle(n).backgroundColor;
    });
    return seen;
  });
  const vidTint = tints.video || vid.tint;
  check('and wears its own colour, not the PDF red',
    vidTint && vidTint !== pdfTint && vidTint !== 'rgba(0, 0, 0, 0)',
    'video ' + vidTint + ' vs pdf ' + pdfTint);

  // THE CARD AND THE READER HAVE TO AGREE ABOUT A FORMAT'S COLOUR. They
  // were two separate sets of rules, and when the card palette was redrawn
  // the reader's was left behind - so the same PDF was one red on a card
  // and a different red in the pane, for two kinds out of seven. Nothing
  // noticed, because every assertion looked at one surface or the other.
  const sameTint = await p.evaluate(() => {
    const out = {};
    document.querySelectorAll('#lrnFiles .lrn-mark').forEach(function (n) {
      const k = n.getAttribute('data-kind');
      if (k) out[k] = getComputedStyle(n).backgroundColor;
    });
    const pane = document.getElementById('lrnDocIcon');
    const kind = pane.getAttribute('data-kind');
    return { kind: kind, card: out[kind] || '(no card of that kind)',
             pane: getComputedStyle(pane).backgroundColor };
  });
  check('a format looks the same on a card as it does in the reader',
    sameTint.card === sameTint.pane,
    sameTint.kind + ': card ' + sameTint.card + ', pane ' + sameTint.pane);

  check('and exactly one row in the list is marked as the open one',
    vid.on === 1, vid.on + ' marked');

  // ---- by type ----
  await p.click('#lrnTree .lrn-folder[data-type="SOP"]');
  await p.waitForTimeout(300);
  check('the by-type list cuts across the folders',
    (await files()).length === 3 &&
    (await files()).indexOf('Stock Transfer') !== -1,
    (await files()).join(' | '));

  // =========================================================================
  // 5. BACK, AND WHAT SURVIVES IT
  // =========================================================================
  await p.click('#lrnBack');
  await p.waitForTimeout(300);
  check('All documents takes you back to the library',
    (await p.evaluate(() => !document.getElementById('lrnLibrary').hidden &&
                            document.getElementById('lrnReader').hidden)));

  check('and the library is still the whole library',
    (await cards()).length === 7, (await cards()).length + ' cards');

  // Leaving the tab and coming back must not re-fetch or lose the screen.
  await p.click('.portal-tab[data-view="home"]');
  await p.waitForTimeout(300);
  await p.click('.portal-tab[data-view="learnings"]');
  await p.waitForTimeout(400);
  check('leaving the page and returning does not empty it',
    (await cards()).length === 7, (await cards()).length + ' cards');

  // =========================================================================
  // 6. IT LOOKS RIGHT, AND IT IS NOT CREAM
  // =========================================================================
  const paint = await p.evaluate(() => {
    const card = document.querySelector('#lrnGrid .lrn-card');
    const tag = document.querySelector('#lrnGrid .lrn-tag.is-type');
    const cs = getComputedStyle(card);
    const r = card.getBoundingClientRect();
    return {
      bg: cs.backgroundColor,
      tagBg: getComputedStyle(tag).backgroundColor,
      font: cs.fontFamily,
      w: Math.round(r.width), h: Math.round(r.height),
      titleClipped: (() => {
        const t = card.querySelector('.lrn-card-title');
        return t.scrollWidth > t.clientWidth + 1;
      })()
    };
  });

  // THE CREAM THE TEAM CARDS USE IS #fcf8f1 = rgb(252, 248, 241). He asked
  // for something other than that, and a near-white card behind a white PDF
  // is the specific thing this page had to avoid.
  const rgb = (paint.bg.match(/\d+/g) || []).map(Number);
  check('the document cards are not the cream the team cards use',
    !(rgb[0] > 230 && rgb[1] > 230 && rgb[2] > 225), paint.bg);

  /*
    THE TEXT ON A CARD HAS TO BE READABLE ON IT.

    This replaced an assertion that the pane was simply DARK, which was
    the wrong property twice over. It passed on the first build, where the
    panes were so dark that a full library read as a grid of holes punched
    in the page; and when they were lightened to fix that, the assertion
    FAILED - on a change that made the page better. A test that fires on
    an improvement is worse than no test.

    What actually went wrong on that first build is that the module and
    business tags - the thing the eye scans at 250 documents - were the
    faintest marks on the card. So contrast is what is measured, by the
    standard definition, against the worst backdrop the card can sit on.

    WORST CASE IS THE LIGHTEST PART OF THE SKY, because the text is white:
    light text loses contrast over a light backdrop, not a dark one. The
    sky is a stack of radial gradients, so its stops are read out of the
    computed background-image and the lightest is used.
  */
  const contrast = await p.evaluate(() => {
    const num = (c) => (String(c).match(/[\d.]+/g) || []).map(Number);
    const rgba = (c) => { const v = num(c);
      return [v[0] || 0, v[1] || 0, v[2] || 0, v.length > 3 ? v[3] : 1]; };
    // Painting a translucent colour onto an opaque one.
    const over = (top, bot) => [0, 1, 2].map((i) =>
      top[i] * top[3] + bot[i] * (1 - top[3]));
    // WCAG relative luminance - sRGB has to be linearised first, which is
    // why this is not an average of the three channels.
    const lum = (c) => {
      const f = (v) => { const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const ratio = (a, b) => {
      const [hi, lo] = lum(a) >= lum(b) ? [a, b] : [b, a];
      return (lum(hi) + 0.05) / (lum(lo) + 0.05);
    };

    // Every colour stop in the sky, lightest first.
    const sky = getComputedStyle(document.querySelector('.portal-sky'));
    // OPAQUE STOPS ONLY, and the page surface is NOT a candidate. The
    // sky's bottom layer is a solid gradient and it covers the whole page
    // here, so the light surface under it is never behind a card. Including
    // it put rgb(242,245,249) forward as the worst case and reported every
    // piece of white text on the page as unreadable against a backdrop it
    // never touches.
    const stops = (sky.backgroundImage.match(/rgba?\([^)]+\)/g) || [])
      .map(rgba).filter((c) => c[3] > 0.9);
    const worst = stops.slice().sort((a, b) => lum(b) - lum(a))[0];

    const card = document.querySelector('#lrnGrid .lrn-card');
    const tag = card.querySelector('.lrn-tag:not(.is-type)');
    const title = card.querySelector('.lrn-card-title');
    const foot = card.querySelector('.lrn-card-foot span');

    const surface = over(rgba(getComputedStyle(card).backgroundColor), worst);
    const on = (el) => {
      const cs = getComputedStyle(el);
      const bg = rgba(cs.backgroundColor);
      const under = bg[3] > 0 ? over(bg, surface) : surface;
      return Math.round(ratio(over(rgba(cs.color), under), under) * 100) / 100;
    };

    return { tag: on(tag), title: on(title), foot: on(foot),
             worst: worst.map(Math.round).join(',') };
  });

  // 4.5 is the standard threshold for ordinary text; the title is large
  // and bold, where 3 is the usual allowance, but it should clear 4.5
  // comfortably and there is no reason to let it off.
  check('the module and business tags are readable on a card',
    contrast.tag >= 4.5, contrast.tag + ':1 over the lightest sky (' +
      contrast.worst + ')');

  check('and so are the title and the size and date under it',
    contrast.title >= 4.5 && contrast.foot >= 4.5,
    'title ' + contrast.title + ':1, footer ' + contrast.foot + ':1');

  // A type tag with no colour means the accent system is not wired up -
  // which is invisible unless something measures it.
  const tagRgb = (paint.tagBg.match(/\d+/g) || []).map(Number);
  check('the type tag carries a colour and is not left transparent',
    tagRgb.length >= 3 && (tagRgb[3] === undefined || tagRgb[3] > 0) &&
    !(tagRgb[0] === tagRgb[1] && tagRgb[1] === tagRgb[2]),
    paint.tagBg);

  // The .portal-cta bug: `font: 600 14px/1 inherit` is invalid, the whole
  // declaration is dropped, and a control falls back to 13.3px Arial. The
  // search input and the chips are the controls at risk here.
  const fonts = await p.evaluate(() => {
    const body = getComputedStyle(document.body).fontFamily;
    const of = (s) => {
      const n = document.querySelector(s);
      return n ? getComputedStyle(n).fontFamily : '(missing)';
    };
    return { body: body, search: of('#lrnSearch'), chip: of('.lrn-chip'),
             btn: of('.lrn-btn'), folder: of('.lrn-folder') };
  });
  check('no control has fallen back to the browser default font',
    [fonts.search, fonts.chip, fonts.btn, fonts.folder]
      .every((f) => f === fonts.body),
    JSON.stringify(fonts));

  check('no card title is cut off mid-word on one line',
    !paint.titleClipped && paint.w > 240,
    paint.w + 'x' + paint.h);

  /*
    THE NAVY HAS TO REACH THE BOTTOM OF THE CONTENT, and this assertion is
    here because nothing else noticed when it did not.

    The portal's sky is a fixed-height gradient at the top of the page and
    the surface below it is near-white. Every surface on this screen is
    translucent glass, so glass that falls past the end of the sky is not
    a lighter pane - it is a GREY SLAB. The first build of this page looked
    correct to all fifty assertions above, because each of them measured a
    colour, a class or a position and none of them measured what was
    BEHIND the cards. The screenshot showed a row of grey rectangles with
    chips on them that had all but disappeared.

    Measured on both screens, because they are different heights and the
    rule that fixes it is one line that could be written for either.
  */
  const skyCovers = async () => await p.evaluate(() => {
    const s = document.querySelector('.portal-sky').getBoundingClientRect();
    return { top: Math.round(s.top), bottom: Math.round(s.bottom),
             fold: window.innerHeight };
  });

  // MEASURED AGAINST THE WINDOW, NOT AGAINST THE CONTENT'S HEIGHT. .portal
  // is position:fixed at viewport height and the content scrolls inside
  // it, so the sky is a backdrop that stays put rather than a band as long
  // as the page. The first version of this compared the sky's bottom with
  // the content's and passed only because this page happens to be shorter
  // than one screen - it would have gone on passing with the backdrop
  // broken, and it reported a failure on the Knowledge page, which is
  // taller and renders correctly.
  const libSky = await skyCovers();
  check('the navy covers the whole window behind the library',
    libSky.top <= 0 && libSky.bottom >= libSky.fold,
    libSky.top + ' to ' + libSky.bottom + ' of ' + libSky.fold);

  await p.click('#lrnGrid .lrn-card');
  await p.waitForTimeout(400);

  // Scrolled to the bottom of the reader, which is where a backdrop only
  // as tall as its first paint would come apart.
  await p.evaluate(() => {
    const all = Array.from(document.querySelectorAll('#portalRoot *'));
    const scroller = all.filter(function (n) {
      return n.scrollHeight > n.clientHeight + 40;
    })[0] || document.scrollingElement;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await p.waitForTimeout(250);

  const readSky = await skyCovers();
  check('and still does in the reader, scrolled to the bottom',
    readSky.top <= 0 && readSky.bottom >= readSky.fold,
    readSky.top + ' to ' + readSky.bottom + ' of ' + readSky.fold);

  await p.click('#lrnBack');
  await p.waitForTimeout(250);

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
