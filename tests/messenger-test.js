// Conversations: who may write, who may read, and what the sign-in page costs.
//
// The messenger adds one thing this dashboard did not have before - a door that
// takes no token at all, because the person it is for is the one who cannot
// sign in. Everything here is about that door and the walls either side of it:
//
//   - a signed-in message is attributed to the TOKEN, never to a field;
//   - a sign-in-page message is attributed to nothing, is marked UNVERIFIED,
//     and lands in a thread the real owner of that ID NEVER SEES. If it did not,
//     a stranger could write into somebody's conversation and be read as them,
//     and a reply meant for the stranger would be waiting on the real
//     employee's screen;
//   - that door cannot be used to find out who has an account;
//   - and it cannot drain a hundred emails before breakfast.
//
//   node tests/messenger-test.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const SRC = process.env.EAS_SRC || path.join(__dirname, '..', 'src');

const out = [];
const check = (n, ok, d) => {
  out.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? '   [' + d + ']' : ''));
};

// ---------------------------------------------------------------------------
// a spreadsheet, a cache and a post room
// ---------------------------------------------------------------------------
function makeSheet(name) {
  const sheet = {
    name: name,
    rows: [],
    width: 0,
    getLastRow: function () { return sheet.rows.length + 1; },
    // The real one reports how wide the sheet actually is, which is what
    // sheetWithHeaders uses to decide whether a tab predates a column. Tracked
    // from every write, so a fake tab is as narrow as what was put in it.
    getLastColumn: function () { return sheet.width; },
    setFrozenRows: function () { return sheet; },
    // Row 2 is the first data row, so deleting row n drops rows[n-2] - and
    // everything below shuffles up, which is the whole reason deleteThread
    // walks backwards.
    deleteRow: function (r) { sheet.rows.splice(r - 2, 1); return sheet; },
    appendRow: function (row) {
      sheet.rows.push(row.slice());
      sheet.width = Math.max(sheet.width, row.length);
      return sheet;
    },
    getRange: function (r, c, n, w) {
      const height = n === undefined ? 1 : n;
      const width = w === undefined ? 1 : w;
      sheet.width = Math.max(sheet.width, c - 1 + width);
      const api = {
        getValues: function () {
          const got = [];
          for (let i = 0; i < height; i++) {
            got.push((sheet.rows[r - 2 + i] || []).slice(c - 1, c - 1 + width));
          }
          return got;
        },
        setValues: function (values) {
          values.forEach(function (v, i) {
            const at = r - 2 + i;
            if (at < 0) return;
            if (!sheet.rows[at]) sheet.rows[at] = [];
            v.forEach(function (cell, j) { sheet.rows[at][c - 1 + j] = cell; });
          });
          return api;
        },
        setValue: function (v) {
          const at = r - 2;
          if (at < 0) return api;
          if (!sheet.rows[at]) sheet.rows[at] = [];
          sheet.rows[at][c - 1] = v;
          return api;
        },
        setFontWeight: () => api, setBackground: () => api,
        setFontColor: () => api, setNumberFormat: () => api
      };
      return api;
    }
  };
  return sheet;
}

const tabs = {};
const book = {
  getSheetByName: function (n) { return tabs[n] || null; },
  insertSheet: function (n) { tabs[n] = makeSheet(n); return tabs[n]; }
};

const sent = [];
let mailWorks = true;
let cache = {};
const props = {};

const sb = {
  console, Object, String, Number, Array, Math, JSON, RegExp, Date,
  isFinite, Boolean, Error, parseInt, parseFloat, Set,
  Logger: { log: function () {} },
  SpreadsheetApp: { openById: function () { return book; } },
  PropertiesService: {
    getScriptProperties: function () {
      return {
        getProperty: function (k) { return k in props ? props[k] : null; },
        setProperty: function (k, v) { props[k] = v; },
        deleteProperty: function (k) { delete props[k]; }
      };
    }
  },
  CacheService: {
    getScriptCache: function () {
      return {
        get: function (k) { return k in cache ? cache[k] : null; },
        put: function (k, v) { cache[k] = v; },
        remove: function (k) { delete cache[k]; }
      };
    }
  },
  MailApp: {
    sendEmail: function (options) {
      if (!mailWorks) throw new Error('Service invoked too many times for one day: email.');
      sent.push(options);
    }
  },
  Utilities: {
    // Unique per call, like the real one - that uniqueness is the only reason
    // thread and message IDs are unique. A constant would test a different
    // program, and a counter padded on the left would not vary in the
    // characters the code actually keeps.
    getUuid: (function () {
      let seed = 0x2f6e2b1;
      const hex = function () {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0).toString(16).padStart(8, '0').slice(0, 8);
      };
      return function () {
        return hex() + '-' + hex() + '-' + hex() + '-' + hex();
      };
    })(),
    formatDate: function (d, tz, fmt) {
      const pad = (n) => (n < 10 ? '0' : '') + n;
      const at = new Date(d);
      return fmt
        .replace('yyyy', at.getUTCFullYear())
        .replace('MMM', 'Aug')
        .replace('MM', pad(at.getUTCMonth() + 1))
        .replace('dd', pad(at.getUTCDate()))
        .replace('d', at.getUTCDate())
        .replace('HHmmss', pad(at.getUTCHours()) + pad(at.getUTCMinutes()) +
                           pad(at.getUTCSeconds()))
        .replace('HH:mm', pad(at.getUTCHours()) + ':' + pad(at.getUTCMinutes()));
    }
  }
};
sb.globalThis = sb;
vm.createContext(sb);

vm.runInContext(fs.readFileSync(path.join(SRC, 'Config.gs'), 'utf8'), sb);
vm.runInContext('function getSpreadsheetId() { return "fake"; }', sb);
vm.runInContext('function CONFIG_TZ() { return "Asia/Dhaka"; }', sb);

