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

  let p = await open();

  // ---- everyone ----
  let rows = await table(p);
  check('with no section chosen, every individual is listed',
    rows.length === 4, rows.map((r) => r.name).join(' | '));
  check('the note is not shown', await p.locator('#kpi1AllPeopleNote').isHidden());

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

  check('the note says whose list this is',
    await p.locator('#kpi1AllPeopleNote').isVisible() &&
    /people in Sales Applications/.test(await p.textContent('#kpi1AllPeopleNote')),
    (await p.textContent('#kpi1AllPeopleNote')).trim());
  check('and that the figures did not move',
    /reads the same here as it does with no filter/.test(
      await p.textContent('#kpi1AllPeopleNote')));

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
  check('and the note goes with it', await p.locator('#kpi1AllPeopleNote').isHidden());

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

  const note = await q.$eval('#kpi1AllPeopleNote', (el) => ({
    shown: !el.hidden, text: el.textContent
  }));
  check('and the table says so in its own words',
    note.shown && /KSL tickets only/.test(note.text) &&
    /not the whole caseload/.test(note.text),
    'a row of 2,664 on one screen and 812 on another needs explaining');

  // The two filters stack, and the note has to account for both.
  await q.selectOption('#fAllSection', 'Sales Applications');
  await q.waitForTimeout(600);
  const both = await q.$eval('#kpi1AllPeopleNote', (el) => el.textContent);
  check('the two filters stack, and the note names both',
    /KSL tickets only/.test(both) && /Sales Applications/.test(both),
    both.slice(0, 80));

  await q.selectOption('#fAllAffiliate', '');
  await q.waitForTimeout(700);
  const back = await q.$eval('#kpi1AllPeopleNote', (el) => el.textContent);
  check('and dropping the affiliate goes back to the whole caseload',
    /whole caseload/.test(back) && /reads the same here/.test(back),
    back.slice(0, 70));
  await q.close();

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
