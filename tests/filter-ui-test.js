// The By individuals SECTION filter, driven in a real browser.
//
// A section is a fact about a person - one desk, one team - so the filter
// narrows WHO is listed and leaves every figure beside them alone. A row reads
// the same whether the filter is on or off, which is the property a module
// filter could not have: Ayesha has 6 PP tickets and 2 MM, so under a module
// heading her row would have had to say either 8 (wrong for the heading) or 6
// (disagreeing with every other screen).
//
// The fixture has two people in Sales Applications, so "filter to a section"
// is distinguishable from "filter to one person".
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/filter-ui-test.js
//
// Needs playwright-core and a Chromium. Skips, loudly and successfully, when
// they are not installed - so `node tests/run.js` still works on a machine
// that has only Node.
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
      // The page loads Chart.js from a CDN this machine cannot reach. That is
      // the network, not the code.
      if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_BLOCKED/.test(m.text())) return;
      errors.push('console: ' + m.text());
    });
    await p.goto(FILE + (query || ''));
    await p.waitForTimeout(1800);
    return p;
  };

  // Each row as { name, received, rate }, so assertions read like the screen.
  const table = (p) => p.$$eval('#kpi1AllPeople tbody tr', (trs) => trs.map((tr) => {
    const c = Array.from(tr.cells).map((x) => x.textContent.trim());
    return { name: c[0], section: c[1], received: c[2], rate: c[7], band: c[8] };
  }));

  // ?view=kpi1 explicitly, now that signing in lands on the portal's Home.
  // Opening with no view at all would land this suite on a page with no
  // people table on it at all.
  let p = await open('?view=kpi1');

  // ---- everyone ----
  let rows = await table(p);
  check('with no section chosen, every individual is listed',
    rows.length === 4, rows.map((r) => r.name).join(' | '));
  const ayeshaAll = rows.filter((r) => r.name === 'Ayesha Rahman')[0];
  check('and a row reads her whole caseload',
    ayeshaAll.received === '8' && ayeshaAll.rate === '87.50%',
    ayeshaAll.received + ' at ' + ayeshaAll.rate);

  // ---- one section ----
  await p.selectOption('#fAllSection', 'Sales Applications');
  await p.waitForTimeout(400);
  rows = await table(p);

  check('choosing a section lists the people who sit in it',
    rows.length === 2 &&
    rows.every((r) => r.section === 'Sales Applications'),
    rows.map((r) => r.name).join(' | '));
  check('and nobody from another section, however their tickets fell',
    !rows.some((r) => r.name === 'Bilal Hossain' || r.name === 'Carim Uddin'),
    'Bilal is Supply Chain, Carim is Manufacturing');

  // THE PROPERTY THE MODULE FILTER COULD NOT HAVE.
  const ayeshaSales = rows.filter((r) => r.name === 'Ayesha Rahman')[0];
  check('her figures are identical to what they were with no filter on',
    ayeshaSales.received === ayeshaAll.received &&
    ayeshaSales.rate === ayeshaAll.rate &&
    ayeshaSales.band === ayeshaAll.band,
    ayeshaSales.received + ' at ' + ayeshaSales.rate + ' either way');

  // The amber line that used to explain this was removed on request. What it
  // asserted still has to be true, so it is asserted off the TABLE instead -
  // which is the better place for it anyway: a note can say the figures did
  // not move while the figures move.
  check('and the count beside the table says how many of how many',
    /2\b/.test(await p.textContent('#cAll')),
    (await p.textContent('#cAll')).trim());

  // ---- a section with one person in it ----
  await p.selectOption('#fAllSection', 'Supply Chain Applications');
  await p.waitForTimeout(400);
  rows = await table(p);
  check('a section with one person shows that one person',
    rows.length === 1 && rows[0].name === 'Bilal Hossain',
    rows.map((r) => r.name).join(' | ') || '(none)');

  check('every section in the table is offered, and nothing else',
    (await p.$$eval('#fAllSection option', (o) => o.map((x) => x.textContent))).join(' | ') ===
      'All sections | Manufacturing Applications | Sales Applications | Supply Chain Applications',
    (await p.$$eval('#fAllSection option', (o) => o.map((x) => x.textContent))).join(' | '));

  // ---- it ANDs with the filters beside it ----
  await p.selectOption('#fAllSection', 'Sales Applications');
  await p.fill('#fAllName', 'ayesha');
  await p.waitForTimeout(400);
  rows = await table(p);
  check('the section and the name search narrow together',
    rows.length === 1 && rows[0].name === 'Ayesha Rahman',
    rows.map((r) => r.name).join(' | ') || '(none)');

  await p.fill('#fAllName', 'bilal');
  await p.waitForTimeout(400);
  const empty = (await p.textContent('#kpi1AllPeople tbody')).replace(/\s+/g, ' ').trim();
  check('a combination that matches nobody says so rather than going blank',
    /Nobody in Sales Applications|No individuals match/.test(empty), empty);

  // ---- reset ----
  await p.click('#fAllReset');
  await p.waitForTimeout(400);
  rows = await table(p);
  check('Reset clears the section with everything else',
    rows.length === 4 && (await p.inputValue('#fAllSection')) === '',
    rows.length + ' rows');

  await p.close();

  // -------------------------------------------------------------------------
  // the affiliate filter
  // -------------------------------------------------------------------------
  // It is the OPPOSITE of the section filter beside it, and the pair is the
  // easiest thing on this screen to get wrong. A section is a fact about a
  // person, so it narrows who is listed and the figures do not move. An
  // affiliate is a fact about a ticket - nobody belongs to KSL - so it cannot
  // narrow a list of people, only re-add up their figures from that
  // affiliate's tickets.
  //
  // WHAT THIS HALF CAN AND CANNOT SHOW
  // A browser cannot run a .gs file, so the numbers below come from the
  // harness fixture, not from Kpi.gs. These assertions prove the dropdown is
  // filled, the note appears and the two filters stack - the PAGE's half.
  // They cannot catch a wrong figure: breaking readPeopleByAffiliate() on
  // purpose left this suite green from end to end. The arithmetic is held by
  // tests/affiliate-test.js, which runs the real readers.
  let q = await open('?view=kpi1');

  const options = await q.$$eval('#fAllAffiliate option',
                                 (ns) => ns.map((n) => n.textContent.trim()));
  check('the affiliate dropdown is filled from the tickets',
    options.length === 4 && options[0] === 'All affiliates' &&
    options.indexOf('KSL') !== -1,
    options.join(', '));
  check('including the ones with no affiliate on them',
    options.indexOf('(none given)') !== -1,
    'hiding them would make the filtered totals disagree with the whole');

  const whole = await q.$$eval('#kpi1AllPeople tbody tr', (trs) => trs.map((tr) => ({
    name: tr.cells[0].textContent.trim(), received: tr.cells[2].textContent.trim()
  })));

  await q.selectOption('#fAllAffiliate', 'KSL');
  await q.waitForTimeout(900);

  const ksl = await q.$$eval('#kpi1AllPeople tbody tr', (trs) => trs.map((tr) => ({
    name: tr.cells[0].textContent.trim(), received: tr.cells[2].textContent.trim()
  })));

  check('choosing one changes the figures, which is the point of it',
    ksl.length > 0 && ksl[0].received !== whole[0].received,
    whole[0].name + ': ' + whole[0].received + ' overall, ' +
    ksl[0].received + ' for KSL');
  check('and every row is smaller than its whole-caseload self',
    ksl.every(function (row) {
      const all = whole.filter((w) => w.name === row.name)[0];
      return !all || Number(row.received.replace(/,/g, '')) <=
                     Number(all.received.replace(/,/g, ''));
    }),
    'one affiliate cannot be more work than all of them');

  // The amber line explaining this was removed on request, so what it claimed
  // is read off the table itself. THE TWO FILTERS STACK: an affiliate narrows
  // nothing and re-adds the figures, a section narrows who is listed and
  // leaves them alone, and applying both has to do both.
  await q.selectOption('#fAllSection', 'Sales Applications');
  await q.waitForTimeout(700);
  const stacked = await q.$$eval('#kpi1AllPeople tbody tr', (trs) => trs.map((tr) => ({
    name: tr.cells[0].textContent.trim(),
    section: tr.cells[1].textContent.trim(),
    received: tr.cells[2].textContent.trim()
  })));

  check('the two filters stack - this section, that affiliate\'s figures',
    stacked.length > 0 &&
    stacked.every((r) => r.section === 'Sales Applications') &&
    stacked.every(function (r) {
      const whole = ksl.filter((k) => k.name === r.name)[0];
      return whole && whole.received === r.received;
    }),
    stacked.map((r) => r.name + ':' + r.received).join(' | '));

  await q.selectOption('#fAllAffiliate', '');
  await q.waitForTimeout(800);
  const back = await q.$$eval('#kpi1AllPeople tbody tr', (trs) => trs.map((tr) => ({
    name: tr.cells[0].textContent.trim(),
    received: tr.cells[2].textContent.trim()
  })));
  check('and dropping the affiliate puts the whole caseload back',
    back.every(function (r) {
      const all = whole.filter((w) => w.name === r.name)[0];
      return all && all.received === r.received;
    }),
    back.map((r) => r.name + ':' + r.received).join(' | '));
  await q.close();

  // ---------------------------------------------------------------------------
  // the two standards
  // ---------------------------------------------------------------------------
  // The same tickets, the same two formulas, two targets: the policy's 90%,
  // which is what TVL headquarters is shown, and the EAS team's own 99.50%.
  // Nothing about the DATA changes - the counts are facts - so what has to
  // move when the toggle moves is the target, the achievement, the band and
  // the headroom, on every table on the page at once.
  let z = await open('?view=kpi1');

  const opts = await z.$$eval('.standard-opt', (ns) => ns.map((n) => ({
    standard: n.getAttribute('data-standard'),
    text: n.textContent.replace(/\s+/g, ' ').trim(),
    on: n.classList.contains('is-on'),
    pressed: n.getAttribute('aria-pressed')
  })));

  check('both standards are on screen, not hidden behind a dropdown',
    opts.length === 2 && opts[0].standard === 'COMPANY' &&
    opts[1].standard === 'EAS',
    opts.map((o) => o.text).join('  |  '));
  check('each carries its own target, so the choice explains itself',
    /90%/.test(opts[0].text) && /99\.5%/.test(opts[1].text),
    'the figures come from CONFIG, not from the markup');
  check('the page starts on the one that gets reported upward',
    opts[0].on === true && opts[0].pressed === 'true' && opts[1].on === false,
    'a wrong default is safest when it is the figure TVL already sees');

  const totals = () => z.$$eval('#kpi1Tiles .tile', (ns) =>
    ns.map((n) => n.textContent.replace(/\s+/g, ' ').trim()).join(' ~ '));
  const rowsNow = () => z.$$eval('#kpi1AllPeople tbody tr', (trs) => trs.map((tr) => ({
    name: tr.cells[0].textContent.trim(),
    received: tr.cells[2].textContent.trim(),
    rate: tr.cells[7].textContent.trim(),
    band: tr.cells[8].textContent.trim()
  })));

  const companyRows = await rowsNow();
  const companyTiles = await totals();

  await z.click('.standard-opt[data-standard="EAS"]');
  await z.waitForTimeout(900);

  const easRows = await rowsNow();
  const easTiles = await totals();

  check('choosing the other one re-reads the page',
    easTiles !== companyTiles, 'the tiles are scored against a new target');

  // THE COUNTS ARE FACTS. A target cannot change what happened.
  check('the ticket counts do not move, because a target cannot move them',
    companyRows.length === easRows.length &&
    companyRows.every((r, i) => r.received === easRows[i].received &&
                                r.rate === easRows[i].rate),
    companyRows.map((r) => r.received).join(',') + ' either way');

  // ...and the judgement does. Somebody at 97.50% is passing the policy and
  // failing the team's own standard, which is the entire point of having both.
  const moved = companyRows.filter((r, i) => r.band !== easRows[i].band);
  check('but the bands do, for anybody between the two targets',
    moved.length > 0,
    moved.map((r, i) => r.name + ' ' + r.rate).join(', ') || 'nothing moved');

  check('and the toggle shows which one is on now',
    (await z.$eval('.standard-opt[data-standard="EAS"]',
                   (n) => n.classList.contains('is-on'))) === true &&
    (await z.$eval('.standard-opt[data-standard="COMPANY"]',
                   (n) => n.getAttribute('aria-pressed'))) === 'false');

  // The line that named the source document under the toggle was removed on
  // request. The toggle itself still has to say which standard is on, and
  // which document stands behind it is still carried as the hover - and into
  // the downloaded report, which is checked further down.
  check('and the chosen option names its standard and its target',
    /EAS KPI/.test(await z.$eval('.standard-opt[data-standard="EAS"]',
                                 (n) => n.textContent)) &&
    /Layer 3/.test(await z.$eval('.standard-opt[data-standard="EAS"]',
                                 (n) => n.getAttribute('title') || '')),
    await z.$eval('.standard-opt[data-standard="EAS"]',
                  (n) => (n.getAttribute('title') || '').slice(0, 50)));

  // The affiliate slice is a SEPARATE server call, so switching standard has
  // to go back for it too. Left alone it would sit in the same table as rows
  // that had just been re-scored, still wearing the other standard's bands.
  //
  // Counted rather than read off the screen: this fixture's people have two
  // to eight tickets each, so the only rates it can produce are 0%, 80% and
  // 100%, and none of those falls between the two targets. The bands would be
  // identical whether the slice was re-read or left stale, and an assertion
  // on them would pass either way. The server side of this - a slice that
  // really does change band - is held in tests/standard-test.js, where the
  // fixture is built with enough tickets to land at 98%.
  await z.selectOption('#fAllAffiliate', 'KSL');
  await z.waitForTimeout(900);

  const before = await z.evaluate(() =>
    (window.__calls && window.__calls.getPeopleByAffiliate) || 0);
  await z.click('.standard-opt[data-standard="COMPANY"]');
  await z.waitForTimeout(1000);
  const after = await z.evaluate(() =>
    (window.__calls && window.__calls.getPeopleByAffiliate) || 0);

  check('switching standard goes back for the affiliate slice as well',
    after === before + 1,
    before + ' -> ' + after + ' calls');
  check('and the rows are still there afterwards',
    (await rowsNow()).length > 0, 'not blanked by the re-read');

  // ---------------------------------------------------------------------------
  // and the screens that are NOT the toggle's own page
  // ---------------------------------------------------------------------------
  // The Summary table shows KPI 1's target and band edges beside a reading
  // taken from the same state the toggle scores. If the target came from the
  // policy while the figure came from the team's own standard, that one row
  // would disagree with itself - a rate shown in red against a target it
  // clears. The same class of defect as the Comparison screen reading stored
  // verdicts, which is written up at length in Kpi.gs.
  const summaryTarget = async () => {
    await z.evaluate(() => {
      const nav = document.querySelector('.nav-item[data-view="settings"]');
      if (nav) nav.click();
    });
    await z.waitForTimeout(700);
    return z.$eval('#settingsTable tbody tr[data-key="KPI1"] .thr-target',
                   (n) => n.textContent.trim());
  };

  const onCompany = await summaryTarget();
  await z.evaluate(() => {
    const nav = document.querySelector('.nav-item[data-view="kpi1"]');
    if (nav) nav.click();
  });
  await z.waitForTimeout(500);
  await z.click('.standard-opt[data-standard="EAS"]');
  await z.waitForTimeout(900);
  const onEas = await summaryTarget();

  check('the Summary row follows the toggle rather than contradicting it',
    /90/.test(onCompany) && /99\.5/.test(onEas),
    onCompany + ' -> ' + onEas);
  check('and says in its basis that this is not the reported figure',
    /not the figure reported/i.test(
      await z.$eval('#kpi1Layer', (n) => n.getAttribute('data-basis') || '')),
    await z.$eval('#kpi1Layer', (n) =>
      (n.getAttribute('data-basis') || '').slice(-46)));

  // ---------------------------------------------------------------------------
  // and the Comparison screen, which had it wrong in both directions
  // ---------------------------------------------------------------------------
  // Reported off a screen recording: EAS KPI selected on KPI 1, walk to
  // Comparison, and the caption under WHICH KPI reads "Target >= 90%" while
  // the chart immediately below it draws a line labelled "Target 99.5%". One
  // screen, two targets, and no way to tell which one the table had been
  // scored against.
  //
  // Two separate faults sat behind that. selectedKpi() returned the entry out
  // of the bootstrap's kpiList, and kpiList is built from CONFIG.KPI - which
  // carries the policy's definition and nothing else - so the caption could
  // never follow the toggle. And a comparison already RUN stayed on screen,
  // banded against whichever standard was on when the button was pressed.
  const goTo = async (view) => {
    await z.evaluate((v) => {
      const nav = document.querySelector('.nav-item[data-view="' + v + '"]');
      if (nav) nav.click();
    }, view);
    await z.waitForTimeout(700);
  };
  const caption = () => z.$eval('#cmpKpiHint', (n) => n.textContent.trim());

  // The Summary block above left the toggle on EAS.
  await goTo('compare');
  const capEas = await caption();

  await goTo('kpi1');
  await z.click('.standard-opt[data-standard="COMPANY"]');
  await z.waitForTimeout(900);
  await goTo('compare');
  const capCompany = await caption();

  check('the caption under WHICH KPI names the target the toggle is on',
    /99\.5%/.test(capEas) && !/90%/.test(capEas) &&
    /90%/.test(capCompany) && !/99\.5%/.test(capCompany),
    capEas + '   ->   ' + capCompany);

  // data-basis is not decoration: it is what gets written into the file when
  // the comparison is downloaded as a report, so a saved PDF that says 90%
  // over EAS figures outlives the screen that produced it.
  const basis = () => z.$eval('#cmpKpiHint', (n) => n.getAttribute('data-basis') || '');
  const basisCompany = await basis();
  await goTo('kpi1');
  await z.click('.standard-opt[data-standard="EAS"]');
  await z.waitForTimeout(900);
  await goTo('compare');
  const basisEas = await basis();

  check('and the basis that travels into the downloaded report follows it too',
    /not the figure reported/i.test(basisEas) &&
    !/not the figure reported/i.test(basisCompany),
    basisEas.slice(-44));

  // ---- a comparison that has already been RUN ----
  // Sales Applications in September is 99 of 100: 99.00%, which clears the
  // policy's 90% and misses the team's 99.50%. It is the only cell in the
  // fixture that sits between the two targets, so it is the only one that can
  // tell a re-read from a stale table.
  await goTo('kpi1');
  await z.click('.standard-opt[data-standard="COMPANY"]');
  await z.waitForTimeout(900);
  await goTo('compare');

  await z.selectOption('#cmpM1', '2026-09');
  await z.selectOption('#cmpM2', '2026-08');
  await z.click('#cmpRun');
  await z.waitForTimeout(1200);

  // The column is found by its heading rather than counted to. Counting is
  // how the first draft of this went wrong: the periods come back sorted
  // oldest-first, so cells[1] is August, and August reads 99.75% - which
  // clears both targets and would have sat there passing under either one.
  const salesCell = () => z.evaluate(() => {
    const head = Array.from(document.querySelectorAll('#cmpSections thead th'))
                      .map((th) => th.textContent.trim());
    const at = head.findIndex((h) => /Sep/i.test(h));
    const row = Array.from(document.querySelectorAll('#cmpSections tbody tr'))
                     .filter((tr) => /Sales Applications/.test(tr.cells[0].textContent))[0];
    if (at < 1 || !row) return '(no September column: ' + head.join('|') + ')';
    return row.cells[at].textContent.replace(/\s+/g, ' ').trim();
  });
  const ranCompany = await salesCell();

  check('a comparison runs and is scored against the standard that is on',
    /^99\.00% GREEN$/i.test(ranCompany), ranCompany);

  // The sequence off the recording: switch standard on KPI 1, walk back.
  await goTo('kpi1');
  await z.click('.standard-opt[data-standard="EAS"]');
  await z.waitForTimeout(900);
  await goTo('compare');
  await z.waitForTimeout(1200);
  const ranEas = await salesCell();

  check('and switching standard re-runs it rather than leaving the old bands up',
    /^99\.00% YELLOW$/i.test(ranEas), ranCompany + '   ->   ' + ranEas);

  // Not implied by the two above: they would both still hold if the rate had
  // been rescored along with the band. The counts are facts - 99 completed of
  // 100 is 99.00% whichever document you hold it against - so the ONLY thing
  // allowed to have moved between those two readings is the verdict.
  check('and only the verdict moved, because a target cannot move a count',
    ranCompany.split(' ')[0] === ranEas.split(' ')[0] &&
    ranCompany.split(' ')[1] !== ranEas.split(' ')[1],
    ranCompany.split(' ')[0] + ' either way, ' +
    ranCompany.split(' ')[1] + ' -> ' + ranEas.split(' ')[1]);

  await z.close();

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
