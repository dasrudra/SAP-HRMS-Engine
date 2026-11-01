// The floating SLA button, and the two sheets behind it.
//
// WHAT IS ACTUALLY AT RISK
//
//   the words        Both sheets are quotations from a signed agreement.
//                    A line that does not make it onto the page, or a
//                    response time that lands in the wrong column, is the
//                    page misquoting a contract - and nothing about it
//                    looks broken.
//
//   the characters   The agreement uses an en dash and a >= sign. They
//                    went out once as "P1 a.." and "a.. 99.5%", because
//                    JSON.stringify turns an escape back into a real
//                    character and the page carrying it has no charset of
//                    its own. Asserted here against Config.gs, which is
//                    the only way to tell the right glyph from a wrong one
//                    that still renders.
//
//   the dialog       Escape, the backdrop, focus going in and coming back,
//                    and the page behind it holding still. A sheet that
//                    covers the screen and can only be dismissed by
//                    hitting one small circle is one people reload the
//                    page to escape.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/sla-test.js
const path = require('path'), fs = require('fs'), vm = require('vm');

const PAGE = process.env.EAS_PAGE || path.join(__dirname, 'harness', 'page.html');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');
const BROWSER = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// the source of truth
// ---------------------------------------------------------------------------
const box = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat
};
box.globalThis = box;
vm.createContext(box);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), box);
const CONFIG = vm.runInContext('CONFIG', box);
const LEVELS = CONFIG.SERVICE_LEVELS;
const SLA = CONFIG.SLA;

// ---------------------------------------------------------------------------
// what can be checked without a browser
// ---------------------------------------------------------------------------
// The SLA table and the KPI layers name the same three layers for two
// different reasons - one is a quotation, the other is how each KPI was
// matched to its definition sheet - so neither can be derived from the
// other. They can be compared, and they have to agree, or the Home page and
// this sheet describe two different companies.
const drift = vm.runInContext('slaLayerDrift()', box);
check('the SLA table and the KPI layers name the same three layers',
  drift.length === 0, drift.join(' / ') || 'no drift');

// The escaping helper, against the exact characters that broke.
const escaped = vm.runInContext('jsonAscii({ a: "P2 \\u2013 High", b: "\\u2265 99.5%" })', box);
check('jsonAscii leaves nothing but ASCII behind',
  !/[^\x20-\x7e]/.test(escaped) && escaped.indexOf('\\u2013') !== -1,
  escaped);

check('and what it writes still parses back to the same text',
  JSON.parse(escaped).a === 'P2 \u2013 High' &&
  JSON.parse(escaped).b === '\u2265 99.5%',
  JSON.parse(escaped).a + ' / ' + JSON.parse(escaped).b);

// An angle bracket in the wording must not be able to close the script tag
// it is printed inside.
const hostile = vm.runInContext('jsonAscii({ x: "a</script><b>" })', box);
check('and a closing script tag cannot survive it',
  hostile.indexOf('</script') === -1 && hostile.indexOf('\\u003c') !== -1,
  hostile);

let chromium = null;
try { chromium = require('playwright-core').chromium; } catch (e) { /* below */ }

if (!chromium || !fs.existsSync(BROWSER) || !fs.existsSync(PAGE)) {
  console.log('SKIP  browser half - ' +
    (!fs.existsSync(PAGE) ? 'no built page' : 'no Chromium at ' + BROWSER));
  const failedEarly = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failedEarly) + '/' + out.length + ' passed');
  process.exit(failedEarly ? 1 : 0);
}

const FILE = 'file://' + PAGE;

