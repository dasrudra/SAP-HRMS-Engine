// KPI 1, scored against both of its standards.
//
// The same tickets, the same two formulas, two different targets:
//
//   Company KPI   >= 90.00%   TVL-KPI-001 v1.0, section 5.3
//                             green >= 90, yellow 85.00-89.99, red < 85
//   EAS KPI       >= 99.50%   Layer 3 TVL-EAS KPI
//                             green >= 99.50, yellow 89.55-99.49, red < 89.55
//
// WHAT THIS SUITE IS GUARDING
// Nothing about the DATA differs between the two - the counts on KPI_MONTHLY
// are facts about what happened and no target can change them. What differs
// is the judgement: achievement, band and headroom. So the thing that can go
// wrong is not "the wrong number" but "the right number judged against the
// wrong target", which looks entirely plausible on screen. This project has
// already shipped that exact defect once, when the target moved from 99.50 to
// 90.00 and the Comparison screen went on reading the stored verdicts while
// KPI 1 recomputed - one screen said GREEN and the other YELLOW about the
// same section in the same month, and only the one section that fell between
// the two targets showed it.
//
// The fixture below is built so that EVERY band transition is crossed by at
// least one section, including the two that only exist because there are two
// standards: 99.00% is GREEN for the company and YELLOW for EAS, and 88.00%
// is YELLOW for the company and RED for EAS.
//
//   node tests/standard-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a spreadsheet just real enough
// ---------------------------------------------------------------------------
function makeSheet(name, rows) {
  const sheet = {
    name: name,
    rows: rows,
    getLastRow: () => sheet.rows.length + 1,
    getRange: function (r, c, n, w) {
      if (!(n >= 1) || !(w >= 1)) {
        throw new Error('The number of rows in the range must be at least 1');
      }
      return {
        getValues: function () {
          const got = [];
          for (let i = 0; i < n; i++) {
            got.push((sheet.rows[r - 2 + i] || []).slice(c - 1, c - 1 + w));
          }
          return got;
        },
        setValues: function (values) {
          values.forEach(function (v, i) {
            const at = r - 2 + i;
            if (!sheet.rows[at]) sheet.rows[at] = [];
            v.forEach(function (cell, j) { sheet.rows[at][c - 1 + j] = cell; });
          });
          return this;
        },
        clearContent: function () {
          for (let i = 0; i < n; i++) sheet.rows[r - 2 + i] = [];
          sheet.rows.length = 0;
          return this;
        },
        setNumberFormat: function () { return this; }
      };
    }
  };
  return sheet;
}

// ---------------------------------------------------------------------------
// four sections, one per cell of the truth table
// ---------------------------------------------------------------------------
//                       completed  delayed     rate   COMPANY   EAS
//   Clearwater             20         0      100.00%   GREEN    GREEN
//   Nearly                100         1       99.00%   GREEN    YELLOW   <-
//   Middling               25         3       88.00%   YELLOW   RED      <-
//   Struggling             20         4       80.00%   RED      RED
//
// The two marked rows are the whole reason this suite exists: they are the
// months that read differently depending on which standard is on, and they
// are the ones a wrong target would make look perfectly reasonable.
//
// INVENTED NAMES, ON PURPOSE. This repository is public, and a fixture that
// hung a RED month on a real colleague's name would read as a statement about
// that person's work.
const SECTIONS = [
  { name: 'Clearwater Applications', who: 'Ayesha Clear',   total: 20,  delayed: 0 },
  { name: 'Nearly Applications',     who: 'Bilal Nearly',   total: 100, delayed: 1 },
  { name: 'Middling Applications',   who: 'Carim Middling', total: 25,  delayed: 3 },
  { name: 'Struggling Applications', who: 'Dina Struggle',  total: 20,  delayed: 4 }
];

const sb = {
  console, Object, String, Number, Array, Math, JSON, RegExp,
  isFinite, Boolean, Error, parseInt, parseFloat, Infinity, Set,
  Date: Date,
  Logger: { log: () => {} },
  Utilities: { getUuid: () => 'uuid', formatDate: (d) => String(d) }
};
sb.globalThis = sb;
vm.createContext(sb);

vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Ingest.gs'), 'utf8')
  .match(/const COL = \(function[\s\S]*?\}\)\(\);/)[0], sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Ingest.gs'), 'utf8')
  .match(/function truthy[\s\S]*?\n}/)[0], sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8')
  .match(/function monthKey[\s\S]*?\n}/)[0], sb);
vm.runInContext('function requireSignedIn() {}', sb);

const CONFIG = vm.runInContext('CONFIG', sb);
const COL = vm.runInContext('COL', sb);

const ticketRows = [];
SECTIONS.forEach(function (s, si) {
  for (let i = 0; i < s.total; i++) {
    const row = new Array(COL.WIDTH).fill('');
    row[COL.TICKET_ID]    = 'T-' + si + '-' + i;
    row[COL.SERVICE]      = 'SAP';
    row[COL.PART]         = 'PP Production';
    row[COL.AFFILIATE]    = i % 2 ? 'KSL' : 'TVL';
    row[COL.REQUEST_DATE] = '2026-08-05';
    row[COL.COMPLETION]   = '2026-08-07';
    row[COL.DELAY_DAYS]   = i < s.delayed ? 2 : 0;
    row[COL.IN_CHARGE]    = s.who;
    row[COL.DEPARTMENT]   = s.name;
    row[COL.IN_DEPT]      = true;
    row[COL.IN_OVERALL]   = true;
    ticketRows.push(row);
  }
});

const tabs = {};
tabs[CONFIG.SHEETS.TICKETS]   = makeSheet('TICKETS', ticketRows);
tabs[CONFIG.SHEETS.KPI_MONTH] = makeSheet('KPI_MONTHLY', []);
vm.runInContext('function sheetFor(name) { return TABS[name]; }', sb);
sb.TABS = tabs;

vm.runInContext(fs.readFileSync(path.join(SRC, 'Kpi.gs'), 'utf8'), sb);
vm.runInContext('recomputeKpiCache()', sb);

const readKpi1 = vm.runInContext('readKpi1', sb);
const readByAffiliate = vm.runInContext('readPeopleByAffiliate', sb);
const comparison = vm.runInContext('getKpiComparison', sb);
const standardOf = vm.runInContext('resolutionStandard', sb);
const bandFor = vm.runInContext('bandFor', sb);
const achievementFor = vm.runInContext('achievementFor', sb);

const COMPANY = CONFIG.KPI.RESOLUTION;
const EAS = CONFIG.KPI.RESOLUTION_EAS;

// ---------------------------------------------------------------------------
// the two definitions
// ---------------------------------------------------------------------------
check('the policy standard is the one the dashboard starts on',
  COMPANY.target === 90 && COMPANY.yellowFloor === 85 &&
  COMPANY.standard === 'COMPANY',
  'green >= ' + COMPANY.target + ', red below ' + COMPANY.yellowFloor);
check('and the team\'s own is the signed sheet\'s 99.50',
  EAS.target === 99.5 && EAS.yellowFloor === 89.55 && EAS.standard === 'EAS',
  'green >= ' + EAS.target + ', red below ' + EAS.yellowFloor);

// 89.55 is not a round number by accident: it is 90% of 99.50, which is what
// puts the EAS sheet's three bands at achievement >= 100%, 90-99.99% and
// < 90% exactly as its threshold table prints them.
check('the EAS red line is where 90% achievement falls',
  Math.abs(EAS.yellowFloor - EAS.target * 0.9) < 0.005,
  EAS.yellowFloor + ' = 90% of ' + EAS.target);

// THE DIFFERENCE IS THE LIST, AND NOTHING ELSE. Two hand-maintained copies
// would drift: a corrected formula string or SLA layer would land on one and
// not the other, and the two screens would quietly describe themselves
// differently while claiming to measure the same thing.
const differs = Object.keys(COMPANY).concat(Object.keys(EAS))
  .filter((k, i, a) => a.indexOf(k) === i)
  .filter((k) => JSON.stringify(COMPANY[k]) !== JSON.stringify(EAS[k]))
  .sort();
check('the two standards differ in the target, the bands and their labels',
  differs.join(',') ===
    'linkKey,policyUrl,standard,standardLabel,standardNote,target,yellowFloor',
  differs.join(', '));
