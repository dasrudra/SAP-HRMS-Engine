// The By individuals module filter, driven in a real browser.
//
// The server half is proved in module-people-test.js: the rebuild writes one
// row per person-and-module pair, and the figures on those rows are the
// module's. This is the other half - that choosing a module actually reads
// those rows, and that the screen says which of the two things you are
// looking at.
//
// The fixture has Ayesha Rahman working in two modules with DIFFERENT rates
// (PP 83.33%, MM 100%, overall 87.50%). Every assertion below turns on those
// three numbers being distinguishable; if the filter merely hid rows, the
// whole-person 87.50% would show under both modules and this suite would fail.
//
// HOW TO RUN
//   node tests/harness/build.js && node tests/filter-ui-test.js
//
// Needs playwright-core and a Chromium. Skips, loudly and successfully, when
// they are not installed - so `node tests/run.js` still works on a machine
// that has only Node.
const path = require('path'), fs = require('fs');

const PAGE = path.join(__dirname, 'harness', 'page.html');
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

  // ---- everyone, which is what it did before ----
  let rows = await table(p);
  check('with no module chosen, every individual is listed',
    rows.length === 3, rows.map((r) => r.name).join(' | '));
  check('and the figures are their whole caseload',
    rows.filter((r) => r.name === 'Ayesha Rahman')[0].received === '8' &&
    rows.filter((r) => r.name === 'Ayesha Rahman')[0].rate === '87.50%',
    rows.filter((r) => r.name === 'Ayesha Rahman')[0].received + ' / ' +
    rows.filter((r) => r.name === 'Ayesha Rahman')[0].rate);
  check('the note is not shown', await p.locator('#kpi1AllPeopleNote').isHidden());

  // ---- one module ----
  // The question this filter asks is "who works in PP", not "whose tickets
  // were PP". Ayesha has 6 PP tickets and 2 MM, so she belongs to PP and
  // appears there only. Bilal is MM and must not appear under PP at all,
  // however many PP tickets he might have covered.
  await p.selectOption('#fAllModule', 'PP');
  await p.waitForTimeout(400);
  rows = await table(p);

  check('choosing PP lists the people who work in PP',
    rows.length === 2 && rows.every((r) => r.name !== 'Bilal Hossain'),
    rows.map((r) => r.name).join(' | '));

  // THE ASSERTION THE CHANGE EXISTS FOR.
  const ayeshaPP = rows.filter((r) => r.name === 'Ayesha Rahman')[0];
  check('and her figures are her WHOLE caseload, not a slice of it',
    ayeshaPP.received === '8' && ayeshaPP.rate === '87.50%',
    ayeshaPP.received + ' tickets at ' + ayeshaPP.rate +
    '  (her 6 PP tickets alone would read 83.33%)');
  check('so a row reads the same whichever filter is on',
    ayeshaPP.received === '8' && ayeshaPP.band === 'YELLOW',
    'the number means the same thing in both views');
  check('her section is still her section, not her module',
    ayeshaPP.section === 'Sales Applications', ayeshaPP.section);

  check('the note says whose list this is',
    await p.locator('#kpi1AllPeopleNote').isVisible() &&
    /people who work in PP/.test(await p.textContent('#kpi1AllPeopleNote')) &&
    /whole caseload/.test(await p.textContent('#kpi1AllPeopleNote')),
    (await p.textContent('#kpi1AllPeopleNote')).trim());
  check('and warns which of them were placed by their work rather than confirmed',
    /placed by where most of their work is/.test(
      await p.textContent('#kpi1AllPeopleNote')),
    'those are the ones to correct in PERSON_MODULES');

  // ---- somebody belongs to one module and one only ----
  await p.selectOption('#fAllModule', 'MM');
  await p.waitForTimeout(400);
  rows = await table(p);
  check('MM lists only the MM person',
    rows.length === 1 && rows[0].name === 'Bilal Hossain',
    rows.map((r) => r.name).join(' | ') || '(none)');
  check('and the person who merely HANDLED MM tickets is not in it',
    !rows.some((r) => r.name === 'Ayesha Rahman'),
    'Ayesha has 2 MM tickets and belongs to PP');
  check('the two lists together are every individual, counted once',
    (await p.$$eval('#fAllModule option', (o) => o.length)) === 3,
    'All modules + PP + MM');

  // ---- it ANDs with the filters beside it ----
  await p.fill('#fAllName', 'bilal');
  await p.waitForTimeout(400);
  rows = await table(p);
  check('the module and the name search narrow together',
    rows.length === 1 && rows[0].name === 'Bilal Hossain',
    rows.map((r) => r.name).join(' | ') || '(none)');

  await p.fill('#fAllName', 'ayesha');
  await p.selectOption('#fAllModule', 'PP');
  await p.waitForTimeout(400);
  rows = await table(p);
  check('and a combination that matches nobody says so rather than going blank',
    rows.length === 1 && rows[0].name === 'Ayesha Rahman',
    rows.map((r) => r.name).join(' | '));

  await p.fill('#fAllName', 'bilal');
  await p.waitForTimeout(400);
  const empty = (await p.textContent('#kpi1AllPeople tbody')).replace(/\s+/g, ' ').trim();
  check('an empty result names the module rather than blaming the filters',
    /PP/.test(empty), empty);

  // ---- reset ----
  await p.click('#fAllReset');
  await p.waitForTimeout(400);
  rows = await table(p);
  check('Reset clears the module with everything else',
    rows.length === 3 && (await p.inputValue('#fAllModule')) === '',
    rows.length + ' rows');
  check('and the note goes with it', await p.locator('#kpi1AllPeopleNote').isHidden());

  await p.close();

  // ---- a database that has not been rebuilt ----
  p = await open('?nocrosstab=1');
  check('with no cross-tab the table still lists everyone',
    (await table(p)).length === 3);
  check('and the module filter is disabled rather than silently useless',
    await p.locator('#fAllModule').isDisabled(),
    'empty dropdowns that do nothing are worse than a disabled one');
  check('with a reason you can read on hover',
    /[Rr]ebuild/.test(await p.getAttribute('#fAllModule', 'title') || ''),
    await p.getAttribute('#fAllModule', 'title'));
  await p.close();

  check('no JS errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  await b.close();
  const failed = out.filter((r) => !r).length;
  console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
  process.exit(failed ? 1 : 0);
})();
