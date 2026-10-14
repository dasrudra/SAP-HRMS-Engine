// Assembles the Apps Script project into one standalone HTML file, with the
// server replaced by fixtures, so the real interface can be driven in a real
// browser.
//
// DELIBERATELY SMALL. An earlier harness stubbed every endpoint and generated
// nine months of tickets; it lived outside version control and was lost with
// the machine it sat on. This one covers what the committed suites actually
// drive, and it is in the repository. Add to it when a suite needs more,
// rather than rebuilding it all at once.
//
//   node tests/harness/build.js        ->  tests/harness/page.html
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = path.join(__dirname, '..', '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// Config.gs is the one source of truth for names, targets and formulas, so the
// fixture reads it rather than carrying its own copy. The copy is how the last
// harness came to be showing a target the engine had stopped using.
const cfgBox = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat
};
cfgBox.globalThis = cfgBox;
vm.createContext(cfgBox);
vm.runInContext(read('Config.gs'), cfgBox);
const CONFIG = vm.runInContext('CONFIG', cfgBox);
const K1 = CONFIG.KPI.RESOLUTION;

// ---------------------------------------------------------------------------
// the fixture
// ---------------------------------------------------------------------------
// Invented people. This repository is public, and a fixture that hung a bad
// month on a real colleague's name would read as a claim about their work.
//
// Built so that ONE PERSON SPANS TWO MODULES and their two figures disagree -
// which is the whole reason the module filter re-reads rather than hides.
const PEOPLE = [
  { name: 'Ayesha Rahman',  department: 'Sales Applications',         received: 8, delayed: 1 },
  { name: 'Bilal Hossain',  department: 'Supply Chain Applications',  received: 3, delayed: 0 },
  { name: 'Carim Uddin',    department: 'Manufacturing Applications', received: 2, delayed: 2 },
  // A second name in a section, so "filter to a section" is distinguishable
  // from "filter to one person".
  { name: 'Dina Karim',     department: 'Sales Applications',         received: 5, delayed: 0 }
];

// Which module each person's tickets fell into. No screen reads this any more
// - it is here so the module TOTALS can be worked out the way the By module
// table gets them, and as a reminder that Ayesha's work is split across two.
const PAIRS = [
  { module: 'PP', name: 'Ayesha Rahman', received: 6, delayed: 1 },
  { module: 'MM', name: 'Ayesha Rahman', received: 2, delayed: 0 },
  { module: 'MM', name: 'Bilal Hossain', received: 3, delayed: 0 },
  { module: 'PP', name: 'Carim Uddin',   received: 2, delayed: 2 },
  { module: 'SD', name: 'Dina Karim',    received: 5, delayed: 0 }
];

function score(row) {
  const completed = row.received;
  const successful = completed - row.delayed;
  const rate = completed ? (successful / completed) * 100 : 0;
  return Object.assign({}, row, {
    completed: completed,
    successful: successful,
    rate: rate,
    achievement: completed ? (rate / K1.target) * 100 : 0,
    band: !completed ? 'NO DATA'
      : rate >= K1.target ? 'GREEN' : (rate >= K1.yellowFloor ? 'YELLOW' : 'RED'),
    headroom: completed ? successful - Math.ceil((K1.target / 100) * completed) : 0
  });
}

const MODULES = ['PP', 'MM'].map(function (name) {
  const mine = PAIRS.filter((p) => p.module === name);
  return score({
    name: name,
    received: mine.reduce((a, p) => a + p.received, 0),
    delayed: mine.reduce((a, p) => a + p.delayed, 0)
  });
});

const KPI1 = score({
  name: 'EAS',
  received: PEOPLE.reduce((a, p) => a + p.received, 0),
  delayed: PEOPLE.reduce((a, p) => a + p.delayed, 0)
});

const FIXTURE = {
  month: '2026-08',
  total: KPI1,
  people: PEOPLE.map(score),
  modules: MODULES,
  departments: [],
  parts: [],
  sources: []
};

// ---------------------------------------------------------------------------
// the page
// ---------------------------------------------------------------------------
let html = read('Index.html');
html = html.replace("<?!= include('Styles'); ?>", () => read('Styles.html'));
// 2,900 lines of encoded photograph, and nothing any suite looks at.
html = html.replace("<?!= include('Bg'); ?>", () => '');
html = html.replace("<?!= include('App'); ?>", () => read('App.html'));
html = html.replace("<?!= include('Report'); ?>", () => read('Report.html'));
html = html.replace(/<\?=\s*appName\s*\?>/g, () => CONFIG.APP_NAME);
html = html.replace(/<\?=\s*appVersion\s*\?>/g, () => CONFIG.APP_VERSION);
html = html.replace(/<\?=\s*CONFIG\.([A-Z0-9_]+)\s*\?>/g, (whole, key) => {
  const hit = new RegExp('^\\s*' + key + ":\\s*'([^']*)'", 'm').exec(read('Config.gs'));
  if (!hit) throw new Error('build: Index.html wants CONFIG.' + key +
                            ', which is not a plain string in Config.gs');
  return hit[1];
});