check('and in nothing else - same formula, same measure, same layer',
  COMPANY.formula === EAS.formula && COMPANY.measure === EAS.measure &&
  COMPANY.slaLayer === EAS.slaLayer && COMPANY.name === EAS.name,
  COMPANY.measure + ' = ' + COMPANY.formula);

// ---------------------------------------------------------------------------
// picking one
// ---------------------------------------------------------------------------
check('asking for the EAS standard gets it',
  standardOf('EAS') === EAS && standardOf('eas') === EAS, 'either case');
check('asking for the company one, or for nothing, gets the policy\'s',
  standardOf('COMPANY') === COMPANY && standardOf('') === COMPANY &&
  standardOf(null) === COMPANY && standardOf(undefined) === COMPANY,
  'the figure that gets reported upward is the safe default');
check('and so does asking for something nobody has heard of',
  standardOf('INTERNAL') === COMPANY && standardOf('99.5') === COMPANY,
  'a screen cannot be left scoring against a target that does not exist');

// ---------------------------------------------------------------------------
// the band edges, exactly as the two documents print them
// ---------------------------------------------------------------------------
const edge = (rate, kpi) => bandFor(rate, kpi);

check('company: 90.00 is green, 89.99 is not',
  edge(90.00, COMPANY) === 'GREEN' && edge(89.99, COMPANY) === 'YELLOW',
  'the policy writes its bands straight onto the success rate');
check('company: 85.00 is yellow, 84.99 is red',
  edge(85.00, COMPANY) === 'YELLOW' && edge(84.99, COMPANY) === 'RED');
check('EAS: 99.50 is green, 99.49 is not',
  edge(99.50, EAS) === 'GREEN' && edge(99.49, EAS) === 'YELLOW',
  'matching the sheet\'s own threshold table');
check('EAS: 89.55 is yellow, 89.54 is red',
  edge(89.55, EAS) === 'YELLOW' && edge(89.54, EAS) === 'RED');

// The gap between the two targets is the whole point of having both.
check('a rate between the two targets is green one way and yellow the other',
  edge(97.50, COMPANY) === 'GREEN' && edge(97.50, EAS) === 'YELLOW',
  '97.50% - which is what the EAS section itself is running at');
check('and a rate between the two red lines is yellow one way and red the other',
  edge(88.00, COMPANY) === 'YELLOW' && edge(88.00, EAS) === 'RED',
  '88.00%');

check('achievement is the rate over the target, whichever target that is',
  Math.abs(achievementFor(99, COMPANY) - 110) < 0.01 &&
  Math.abs(achievementFor(99, EAS) - 99.4975) < 0.01,
  '99% is ' + achievementFor(99, COMPANY).toFixed(2) + '% of the policy ' +
  'target and ' + achievementFor(99, EAS).toFixed(2) + '% of the EAS one');

// ---------------------------------------------------------------------------
// a whole month, read twice
// ---------------------------------------------------------------------------
const asCompany = readKpi1('2026-08', 'COMPANY');
const asEas = readKpi1('2026-08', 'EAS');

const sectionIn = (data, name) => data.departments
  .filter((d) => d.name === name)[0];

check('both readings load the month',
  asCompany.hasData === true && asEas.hasData === true);

// THE COUNTS ARE FACTS. Nothing about a target can change what happened.
check('the counts are identical, because a target cannot change them',
  asCompany.total.received === asEas.total.received &&
  asCompany.total.completed === asEas.total.completed &&
  asCompany.total.delayed === asEas.total.delayed &&
  asCompany.total.successful === asEas.total.successful,
  [asCompany.total.completed, asCompany.total.delayed,
   asCompany.total.successful].join(' / '));
check('and so is the success rate, which is counts over counts',
  Math.abs(asCompany.total.rate - asEas.total.rate) < 0.0001,
  asCompany.total.rate.toFixed(2) + '%');

check('what moves is the target the reading declares',
  asCompany.target === 90 && asEas.target === 99.5 &&
  asCompany.yellowFloor === 85 && asEas.yellowFloor === 89.55,
  asCompany.target + ' vs ' + asEas.target);