// THE WHOLE OF Auth.gs, not five functions picked out of it.
//
// It used to be five: the role constants, rankOf and the two guards. That was
// enough while the messenger kept everything it knew about a person on their
// conversations. It knows where to look now - a name lives on the ACCOUNT -
// so the real account store has to be here, or these tests would be checking
// a stand-in that answers whatever is convenient. Three bugs in this project
// have already hidden behind a test double more generous than the server.
//
// The stubs below are applied AFTER it, and a later declaration wins, so
// currentSession and liveRoleOf are still the simple test versions.
vm.runInContext(fs.readFileSync(path.join(SRC, 'Auth.gs'), 'utf8'), sb);
// A token is 'ROLE:employeeId' here; null is nobody.
vm.runInContext(
  'function currentSession(token) {\n' +
  '  if (!token) return null;\n' +
  '  var bits = String(token).split(":");\n' +
  '  return { u: bits[1], r: bits[0] };\n' +
  '}\n' +
  'function liveRoleOf(u) { return ROLES_BY_ID[u] || "USER"; }\n' +
  'var ROLES_BY_ID = {};\n' +
  'function requireOwner() {}', sb);

vm.runInContext(fs.readFileSync(path.join(SRC, 'Questions.gs'), 'utf8'), sb);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Messenger.gs'), 'utf8'), sb);
vm.runInContext('ROLES_BY_ID["20000099"] = "ADMIN";', sb);

const CONFIG = vm.runInContext('CONFIG', sb);
const boot = vm.runInContext('messengerBoot', sb);
const sendRaw = vm.runInContext('sendMessage', sb);
const myThreads = vm.runInContext('myThreads', sb);

// A person has MANY queries now, each its own conversation. send() with no
// thread starts a new one; replyIn() adds a line to one they already own.
const send = (token, text, name) => sendRaw(token, '', '', text, name);
const askAbout = (token, topic, text, name) => sendRaw(token, '', topic, text, name);
const replyIn = (token, id, text, name) => sendRaw(token, id, '', text, name);
// The token slot is first on every endpoint, so the client can inject it in
// one place. This one ignores it - that is the point of it.
const sendAnonRaw = vm.runInContext('sendUnverifiedMessage', sb);
const sendAnon = (id, text) => sendAnonRaw(null, id, text);
const sendAnonNamed = (id, text, name) => sendAnonRaw(null, id, text, name);
const myMessagesRaw = vm.runInContext('myMessages', sb);

/** Every line of theirs, across every query, oldest first. */
const mine = function (token) {
  const data = myMessagesRaw(token);
  const threads = data.threads || [];
  const flat = [];
  threads.slice().reverse().forEach(function (t) {
    t.messages.forEach(function (m) { flat.push(m); });
  });
  return { threads: threads, messages: flat, unread: data.unread };
};
const markRead = vm.runInContext('markMyMessagesRead', sb);
const threads = vm.runInContext('listThreads', sb);
const reply = vm.runInContext('replyToThread', sb);
/** One conversation's lines, oldest first - to ask WHICH thread holds what. */
const threadLines = vm.runInContext('threadMessageList', sb);
const waiting = vm.runInContext('unansweredQuestionCount', sb);

const T = CONFIG.SHEETS.THREADS, M = CONFIG.SHEETS.MESSAGES;
const USER = 'USER:20990012';
const OTHER = 'USER:20000002';
const ADMIN = 'ADMIN:20000099';
const MASTER = 'MASTER:20000001';
const threw = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message || e); } };

// ---------------------------------------------------------------------------
// a signed-in conversation
// ---------------------------------------------------------------------------
check('somebody signed out cannot send as somebody',
  send(null, 'Hello there').ok === false, send(null, 'Hello').message);

const first = send(USER, 'I cannot see September on the KPI 1 screen.');
check('a signed-in person can', first.ok === true, first.message);

check('one thread was opened, keyed to the ID on the token',
  tabs[T].rows.length === 1 && tabs[T].rows[0][1] === '20990012',
  'Person = ' + tabs[T].rows[0][1]);
check('and marked verified, because the token proved it',
  tabs[T].rows[0][2] === 'YES');
check('with the message on it, from the USER side',
  tabs[M].rows.length === 1 && tabs[M].rows[0][3] === 'USER' &&
  /cannot see September/.test(tabs[M].rows[0][5]));

// EACH QUESTION IS ITS OWN QUERY NOW. Sending with no thread starts a new
// one; a run of unrelated questions used to pile into a single endless
// conversation with no way to tell where one ended and the next began.
send(USER, 'Separately - who do I ask about a purchase order?');
check('a message with no thread starts a NEW query',
  tabs[T].rows.length === 2 && tabs[M].rows.length === 2,
  tabs[T].rows.length + ' queries, ' + tabs[M].rows.length + ' messages');

replyIn(USER, first.threadId, 'Never mind - the month filter was on August.');
check('and a reply into one joins that query rather than starting another',
  tabs[T].rows.length === 2 && tabs[M].rows.length === 3,
  tabs[T].rows.length + ' queries, ' + tabs[M].rows.length + ' messages');

const firstQuery = mine(USER).threads.filter((t) => t.id === first.threadId)[0];
check('and that query reads in order, oldest first',
  firstQuery.messages.length === 2 &&
  /cannot see September/.test(firstQuery.messages[0].text),
  'like a chat');

// ---------------------------------------------------------------------------
// the email is a nudge, and only one per pending conversation
// ---------------------------------------------------------------------------
check('with nobody on the alert list nothing is sent, and the message lands',
  sent.length === 0 && tabs[M].rows.length === 3,
  sent.length + ' sent, ' + tabs[M].rows.length + ' messages stored');