const stub = `
<script>
(function () {
  var FIXTURE = ${JSON.stringify(FIXTURE)};
  var EMPTY = Object.assign({}, FIXTURE, {
    hasData: false, people: [], peopleByModule: [], modules: []
  });

  function kpi1() {
    var k = Object.assign({ hasData: true, allMonths: false, monthsCovered: 1,
                            target: ${K1.target}, yellowFloor: ${K1.yellowFloor},
                            basis: null }, FIXTURE);
    return k;
  }

  var HANDLERS = {
    getSession: function () {
      return { signedIn: true, role: 'MASTER', username: '20000000', mode: 'EXEC' };
    },
    getBootstrap: function () {
      return {
        ok: true, configured: true,
        appName: ${JSON.stringify(CONFIG.APP_NAME)},
        appVersion: ${JSON.stringify(CONFIG.APP_VERSION)},
        role: 'MASTER', username: '20000000', mode: 'EXEC',
        departments: ${JSON.stringify(CONFIG.DEPARTMENTS)},
        kpiList: ${JSON.stringify(CONFIG.KPI_ORDER.map((k) => CONFIG.KPI[k]))},
        kpiPolicy: ${JSON.stringify(CONFIG.POLICY)},
        kpiLinks: {},
        availableMonths: ['2026-08'],
        ticketColumns: ${JSON.stringify(CONFIG.TICKET_COLUMNS)},
        feedbackMonths: [], uploads: [], backup: { on: false },
        ticketFrom: '2026-08-01', ticketTo: '2026-08-31'
      };
    },
    getKpi1: kpi1,
    getKpi2: function () { return { hasData: false }; },
    getUploads: function () { return []; },
    getOrgChart: function () { return { sections: [] }; },
    renewToken: function () { return { ok: true, token: 't', role: 'MASTER' }; },
    logout: function () { return { ok: true }; }
  };

  // google.script.run, as Apps Script presents it: chainable handlers, then a
  // call. Asynchronous on purpose - code that happens to work only because a
  // fixture answered instantly would not work in production.
  window.google = { script: { run: (function () {
    function make(onOk, onFail) {
      var api = {
        withSuccessHandler: function (fn) { return make(fn, onFail); },
        withFailureHandler: function (fn) { return make(onOk, fn); }
      };
      Object.keys(HANDLERS).forEach(function (name) {
        api[name] = function () {
          var args = arguments;
          setTimeout(function () {
            try { if (onOk) onOk(HANDLERS[name].apply(null, args)); }
            catch (e) { if (onFail) onFail(e); }
          }, 4);
        };
      });
      // Anything the page calls that is not stubbed should be loud here rather
      // than silently doing nothing and leaving a panel mysteriously empty.
      return new Proxy(api, {
        get: function (target, prop) {
          if (prop in target) return target[prop];
          if (typeof prop !== 'string') return undefined;
          return function () {
            console.error('harness: no stub for google.script.run.' + prop);
          };
        }
      });
    }
    return make(null, null);
  })(), history: { replace: function () {} }, host: { close: function () {} } } };

  // The page reads its token from the address bar.
  if (location.search.indexOf('token=') === -1) {
    try {
      history.replaceState(null, '', location.pathname + location.search +
        (location.search ? '&' : '?') + 'token=harness');
    } catch (e) { /* file:// may refuse; the stub answers regardless */ }
  }
})();
</script>
`;

// A FUNCTION replacement: the app contains `$&` inside a regex escape, and in
// a string replacement `$&` means "the matched text", which silently corrupts
// the output and shows up much later as a syntax error.
html = html.replace(read('App.html'), () => stub + read('App.html'));

const leftover = (html.match(/<\?[\s\S]*?\?>/g) || [])
  .filter((s) => !/^<\?=\s*devToken\s*\?>$/.test(s));
if (leftover.length) {
  throw new Error('build: unresolved scriptlet(s): ' + leftover.join(', '));
}

const out = path.join(__dirname, 'page.html');
fs.writeFileSync(out, html);
console.log('wrote ' + out + '  (' + html.length + ' bytes)');
