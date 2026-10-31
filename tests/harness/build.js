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
// Both of KPI 1's standards, read from Config.gs rather than written out
// here: the point of the toggle is that two targets score the same counts
// differently, and a fixture carrying its own copy of those targets would
// still pass if Config.gs changed underneath it.
const K1_STANDARDS = [CONFIG.KPI.RESOLUTION, CONFIG.KPI.RESOLUTION_EAS];

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
html = html.replace("<?!= include('PortalStyles'); ?>", () => read('PortalStyles.html'));
html = html.replace("<?!= include('Portal'); ?>", () => read('Portal.html'));
// 2,900 lines of encoded photograph, and nothing any suite looks at.
html = html.replace("<?!= include('Bg'); ?>", () => '');
html = html.replace("<?!= include('App'); ?>", () => read('App.html'));
html = html.replace("<?!= include('Report'); ?>", () => read('Report.html'));
// EVERY include HAS TO HAVE BEEN REPLACED BY NOW.
//
// These are matched as exact strings, so adding a file to Index.html without
// adding it here leaves the scriptlet sitting in the page as text: the file
// is simply absent, nothing throws, and every browser suite goes on passing
// against a page missing a part of the product. That is the quietest way this
// harness can lie, so it is checked rather than remembered.
const missed = html.match(/<\?!=\s*include\([^)]*\)\s*;?\s*\?>/g);
if (missed) {
  throw new Error('build: Index.html includes a file this harness does not ' +
                  'assemble: ' + missed.join(', ') +
                  '\n       Add a line for it beside the others above.');
}

html = html.replace(/<\?=\s*appName\s*\?>/g, () => CONFIG.APP_NAME);
html = html.replace(/<\?=\s*appVersion\s*\?>/g, () => CONFIG.APP_VERSION);
html = html.replace(/<\?=\s*CONFIG\.([A-Z0-9_]+)\s*\?>/g, (whole, key) => {
  const hit = new RegExp('^\\s*' + key + ":\\s*'([^']*)'", 'm').exec(read('Config.gs'));
  if (!hit) throw new Error('build: Index.html wants CONFIG.' + key +
                            ', which is not a plain string in Config.gs');
  return hit[1];
});

// Anything Index.html prints as JSON - the About us and Partners wording, the
// service layers. EVALUATED IN THE SAME SANDBOX Config.gs was just loaded
// into, rather than pulled out with a regex, so a value that is worked out by
// a function is resolved the same way a constant is. serviceLayers() derives
// the three SLA layers from the four KPIs, and a harness that could only read
// constants would have needed its own copy of the answer - which is the copy
// that goes stale.
//
// Nothing but Config.gs is in that sandbox, so this runs the project's own
// code and no more.
html = html.replace(/<\?!=\s*(JSON\.stringify\([A-Za-z0-9_.()]*\))\s*\?>/g,
  (whole, expr) => {
    let value;
    try {
      value = vm.runInContext(expr, cfgBox);
    } catch (e) {
      throw new Error('build: Index.html prints ' + expr + ', which Config.gs ' +
                      'could not evaluate: ' + e.message);
    }
    if (value === undefined) {
      throw new Error('build: Index.html prints ' + expr + ', which came back ' +
                      'undefined - Config.gs does not define it');
    }
    return value;
  });