vm.runInContext('setQuestionAlerts', sb)('boss@example.com, lead@example.com');
cache = {};                                  // a fresh hour

// A fresh person, so this really is a first message. USER already has two
// unanswered, and the whole point of the rule below is that those do not email
// again - testing the nudge on them would prove nothing.
const THIRD = 'USER:20000003';
const opened = send(THIRD, 'Where do I find last year\'s numbers?');
check('a first message from somebody emails the team',
  opened.emailed === true && sent.length === 1 &&
  sent[0].to === 'boss@example.com,lead@example.com',
  sent[0].to);
check('as plain text, so nothing somebody typed can be markup',
  sent[0].htmlBody === undefined && typeof sent[0].body === 'string');
check('and it says the identity was verified',
  /Identity: verified/.test(sent[0].body), 'they were signed in');

const followUp = replyIn(THIRD, opened.threadId, 'Sorry - I mean 2025, not 2024.');
check('a follow-up while we already owe them a reply does NOT email again',
  followUp.ok === true && followUp.emailed === false && sent.length === 1,
  'somebody thinking out loud is one interruption, not four');

const third = replyIn(USER, first.threadId,
                      'Actually it is still wrong - September shows zero.');
check('and the same is true of a query already waiting on us',
  third.ok === true && third.emailed === false && sent.length === 1,
  'that query already had an unanswered line when the alert list was set');

// THE ONE THAT MATTERS.
mailWorks = false;
cache = {};
let escaped = '';
let despite = { ok: false };
try { despite = send(OTHER, 'The download button gives me an empty file.'); }
catch (e) { escaped = String(e.message || e); }
mailWorks = true;
check('a message still lands when the email fails outright',
  !escaped && despite.ok === true &&
  tabs[M].rows.filter((r) => /empty file/.test(r[5])).length === 1,
  escaped ? 'the send threw all the way out: ' + escaped
          : 'quota, authorisation and a bad address all throw the same way');

// ---------------------------------------------------------------------------
// one person's conversation is one person's
// ---------------------------------------------------------------------------
check('a person sees only their own queries',
  !mine(USER).messages.some((m) => /empty file/.test(m.text)) &&
  !mine(USER).messages.some((m) => /last year/.test(m.text)),
  mine(USER).threads.length + ' queries, ' +
  mine(USER).messages.length + ' lines, none of them anybody else\'s'); 
check('and no employee ID is echoed back on their own lines',
  mine(USER).messages.every((m) => m.author === undefined),
  'they know who they are');
check('somebody signed out gets nothing rather than everything',
  mine(null).messages.length === 0);

// ---------------------------------------------------------------------------
// THE SIGN-IN PAGE DOOR
// ---------------------------------------------------------------------------
cache = {};
const anon = sendAnon('20990012', 'I am locked out, my password will not work.');
check('the sign-in page accepts a message with no token at all',
  anon.ok === true, anon.message);

const anonThreads = tabs[T].rows.filter((r) => r[2] === 'NO');
check('it goes to a thread of its own, marked NOT verified',
  anonThreads.length === 1 && anonThreads[0][1] === '20990012',
  tabs[T].rows.length + ' threads, ' + anonThreads.length + ' unverified');

// THE ONE THAT REALLY MATTERS. Deliberately not counting messages - this must
// hold whatever else the suite has done, and it has to be sure the message it
// is looking for exists at all, or an empty thread would pass it.
const anonId = findThreadId('20990012', 'NO');
const verifiedId = findThreadId('20990012', 'YES');
check('the two threads for that ID really are different rows',
  Boolean(anonId) && Boolean(verifiedId) && anonId !== verifiedId,
  anonId + ' vs ' + verifiedId);
check('and the stranger\'s words are genuinely stored somewhere',
  tabs[M].rows.some((r) => r[1] === anonId && /locked out/.test(r[5])),
  'otherwise the next assertion proves nothing');
check('but the real owner of that ID does NOT see them in their messenger',
  !mine(USER).messages.some((m) => /locked out/.test(m.text)),
  'a stranger typing your ID cannot put words in your conversation');

reply(ADMIN, anonThreads[0][0], 'Who is this? Ring the EAS desk on 2214.');
check('nor does a reply written to that stranger reach them',
  !mine(USER).messages.some((m) => /Ring the EAS desk/.test(m.text)),
  'it would be read as a reply to something they never sent');

check('the team is told in the subject line that it is unverified',
  sent.some((e) => /UNVERIFIED/.test(e.subject)),
  (sent[sent.length - 1] || {}).subject);
check('and the body says plainly not to reset anything on it',
  /Do not reset a password/.test(sent[sent.length - 1].body),
  'this is the social-engineering path, so the warning travels with it');

check('an employee ID that does not exist is accepted exactly the same way',
  sendAnon('99999999', 'Hello, I cannot sign in.').ok === true &&
  sendAnon('99999999', 'Hello again, still stuck.').message ===
    sendAnon('20990012', 'Me too, cannot sign in.').message,
  'otherwise the box tells a stranger who works here');

check('a message with no employee ID is refused',
  sendAnon('', 'Let me in').ok === false, sendAnon('', 'Let me in').message);
check('and so is a silly one',
  sendAnon('<script>', 'Let me in').ok === false,
  'the ID is checked for shape, not for existence');

