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

// Overridable so a mutation run can build a deliberately broken copy of the
// source to a scratch page, and check that the suite actually fails on it.
// A test that cannot be made to fail is not testing anything.
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', '..', 'src');
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

  // ?role=USER drives the page as a viewer. The role has to be a knob, not a
  // constant, because the thing worth testing about the Help screen is what a
  // viewer canNOT see - the inbox and the answer boxes - and MASTER sees
  // everything.
  var ROLE = new URLSearchParams(location.search).get('role') || 'MASTER';

  // ?signedout=1 drives the page the way the sign-in screen does: the panel has
  // no conversation and an employee ID field, and the endpoint behind it is the
  // one that takes no token.
  var SIGNED_IN = new URLSearchParams(location.search).get('signedout') !== '1';

  /*
    ?signin=1 starts the page with NOBODY signed in, so the sign-in card comes
    up and the test can drive the form.

    Worth the trouble because it is the only way to reach a bug that lived for
    two releases: the message panel was loaded once, from onSession, and
    signing in through the FORM does not go back through onSession. Every
    suite arrived with a token already in hand, took the one path that
    happened to work, and saw nothing.

    SIGNED_IN flips to true once login() succeeds, exactly as the server's
    answer would change.
  */
  var MUST_SIGN_IN = new URLSearchParams(location.search).get('signin') === '1';
  var HAS_SIGNED_IN = !MUST_SIGN_IN;

  // Three conversations: an ordinary one waiting on a reply, one from the
  // sign-in page that nobody has proved anything about, and the signed-in
  // person's own with an unread reply on it.
  var ME = '20000000';
  var THREADS = [
    { id: 'T1', person: '20000042', name: 'Ayesha Rahman', verified: true, topic: 'KPI 1',
      startedAt: '2026-08-02T09:15:00.000Z', lastAt: '2026-08-02T09:15:00.000Z',
      lastBy: 'USER', status: 'OPEN', waiting: 1,
      messages: [ { id: 'M1', at: '2026-08-02T09:15:00.000Z', side: 'USER',
                    text: 'Why is my section showing a delayed ticket?' } ] },
    { id: 'T2', person: '20536723', name: 'Rudra', verified: false, topic: '',
      startedAt: '2026-08-02T10:02:00.000Z', lastAt: '2026-08-02T10:02:00.000Z',
      lastBy: 'USER', status: 'OPEN', waiting: 1,
      messages: [ { id: 'M2', at: '2026-08-02T10:02:00.000Z', side: 'USER',
                    text: 'I am locked out, please reset my password.' } ] },
    { id: 'T4', person: ME, name: 'Rudra Das', verified: true, unread: 0,
      topic: 'Affiliate table',
      startedAt: '2026-08-03T04:00:00.000Z', lastAt: '2026-08-03T04:05:00.000Z',
      lastBy: 'USER', status: 'OPEN', waiting: 1,
      messages: [
        { id: 'M5', at: '2026-08-03T04:00:00.000Z', side: 'USER',
          text: 'Could you add an affiliate-wise table?' },
        { id: 'M6', at: '2026-08-03T04:05:00.000Z', side: 'USER',
          text: 'No rush on it.' } ] },
    { id: 'T3', person: ME, name: 'Rudra Das', verified: true, topic: 'September export', unread: 1,
      startedAt: '2026-08-01T08:00:00.000Z', lastAt: '2026-08-01T08:30:00.000Z',
      lastBy: 'TEAM', status: 'OPEN', waiting: 0,
      messages: [
        { id: 'M3', at: '2026-08-01T08:00:00.000Z', side: 'USER',
          text: 'Can I get the September export?' },
        { id: 'M4', at: '2026-08-01T08:30:00.000Z', side: 'TEAM',
          by: 'Pritam Saha (20467174)',
          text: 'Sent it to you just now.' } ] }
  ];

  // Every query of this person's, newest activity first. The panel lists these
  // and opens one; the single-thread version it replaced could not show that a
  // person with four running questions has an answer to the second.
  function myThreadList() {
    return THREADS
      .filter(function (t) { return t.person === ME && t.verified; })
      .map(function (t) {
        return { id: t.id, topic: t.topic, startedAt: t.startedAt,
                 lastAt: t.lastAt, lastBy: t.lastBy,
                 waiting: t.waiting || 0, unread: t.unread || 0,
                 messages: t.messages.slice() };
      })
      .sort(function (a, b) { return String(b.lastAt).localeCompare(String(a.lastAt)); });
  }
  function myThread() {
    return THREADS.filter(function (t) { return t.person === ME && t.verified; })[0];
  }
  function waitingCount() {
    return THREADS.filter(function (t) { return t.waiting > 0; }).length;
  }
  function faq() {
    return [
      { order: 1, question: 'How do I sign in for the first time?',
        answer: 'Use the starting login your team gave you.' },
      { order: 2, question: 'What do GREEN, YELLOW and RED mean?',
        answer: 'They are the ratings in the approved KPI policy.' }
    ];
  }

  var HANDLERS = {
    getSession: function () {
      return { signedIn: HAS_SIGNED_IN, role: ROLE, username: '20000000',
               mode: 'EXEC' };
    },
    login: function (username, password) {
      if (!username || !password) {
        return { ok: false, message: 'That username and password do not match.' };
      }
      HAS_SIGNED_IN = true;
      return { ok: true, setup: false, role: ROLE, username: String(username),
               token: 'harness', message: '' };
    },
    getBootstrap: function () {
      return {
        ok: true, configured: true,
        appName: ${JSON.stringify(CONFIG.APP_NAME)},
        appVersion: ${JSON.stringify(CONFIG.APP_VERSION)},
        role: ROLE, username: '20000000', mode: 'EXEC',
        departments: ${JSON.stringify(CONFIG.DEPARTMENTS)},
        kpiList: ${JSON.stringify(CONFIG.KPI_ORDER.map((k) => CONFIG.KPI[k]))},
        kpiPolicy: ${JSON.stringify(CONFIG.POLICY)},
        kpiLinks: {},
        questionsWaiting: waitingCount(),
        availableMonths: ['2026-08'],
        ticketColumns: ${JSON.stringify(CONFIG.TICKET_COLUMNS)},
        feedbackMonths: [], uploads: [], backup: { on: false },
        ticketFrom: '2026-08-01', ticketTo: '2026-08-31'
      };
    },
    getKpi1: kpi1,

    // The messenger. The threads live in the stub rather than on the page, so
    // sending one and then listing them exercises the round trip rather than a
    // hard-coded array.
    faqEntries: faq,

    // THIS ONE READS THE TOKEN IT IS GIVEN, and so must any stub standing in
    // for a server function whose answer depends on one. The first version
    // ignored it and reported SIGNED_IN from the query string, which meant a
    // page calling this BEFORE the token had been read looked perfectly
    // correct here and shipped broken: everybody signed in got the signed-out
    // panel. A stub more generous than the server it stands for is not a
    // simplification, it is a blind spot.
    messengerBoot: function (token) {
      var signedIn = SIGNED_IN && HAS_SIGNED_IN && Boolean(token);
      var list = signedIn ? myThreadList() : [];
      var t = myThread();
      return {
        signedIn: signedIn, faq: faq(),
        threads: list,
        unread: list.reduce(function (n, x) { return n + (x.unread || 0); }, 0),
        name: signedIn && t ? (t.name || '') : '',
        canAnswer: signedIn && ROLE !== 'USER',
        canDelete: signedIn && ROLE === 'MASTER'
      };
    },
    myMessages: function () {
      var list = myThreadList();
      return { threads: list,
               unread: list.reduce(function (n, x) { return n + (x.unread || 0); }, 0) };
    },
    markMyMessagesRead: function (token, id) {
      var t = THREADS.filter(function (x) { return x.id === id; })[0];
      if (t) t.unread = 0;
      return { ok: Boolean(t) };
    },
    sendMessage: function (token, threadId, topic, text, name) {
      if (!SIGNED_IN || !HAS_SIGNED_IN) {
        return { ok: false, message: 'Your session has ended.' };
      }
      if (!text || String(text).trim().length < 2) {
        return { ok: false, message: 'Write the message first.' };
      }
      var t = threadId
        ? THREADS.filter(function (x) {
            return x.id === threadId && x.person === ME && x.verified;
          })[0]
        : null;
      if (threadId && !t) {
        return { ok: false, message: 'That conversation is no longer there.' };
      }
      if (!t) {
        t = { id: 'T' + (THREADS.length + 9), person: ME, name: name || '',
              verified: true, topic: String(topic || ''), unread: 0,
              startedAt: new Date().toISOString(), lastAt: new Date().toISOString(),
              lastBy: 'USER', status: 'OPEN', waiting: 0, messages: [] };
        THREADS.unshift(t);
      }
      t.messages.push({ id: 'M' + (t.messages.length + 9),
                        at: new Date().toISOString(), side: 'USER',
                        text: String(text) });
      t.waiting = (t.waiting || 0) + 1;
      t.lastAt = new Date().toISOString();
      if (name) t.name = String(name);
      return { ok: true, message: 'Sent.', emailed: true, name: t.name,
               threadId: t.id, threads: myThreadList() };
    },
    sendUnverifiedMessage: function (token, employeeId, text, name) {
      if (!/^[A-Za-z0-9._-]{3,40}$/.test(String(employeeId || ''))) {
        return { ok: false, message: 'Put your employee ID in first - the one ' +
                                     'you sign in with.' };
      }
      if (!text || String(text).trim().length < 2) {
        return { ok: false, message: 'Write the message first.' };
      }
      return { ok: true, message: 'Sent to the EAS team. They will contact you ' +
                                  'directly - the reply cannot come back to ' +
                                  'this box, because you are not signed in.' };
    },
    deleteThread: function (token, id) {
      if (ROLE !== 'MASTER') {
        throw new Error('That action needs the master login.');
      }
      const at = THREADS.findIndex(function (t) { return t.id === id; });
      if (at === -1) return { ok: false, message: 'That conversation is no longer there.' };
      THREADS.splice(at, 1);
      return { ok: true, message: 'Conversation deleted.' };
    },
    listThreads: function () {
      if (ROLE === 'USER') throw new Error('That action needs the admin login.');
      return THREADS.slice().sort(function (a, b) {
        if ((a.waiting > 0) !== (b.waiting > 0)) return a.waiting > 0 ? -1 : 1;
        return String(b.lastAt).localeCompare(String(a.lastAt));
      });
    },
    replyToThread: function (token, id, text) {
      if (ROLE === 'USER') throw new Error('That action needs the admin login.');
      var t = THREADS.filter(function (x) { return x.id === id; })[0];
      if (!t) return { ok: false, message: 'That conversation is no longer there.' };
      if (!text || String(text).trim().length < 2) {
        return { ok: false, message: 'Write the message first.' };
      }
      t.messages.push({ id: 'R' + t.messages.length, at: new Date().toISOString(),
                        side: 'TEAM', by: 'Rudra Das (20000000)',
                        text: String(text) });
      t.waiting = 0; t.lastBy = 'TEAM'; t.lastAt = new Date().toISOString();
      return { ok: true, message: 'Replied.', messages: t.messages.slice() };
    },
    // Accounts, deliberately out of order by last sign-in and with two edge
    // cases in it: somebody who has never signed in, and the shared starting
    // login, which is not a person and has no sign-in of its own.
    masterListAccounts: function () {
      return [
        { username: '20217450', role: 'USER', created: '2026-10-05T06:46:00.000Z',
          lastSignIn: '2026-10-05T06:46:00.000Z', signIns: 1, mustChange: false },
        { username: '20536723', role: 'MASTER', created: '2026-10-04T09:15:00.000Z',
          lastSignIn: '2026-10-18T02:19:00.000Z', signIns: 29, mustChange: false },
        { username: '20217474', role: 'ADMIN', created: '2026-10-15T06:49:00.000Z',
          lastSignIn: '2026-10-17T02:20:00.000Z', signIns: 3, mustChange: false },
        { username: '20900001', role: 'USER', created: '2026-10-16T04:00:00.000Z',
          lastSignIn: '', signIns: 0, mustChange: true },
        { username: '20467174', role: 'ADMIN', created: '2026-10-04T09:33:00.000Z',
          lastSignIn: '2026-10-15T03:17:00.000Z', signIns: 17, mustChange: false },
        // Deliberately the MOST RECENT date in the list. With an empty one it
        // sank to the bottom whether the bootstrap rule worked or not, so the
        // rule was untested - removing it changed nothing the suite could see.
        { username: 'user', role: 'USER', bootstrap: true, created: '',
          lastSignIn: '2026-10-18T09:00:00.000Z', signIns: 0, mustChange: false }
      ];
    },
    // Long on purpose: the point of the capped table is what happens when
    // there are more rows than fit, and an empty log proves nothing.
    masterAuditLog: function () {
      var out = [];
      for (var i = 0; i < 120; i++) {
        out.push({ when: new Date(Date.UTC(2026, 9, 18, 9, 0) - i * 36e5).toISOString(),
                   username: i % 3 ? '20536723' : '20467174',
                   event: 'SIGNIN', role: i % 3 ? 'MASTER' : 'ADMIN', detail: '' });
      }
      return out;
    },
    messagesWaiting: function () {
      if (ROLE === 'USER') throw new Error('That action needs the admin login.');
      return waitingCount();
    },

    getKpi2: function () { return { hasData: false }; },
    getUploads: function () { return []; },
    getOrgChart: function () { return { sections: [] }; },
    renewToken: function () { return { ok: true, token: 't', role: ROLE }; },
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
      // ?drop=listThreads removes a handler, which is what a project with a
      // half-pasted set of files looks like from the page: the HTML asks for
      // something the deployed script does not have. There is no other way to
      // test that path, and it is the one a person actually hits.
      var DROPPED = (new URLSearchParams(location.search).get('drop') || '')
                      .split(',').filter(Boolean);

      Object.keys(HANDLERS).filter(function (name) {
        return DROPPED.indexOf(name) === -1;
      }).forEach(function (name) {
        api[name] = function () {
          var args = arguments;
          setTimeout(function () {
            try { if (onOk) onOk(HANDLERS[name].apply(null, args)); }
            catch (e) { if (onFail) onFail(e); }
          }, 4);
        };
      });
      // A name the real google.script.run does not have is UNDEFINED, not a
      // function that quietly does nothing. That is worth copying exactly: it
      // is how a project whose HTML and .gs files are from different versions
      // announces itself, and the page now turns it into a sentence that says
      // so. A harness that handed back a working stub for every name could
      // never have shown that.
      return new Proxy(api, {
        get: function (target, prop) {
          if (prop in target) return target[prop];
          if (typeof prop !== 'string') return undefined;
          console.error('harness: no stub for google.script.run.' + prop);
          return undefined;
        }
      });
    }
    return make(null, null);
  })(),
    // getLocation is how the page reads ?view= and ?month= inside the Apps
    // Script sandbox, where it cannot see its own address bar. Without it the
    // page always opened on KPI 1 and no suite could reach another screen.
    url: {
      getLocation: function (cb) {
        var p = {};
        new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; });
        setTimeout(function () { cb({ parameter: p, hash: '' }); }, 2);
      }
    },
    history: { replace: function () {} }, host: { close: function () {} } } };

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

const out = process.env.EAS_PAGE || path.join(__dirname, 'page.html');
fs.writeFileSync(out, html);
console.log('wrote ' + out + '  (' + html.length + ' bytes)');