// EVERY BACKSLASH IN HERE HAS TO BE DOUBLED.
//
// This is a template literal, so \s is not an escape JavaScript knows and the
// backslash is simply dropped on the way through: a regex written /\s+/g
// arrives in the built page as /s+/g, which matches the letter s. It is not a
// syntax error and nothing warns - the stub just quietly tests something else.
// The check after this block catches it if it happens again.
const stub = `
<script>
(function () {
  var FIXTURE = ${JSON.stringify(FIXTURE)};
  var EMPTY = Object.assign({}, FIXTURE, {
    hasData: false, people: [], peopleByModule: [], modules: []
  });

  // KPI 1'S TWO STANDARDS, scored in the browser rather than baked in at
  // build time. The server re-bands the same stored counts against whichever
  // target is asked for, so a stub that answered with one set of bands
  // whatever it was handed would let the toggle be wired to nothing at all
  // and this suite would never know.
  var STANDARDS = ${JSON.stringify(K1_STANDARDS)};

  function standardOf(code) {
    return String(code || '').trim().toUpperCase() === 'EAS'
      ? STANDARDS[1] : STANDARDS[0];
  }

  function rescore(row, kpi) {
    var completed = row.completed === undefined ? row.received : row.completed;
    var successful = completed - (row.delayed || 0);
    var rate = completed ? (successful / completed) * 100 : 0;
    return Object.assign({}, row, {
      rate: rate,
      achievement: completed ? (rate / kpi.target) * 100 : 0,
      band: !completed ? 'NO DATA'
        : rate >= kpi.target ? 'GREEN'
        : (rate >= kpi.yellowFloor ? 'YELLOW' : 'RED'),
      headroom: completed
        ? successful - Math.ceil((kpi.target / 100) * completed) : 0
    });
  }

  function kpi1(standard) {
    var kpi = standardOf(standard);
    var k = Object.assign({ hasData: true, allMonths: false, monthsCovered: 1,
                            target: kpi.target, yellowFloor: kpi.yellowFloor,
                            standard: kpi.standard,
                            standardLabel: kpi.standardLabel,
                            standardNote: kpi.standardNote,
                            basis: null }, FIXTURE);
    k.total = rescore(FIXTURE.total, kpi);
    k.people = FIXTURE.people.map(function (p) { return rescore(p, kpi); });
    k.modules = FIXTURE.modules.map(function (m) { return rescore(m, kpi); });
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
  // What the signed-in person's ACCOUNT says they are called, and the switch
  // for the one case that still has to be asked.
  var NO_NAME = new URLSearchParams(location.search).get('noname') === '1';
  // ?signups=closed drives the sign-in page with the door shut.
  var SIGNUPS_OPEN =
    new URLSearchParams(location.search).get('signups') !== 'closed';
  // Makes every guarded call refuse the token from now on, the way the
  // server does once a session is over.
  window.__expireSession = function () { window.__sessionDead = true; };
  var MY_NAME = NO_NAME ? '' : 'Rudra Das';
  var ACCOUNTS = [
    { username: '20990011', role: 'USER', created: '2026-10-05T06:46:00.000Z',
      lastSignIn: '2026-10-05T06:46:00.000Z', signIns: 1, mustChange: false,
      fullName: 'Ayesha Rahman', email: 'ayesha@example.com' },
    { username: '20990012', role: 'MASTER', created: '2026-10-04T09:15:00.000Z',
      lastSignIn: '2026-10-18T02:19:00.000Z', signIns: 29, mustChange: false,
      fullName: 'Rudra Das', email: 'rudra@example.com' },
    { username: '20990013', role: 'ADMIN', created: '2026-10-15T06:49:00.000Z',
      lastSignIn: '2026-10-17T02:20:00.000Z', signIns: 3, mustChange: false,
      fullName: '', email: '' },
    { username: '20900001', role: 'USER', created: '2026-10-16T04:00:00.000Z',
      lastSignIn: '', signIns: 0, mustChange: true, fullName: '', email: '' },
    { username: '20990014', role: 'ADMIN', created: '2026-10-04T09:33:00.000Z',
      lastSignIn: '2026-10-15T03:17:00.000Z', signIns: 17, mustChange: false,
      fullName: 'Pritam Saha', email: '' },
    // Deliberately the MOST RECENT date in the list. With an empty one it
    // sank to the bottom whether the bootstrap rule worked or not, so the
    // rule was untested - removing it changed nothing the suite could see.
    { username: 'user', role: 'USER', bootstrap: true, created: '',
      lastSignIn: '2026-10-18T09:00:00.000Z', signIns: 0, mustChange: false }
  ];

  var THREADS = [
    { id: 'T1', person: '20000042', name: 'Ayesha Rahman', verified: true, topic: 'KPI 1',
      startedAt: '2026-08-02T09:15:00.000Z', lastAt: '2026-08-02T09:15:00.000Z',
      lastBy: 'USER', status: 'OPEN', waiting: 1,
      messages: [ { id: 'M1', at: '2026-08-02T09:15:00.000Z', side: 'USER',
                    text: 'Why is my section showing a delayed ticket?' } ] },
    { id: 'T2', person: '20990012', name: 'Rudra', verified: false, topic: '',
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
          by: 'Pritam Saha (20990014)',
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

  /*
    PRESENCE, as the script cache would hold it.

    Stateful on purpose. The feature is a two-button state machine, and a
    stub that answered with a constant would let the Away button be wired to
    nothing at all - or to the wrong person - and still pass every assertion
    about the colour of a dot.

    Seeded with all three states already on the page, because a fixture where
    everybody is active only ever exercises the one branch. 20000000 is the
    username getSession hands back below, so it is the signed-in person AND
    the department head in the getTeam fixture: pressing Away has to change a
    card in the directory as well as the dot in the top bar, which is the
    join between the two halves of this feature and the thing most likely to
    be wrong.
  */
  var PRESENCE = {
    '20000000': 'ACTIVE',   // me - the department head
    '20000001': 'ACTIVE',   // Ayesha, head of Sales
    '20000002': 'AWAY',     // Carim, signed in but stepped away
    '20000003': 'OFFLINE'   // Bilal, not signed in
    // 20000004 is absent entirely, which is what the server really returns
    // for somebody with no cache entry. A page that only ever saw the string
    // 'OFFLINE' would pass while being unable to cope with a missing key.
  };

  var HANDLERS = {
    getSession: function () {
      return { signedIn: HAS_SIGNED_IN, role: ROLE, username: '20000000',
               mode: 'EXEC' };
    },
    // IT HAS TO REFUSE AN EMPLOYEE ID NOBODY HAS USED, and say which of the
    // two things went wrong. Signing anybody in whatever they typed meant the
    // sign-in card's own error states could not be driven at all - including
    // the one somebody actually hits: never having signed up, typing their ID
    // and an invented password, and being told the two "do not match".
    login: function (username, password) {
      var name = String(username || '').trim().toLowerCase();
      if (!name || !password) {
        return { ok: false, message: 'That username and password do not match.' };
      }
      var hit = ACCOUNTS.filter(function (a) { return a.username === name; })[0];
      if (!hit || name === 'user') {
        return { ok: false, message: SIGNUPS_OPEN
          ? 'There is no login for that employee ID yet. Choose "Create your ' +
            'login" below to make one.'
          : 'There is no login for that employee ID. Ask the EAS team to add ' +
            'it, and you will be able to set a password.' };
      }
      if (hit.mustChange) {
        return { ok: true, setup: true, role: '', username: name, token: '',
                 setupToken: 'setup-' + name,
                 needsName: !hit.fullName, needsEmail: !hit.email, message: '' };
      }
      HAS_SIGNED_IN = true;
      // A fresh session. Without this, signing back in after a sign-out would
      // leave every later call refused, which is not what the server does.
      window.__sessionDead = false;
      return { ok: true, setup: false, role: ROLE, username: name,
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
        kpi1Standards: STANDARDS,
        teamSize: ${CONFIG.TEAM_SIZE},
        kpiLinks: {},
        questionsWaiting: waitingCount(),
        availableMonths: ['2026-09', '2026-08'],
        ticketColumns: ${JSON.stringify(CONFIG.TICKET_COLUMNS)},
        feedbackMonths: [], uploads: [], backup: { on: false },
        ticketFrom: '2026-08-01', ticketTo: '2026-08-31'
      };
    },
    // The token comes first, exactly as it does on the server - callServer
    // injects it into every call. Bound as a bare reference before the
    // standard existed, which would have made the token the standard and
    // every reading score as the company's.
    getKpi1: function (token, month, standard) { return kpi1(standard); },

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
      // The name comes off the ACCOUNT now, so the stub answers from the
      // same place the server does rather than from a thread. ?noname=1
      // gives this person an account with no name on it - which is every
      // account that existed before the column did, and the one case where
      // the panel still has to ask for one.
      var onAccount = signedIn ? MY_NAME : '';
      return {
        signedIn: signedIn, faq: faq(),
        threads: list,
        unread: list.reduce(function (n, x) { return n + (x.unread || 0); }, 0),
        name: onAccount || (signedIn && t ? (t.name || '') : ''),
        nameOnAccount: Boolean(onAccount),
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
      // A name typed by somebody whose account has none is kept ON THE
      // ACCOUNT, which is what stops the panel asking again tomorrow. The
      // server does this through setMyName; the stub does the same thing to
      // MY_NAME so the panel sees the same answer come back.
      if (name && !MY_NAME) { MY_NAME = String(name); NO_NAME = false; }
      if (name) t.name = String(name);
      return { ok: true, message: 'Sent.', emailed: true,
               name: MY_NAME || t.name,
               nameOnAccount: Boolean(MY_NAME),
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
    // Names and emails are deliberately PATCHY: one admin with both, one
    // admin with neither, a viewer carrying an address that is stored and
    // never written to. A fixture where everybody had both would not show
    // what an unanswered cell looks like, which is most of this screen's job.
    masterListAccounts: function () {
      return ACCOUNTS.map(function (a) {
        var alerted = (a.role === 'ADMIN' || a.role === 'MASTER');
        return { username: a.username, role: a.role, created: a.created,
                 lastSignIn: a.lastSignIn, signIns: a.signIns,
                 mustChange: a.mustChange, bootstrap: Boolean(a.bootstrap),
                 fullName: a.fullName || '', email: a.email || '',
                 alerted: alerted && Boolean(a.email) };
      });
    },
    // The real one tidies a name, refuses an address that is not one, and
    // reads null as "leave that field alone". A stub that simply said yes
    // would let the screen look right while storing anything at all.
    masterSetDetails: function (token, employeeId, fullName, email) {
      var hit = ACCOUNTS.filter(function (a) {
        return a.username === String(employeeId);
      })[0];
      if (!hit) throw new Error('No account for employee ID ' + employeeId + '.');

      if (fullName !== undefined && fullName !== null) {
        hit.fullName = String(fullName).replace(/\\s+/g, ' ').trim().slice(0, 60);
      }
      if (email !== undefined && email !== null) {
        var address = String(email).trim();
        if (address && !/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(address)) {
          throw new Error('That does not look like an email address: ' + address);
        }
        hit.email = address;
      }
      return { ok: true, username: hit.username, fullName: hit.fullName || '',
               email: hit.email || '',
               alerted: (hit.role === 'ADMIN' || hit.role === 'MASTER') &&
                        Boolean(hit.email) };
    },
    // Long on purpose: the point of the capped table is what happens when
    // there are more rows than fit, and an empty log proves nothing.
    masterAuditLog: function () {
      var out = [];
      for (var i = 0; i < 120; i++) {
        out.push({ when: new Date(Date.UTC(2026, 9, 18, 9, 0) - i * 36e5).toISOString(),
                   username: i % 3 ? '20990012' : '20990014',
                   event: 'SIGNIN', role: i % 3 ? 'MASTER' : 'ADMIN', detail: '' });
      }
      return out;
    },
    messagesWaiting: function () {
      if (ROLE === 'USER') throw new Error('That action needs the admin login.');
      return waitingCount();
    },

    // Affiliates. FIXTURE's people carry a ticket count; here they are split
    // across two affiliates so a filtered figure is visibly a DIFFERENT number
    // from the unfiltered one - which is the whole point of this filter and
    // the thing most worth being able to see go wrong.
    listAffiliates: function () {
      return [{ name: 'KSL', tickets: 9 }, { name: 'TVL', tickets: 6 },
              { name: '(none given)', tickets: 2 }];
    },
    getPeopleByAffiliate: function (token, month, affiliate, standard) {
      var kpi = standardOf(standard);
      var share = affiliate === 'KSL' ? 0.6 : affiliate === 'TVL' ? 0.3 : 0.1;
      var people = FIXTURE.people.map(function (p) {
        var received = Math.max(1, Math.round(p.received * share));
        var delayed = Math.min(received, Math.round((p.delayed || 0) * share));
        // Banded through the same rescore() the rest of the page uses, and
        // against the standard that was asked for. It used to hardcode a
        // bare rate-over-90 test, which is the company target spelled out by
        // hand - the one thing that must not be written down twice now that
        // there are two of them.
        return rescore({ name: p.name, department: p.department,
                         received: received, completed: received, open: 0,
                         delayed: delayed,
                         successful: received - delayed }, kpi);
      });
      return { affiliate: affiliate, hasData: people.length > 0, people: people,
               affiliates: [{ name: 'KSL', tickets: 9 }, { name: 'TVL', tickets: 6 },
                            { name: '(none given)', tickets: 2 }] };
    },

    // THE TWO DOORS, and the switch in front of one of them.
    //
    // SIGNUPS_OPEN is a knob rather than a constant because the thing worth
    // testing about the sign-in page is what it offers when the door is SHUT:
    // no "create your login", and a line saying who to ask instead.
    signupsAreOpen: function () { return SIGNUPS_OPEN; },
    masterSetSignups: function (token, open) {
      SIGNUPS_OPEN = Boolean(open);
      return { ok: true, open: SIGNUPS_OPEN };
    },
    createAccount: function (employeeId, fullName, email, password) {
      if (!SIGNUPS_OPEN) {
        return { ok: false, message: 'Sign-ups are closed. Ask the EAS team ' +
                                     'to add your employee ID.' };
      }
      if (!/^[0-9]{4,12}$/.test(String(employeeId || ''))) {
        return { ok: false, message: 'An employee ID is digits only.' };
      }
      if (!String(fullName || '').trim()) {
        return { ok: false, message: 'Put your name in - it is what your ' +
                                     'messages are signed with.' };
      }
      if (String(password || '').length < 6) {
        return { ok: false, message: 'Choose a password of at least 6 characters.' };
      }
      if (ACCOUNTS.filter(function (a) { return a.username === String(employeeId); }).length) {
        return { ok: false, message: 'There is already a login for employee ID ' +
                                     employeeId + '.' };
      }
      ACCOUNTS.push({ username: String(employeeId), role: 'USER',
                      created: new Date().toISOString(),
                      lastSignIn: new Date().toISOString(), signIns: 1,
                      mustChange: false,
                      fullName: String(fullName).replace(/\\s+/g, ' ').trim(),
                      email: String(email || '').trim() });
      return { ok: true, setup: false, role: 'USER',
               username: String(employeeId), token: 'tok-' + employeeId };
    },

    /*
      THE COMPARISON SCREEN, which had no stub at all - so no browser test
      had ever opened it, and the one thing it got wrong went unseen: the
      caption under the KPI selector read the policy's target while the chart
      under it drew the EAS one, on the same screen at the same time.

      Sales Applications in September is the row that matters: 99 of 100, so
      99.00% - GREEN against the policy's 90% and YELLOW against the team's
      99.50%. Everything else clears both, so exactly one cell moves and the
      test cannot pass by accident.
    */
    getKpiComparison: function (token, periods, standard) {
      var kpi = standardOf(standard);
      var want = (periods || []).slice().sort();
      var DATA = {
        '2026-08': { 'Sales Applications': [800, 2],
                     'Functional Applications': [1200, 1] },
        '2026-09': { 'Sales Applications': [100, 1],
                     'Functional Applications': [1000, 2] }
      };

      var out = {
        periods: want, sections: [], totals: {}, bySection: {},
        target: kpi.target, standard: kpi.standard,
        standardLabel: kpi.standardLabel,
        kpi: 'KPI1', name: kpi.name, unit: '%',
        periodKind: 'MONTH', periodLabel: 'Month', periodLabelPlural: 'months',
        sectionLabel: 'Section', rateLabel: 'Success Rate',
        volumeKey: 'completed', volumeLabel: 'Tickets completed',
        measures: [{ key: 'received', label: 'Received' },
                   { key: 'completed', label: 'Completed' },
                   { key: 'open', label: 'Open' },
                   { key: 'delayed', label: 'Delayed' },
                   { key: 'successful', label: 'Successful' }]
      };

      want.forEach(function (month) {
        var rows = DATA[month];
        if (!rows) return;
        var whole = { received: 0, completed: 0, delayed: 0, successful: 0 };

        Object.keys(rows).forEach(function (section) {
          var completed = rows[section][0], delayed = rows[section][1];
          var entry = rescore({ received: completed, completed: completed,
                                open: 0, delayed: delayed,
                                successful: completed - delayed }, kpi);
          if (out.sections.indexOf(section) === -1) out.sections.push(section);
          out.bySection[section] = out.bySection[section] || {};
          out.bySection[section][month] = entry;

          whole.received += completed;
          whole.completed += completed;
          whole.delayed += delayed;
          whole.successful += completed - delayed;
        });

        out.totals[month] = rescore(Object.assign({ open: 0 }, whole), kpi);
      });

      return out;
    },

    /*
      THE TEAM DIRECTORY. Invented people with invented numbers - the real
      directory is thirty-seven colleagues' mobile numbers and has no business
      in a test fixture any more than it has in the source.

      Deliberately NOT a clean fixture: Ayesha has no photo and no extension,
      so the card has to cope with missing cells, and 'Nobody In Roster' is in
      the sheet but not in CONFIG.ROSTER so the drift notice has something to
      report. A fixture where everything is filled in tests the one case that
      never happens.
    */
    getTeam: function () {
      var utpal = { name: 'Utpal Biswas', id: '20000000', title: 'Senior Manager',
                    section: 'ALL', office: 'TVL HQ', ext: '2428',
                    phone: '01700000000', email: 'utpal@example.test',
                    photo: '', note: '', leads: 'Supply Chain Applications' };
      var ayesha = { name: 'Ayesha Rahman', id: '20000001', title: 'Manager',
                     section: 'Sales Applications', office: 'TVL HQ', ext: '',
                     phone: '01700000001', email: 'ayesha@example.test',
                     photo: '', note: '', leads: 'Yes' };
      return {
        filled: true,
        count: 5,
        // The department head, lifted out of the sections - his row says ALL,
        // which is not a section anybody is in.
        lead: utpal,
        sections: [
          // Supply Chain first and led by somebody who is not in it: that is
          // what interim means here, and it is the one case the ordering and
          // the labelling both have to get right.
          { name: 'Supply Chain Applications', count: 2, head: utpal, interim: true,
            members: [
              { name: 'Bilal Hossain', id: '20000003', title: 'Deputy Manager',
                section: 'Supply Chain Applications', office: 'YCL', ext: '2222',
                phone: '01700000003', email: 'bilal@example.test',
                photo: '', note: '', leads: '' }
            ] },
          { name: 'Sales Applications', count: 2, head: ayesha, interim: false,
            members: [
              { name: 'Carim Uddin', id: '20000002', title: 'Senior Officer',
                section: 'Sales Applications', office: 'TVL HQ', ext: '1234',
                phone: '01700000002', email: 'carim@example.test',
                photo: '', note: '', leads: '' }
            ] },
          // Nobody marked as its head, so it falls to the department head -
          // the arrangement the real team is in for Supply Chain.
          { name: 'Financial Applications', count: 2, head: utpal, interim: true,
            members: [
              { name: 'Nobody In Roster', id: '20000004', title: 'Officer',
                section: 'Financial Applications', office: 'YCL', ext: '3333',
                phone: '01700000004', email: 'nobody@example.test',
                photo: '', note: '', leads: '' }
            ] }
        ],
        drift: { missing: ['Dilruba Khatun'], unknown: ['Nobody In Roster'] }
      };
    },

    /*
      THE BEAT. Reads the token it is given, and reads 'away' as a parameter,
      exactly as the server does - and writes the state of 20000000 and
      nobody else, which is the one thing about the real endpoint worth
      modelling: whose state it sets is not something the caller gets to say.
    */
    presenceTick: function (token, away) {
      if (!token) {
        throw new Error('Your session has ended. Reload the page and sign in again.');
      }
      PRESENCE['20000000'] = away ? 'AWAY' : 'ACTIVE';
      return { me: PRESENCE['20000000'] };
    },

    getPresence: function (token) {
      if (!token) {
        throw new Error('Your session has ended. Reload the page and sign in again.');
      }
      // A copy. Handing the page the object the stub keeps its state in
      // would let a bug that mutated the answer pass unnoticed, and the
      // server returns a fresh object every time.
      var copy = {};
      Object.keys(PRESENCE).forEach(function (key) { copy[key] = PRESENCE[key]; });
      return copy;
    },

    presenceClear: function (token) {
      if (!token) return { me: 'OFFLINE' };
      delete PRESENCE['20000000'];
      return { me: 'OFFLINE' };
    },

    getKpi2: function () { return { hasData: false }; },
    getUploads: function () { return []; },
    getOrgChart: function () { return { sections: [] }; },
    renewToken: function () { return { ok: true, token: 't', role: ROLE }; },
    logout: function () { window.__sessionDead = true; return { ok: true }; }
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
          // A CALL THAT HAS NOT COME BACK YET. window.__slowNext = ms holds
          // the next dispatch open for that long, which is the only way to
          // reproduce what actually goes wrong on this page: a poll sent
          // before Sign out was pressed, landing after it, carrying a token
          // the server has just forgotten.
          var hold = window.__slowNext || 0;
          window.__slowNext = 0;
          setTimeout(function () {
            // HOW MANY TIMES EACH ENDPOINT WAS ASKED. Some of what the page
            // has to do is re-FETCH rather than re-draw - changing KPI 1's
            // standard has to go back for the affiliate slice as well, or it
            // keeps the bands it was given under the other target - and a
            // test reading the table cannot tell a stale answer from a fresh
            // one that happens to look the same.
            window.__calls = window.__calls || {};
            window.__calls[name] = (window.__calls[name] || 0) + 1;

            // A TOKEN THE SERVER NO LONGER ACCEPTS. Set by a test through
            // window.__expireSession(), because the page's answer to this
            // depends on WHY it happened - an hour of nothing, an account
            // removed, or the person having just pressed Sign out - and none
            // of those could be driven from a stub that always said yes.
            if (window.__sessionDead && name !== 'logout' &&
                name !== 'login' && name !== 'createAccount' &&
                name !== 'signupsAreOpen') {
              if (onFail) onFail(new Error('Your session has ended. Reload ' +
                                           'the page and sign in again.'));
              return;
            }

            try { if (onOk) onOk(HANDLERS[name].apply(null, args)); }
            catch (e) { if (onFail) onFail(e); }
          }, hold || 4);
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

// A BACKSLASH THAT DID NOT SURVIVE THE TEMPLATE LITERAL.
//
// The stub above is a template literal, where \s is not an escape JavaScript
// recognises and the backslash is dropped without a word. A regex written
// /\s+/g arrives as /s+/g - still valid, still silent, and now matching the
// letter s instead of whitespace. It cost an afternoon once; it is two lines
// to notice.
//
// Checked by looking for the mangled forms rather than the correct ones, so
// this keeps working when the stub grows new regexes of its own.
const mangled = ['/s+/', '/d+/', '/w+/', '[^@s]', '/S+/', '/D+/', '/W+/']
  .filter((bad) => html.indexOf(bad) !== -1);
if (mangled.length) {
  throw new Error(
    'build: a backslash was eaten by the stub template literal - ' +
    mangled.join(', ') + ' should be \\s, \\d, \\w and so on. Double every ' +
    'backslash inside the `stub` template.');
}

const out = process.env.EAS_PAGE || path.join(__dirname, 'page.html');
fs.writeFileSync(out, html);
console.log('wrote ' + out + '  (' + html.length + ' bytes)');