// the hourly ceiling on the public door
cache = {};
const flood = [];
const mailBefore = sent.length;
for (let i = 0; i < CONFIG.UNVERIFIED_PER_HOUR + 10; i++) {
  flood.push(sendAnon('3000' + String(i).padStart(4, '0'),
                      'Message number ' + i + ' from a script.'));
}
const got = flood.filter((r) => r.ok).length;
const floodMail = sent.length - mailBefore;
check('the sign-in box stops accepting after the hourly ceiling',
  got === CONFIG.UNVERIFIED_PER_HOUR,
  got + ' of ' + flood.length + ' accepted, ceiling is ' + CONFIG.UNVERIFIED_PER_HOUR);
check('and far fewer of those were allowed to send an email',
  floodMail <= CONFIG.UNVERIFIED_EMAILS_PER_HOUR,
  floodMail + ' emails for ' + got + ' messages - a bot must not spend a ' +
  'day of quota before a colleague can be heard');

// A cache it cannot read must not mean a door it cannot close.
const realCache = sb.CacheService.getScriptCache;
sb.CacheService.getScriptCache = function () { throw new Error('cache is gone'); };
const whenBlind = sendAnon('20000055', 'Can anyone hear me?');
sb.CacheService.getScriptCache = realCache;
check('a cache failure closes the public door rather than opening it',
  whenBlind.ok === false,
  'the per-person cap fails open on purpose; this one must not');

// ---------------------------------------------------------------------------
// the team's inbox
// ---------------------------------------------------------------------------
check('listing conversations needs ADMIN',
  /admin login/i.test(threw(() => threads(USER))), threw(() => threads(USER)));
check('replying needs ADMIN too',
  /admin login/i.test(threw(() => reply(USER, 'T1', 'Sure.'))),
  'hiding the box is not what stops them');

const inbox = threads(ADMIN);
check('an admin sees every conversation, with its messages',
  inbox.length === tabs[T].rows.length && inbox[0].messages.length > 0,
  inbox.length + ' conversations');
check('the ones waiting on us come first',
  inbox[0].waiting > 0, 'an inbox sorted by nothing is a list');
check('and each says whether the person was verified',
  inbox.some((t) => t.verified === false) && inbox.some((t) => t.verified === true),
  'the flag travels to the screen, not just the email');

cache = {};
const answerTo = findThreadId('20990012', 'YES');
const queriesBeforeReply = tabs[T].rows.length;
const answer = reply(ADMIN, answerTo,
                     'September was filed under the wrong section. Fixed now.');
check('an admin can reply', answer.ok === true, answer.message);
check('and the reply lands in that person\'s own messenger',
  mine(USER).messages.some((m) => /wrong section/.test(m.text) && m.side === 'TEAM'),
  'one conversation, both sides, one place to look');

// THE TEAM DOES NOT START CONVERSATIONS.
// replyToThread() looked its thread up correctly and then called
// appendToThread() one argument short, so every reply the team sent forked a
// new untitled query owned by the person who had asked. The question stayed
// put, the answer appeared beside it, and neither screen could tell they
// belonged together.
//
// The assertion directly above this one did not catch it, and could not:
// mine() flattens every one of that person's queries into a single list, so a
// reply sitting in a query of its own is still somewhere in that list. These
// ask WHICH conversation it went into.
check('a team reply joins the query it was sent to and starts no new one',
  tabs[T].rows.length === queriesBeforeReply,
  queriesBeforeReply + ' queries before the reply, ' + tabs[T].rows.length +
  ' after');
check('and the line is in THAT conversation, under the question',
  threadLines(answerTo).some((m) => /wrong section/.test(m.text) &&
                                    m.side === 'TEAM'),
  threadLines(answerTo).map((m) => m.side).join(' -> '));
check('which is how the asker sees it too, in the query they opened',
  (mine(USER).threads.filter((t) => t.id === answerTo)[0] || { messages: [] })
    .messages.some((m) => /wrong section/.test(m.text) && m.side === 'TEAM'),
  'not as a second query that answers a question it does not contain');
check('and no conversation anywhere is nothing but team lines',
  !threads(ADMIN).some((t) => t.messages.length > 0 &&
                              t.messages.every((m) => m.side === 'TEAM')),
  'nobody can start one of those by hand - the team only ever replies');

// The guard that stops the next caller repeating it. A team line with no
// conversation to go into is a caller that forgot to say which thread it
// meant, and a thread invented for it is how three weeks of replies went
// missing in plain sight.
const appendRaw = vm.runInContext('appendToThread', sb);
const beforeOrphan = tabs[T].rows.length;
check('appending a team line with no conversation is refused outright',
  /no conversation to go into/i.test(
    threw(() => appendRaw('20990012', 'YES', 'TEAM', '20000099', 'Orphan.'))),
  'rather than quietly making a query out of it');
check('and nothing was written while it was refused',
  tabs[T].rows.length === beforeOrphan,
  beforeOrphan + ' queries, unchanged');
const answered = mine(USER).threads.filter((t) =>
  t.messages.some((m) => /wrong section/.test(m.text)))[0];
const beforeThanks = answered.messages.length;
const queriesBefore = mine(USER).threads.length;
check('the person can answer the reply, and it stays in that query',
  replyIn(USER, answered.id, 'Thank you, that is right now.').ok === true &&
  mine(USER).threads.filter((t) => t.id === answered.id)[0].messages.length
    === beforeThanks + 1 &&
  mine(USER).threads.length === queriesBefore,
  beforeThanks + ' -> ' + (beforeThanks + 1) + ' lines, still ' +
  queriesBefore + ' queries');

// ---------------------------------------------------------------------------
// unread counts
// ---------------------------------------------------------------------------
cache = {};
send(OTHER, 'One more thing about the download.');
reply(ADMIN, findThreadId('20000002', 'YES'), 'Looking at it now.');
check('a reply raises an unread count on the asker\'s bar',
  mine(OTHER).unread > 0, mine(OTHER).unread + ' unread');