(async () => {
  const b = await chromium.launch({ executablePath: BROWSER });
  const errors = [];

  const open = async (query) => {
    const p = await b.newPage({ viewport: { width: 1480, height: 1000 } });
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

  // ---------------------------------------------------------------------------
  // the button itself
  // ---------------------------------------------------------------------------
  {
    const q = await open('?signin=1');
    check('the SLA button is not offered to somebody who is not signed in',
      (await q.$eval('#slaFab', (n) => n.hidden)) === true,
      'its sheets are company documents');
    await q.close();
  }

  const p = await open();

  check('signing in puts the button on screen',
    (await p.$eval('#slaFab', (n) => n.hidden)) === false);

  // Two floating circles over one scroll area. In the same corner, one of
  // them is unreachable at exactly the moment somebody wants it.
  const apart = await p.evaluate(() => {
    const a = document.getElementById('slaFab').getBoundingClientRect();
    const m = document.getElementById('msgr').getBoundingClientRect();
    return a.right < m.left || m.right < a.left;
  });
  check('and it does not sit on top of the Messages bubble', apart === true,
    'opposite corners');

  // It has to hold still to be pressed. A circle that drifts forever is a
  // moving target, and the browser driver will not click one at all.
  const steady = await p.evaluate(() => {
    const n = document.getElementById('slaBtn');
    const before = n.getBoundingClientRect().top;
    return new Promise((done) => setTimeout(() => {
      done(Math.abs(n.getBoundingClientRect().top - before) < 0.5);
    }, 700));
  });
  check('the button holds still rather than drifting', steady === true,
    'a wandering target is hard to hit and impossible to automate');

  // IT MUST NOT SIT ON THE FOOTER. It did: at 18px from the bottom it
  // covered the first words of "Enterprise Application Services ...". The
  // messenger on the other side is fine because the footer reserves 330px
  // of right-hand padding for it; this one has nothing reserved, so it has
  // to float clear on its own. Checked at two widths, because the footer
  // changes height on a phone.
  for (const width of [1480, 420]) {
    const q = await b.newPage({ viewport: { width: width, height: 1000 } });
    q.on('pageerror', (e) => errors.push(String(e)));
    await q.goto(FILE);
    await q.waitForTimeout(1700);
    const gap = await q.evaluate(() => {
      const fab = document.getElementById('slaFab').getBoundingClientRect();
      const foot = document.querySelector('.portal-foot').getBoundingClientRect();
      return Math.round(foot.top - fab.bottom);
    });
    check('at ' + width + 'px the button sits clear of the footer',
      gap >= 0, gap + 'px between the button and the footer');
    await q.close();
  }

  // The artwork, not lettering. It was three letters on a blue disc; what
  // was asked for is the handshake under its badge, which travels in the
  // stylesheet as a data URI so it cannot arrive late or not at all.
  const mark = await p.$eval('.sla-btn-mark', (n) => ({
    text: n.textContent.trim(),
    image: getComputedStyle(n).backgroundImage.slice(0, 30)
  }));
  check('the button shows the handshake icon rather than lettering',
    mark.text === '' && mark.image.indexOf('data:image/png') !== -1,
    'text "' + mark.text + '", background ' + mark.image);

  check('the two choices are hidden until it is pressed',
    (await p.$eval('#slaMenu', (n) => n.hidden)) === true &&
    (await p.$eval('#slaBtn', (n) => n.getAttribute('aria-expanded'))) === 'false');

  await p.click('#slaBtn');
  await p.waitForTimeout(350);

  const choices = await p.$$eval('.sla-choice', (ns) => ns.map((n) => n.textContent.trim()));
  check('pressing it offers exactly the two choices asked for',
    choices.length === 2 &&
    /Service levels$/.test(choices[0]) && /SLA$/.test(choices[1]),
    choices.join(' | '));

  check('and the button says it is open',
    (await p.$eval('#slaBtn', (n) => n.getAttribute('aria-expanded'))) === 'true');

  // ---------------------------------------------------------------------------
  // the service levels sheet
  // ---------------------------------------------------------------------------
  await p.click('.sla-choice[data-sheet="levels"]');
  await p.waitForTimeout(500);

  check('choosing Service levels opens the sheet, and puts the menu away',
    (await p.$eval('#slaSheet', (n) => n.hidden)) === false &&
    (await p.$eval('#slaMenu', (n) => n.hidden)) === true,
    await p.$eval('#slaSheetTitle', (n) => n.textContent.trim()));

  const shownLevels = await p.$$eval('#slaSheetBody .lvl', (ns) => ns.map((n) => ({
    name: n.querySelector('.lvl-head').textContent.trim(),
    items: Array.from(n.querySelectorAll('.lvl-list > li')).map((li) => {
      const sub = Array.from(li.querySelectorAll('.lvl-sub li')).map((s) => s.textContent.trim());
      const clone = li.cloneNode(true);
      const nested = clone.querySelector('.lvl-sub');
      if (nested) nested.remove();
      return { text: clone.textContent.trim(), sub: sub };
    })
  })));

  check('all three levels are there, named as the deck names them',
    JSON.stringify(shownLevels.map((l) => l.name)) ===
      JSON.stringify(LEVELS.levels.map((l) => l.name)),
    shownLevels.map((l) => l.name).join(' | '));

  const wantLines = LEVELS.levels.reduce((all, l) =>
    all.concat(l.items.map((i) => i.text)), []);
  const gotLines = shownLevels.reduce((all, l) => all.concat(l.items.map((i) => i.text)), []);
  check('every service in Config.gs is on the sheet, none dropped',
    JSON.stringify(gotLines) === JSON.stringify(wantLines),
    gotLines.length + ' of ' + wantLines.length);

  // The first level has one service with four things under it. Flattened,
  // the page would be claiming EAS does five first-level services.
  const wantSub = LEVELS.levels[0].items[0].sub || [];
  check('the four things under the first level stay under it',
    JSON.stringify(shownLevels[0].items[0].sub) === JSON.stringify(wantSub) &&
    shownLevels[0].items.length === 1,
    shownLevels[0].items.length + ' service(s), ' +
      shownLevels[0].items[0].sub.length + ' nested');

  // ---------------------------------------------------------------------------
  // closing it
  // ---------------------------------------------------------------------------
  check('the page behind the sheet stops scrolling while it is up',
    (await p.evaluate(() => document.body.style.overflow)) === 'hidden');

  await p.keyboard.press('Escape');
  await p.waitForTimeout(350);
  check('escape closes it',
    (await p.$eval('#slaSheet', (n) => n.hidden)) === true);

  check('and the page can scroll again',
    (await p.evaluate(() => document.body.style.overflow)) === '',
    'left as hidden, nothing on any page would scroll again');

  check('focus comes back to the button that opened it',
    (await p.evaluate(() => document.activeElement && document.activeElement.id)) === 'slaBtn',
    'otherwise somebody not using a mouse is left nowhere');

  // The backdrop closes it too.
  await p.click('#slaBtn');
  await p.waitForTimeout(300);
  await p.click('.sla-choice[data-sheet="sla"]');
  await p.waitForTimeout(500);
  await p.mouse.click(40, 40);          // outside the sheet
  await p.waitForTimeout(350);
  check('and so does clicking the backdrop',
    (await p.$eval('#slaSheet', (n) => n.hidden)) === true);

  // ---------------------------------------------------------------------------
  // the agreement
  // ---------------------------------------------------------------------------
  await p.click('#slaBtn');
  await p.waitForTimeout(300);
  await p.click('.sla-choice[data-sheet="sla"]');
  await p.waitForTimeout(500);

  const shownSla = await p.$$eval('#slaSheetBody .sla-layer', (ns) => ns.map((n) => ({
    no: n.querySelector('.sla-layer-no').textContent.trim(),
    title: n.querySelector('.sla-layer-head h3').textContent.trim(),
    rows: Array.from(n.querySelectorAll('.sla-row:not(.is-head)')).map((r) => ({
      cells: Array.from(r.children).map((c) => {
        const clone = c.cloneNode(true);
        const label = clone.querySelector('.sla-row-label');
        if (label) label.remove();
        return clone.textContent.trim();
      }),
      spans: !!r.querySelector('.is-span')
    }))
  })));

  check('every layer of the agreement is on the sheet',
    JSON.stringify(shownSla.map((l) => l.no + ' ' + l.title)) ===
      JSON.stringify(SLA.layers.map((l) => l.layer + ' ' + l.title)),
    shownSla.map((l) => l.no + ' ' + l.title).join(' | '));

  check('and every category under them',
    JSON.stringify(shownSla.map((l) => l.rows.map((r) => r.cells[0]))) ===
      JSON.stringify(SLA.layers.map((l) => l.rows.map((r) => r.category))),
    shownSla.reduce((n, l) => n + l.rows.length, 0) + ' rows');

  // THE COLUMNS. A response time printed under the target heading is the
  // page misquoting a contract, and it is the kind of thing a reader
  // believes because the table around it looks right.
  let wrong = [];
  SLA.layers.forEach(function (layer, i) {
    layer.rows.forEach(function (row, j) {
      const got = (shownSla[i].rows[j] || {}).cells || [];
      if (row.span) {
        if (got.length !== 3 || got[2] !== row.target) {
          wrong.push(row.category + ' (merged cell)');
        }
        return;
      }
      if (got.length !== 4 || got[2] !== row.response || got[3] !== row.target) {
        wrong.push(row.category);
      }
    });
  });
  check('each response time and target sits in its own column',
    wrong.length === 0, wrong.join('; ') || 'all rows line up');

  // The signed table merges the last two cells on one row. Printing the
  // same sentence twice, or inventing a response time it does not give,
  // would both be wrong in ways that read as normal.
  const merged = shownSla.reduce((all, l) =>
    all.concat(l.rows.filter((r) => r.spans).map((r) => r.cells[0])), []);
  const wantMerged = SLA.layers.reduce((all, l) =>
    all.concat(l.rows.filter((r) => r.span).map((r) => r.category)), []);
  check('the one merged cell in the agreement is merged on the page too',
    JSON.stringify(merged) === JSON.stringify(wantMerged),
    merged.join(', ') || 'none merged');

  // THE CHARACTERS. This shipped wrong once: an en dash read back as three
  // Latin-1 bytes, so the agreement said "P1 a..." on screen. Comparing the
  // rendered text to Config.gs is what tells a right glyph from a wrong one
  // that still renders.
  const flat = await p.$eval('#slaSheetBody', (n) => n.textContent);
  const badGlyph = /\u00c3|\u00e2\u0080|\u00a2\u20ac/.test(flat);
  check('the en dash and the >= sign survive the trip to the page',
    flat.indexOf('P1 \u2013 Critical') !== -1 &&
    flat.indexOf('\u2265 99.5% monthly availability') !== -1 &&
    !badGlyph,
    badGlyph ? 'mojibake on the page' : 'both render as one character each');

  await p.close();

  // ---------------------------------------------------------------------------
  // signing out takes it away
  // ---------------------------------------------------------------------------
  // The ?signin=1 check near the top was not enough and a mutant proved it:
  // the button starts hidden in the markup, so a page that never signs
  // anybody in passes whether or not anything hides it on the way out. The
  // case that matters is the other one - signed in, sheet open, and then
  // Sign out - because what is on screen then is a company document over a
  // locked screen.
  {
    const q = await open();
    check('(before) signed in, the button is there',
      (await q.$eval('#slaFab', (n) => n.hidden)) === false);

    await q.click('#slaBtn');
    await q.waitForTimeout(300);
    await q.click('.sla-choice[data-sheet="sla"]');
    await q.waitForTimeout(450);

    // NOT by pressing Sign out, which cannot be reached from here and
    // should not be: the sheet covers the page, and a modal that let the
    // buttons behind it be clicked would not be a modal. The session ends
    // the way it really does while something is open - the idle hour runs
    // out - which is also the only path that reaches showSignIn with a
    // sheet still up.
    await q.evaluate(() => {
      window.__setIdleAge(2 * 60 * 60 * 1000);
      window.__checkIdleNow();
    });
    await q.waitForTimeout(700);

    check('a session ending closes the sheet and takes the button away',
      (await q.$eval('#slaSheet', (n) => n.hidden)) === true &&
      (await q.$eval('#slaFab', (n) => n.hidden)) === true,
      'sheet hidden: ' + (await q.$eval('#slaSheet', (n) => n.hidden)) +
        ', button hidden: ' + (await q.$eval('#slaFab', (n) => n.hidden)));

    check('and it does not leave the sign-in page unable to scroll',
      (await q.evaluate(() => document.body.style.overflow)) === '',
      'the lock the sheet put on has to come off with it');
    await q.close();
  }

  // ---------------------------------------------------------------------------
  // the home page no longer carries the preview note
  // ---------------------------------------------------------------------------
  {
    const q = await open();
    check('the preview-figures line is gone from Home',
      (await q.$$eval('.portal-phase-note', (ns) => ns.length)) === 0,
      'removed as asked');
    await q.close();
  }

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