check('and the reading says which standard it was scored under',
  asCompany.standard === 'COMPANY' && asEas.standard === 'EAS' &&
  Boolean(asCompany.standardNote) && Boolean(asEas.standardNote),
  asEas.standardLabel + ': ' + String(asEas.standardNote).slice(0, 44) + '...');

check('the achievement moves with it',
  asCompany.total.achievement > asEas.total.achievement,
  asCompany.total.achievement.toFixed(2) + '% vs ' +
  asEas.total.achievement.toFixed(2) + '% on the same ' +
  asCompany.total.rate.toFixed(2) + '% rate');
check('and the headroom, which is counted against the target',
  asCompany.total.headroom > asEas.total.headroom,
  asCompany.total.headroom + ' vs ' + asEas.total.headroom + ' spare delays');

// ---- the truth table, end to end ----
const table = [
  ['Clearwater Applications', 100.00, 'GREEN',  'GREEN'],
  ['Nearly Applications',      99.00, 'GREEN',  'YELLOW'],
  ['Middling Applications',    88.00, 'YELLOW', 'RED'],
  ['Struggling Applications',  80.00, 'RED',    'RED']
];
table.forEach(function (row) {
  const name = row[0], rate = row[1], wantCo = row[2], wantEas = row[3];
  const co = sectionIn(asCompany, name);
  const ea = sectionIn(asEas, name);
  check('a section at ' + rate.toFixed(2) + '% is ' + wantCo +
        ' for the company and ' + wantEas + ' for EAS',
    co && ea &&
    Math.abs(co.rate - rate) < 0.005 && Math.abs(ea.rate - rate) < 0.005 &&
    co.band === wantCo && ea.band === wantEas,
    co && ea ? co.rate.toFixed(2) + '% -> ' + co.band + ' / ' + ea.band
             : 'section missing: ' + name);
});

// ---------------------------------------------------------------------------
// everything else on the page follows it
// ---------------------------------------------------------------------------
// A filtered slice scored against the other standard would sit in the same
// table as rows that had been scored against this one.
// TVL rather than KSL: the affiliates alternate down each section, and
// Bilal's one delayed ticket is the first of his, which makes it a TVL one.
// His KSL half is a clean 50 from 50, which is GREEN under either standard
// and would prove nothing at all.
const affCo = readByAffiliate('2026-08', 'TVL', 'COMPANY');
const affEas = readByAffiliate('2026-08', 'TVL', 'EAS');
const person = (d, name) => d.people.filter((p) => p.name === name)[0];
const bilalCo = person(affCo, 'Bilal Nearly');
const bilalEas = person(affEas, 'Bilal Nearly');

check('the affiliate filter is scored against the chosen standard too',
  bilalCo && bilalEas &&
  bilalCo.received === bilalEas.received &&
  Math.abs(bilalCo.rate - 98) < 0.005 &&
  bilalCo.band === 'GREEN' && bilalEas.band === 'YELLOW',
  bilalCo ? bilalCo.received + ' tickets at ' + bilalCo.rate.toFixed(2) +
            '% -> ' + bilalCo.band + ' / ' + bilalEas.band
          : 'not in the TVL slice');

// The Comparison screen reads the SAME stored counts as KPI 1. If it judged
// them against a different target, the same section in the same month would
// be GREEN on one screen and YELLOW on the other - which is precisely the
// defect that made every screen recompute in the first place.
const cmpCo = comparison('token', ['2026-08'], 'COMPANY');
const cmpEas = comparison('token', ['2026-08'], 'EAS');

check('the comparison screen follows the toggle rather than contradicting it',
  cmpCo.target === 90 && cmpEas.target === 99.5 &&
  cmpCo.totals['2026-08'].band === asCompany.total.band &&
  cmpEas.totals['2026-08'].band === asEas.total.band,
  'KPI 1 says ' + asEas.total.band + ', comparison says ' +
  cmpEas.totals['2026-08'].band);
check('and it agrees cell for cell on the section that reads differently',
  cmpCo.bySection['Nearly Applications']['2026-08'].band ===
    sectionIn(asCompany, 'Nearly Applications').band &&
  cmpEas.bySection['Nearly Applications']['2026-08'].band ===
    sectionIn(asEas, 'Nearly Applications').band,
  'the one section that falls between the two targets');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