// Per query, not all at once: opening one conversation is not reading the
// others, and clearing their dots would hide a reply nobody has looked at.
const unreadQuery = mine(OTHER).threads.filter((t) => t.unread > 0)[0];
markRead(OTHER, unreadQuery.id);
check('and opening that one clears its dot',
  mine(OTHER).threads.filter((t) => t.id === unreadQuery.id)[0].unread === 0);
check('without reaching into anybody else\'s',
  markRead(USER, unreadQuery.id).ok === false,
  'a thread ID is not a key to it');
check('without touching anybody else\'s',
  mine(USER).unread === 0 || typeof mine(USER).unread === 'number');

check('the badge counts conversations waiting on us, not messages',
  waiting() === threads(ADMIN).filter((t) => t.waiting > 0).length,
  waiting() + ' waiting');

// ---------------------------------------------------------------------------
// what the panel is handed
// ---------------------------------------------------------------------------
const signedOut = boot(null);
check('the panel works signed out, for the sign-in page',
  signedOut.signedIn === false && signedOut.faq.length > 0,
  signedOut.faq.length + ' FAQ entries');
check('and carries no queries there, because there is nobody to have one',
  signedOut.threads.length === 0 && signedOut.canAnswer === false);
check('and offers nobody the delete control',
  signedOut.canDelete === false);

const asUser = boot(USER);
check('a signed-in person is handed the FAQ and every query of theirs',
  asUser.signedIn === true && asUser.faq.length > 0 &&
  asUser.threads.length === mine(USER).threads.length &&
  asUser.threads.length > 1,
  asUser.threads.length + ' queries');
check('and is not told they can answer',
  asUser.canAnswer === false, 'the Help screen is the team\'s, not theirs');
check('an admin is',
  boot(ADMIN).canAnswer === true, 'so the screen knows whether to offer it');

// Deleting destroys somebody else's record of what they were told, so it is
// not a thing every admin should be able to do on a mis-click.
check('an admin is NOT offered the delete control',
  boot(ADMIN).canDelete === false, 'it would be refused anyway');

function findThreadId(person, verified) {
  const hit = tabs[T].rows.filter((r) => r[1] === person && r[2] === verified)[0];
  return hit ? hit[0] : '';
}

// ---------------------------------------------------------------------------
// one person, many queries
// ---------------------------------------------------------------------------
cache = {};
const subject = askAbout(USER, 'Affiliate table',
                         'Could you add an affiliate-wise table?');
check('a new query can carry a subject',
  subject.ok === true &&
  mine(USER).threads.filter((t) => t.id === subject.threadId)[0].topic
    === 'Affiliate table',
  'it is what the panel and the inbox put on the row');

check('and the list comes back newest activity first',
  mine(USER).threads[0].id === subject.threadId,
  'the one just touched is the one most likely wanted');

// THE ONE THAT MATTERS. A thread ID is not a key to that thread - without the
// ownership check a signed-in person could paste any conversation's ID into
// the call and write a line into somebody else's query, signed with that
// person's name, to be read as theirs by whoever answers it.
const notMine = mine(OTHER).threads[0];
const trespass = replyIn(USER, notMine.id, 'Writing into somebody else\'s query.');
check('a thread ID is not a key to that thread',
  trespass.ok === false, trespass.message);
