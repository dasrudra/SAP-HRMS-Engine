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

// ---- A MODULE CODE BEATS A DESCRIPTIVE WORD ----
// This is the defect that put people from Financial, Sales and Supply Chain
// into PP's individuals list with a ticket or two each, and the same in every
// other module. The two pattern lists used to be one, sorted longest first,
// so 'production' at ten characters was tried before 'fi', 'co', 'md' and
// 'sd' at two - and the word beside the code won.
//
// Real Part values, against the real compiled list.
const pairs = [
  ['FI Production Report',   'FI/TR'],
  ['CO Production Planning', 'CO'],
  ['MD Production Data',     'MD'],
  ['SD Production Order',    'SD'],
  ['MM Production Plan',     'MM'],
  ['FI Export Statement',    'FI/TR'],
  ['CO Report Development',  'CO'],
  ['FI Purchase Invoice',    'FI/TR']
];
const wrong = pairs.filter(function (pair) {
  return why(pair[0], 'Nobody At All', '2026-08').module !== pair[1];
});
check('a module code in the Part column beats a descriptive word beside it',
  wrong.length === 0,
  wrong.length
    ? wrong.map(function (p) {
        return '"' + p[0] + '" -> ' + why(p[0], 'Nobody At All', '2026-08').module +
               ' (want ' + p[1] + ')';
      }).join('; ')
    : pairs.length + ' Part values, each to the module its code names');
check('  and the reason given names the code that did it, not the word',
  why('FI Production Report', 'Nobody At All', '2026-08').detail === 'fi',
  'reported as \'' + why('FI Production Report', 'Nobody At All', '2026-08').detail + '\'');

// The words still have to work, or the fix would have traded one wrong answer
// for another: most Part values describe the work and name no module at all.
const described = [
  ['Production Planning', 'PP'], ['Production', 'PP'],
  ['Development',         'SD'], ['Data Export', 'SD'],
  ['Inventory',           'MM'], ['Purchase',    'MM'],
  ['Shipping Document',   'SD']
];
const lost = described.filter(function (pair) {
  return why(pair[0], 'Nobody At All', '2026-08').module !== pair[1];
});
check('while a Part value that only DESCRIBES the work still lands right',
  lost.length === 0,
  lost.map(function (p) { return '"' + p[0] + '"'; }).join(', ') ||
  described.length + ' values with no module code in them');
check('  and those are reported as a word, so the two can be told apart',
  why('Production Planning', 'Nobody At All', '2026-08').detail === 'production',
  'every code is tried before any word');

// ---- the ordering itself, not just its effects ----
// Checked as a property of the compiled list so it holds for patterns nobody
// thought to write a Part value for.
const compiled = vm.runInContext('ticketModulePatterns()', sb);
const firstWord = compiled.findIndex(function (p) { return p.kind === 'word'; });
const lastCode = compiled.map(function (p) { return p.kind; }).lastIndexOf('code');
check('every code is compiled ahead of every word',
  firstWord === -1 || lastCode < firstWord,
  compiled.filter((p) => p.kind === 'code').length + ' codes then ' +
  compiled.filter((p) => p.kind === 'word').length + ' words');
check('and longest-first still holds inside each tier',
  ['code', 'word'].every(function (kind) {
    const tier = compiled.filter(function (p) { return p.kind === kind; });
    return tier.every(function (p, i) { return i === 0 || tier[i - 1].length >= p.length; });
  }),
  'which is what keeps \'fi/tr\' ahead of \'fi\'');
check('every module still contributes at least one pattern',
  CONFIG.TICKET_MODULES.every(function (m) {
    return compiled.some(function (p) { return p.name === m.name; });
  }),
  CONFIG.TICKET_MODULES.map(function (m) { return m.name; }).join(' '));

// The old single-list shape must still score rather than silently filing
// every ticket as unassigned, in case Config.gs is ever half-pasted.
check('a module written the old way is still read, as codes',
  (function () {
    const box = { console, Object, String, Number, Array, Math, JSON, RegExp,
                  Date, isFinite, Boolean, Error, parseInt, parseFloat };
    box.globalThis = box;
    vm.createContext(box);
    vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), box);
    vm.runInContext("CONFIG.TICKET_MODULES = [{ name: 'PP', match: ['pp'] }];" +
                    'TICKET_MODULE_PATTERNS = null;', box);
    return vm.runInContext('moduleFromPart', box)('PP') === 'PP';
  })(),
  'the `match` key is accepted as codes');

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
