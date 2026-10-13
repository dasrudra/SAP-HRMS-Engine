// Why a ticket is filed under the module it is filed under.
//
// Asked because people from Financial, Sales and Supply Chain appeared under
// PP on the By individuals table and looked wrong. Two different things were
// behind that, and only one of them is a defect:
//
//   1. A SECTION IS NOT A MODULE. Md. Abdullah Al Mamun sits in Supply Chain
//      and works PP - it is written down in PERSON_MODULES. His tickets are
//      correctly PP and the Section column correctly says Supply Chain.
//
//   2. ORDINARY WORDS OUTRANK MODULE CODES. The patterns include 'production',
//      'development', 'export', 'purchase' and 'inventory', and the list is
//      sorted longest first, so 'production' (ten characters) is tried before
//      'fi', 'co', 'md' and 'sd' (two). A Part value of 'FI Production Report'
//      is therefore filed under PP rather than FI/TR.
//
// The second is proved below against the real matcher. Whether it is actually
// happening in the live database is a question about the DATA, which no test
// here can answer - explainModule() in Kpi.gs is what answers it.
//
//   node tests/module-reason-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

const sb = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat, Set,
  Logger: { log: () => {} }
};
sb.globalThis = sb;
vm.createContext(sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), sb);
// whyModule() is in Kpi.gs; the rest of that file needs globals this suite has
// no use for, so only the function under test is loaded.
const KPI = fs.readFileSync(path.join(SRC, 'Kpi.gs'), 'utf8');
vm.runInContext(KPI.match(/function whyModule[\s\S]*?\n}/)[0], sb);

const why = vm.runInContext('whyModule', sb);
const moduleForTicket = vm.runInContext('moduleForTicket', sb);
const CONFIG = vm.runInContext('CONFIG', sb);

// ---------------------------------------------------------------------------
// the two functions must never disagree
// ---------------------------------------------------------------------------
// whyModule() exists so a human can be told the reason. If it walked the list
// differently from the one that actually scores, the explanation would be of
// a decision nothing made.
const SAMPLES = [
  'PP', 'Production Planning', 'FI Production Report', 'MD', 'FI/TR', 'CO',
  'Report Development', 'Data Export', 'MM Inventory', 'Account',
  'E-Accounting', 'Monitoring', 'Groupware', '', 'Others'
];
const agree = SAMPLES.every(function (part) {
  return why(part, 'Nobody At All', '2026-08').module ===
         moduleForTicket(part, 'Nobody At All', '2026-08');
});
check('whyModule agrees with moduleForTicket on every sample',
  agree, SAMPLES.length + ' Part values');

// ---------------------------------------------------------------------------
// reason 1: the Part column
// ---------------------------------------------------------------------------
const clean = why('Production Planning', 'Nobody At All', '2026-08');
check('a Part value that names a module says so, and names the pattern',
  clean.module === 'PP' && clean.how === 'part' && clean.detail === 'production',
  clean.module + ' via ' + clean.how + ' \'' + clean.detail + '\'');

const code = why('PP', 'Nobody At All', '2026-08');
check('and a bare module code matches on the code itself',
  code.module === 'PP' && code.detail === 'pp', code.detail);

// ---- THE TRAP ----
// Not a hypothetical. This is the real compiled pattern list, in its real
// order, and these are Part values an ITSM plausibly holds.
const trap = [
  ['FI Production Report',  'FI/TR'],
  ['CO Production Planning','CO'],
  ['MD Production Data',    'MD'],
  ['SD Production Order',   'SD'],
  ['FI Export Statement',   'FI/TR'],
  ['CO Report Development', 'CO']
];
const stolen = trap.filter(function (pair) {
  return why(pair[0], 'Nobody At All', '2026-08').module !== pair[1];
});
check('a descriptive word still outranks a module code beside it',
  stolen.length === trap.length,
  stolen.map(function (p) {
    return '"' + p[0] + '" -> ' + why(p[0], 'Nobody At All', '2026-08').module +
           ' (not ' + p[1] + ')';
  }).join('; '));
check('  and the reason given names the word that did it',
  why('FI Production Report', 'Nobody At All', '2026-08').detail === 'production',
  'reported as \'' + why('FI Production Report', 'Nobody At All', '2026-08').detail + '\'');

// This check is the one that would go red if the ordering were ever fixed, so
// it says what to do rather than just failing.
check('  NOTE: this records current behaviour, not desired behaviour',
  true,
  'if these start resolving to the module code, update this suite - the ' +
  'ordering was deliberately changed');

// ---------------------------------------------------------------------------
// reason 2: the person, when the Part column names nothing
// ---------------------------------------------------------------------------
// 'Monitoring' is in the Part column and is deliberately not a module - see
// TICKET_MODULES. So these fall through to whoever handled the ticket.
const listed = Object.keys(CONFIG.PERSON_MODULES)[0];
const own = why('Monitoring', listed, '2026-08');
check('somebody with their own module role gets it, and is told so',
  own.module === CONFIG.PERSON_MODULES[listed] && own.how === 'person',
  listed + ' -> ' + own.module + ' via ' + own.how);

// Md. Abdullah Al Mamun is the case that started this: Supply Chain section,
// PP module, written down. His PP tickets are correct.
const mamun = why('Monitoring', 'Md. Abdullah Al Mamun', '2026-08');
check('the Supply Chain person who works PP is correctly in PP',
  mamun.module === 'PP' && mamun.how === 'person',
  'section says Supply Chain, module role says PP, both are true');

// ---------------------------------------------------------------------------
// reason 3: the section default
// ---------------------------------------------------------------------------
const bySection = why('Monitoring', 'Shanta Aich', '2026-08');
check('somebody with no entry of their own takes their section\'s module',
  bySection.how === 'section' && bySection.module === 'MM',
  'Shanta Aich -> ' + bySection.module + ' (' + bySection.detail + ')');
check('  which is a default, and says so - the other two are confirmed',
  bySection.how !== 'person',
  'section defaults are the ones worth arguing with');

// ---------------------------------------------------------------------------
// nothing at all
// ---------------------------------------------------------------------------
const nobody = why('Monitoring', 'Someone Not On The Roster', '2026-08');
check('a ticket nothing can place is unassigned, not guessed at',
  nobody.module === '(unassigned)' && nobody.how === 'none',
  nobody.module + ' via ' + nobody.how);

// ---------------------------------------------------------------------------
// the function is reachable from the editor
// ---------------------------------------------------------------------------
check('explainModule exists and is owner-only, like the other maintenance functions',
  /function explainModule\(/.test(KPI) &&
  /function explainModule\([\s\S]{0,200}requireOwner\(\)/.test(KPI),
  'it prints Part values and names verbatim');
check('and it reports the Part text, which is what tells cover from a misfile',
  /examples\[label\]/.test(KPI) && /e\.g\. /.test(KPI));

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