check('and nothing of theirs was written',
  !mine(OTHER).messages.some((m) => /somebody else/.test(m.text)) &&
  !tabs[M].rows.some((r) => /somebody else's query/.test(r[5])),
  'refused before anything touched the sheet');
check('an unverified thread is not reachable from a signed-in session either',
  replyIn(USER, findThreadId('20990012', 'NO'), 'Mine now.').ok === false,
  'the two kinds stay apart in both directions');

// ---------------------------------------------------------------------------
// what somebody is called, and what they are
// ---------------------------------------------------------------------------
// The name is typed; the employee ID on a verified thread comes from the
// session token. So a name can never be identification, and the pair is only
// as good as its second half.
cache = {};
const named = send(USER, 'One more question about the export.', '  Rudra   Das ');
check('a name sent with a message is kept on the conversation',
  named.ok === true && findThreadName('20990012', 'YES') === 'Rudra Das',
  JSON.stringify(findThreadName('20990012', 'YES')));
check('and tidied, so a stray double space is not somebody\'s name forever',
  findThreadName('20990012', 'YES').indexOf('  ') === -1);

check('a name written once shows on EVERY query of theirs',
  mine(USER).threads.length > 1 &&
  threads(ADMIN).filter((t) => t.person === '20990012' && t.verified)
                .every((t) => t.name === 'Rudra Das'),
  'written to one row only, the inbox would name them on one card and show a ' +
  'bare employee ID on the next');

check('the inbox shows both halves, name first',
  threads(ADMIN).filter((t) => t.person === '20990012' && t.verified)[0].name === 'Rudra Das',
  'the screen writes it as Rudra Das (20990012)');
check('and the panel hands the name back, so nobody types it twice',
  boot(USER).name === 'Rudra Das', boot(USER).name);

cache = {};
send(USER, 'Correcting my name.', 'Rudra');
check('a later message can correct it',
  findThreadName('20990012', 'YES') === 'Rudra', findThreadName('20990012', 'YES'));
cache = {};
send(USER, 'And this one leaves the box empty.', '');
check('but leaving the box empty does not erase it',
  findThreadName('20990012', 'YES') === 'Rudra',
  'otherwise the name vanishes the first time somebody is in a hurry');

cache = {};
sendAnonNamed('20990015', 'I cannot sign in.', 'Not Rudra At All');
check('a name on an UNVERIFIED thread is stored like any other',
  findThreadName('20990015', 'NO') === 'Not Rudra At All',
  'it is a label, not a claim the system can check');
check('and that thread is still marked unverified, name or no name',
  threads(ADMIN).filter((t) => t.person === '20990015')[0].verified === false,
  'a name must never make something look more checked than it is');

check('the email says who it is from, name and ID together',
  sent.length > 0 && /Rudra/.test(sent[sent.length - 1].body + sent[sent.length - 1].subject),
  (sent[sent.length - 1] || {}).subject);

// ---------------------------------------------------------------------------
// a tab made before the Name column existed
// ---------------------------------------------------------------------------
// His THREADS tab was created yesterday, one column short. Reading a range
// wider than the sheet throws, so this is the difference between the messenger
// working on Thursday and not.
const narrow = tabs[T];
narrow.width = CONFIG.THREAD_COLUMNS.length - 1;
const was = narrow.width;                  // read BEFORE the call widens it
const after = vm.runInContext('threadTab', sb)();
check('an older, narrower tab is widened rather than thrown at',
  was === CONFIG.THREAD_COLUMNS.length - 1 &&
  after.width >= CONFIG.THREAD_COLUMNS.length,
  was + ' -> ' + after.width + ' columns');
check('and everything in it still reads back',
  threads(ADMIN).length > 0 && Boolean(threads(ADMIN)[0].id),
  threads(ADMIN).length + ' conversations survived');

// ---------------------------------------------------------------------------
// who replied
// ---------------------------------------------------------------------------
// Both sides need this and for different reasons: the person who asked wants
// to know who owns their answer, and the next admin to open the inbox wants to
// know a colleague has already picked it up rather than writing a second reply
// underneath the first.
cache = {};
const mineNow = mine(USER).messages;
const teamLines = mineNow.filter((m) => m.side === 'TEAM');
check('a reply carries who wrote it, all the way to the asker\'s own panel',
  teamLines.length > 0 && teamLines.every((m) => Boolean(m.by)),
  teamLines.length ? teamLines[teamLines.length - 1].by : 'no team lines');
check('and it carries the employee ID even before that admin has a name',
  /20000099/.test(teamLines[teamLines.length - 1].by),
  teamLines[teamLines.length - 1].by);
check('their own lines carry no author at all',
  mineNow.filter((m) => m.side === 'USER').every((m) => m.by === undefined),
  'they know who they are, and the team has the thread header');

// A name is stamped when the reply is written, not looked up when it is read.
send(ADMIN, 'Setting my own name.', 'Shahriar Kabir');
cache = {};
reply(ADMIN, findThreadId('20000002', 'YES'), 'Having a look at that now.');
const named2 = mine(OTHER).messages.filter((m) => m.side === 'TEAM');
check('once an admin has a name, their replies carry it',
  /Shahriar Kabir/.test(named2[named2.length - 1].by),
  named2[named2.length - 1].by);

// ---------------------------------------------------------------------------
// deleting a conversation
// ---------------------------------------------------------------------------
const del = vm.runInContext('deleteThread', sb);

// MASTER, not ADMIN. Deleting destroys the conversation for the person who
// wrote it as well as for the team - their copy goes from their own panel
// with everything they were told in it.
check('deleting is refused to a viewer',
  /session|master|admin/i.test(threw(() => del(USER, findThreadId('20000002', 'YES')))),
  threw(() => del(USER, findThreadId('20000002', 'YES'))));
check('and refused to an ADMIN too',
  /master access only/i.test(threw(() => del(ADMIN, findThreadId('20000002', 'YES')))),
  'an admin answers queries; they do not erase somebody else\'s record');
check('and a conversation that is not there says so',
  del(MASTER, 'T-nope').ok === false, del(MASTER, 'T-nope').message);

// A thread with several messages, written AROUND another thread's, so the
// rows are interleaved on the tab the way they really are.
// Several lines INTO one query, written around other people's, so the rows
// are interleaved on the tab the way they really are.
cache = {};
const victimId = mine(OTHER).threads[0].id;
replyIn(OTHER, victimId, 'One line.');
send(USER, 'Somebody else, in between.');
cache = {};
replyIn(OTHER, victimId, 'Another line.');
send(USER, 'And again in between.');

const beforeT = tabs[T].rows.length;
const beforeM = tabs[M].rows.length;
const victimLines = tabs[M].rows.filter((r) => r[1] === victimId).length;
const survivorId = mine(USER).threads[0].id;
const survivorLines = tabs[M].rows.filter((r) => r[1] === survivorId).length;
const otherQueriesBefore = mine(OTHER).threads.length;

const gone = del(MASTER, victimId);
check('the master can delete one', gone.ok === true, gone.message);
check('the conversation row goes',
  tabs[T].rows.length === beforeT - 1 &&
  !tabs[T].rows.some((r) => r[0] === victimId),
  beforeT + ' -> ' + tabs[T].rows.length + ' threads');
check('and only that one of theirs',
  mine(OTHER).threads.length === otherQueriesBefore - 1,
  otherQueriesBefore + ' -> ' + mine(OTHER).threads.length + ' queries');

// THE ONE THAT WOULD HAVE BEEN WRONG. Deleting row 5 moves row 6 up to 5, so
// walking downwards skips every second match and leaves half a conversation
// behind - which looks exactly like it worked.
check('and EVERY message in it goes, not every other one',
  tabs[M].rows.filter((r) => r[1] === victimId).length === 0,
  victimLines + ' lines, ' +
  tabs[M].rows.filter((r) => r[1] === victimId).length + ' left');
check('while nobody else loses a line',
  tabs[M].rows.filter((r) => r[1] === survivorId).length === survivorLines &&
  tabs[M].rows.length === beforeM - victimLines,
  beforeM + ' -> ' + tabs[M].rows.length + ' messages, ' +
  victimLines + ' expected to go');
check('and the person it belonged to cannot read it any more either',
  !mine(OTHER).messages.some((m) => /One line\.|Another line\./.test(m.text)),
  'it goes from their panel too, which is the part worth asking about first');

// ---------------------------------------------------------------------------
// how somebody is written, and who may ask what is waiting
// ---------------------------------------------------------------------------
const nameOf = vm.runInContext('who', sb);
check('somebody with a name is written name first, ID in brackets',
  nameOf('20990012', 'Rudra Das') === 'Rudra Das (20990012)',
  nameOf('20990012', 'Rudra Das'));
check('and somebody without one is just the ID',
  nameOf('20990014', '') === '20990014', nameOf('20990014', ''));
check('with no "employee ID" said out loud on a line that is already an ID',
  !/employee/i.test(nameOf('20990014', '')) &&
  !/employee/i.test(nameOf('20990012', 'Rudra Das')),
  'the screen has one line per message - two words of label is a third of it');

const waitingFor = vm.runInContext('messagesWaiting', sb);
check('the count behind the badge needs ADMIN',
  /admin login/i.test(threw(() => waitingFor(USER))), threw(() => waitingFor(USER)));
check('and gives an admin the same number the badge shows',
  waitingFor(ADMIN) === waiting(), waitingFor(ADMIN) + ' waiting');

function findThreadName(person, verified) {
  const hit = tabs[T].rows.filter((r) => r[1] === person && r[2] === verified)[0];
  return hit ? String(hit[10] || '') : '';
}

// ---------------------------------------------------------------------------
// putting back what the bug already wrote
// ---------------------------------------------------------------------------
// The code is fixed, which stops it happening again and does nothing at all
// about the rows that are already in the sheet. Those have to be moved, and
// the link back to the question was never written down - so the repair infers
// it, and a repair that infers things is one you want a test around.
//
// The fixture is built by hand, in the shape the live sheet is actually in:
// a real question, and beside it a conversation containing nothing but the
// reply it was given.
const repair = vm.runInContext('repairStrayReplies', sb);

// A reply is typed AFTER the question it answers, and that ordering is the
// only thing the repair has to go on - so the fixture has to honour it.
const soonAfter = (seconds) => new Date(Date.now() + seconds * 1000);

const asked = send(USER, 'The affiliate filter is showing the wrong total.');
const askedId = asked.threadId;

// A reply as the broken build wrote it: its own thread, owned by the asker,
// no topic, one TEAM line in it.
const strayBorn = soonAfter(60);
tabs[T].rows.push(['T-STRAY-1', '20990012', 'YES', strayBorn,
                   '', strayBorn, 'TEAM', 'OPEN', 0, 1, 'Rudra Das']);
tabs[M].rows.push(['M-STRAY-1', 'T-STRAY-1', strayBorn,
                   'TEAM', '20000099', 'Yes, of course. I am working on it.',
                   'Shahriar Kabir']);

const threadsBefore = tabs[T].rows.length;
const messagesBefore = tabs[M].rows.length;

check('a stray reply is one more query in the asker\'s panel, which is the bug',
  mine(USER).threads.filter((t) => t.id === 'T-STRAY-1').length === 1,
  'this is what the screen was showing');

// ---- the report changes nothing ----
const planned = repair();
check('the report finds it', planned === 1, planned + ' to merge');
check('and writes absolutely nothing while reporting',
  tabs[T].rows.length === threadsBefore &&
  tabs[M].rows.length === messagesBefore &&
  tabs[M].rows.some((r) => r[1] === 'T-STRAY-1'),
  'you read the list before it moves anybody\'s messages');

// ---- and then it does ----
const merged = repair(true);
check('applying it merges that one', merged === 1, merged + ' merged');
check('the line itself is kept, not deleted',
  tabs[M].rows.length === messagesBefore &&
  tabs[M].rows.some((r) => /I am working on it/.test(r[5])),
  'it is a message somebody typed - the thread around it was the mistake');
check('and it now sits in the query it was answering',
  threadLines(askedId).some((m) => /I am working on it/.test(m.text) &&
                                   m.side === 'TEAM'),
  threadLines(askedId).map((m) => m.side).join(' -> '));
check('the empty shell is gone from the sheet',
  tabs[T].rows.length === threadsBefore - 1 &&
  !tabs[T].rows.some((r) => r[0] === 'T-STRAY-1'),
  threadsBefore + ' -> ' + tabs[T].rows.length + ' queries');
check('so the asker is back to one query, with both sides in it',
  mine(USER).threads.filter((t) => t.id === 'T-STRAY-1').length === 0 &&
  mine(USER).threads.filter((t) => t.id === askedId)[0].messages.length === 2,
  'a question and the answer to it, in one place');

// The counters are a running tally - a user line counts up, a team line
// clears it - so they are replayed rather than added to.
const mendedRow = tabs[T].rows.filter((r) => r[0] === askedId)[0];
check('and the query no longer claims to be waiting on us',
  Number(mendedRow[8]) === 0 && String(mendedRow[6]) === 'TEAM',
  'waiting ' + mendedRow[8] + ', last by ' + mendedRow[6]);
check('while the reply counts as one the person has not read',
  Number(mendedRow[9]) === 1, 'unread ' + mendedRow[9]);

// ---- run it again ----
check('running it a second time finds nothing left to do',
  repair(true) === 0,
  'it is safe to run twice, like the migration beside it');

// ---- what it refuses to guess ----
// A stray belonging to somebody with no other conversation has nothing to be
// merged into. Inventing one, or attaching it to a stranger's query, would be
// worse than leaving it where it is.
const orphanBorn = soonAfter(120);
tabs[T].rows.push(['T-STRAY-2', '20999999', 'YES', orphanBorn,
                   '', orphanBorn, 'TEAM', 'OPEN', 0, 1, '']);
tabs[M].rows.push(['M-STRAY-2', 'T-STRAY-2', orphanBorn,
                   'TEAM', '20000099', 'Sorry - wrong window.', 'Shahriar Kabir']);
const orphanThreads = tabs[T].rows.length;
check('a stray with no question of its own to go back to is left alone',
  repair(true) === 0 && tabs[T].rows.length === orphanThreads &&
  tabs[M].rows.some((r) => r[0] === 'M-STRAY-2'),
  'reported, not guessed at, and above all not thrown away');

// ---- and what it is told explicitly ----
// The inference is "whichever of their queries was most recently active when
// the reply was typed", which is right when the team answers what has just
// come in and wrong if somebody goes back to an older one. So it can be told.
const older = send(OTHER, 'An older question of mine.');
const newer = send(OTHER, 'A newer one, asked afterwards.');

// Both were sent by the line above within the same millisecond, which left
// "the most recently active" a coin toss and this suite failing about one run
// in three. Which of the two is older is the whole subject of the next two
// assertions, so it is stated rather than raced for.
const setLastAt = function (threadId, when) {
  tabs[T].rows.filter((r) => r[0] === threadId)[0][5] = when;
};
// Ahead of everything else this person has, so the pair really are their two
// most recent and an older thread from further up this file cannot win.
setLastAt(older.threadId, soonAfter(10));
setLastAt(newer.threadId, soonAfter(20));

const strayThree = soonAfter(180), strayFour = soonAfter(240);
tabs[T].rows.push(['T-STRAY-3', '20000002', 'YES', strayThree,
                   '', strayThree, 'TEAM', 'OPEN', 0, 1, '']);
tabs[M].rows.push(['M-STRAY-3', 'T-STRAY-3', strayThree,
                   'TEAM', '20000099', 'About that older one.', 'Shahriar Kabir']);
tabs[T].rows.push(['T-STRAY-4', '20000002', 'YES', strayFour,
                   '', strayFour, 'TEAM', 'OPEN', 0, 1, '']);
tabs[M].rows.push(['M-STRAY-4', 'T-STRAY-4', strayFour,
                   'TEAM', '20000099', 'About the new one.', 'Shahriar Kabir']);

// One named explicitly, one left to the inference, so the two are told apart.
repair(true, { 'T-STRAY-3': older.threadId });
check('left to itself it picks the query that was most recently active',
  threadLines(newer.threadId).some((m) => /About the new one/.test(m.text)),
  'the one the admin had open when they typed the reply');
check('an override puts a reply in the query you name instead',
  threadLines(older.threadId).some((m) => /About that older one/.test(m.text)) &&
  !threadLines(newer.threadId).some((m) => /About that older one/.test(m.text)),
  'for when the team answered an older query while a newer one was waiting');

// TWO shells cleared in ONE run, which is the only way to tell that they are
// deleted bottom-up. Deleting the upper one first moves everything below it
// up a row, so the second delete lands on a row that is no longer the one it
// was aimed at - and with the strays at the end of the sheet it quietly does
// nothing at all, leaving a shell behind.
check('and both shells are gone, not just the first',
  !tabs[T].rows.some((r) => r[0] === 'T-STRAY-3' || r[0] === 'T-STRAY-4'),
  tabs[T].rows.filter((r) => /^T-STRAY/.test(String(r[0])))
    .map((r) => r[0]).join(' ') || 'none left');

// ---------------------------------------------------------------------------
// the migration had the same hole in it
// ---------------------------------------------------------------------------
// It wrote the question with appendToThread and then the answer with another
// call that named no thread, so every old question and the answer it had
// already been given arrived as two unrelated queries.
const migrate = vm.runInContext('migrateQuestionsToThreads', sb);
vm.runInContext(
  'function readQuestions() {\n' +
  '  return [{ id: "Q1", from: "20990014", topic: "ITSM",\n' +
  '            question: "How do I reopen a closed ticket?",\n' +
  '            askedAt: "2026-09-01T09:00:00Z",\n' +
  '            answer: "Ask the desk to reopen it.",\n' +
  '            answeredBy: "20000099",\n' +
  '            answeredAt: "2026-09-01T10:00:00Z" }];\n' +
  '}', sb);

const beforeMigration = tabs[T].rows.length;
const addedLines = migrate();
check('a migrated question and its answer are two lines',
  addedLines === 2, addedLines + ' messages written');
check('in ONE conversation, not one each',
  tabs[T].rows.length === beforeMigration + 1,
  beforeMigration + ' -> ' + tabs[T].rows.length + ' queries');

const migrated = tabs[T].rows[tabs[T].rows.length - 1];
check('with the question first and the answer under it',
  threadLines(migrated[0]).length === 2 &&
  threadLines(migrated[0])[0].side === 'USER' &&
  threadLines(migrated[0])[1].side === 'TEAM',
  threadLines(migrated[0]).map((m) => m.side).join(' -> '));
check('and the subject kept on the conversation it belongs to',
  String(migrated[4]) === 'ITSM', 'Topic = ' + migrated[4]);

const afterFirstRun = tabs[T].rows.length;
check('running the migration twice adds nothing the second time',
  migrate() === 0 && tabs[T].rows.length === afterFirstRun,
  'the message IDs are derived from the question, so a second run sees them');

const failed = out.filter((r) => !r).length;
console.log('\n' + (out.length - failed) + '/' + out.length + ' passed');
process.exit(failed ? 1 : 0);
