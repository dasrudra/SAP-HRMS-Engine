/**
 * THE HELP SCREEN, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node help-ui-test.js
 *
 * Two cards and two audiences. The FAQ is published and belongs to
 * everybody; the inbox is the team's post, and almost everything that can
 * go wrong on this screen is about telling the team something untrue
 * concerning who wrote to them.
 *
 * THE FOUR STATES A CARD CAN BE IN, which is what most of this tests:
 *
 *   signed in              a plain card. No marker at all - App.html:
 *                          "a word that is on everything is a word nobody
 *                          reads on the one that matters."
 *   from the sign-in page,
 *   no account             NOT VERIFIED, amber. The alarm, for the moment
 *                          somebody is reading a convincing password-reset
 *                          request from an ID nobody has proved.
 *   from the sign-in page,
 *   account since opened   FROM THE SIGN-IN PAGE, quiet, with the button
 *                          that attaches it once a human has checked.
 *   answered               no WAITING pill, and not counted by the badge.
 *
 * THE FIXTURE OWNS ITS OWN ENROLMENT. Whether a card is amber depends on
 * whether an account exists for that employee ID, so the suite creates the
 * accounts it needs and deletes them again. Asserting that 20990002 is
 * enrolled would be asserting something about the database the suite is
 * run against, which on this port has now cost six suites a false failure.
 *
 * Everything else about the whole inbox - how many people, how many
 * queries, how many waiting - is compared against the SERVER'S OWN answer
 * for the same question, never against a number written here. The live
 * machine has real conversations in it.
 */
require('dotenv').config();
const db = require('./db');
const { signToken } = require('./auth');
const browser = require('../tests/harness/browser');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PAGE = BASE + '/help.html';

/* Reserved test range. See the note on employee IDs in PORT-INVENTORY. */
const ADMIN_ID = '20990770';
const MASTER_ID = '20990769';
const VIEWER_ID = '20990771';

const PLAIN = '20990781';      // enrolled, signed in, waiting
const BOTH = '20990782';       // enrolled, one signed-in and one sign-in-page
const STRANGER = '20990783';   // NOT enrolled, from the sign-in page
const ANSWERED = '20990784';   // enrolled, the team spoke last

let pass = 0;
let fail = 0;
const failures = [];
const notes = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++;
  const line = name + (detail === undefined ? '' : '   ' + detail);
  failures.push(line);
  console.log('  FAIL ' + line);
}

function note(line) {
  notes.push(line);
  console.log('  ..   ' + line);
}

function recap() {
  if (notes.length) {
    console.log('');
    console.log('  ' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + ':');
    notes.forEach(function (line) { console.log('    - ' + line); });
  }
  if (!failures.length) return;
  console.log('');
  console.log('  ' + failures.length + ' failed:');
  failures.forEach(function (line) { console.log('    - ' + line); });
}


const PEOPLE = [PLAIN, BOTH, STRANGER, ANSWERED];

async function sweep() {
  await db.query("DELETE FROM msg_line WHERE thread_id LIKE 'T-HELP-%'");
  await db.query("DELETE FROM msg_thread WHERE thread_id LIKE 'T-HELP-%'");
  /*
    account.employee_id REFERENCES team(employee_id) ON DELETE CASCADE, so
    removing the team row removes the account with it. Done in that order
    anyway, because relying on a cascade to clean up after a test is
    relying on a schema detail the test does not own.
  */
  await db.query('DELETE FROM account WHERE employee_id = ANY($1)', [PEOPLE]);
  await db.query('DELETE FROM team WHERE employee_id = ANY($1)', [PEOPLE]);
}


/**
 * An account, so enrolmentOf() finds this person.
 *
 * AND A TEAM ROW UNDER IT, because account.employee_id has a foreign key
 * to team. That is not a detour: it is the same rule the real system
 * follows - somebody gets a login because they are on the team - and a
 * fixture that sidestepped it would be testing a state the database
 * refuses to hold.
 *
 * THE FIXTURE OWNS ENROLMENT RATHER THAN BORROWING IT. Whether a card
 * shows NOT VERIFIED depends on whether this row exists, so picking an
 * employee ID that happens to have an account on this machine would make
 * the test pass here and fail on a machine where it does not.
 */
async function enrol(id, name) {
  await db.query(
    `INSERT INTO team (employee_id, full_name, designation, department)
     VALUES ($1, $2, 'Fixture', 'EAS')
     ON CONFLICT (employee_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
    [id, name]);
  await db.query(
    `INSERT INTO account (employee_id, password_hash, role, must_change, full_name)
     VALUES ($1, 'x-not-a-usable-hash', 'USER', true, $2)
     ON CONFLICT (employee_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
    [id, name]);
}


/**
 * One conversation, and the lines in it.
 *
 * `waiting_for_team` and `last_message_by` are written to match the lines,
 * because listThreads reads the first and peopleWaiting reads the second -
 * a fixture where the two disagree would be testing a state the
 * application cannot produce.
 */
async function thread(o) {
  await db.query(
    `INSERT INTO msg_thread (thread_id, person, name, verified, topic, started,
                             last_message_at, last_message_by, status,
                             waiting_for_team, unread_by_person)
     VALUES ($1,$2,$3,$4,$5, now() - ($6 || ' minutes')::interval,
             now() - ($7 || ' minutes')::interval, $8, 'OPEN', $9, 0)`,
    [o.id, o.person, o.name || '', o.verified, o.topic,
     String(o.startedAgo), String(o.lastAgo), o.lastBy,
     o.waiting === undefined ? 1 : o.waiting]);

  let n = 0;
  for (const line of o.lines) {
    n++;
    await db.query(
      `INSERT INTO msg_line (message_id, thread_id, at, side, author, body,
                             author_name, files)
       VALUES ($1,$2, now() - ($3 || ' minutes')::interval, $4,$5,$6,$7,
               $8::jsonb)`,
      [o.id + '-m' + n, o.id, String(line.ago), line.side, line.author,
       line.text, line.name || '', JSON.stringify(line.files || [])]);
  }
}


async function seed() {
  await enrol(PLAIN, 'Plain Person');
  await enrol(BOTH, 'Both Ways');
  await enrol(ANSWERED, 'Already Answered');
  // STRANGER deliberately gets no account. sweep() removed any.

  await thread({
    id: 'T-HELP-PLAIN', person: PLAIN, name: 'Plain Person', verified: true,
    topic: 'MIGO dumps on a goods receipt',
    startedAgo: 240, lastAgo: 240, lastBy: PLAIN, waiting: 1,
    lines: [{ ago: 240, side: 'USER', author: PLAIN, name: 'Plain Person',
              text: 'MIGO throws a dump when I post a goods receipt.' }]
  });

  /*
    TWO QUERIES ON ONE CARD, one of each kind. This is the card that has to
    say FROM THE SIGN-IN PAGE rather than NOT VERIFIED, offer the attach
    button for the loose one only, and grow a picker so a reply can be
    filed against either.
  */
  await thread({
    id: 'T-HELP-BOTH-A', person: BOTH, name: 'Both Ways', verified: true,
    topic: 'Purchase order release strategy',
    startedAgo: 200, lastAgo: 200, lastBy: BOTH, waiting: 1,
    lines: [{ ago: 200, side: 'USER', author: BOTH, name: 'Both Ways',
              text: 'Which release code applies to a framework order?' }]
  });
  await thread({
    id: 'T-HELP-BOTH-B', person: BOTH, name: 'Both Ways', verified: false,
    topic: 'Locked out this morning',
    startedAgo: 180, lastAgo: 180, lastBy: BOTH, waiting: 1,
    lines: [{ ago: 180, side: 'USER', author: BOTH, name: 'Both Ways',
              text: 'I could not sign in before I had an account.' }]
  });

  await thread({
    id: 'T-HELP-STRANGER', person: STRANGER, name: 'Says They Are', verified: false,
    topic: 'Please reset my password',
    startedAgo: 120, lastAgo: 120, lastBy: STRANGER, waiting: 1,
    lines: [{ ago: 120, side: 'USER', author: STRANGER, name: 'Says They Are',
              text: 'Reset my SAP password and send it here.' }]
  });

  /*
    THE TEAM SPOKE LAST, so this person is not owed a word. It is the
    control for every WAITING assertion: without a card that is NOT
    waiting, a screen that lit the pill on everything would pass.

    AND `waiting_for_team` IS DELIBERATELY LEFT AT 2 WHILE THE TEAM SPOKE
    LAST, which is not a contradiction - it is the exact state App.html
    describes: "It used to add up the unanswered lines across every query
    on the card, so two questions and one answer left the pill lit and the
    badge saying 1 for ever." The column counts unanswered LINES; whether
    a person is owed a word is decided by who spoke last. A fixture where
    the two agreed on every card could not tell the two rules apart, and a
    screen that went back to summing would pass.
  */
  await thread({
    id: 'T-HELP-ANSWERED', person: ANSWERED, name: 'Already Answered',
    verified: true, topic: 'How do I run MB51',
    startedAgo: 90, lastAgo: 30, lastBy: ADMIN_ID, waiting: 2,
    lines: [
      { ago: 90, side: 'USER', author: ANSWERED, name: 'Already Answered',
        text: 'How do I run MB51 for one plant?' },
      { ago: 30, side: 'TEAM', author: ADMIN_ID, name: 'Helpdesk Admin',
        text: 'Open MB51, put the plant in the selection screen and execute.' }
    ]
  });
}


async function open(p, role) {
  const id = role === 'MASTER' ? MASTER_ID
           : role === 'USER' ? VIEWER_ID : ADMIN_ID;
  await p.goto(PAGE);
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                   signToken(id, role));
  await p.goto(PAGE);
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(400);
}


/** Every card on the screen, keyed the way the screen keys them. */
async function cards(p) {
  return p.evaluate(function () {
    const out = {};
    Array.prototype.slice.call(document.querySelectorAll('#inboxList .thread'))
      .forEach(function (el, i) {
        const row = el.querySelector('.thread-row');
        out[el.getAttribute('data-thread')] = {
          index: i,
          classes: el.className,
          unverified: el.classList.contains('is-unverified'),
          presignin: el.classList.contains('is-presignin'),
          open: el.classList.contains('is-open'),
          waiting: Boolean(el.querySelector('.pill-wait')),
          who: (el.querySelector('.thread-who') || {}).textContent || '',
          warn: (el.querySelector('.thread-warn') || {}).textContent || '',
          pre: (el.querySelector('.thread-pre') || {}).textContent || '',
          topic: (el.querySelector('.q-topic') || {}).textContent || '',
          peek: (el.querySelector('.thread-peek') || {}).textContent || '',
          when: (el.querySelector('.q-when') || {}).textContent || '',
          expanded: row ? row.getAttribute('aria-expanded') : '',
          bin: Boolean(el.querySelector('.thread-del')),
          note: (el.querySelector('.thread-note') || {}).textContent || '',
          noteSoft: Boolean(el.querySelector('.thread-note.is-soft')),
          attach: el.querySelector('[data-attach]')
            ? el.querySelector('[data-attach]').getAttribute('data-attach') : null,
          subs: Array.prototype.slice.call(el.querySelectorAll('.thread-sub-topic'))
            .map(function (s) { return s.textContent; }),
          picker: Boolean(el.querySelector('select[data-reply-into]')),
          pickerOptions: Array.prototype.slice.call(
            el.querySelectorAll('select[data-reply-into] option'))
            .map(function (o) { return o.textContent; }),
          replyInto: el.querySelector('[data-reply-into]')
            ? el.querySelector('[data-reply-into]').value : '',
          placeholder: el.querySelector('[data-reply]')
            ? el.querySelector('[data-reply]').getAttribute('placeholder') : '',
          clipDisabled: el.querySelector('.msgr-clip')
            ? el.querySelector('.msgr-clip').disabled : null,
          bubbles: Array.prototype.slice.call(el.querySelectorAll('.bubble'))
            .map(function (b) {
              return {
                side: b.classList.contains('bubble-mine') ? 'mine' : 'theirs',
                text: (b.querySelector('p') || {}).textContent || '',
                by: (b.querySelector('.bubble-by') || {}).textContent || '',
                time: (b.querySelector('time') || {}).textContent || ''
              };
            })
        };
      });
    return out;
  });
}


/** What the server itself says, for everything that spans the database. */
async function serverSays(role) {
  const id = role === 'MASTER' ? MASTER_ID : ADMIN_ID;
  const headers = { Authorization: 'Bearer ' + signToken(id, role || 'ADMIN') };
  const [boot, inbox] = await Promise.all([
    fetch(BASE + '/api/help/boot', { headers }).then(function (r) { return r.json(); }),
    fetch(BASE + '/api/help/inbox', { headers }).then(function (r) { return r.json(); })
  ]);
  return { boot: boot, inbox: inbox };
}


/** The card keys the SCREEN would build from a server payload. */
function keysOf(threads) {
  const seen = {};
  (threads || []).forEach(function (t) {
    seen[(t.enrolled ? 'P' : (t.verified ? 'V' : 'U')) + ':' + t.person] = true;
  });
  return Object.keys(seen);
}


async function main() {
  if (!browser.ready) {
    console.log('');
    console.log('  SKIPPED - no browser to drive.');
    console.log('  ' + browser.skipReason());
    console.log('');
    process.exit(0);
  }

  try {
    const res = await fetch(BASE + '/api/health');
    if (!res.ok) throw new Error('health check answered ' + res.status);
  } catch (err) {
    console.log('');
    console.log('  The API is not answering on ' + BASE + '.');
    console.log('  Start it in Terminal 3 with:  npm start');
    console.log('  (' + err.message + ')');
    console.log('');
    process.exit(1);
  }

  await sweep();
  await seed();

  const b = await browser.launch();
  const context = await b.newContext();
  const p = await context.newPage();

  const thrown = [];
  const badRequests = [];
/* How many 400s this suite provokes on purpose. See the refused reply. */
let expected400 = 0;
  p.on('pageerror', function (e) { thrown.push(String(e.message || e)); });
  p.on('console', function (m) {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      thrown.push(m.text());
    }
  });
  p.on('response', function (r) {
    if (r.status() >= 400) badRequests.push(r.status() + ' ' + r.url());
  });
  p.on('requestfailed', function (r) {
    const why = (r.failure() || {}).errorText || '';
    if (/ERR_ABORTED/.test(why)) return;
    badRequests.push('could not be reached: ' + r.url() + ' (' + why + ')');
  });

  await open(p, 'ADMIN');
  let says = await serverSays('ADMIN');
  let c = await cards(p);

  console.log('');
  console.log('  Fixture: 4 people, 5 queries. The inbox holds ' +
              says.inbox.count + ' queries from ' +
              keysOf(says.inbox.threads).length + ' people in all, with ' +
              says.inbox.waiting + ' waiting - which is what the screen must ' +
              'print.');


  // =======================================================================
  console.log('');
  console.log('  The screen opens, in the shell');
  // =======================================================================
  check('Help is served at help.html',
        /\/help\.html$/.test(p.url().split('?')[0]), p.url());
  check('the sidebar has it lit',
        await p.evaluate(function () {
          const lit = document.querySelector('.nav-item.is-active');
          return lit && lit.getAttribute('data-view') === 'help';
        }));
  check('the top bar calls it Help & FAQ',
        (await p.textContent('#viewLabel')) === 'Help & FAQ',
        await p.textContent('#viewLabel'));
  check('and the sentence under the heading is the original\'s - this screen ' +
        'is the team\'s, everybody else asks from the message bar',
        /This screen is the team's/.test(await p.textContent('.page-head .sub')) &&
        /message bar in the corner/.test(await p.textContent('.page-head .sub')),
        JSON.stringify((await p.textContent('.page-head .sub')).slice(0, 70)));


  // =======================================================================
  console.log('');
  console.log('  The published answers');
  // =======================================================================
  const faq = await p.evaluate(function () {
    return Array.prototype.slice.call(document.querySelectorAll('.faq-item'))
      .map(function (d) {
        return {
          q: (d.querySelector('summary') || {}).textContent || '',
          a: (d.querySelector('.faq-answer') || {}).textContent || '',
          open: d.open
        };
      });
  });
  check('every published answer is drawn, and they are the server\'s',
        faq.length === says.boot.faq.length &&
        faq.every(function (row, i) {
          return row.q === says.boot.faq[i].question &&
                 row.a === says.boot.faq[i].answer;
        }),
        JSON.stringify([faq.length, says.boot.faq.length]));
  check('the count beside the heading agrees with them',
        (await p.textContent('#faqCount')) ===
        faq.length + (faq.length === 1 ? ' question' : ' questions'),
        JSON.stringify(await p.textContent('#faqCount')));
  check('AS <details>, WHICH IS WHY THEY ARE NOT DIVS - keyboard support, ' +
        'find-in-page and an open state for nothing',
        await p.evaluate(function () {
          const all = document.querySelectorAll('.faq-list details.faq-item');
          return all.length > 0 && all.length ===
            document.querySelectorAll('.faq-item').length;
        }));
  check('and they start closed',
        faq.every(function (row) { return row.open === false; }));
  await p.click('.faq-item summary');
  await p.waitForTimeout(150);
  check('clicking one opens it, without a line of script',
        await p.evaluate(function () {
          return document.querySelector('.faq-item').open === true;
        }));
  check('an empty FAQ says nothing is published rather than drawing nothing',
        await p.evaluate(function () {
          const s = window.__helpScreen;
          const box = document.createElement('div');
          box.id = 'faqProbe';
          document.body.appendChild(box);
          s.paintFaq('faqProbe', []);
          const text = box.textContent;
          box.remove();
          return /Nothing published yet/.test(text);
        }));


  // =======================================================================
  console.log('');
  console.log('  The four states a card can be in');
  // =======================================================================
  check('every fixture person has a card',
        ['P:' + PLAIN, 'P:' + BOTH, 'U:' + STRANGER, 'P:' + ANSWERED]
          .every(function (k) { return Boolean(c[k]); }),
        JSON.stringify(Object.keys(c)));

  const plain = c['P:' + PLAIN];
  const both = c['P:' + BOTH];
  const stranger = c['U:' + STRANGER];
  const answered = c['P:' + ANSWERED];

  check('a signed-in query carries NO MARKER AT ALL - a word that is on ' +
        'everything is a word nobody reads on the one that matters',
        !plain.unverified && !plain.presignin &&
        plain.warn === '' && plain.pre === '' && plain.note === '',
        JSON.stringify([plain.classes, plain.warn, plain.pre]));

  check('AN ID WITH NO ACCOUNT IS THE ALARM: amber, and NOT VERIFIED',
        stranger.unverified && !stranger.presignin &&
        stranger.warn === 'NOT VERIFIED',
        JSON.stringify([stranger.classes, stranger.warn]));
  check('and the note says not to reset a password on the strength of it',
        /only what the sender typed/.test(stranger.note) &&
        /Do not reset a password/.test(stranger.note) &&
        /ring them or check in SAP/.test(stranger.note),
        JSON.stringify(stranger.note.slice(0, 80)));
  check('AND IT OFFERS NO ATTACH BUTTON - there is no account to attach to',
        stranger.attach === null);

  check('AN ENROLLED ID IS NOT THE ALARM even when it wrote in before it had ' +
        'an account: quiet, and FROM THE SIGN-IN PAGE',
        both.presignin && !both.unverified &&
        both.pre === 'FROM THE SIGN-IN PAGE' && both.warn === '',
        JSON.stringify([both.classes, both.pre, both.warn]));
  check('its note is the soft one, and says to check who they are first',
        both.noteSoft && /Check who they are first/.test(both.note) &&
        /before this person had an account/.test(both.note) &&
        /nothing here reaches them until somebody says it is really them/
          .test(both.note) &&
        // AND HOW. "Check who they are" with no way to do it is a slogan.
        /ring them, or ask in SAP/.test(both.note),
        JSON.stringify(both.note.slice(0, 80)));
  check('AND IT OFFERS THE ATTACH BUTTON FOR THE LOOSE QUERY ONLY - the ' +
        'signed-in one is already theirs',
        both.attach === 'T-HELP-BOTH-B',
        JSON.stringify(both.attach));

  check('a person the team has answered carries no WAITING pill',
        answered.waiting === false);
  /*
    THE BUG THE ORIGINAL'S COMMENT IS ABOUT. This card's queries still
    count two unanswered lines between them, and the team still spoke
    last. A screen that summed the lines would light the pill here and
    keep it lit for ever; one that reads the server's per-person answer
    leaves it dark.
  */
  check('EVEN THOUGH ITS QUERIES STILL COUNT UNANSWERED LINES - waiting is ' +
        'a fact about the person, decided by who spoke last, not a sum',
        answered.waiting === false &&
        (says.inbox.threads.filter(function (t) {
          return t.id === 'T-HELP-ANSWERED';
        })[0] || {}).waiting === 2,
        JSON.stringify((says.inbox.threads.filter(function (t) {
          return t.id === 'T-HELP-ANSWERED'; })[0] || {}).waiting));
  check('and the three nobody has got back to do',
        plain.waiting && both.waiting && stranger.waiting,
        JSON.stringify([plain.waiting, both.waiting, stranger.waiting]));

  check('the name and the employee ID are both on the row',
        plain.who === 'Plain Person (' + PLAIN + ')', JSON.stringify(plain.who));
  check('the closed row says what they are waiting on now, and when',
        plain.topic === 'MIGO dumps on a goods receipt' &&
        /goods receipt/.test(plain.peek) && /^\d{4}-\d{2}-\d{2} /.test(plain.when),
        JSON.stringify([plain.topic, plain.peek.slice(0, 30), plain.when]));


  // =======================================================================
  console.log('');
  console.log('  Waiting first, and one definition of waiting');
  // =======================================================================
  /*
    App.html records three different answers to "who is waiting" living on
    this screen at once - the badge counted threads, the heading counted
    people by a per-thread sum, and the poll asked the server. The server
    is the only one now, so these three have to agree with each other and
    with it.
  */
  const waitingShown = Object.keys(c)
    .filter(function (k) { return c[k].waiting; }).length;
  check('THE HEADING, THE PILLS AND THE BADGE ARE ONE ANSWER',
        waitingShown === says.inbox.waiting &&
        (await p.textContent('#helpBadge')) === String(says.inbox.waiting),
        JSON.stringify([waitingShown, says.inbox.waiting,
                        await p.textContent('#helpBadge')]));
  check('and the heading counts PEOPLE, with the queries behind them when ' +
        'the two differ',
        (await p.textContent('#inboxCount')) ===
        (function () {
          const people = keysOf(says.inbox.threads).length;
          const rows = says.inbox.count;
          return people + (people === 1 ? ' person' : ' people') +
            (rows === people ? '' : ' \u00b7 ' + rows + ' queries') +
            (says.inbox.waiting ? ' \u00b7 ' + says.inbox.waiting + ' waiting'
                                : ' \u00b7 all answered');
        }()),
        JSON.stringify(await p.textContent('#inboxCount')));
  check('the cards a word is owed to are above the ones that are settled',
        Object.keys(c).every(function (k) {
          return !c[k].waiting ||
            Object.keys(c).every(function (other) {
              return c[other].waiting || c[k].index < c[other].index;
            });
        }),
        JSON.stringify(Object.keys(c).map(function (k) {
          return k + (c[k].waiting ? '(w)' : ''); })));
  check('and the server and the screen agree on how many cards there are',
        Object.keys(c).length === keysOf(says.inbox.threads).length,
        JSON.stringify([Object.keys(c).length,
                        keysOf(says.inbox.threads).length]));


  // =======================================================================
  console.log('');
  console.log('  Opening a card');
  // =======================================================================
  check('every card starts closed',
        Object.keys(c).every(function (k) {
          return !c[k].open && c[k].expanded === 'false';
        }));
  await p.click('.thread[data-thread="P:' + PLAIN + '"] .thread-row');
  await p.waitForTimeout(250);
  c = await cards(p);
  check('clicking the row opens it, and says so to a screen reader',
        c['P:' + PLAIN].open && c['P:' + PLAIN].expanded === 'true');
  check('AND ONLY IT - one conversation is being read, not four',
        Object.keys(c).filter(function (k) { return c[k].open; }).length === 1);
  check('the reply box takes the cursor, so answering needs no second click',
        await p.evaluate(function () {
          const el = document.activeElement;
          return Boolean(el && el.hasAttribute('data-reply'));
        }));
  await p.click('.thread[data-thread="P:' + PLAIN + '"] .thread-row');
  await p.waitForTimeout(200);
  check('clicking it again closes it',
        !(await cards(p))['P:' + PLAIN].open);

  await p.focus('.thread[data-thread="P:' + PLAIN + '"] .thread-row');
  await p.keyboard.press('Enter');
  await p.waitForTimeout(200);
  check('AND THE KEYBOARD OPENS IT TOO - it is a role="button", so Enter ' +
        'has to do what a click does',
        (await cards(p))['P:' + PLAIN].open);


  // =======================================================================
  console.log('');
  console.log('  The bubbles');
  // =======================================================================
  c = await cards(p);
  check('a person\'s own words are on the left of the team\'s inbox',
        c['P:' + PLAIN].bubbles.length === 1 &&
        c['P:' + PLAIN].bubbles[0].side === 'theirs' &&
        /goods receipt/.test(c['P:' + PLAIN].bubbles[0].text),
        JSON.stringify(c['P:' + PLAIN].bubbles));
  check('AND THE TEAM\'S REPLY IS ON THE RIGHT - "us" is TEAM here, and one ' +
        'function served both screens with this answer once, so people saw ' +
        'their own words arriving from the other side of their own screen',
        answered.bubbles.length === 2 &&
        answered.bubbles[0].side === 'theirs' &&
        answered.bubbles[1].side === 'mine',
        JSON.stringify(answered.bubbles.map(function (x) { return x.side; })));
  check('a team line is signed, so the next admin can see it is in hand',
        /Helpdesk Admin \(/.test(answered.bubbles[1].by) &&
        answered.bubbles[1].by.indexOf(ADMIN_ID) !== -1,
        JSON.stringify(answered.bubbles[1].by));
  check('AND A PERSON\'S OWN LINE IS NOT - they know who they are',
        answered.bubbles[0].by === '',
        JSON.stringify(answered.bubbles[0].by));
  check('the byline is separated from the time in the markup, not in CSS - ' +
        'a ::after separator kept it out of textContent where a test could ' +
        'see it',
        /Helpdesk Admin \([0-9]+\) \u00b7 \d{4}-/.test(answered.bubbles[1].time),
        JSON.stringify(answered.bubbles[1].time));
  /*
    THE SERVER BUILDS IT, and the screen can also work it out. Both are
    checked, because they are two different promises: Messenger.gs sends
    `by` and nothing else, so anything reading these threads is entitled
    to it - and the port sends `author` and `authorName` as well, which is
    the fallback that stopped this screen depending on a field that was
    missing from messenger-read.js until this week.
  */
  const fromServer = (says.inbox.threads.filter(function (t) {
    return t.id === 'T-HELP-ANSWERED';
  })[0] || { messages: [] }).messages;
  check('THE SERVER PUTS THE BYLINE ON A TEAM LINE ITSELF, so anything ' +
        'reading a conversation gets it without rebuilding it',
        fromServer.length === 2 &&
        fromServer[1].side === 'TEAM' &&
        fromServer[1].by === 'Helpdesk Admin (' + ADMIN_ID + ')',
        JSON.stringify(fromServer.map(function (m) {
          return m.side + ':' + (m.by === undefined ? '(none)' : m.by); })));
  check('AND NOT ON THE ASKER\'S OWN LINE',
        fromServer[0].side === 'USER' && fromServer[0].by === undefined,
        JSON.stringify(fromServer[0].by));
  check('and the screen reads a byline whichever shape the server sends it in',
        await p.evaluate(function () {
          const s = window.__helpScreen;
          return s.byline({ by: 'Server Said (1)' }) === 'Server Said (1)' &&
                 s.byline({ author: '2', authorName: 'Name' }) === 'Name (2)' &&
                 s.byline({ author: '3', authorName: '' }) === '3' &&
                 s.byline({}) === '';
        }));


  // =======================================================================
  console.log('');
  console.log('  Two queries on one card');
  // =======================================================================
  await p.click('.thread[data-thread="P:' + BOTH + '"] .thread-row');
  await p.waitForTimeout(250);
  c = await cards(p);
  const two = c['P:' + BOTH];
  check('ONE CARD PER PERSON, not per query - both of theirs are on it',
        two.bubbles.length === 2, JSON.stringify(two.bubbles.length));
  check('each query is named by a rule above its own run of bubbles',
        JSON.stringify(two.subs) ===
        JSON.stringify(['Purchase order release strategy',
                        'Locked out this morning']),
        JSON.stringify(two.subs));
  check('oldest query first, so the card reads in the order it happened',
        two.subs[0] === 'Purchase order release strategy');
  check('A CARD WITH ONE QUERY HAS NO RULE - its subject is on the row above',
        plain.subs.length === 0 && c['P:' + PLAIN].subs.length === 0);
  check('and it grows a picker saying which query a reply goes into',
        two.picker && !c['P:' + PLAIN].picker);
  check('with the one they spoke in last chosen, newest first',
        two.replyInto === 'T-HELP-BOTH-B' &&
        two.pickerOptions[0] === 'Locked out this morning',
        JSON.stringify([two.replyInto, two.pickerOptions]));
  /*
    AND THE CLOSED ROW SPEAKS FOR THE SAME QUERY. The subject and the last
    line on it come from `newest`, which is what the card is about: "the
    closed row says what this person is waiting on now; the rest is a
    click away." Taking the oldest instead leaves the row describing a
    question that was answered a week ago, and the picker still defaults
    correctly - so without this the two can disagree unnoticed.
  */
  check('AND THE CLOSED ROW SPEAKS FOR THE QUERY THEY SPOKE IN LAST, not ' +
        'the one they opened first',
        two.topic === 'Locked out this morning' &&
        /before I had an account/.test(two.peek),
        JSON.stringify([two.topic, two.peek]));
  check('a single-query card hides the thread id in a field instead',
        c['P:' + PLAIN].replyInto === 'T-HELP-PLAIN',
        JSON.stringify(c['P:' + PLAIN].replyInto));

  check('THE REPLY BOX WARNS WHEN THEY WILL NOT SEE IT - a sign-in-page ' +
        'query is never read by the account that owns the ID',
        /they will not see it/.test(two.placeholder) &&
        !/they will not see it/.test(c['P:' + PLAIN].placeholder),
        JSON.stringify([two.placeholder, c['P:' + PLAIN].placeholder]));

  check('the screenshot clip is drawn and switched off, since nothing can ' +
        'store one yet',
        two.clipDisabled === true,
        JSON.stringify(two.clipDisabled));
  check('and it says why on the hover rather than failing after the send',
        await p.evaluate(function () {
          const el = document.querySelector('.msgr-clip');
          return el && /not stored yet/i.test(el.title) &&
                 /CHAT_FOLDER/.test(el.title);
        }));


  // =======================================================================
  console.log('');
  console.log('  Replying');
  // =======================================================================
  /*
    OPEN THE CARD BEFORE REACHING INTO IT. The reply box of a closed card
    is in the DOM but hidden, so a fill() against it waits thirty seconds
    and then says the element is not visible - which is Playwright telling
    the truth about a screen that is behaving correctly.
  */
  const waitingBefore = (await serverSays('ADMIN')).inbox.waiting;
  await p.click('.thread[data-thread="P:' + PLAIN + '"] .thread-row');
  await p.waitForTimeout(250);
  await p.fill('[data-reply="P:' + PLAIN + '"]',
               'Clear the GR/IR buffer and post it again.');
  await p.click('[data-reply-go="P:' + PLAIN + '"]');
  await p.waitForTimeout(1200);
  c = await cards(p);
  says = await serverSays('ADMIN');

  check('the reply lands in the conversation, signed',
        c['P:' + PLAIN].bubbles.length === 2 &&
        c['P:' + PLAIN].bubbles[1].side === 'mine' &&
        /GR\/IR buffer/.test(c['P:' + PLAIN].bubbles[1].text),
        JSON.stringify(c['P:' + PLAIN].bubbles));
  check('THE PILL GOES OUT, because the last word is now ours',
        c['P:' + PLAIN].waiting === false);
  check('and the badge comes down with it, from the same answer',
        (await p.textContent('#helpBadge')) === String(says.inbox.waiting) &&
        says.inbox.waiting === waitingBefore - 1,
        JSON.stringify([await p.textContent('#helpBadge'),
                        says.inbox.waiting, waitingBefore]));
  check('THE CARD STAYS OPEN over the redraw - having it snap shut the ' +
        'moment you answered would mean reopening it to read what you wrote',
        c['P:' + PLAIN].open === true);
  check('and the box is empty, ready for the next one',
        (await p.inputValue('[data-reply="P:' + PLAIN + '"]')) === '');

  await p.fill('[data-reply="P:' + PLAIN + '"]', '   ');
  await p.click('[data-reply-go="P:' + PLAIN + '"]');
  await p.waitForTimeout(500);
  check('AN EMPTY REPLY SENDS NOTHING AND SAYS NOTHING - no dialog, no ' +
        'error, just the cursor back in the box',
        (await cards(p))['P:' + PLAIN].bubbles.length === 2 &&
        await p.evaluate(function () {
          const el = document.activeElement;
          return Boolean(el && el.hasAttribute('data-reply'));
        }));
  /*
    A REFUSED REPLY MUST NOT LOSE THE SENTENCE. cleanMessage refuses a
    message of one character, so this is a send the server really does
    turn down - and the box has to still hold the words afterwards.
    Clearing it before the round trip looks identical on every reply that
    succeeds, which is why only a refused one can tell the two apart.
  */
  await p.fill('[data-reply="P:' + PLAIN + '"]', 'x');
  await p.click('[data-reply-go="P:' + PLAIN + '"]');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 20000 });
  const refused = await p.evaluate(function () {
    return {
      title: document.getElementById('modalTitle').textContent,
      body: document.getElementById('modalBody').textContent
    };
  });
  await p.click('#modalConfirm');
  await p.waitForTimeout(400);
  check('A REFUSED REPLY SAYS SO, and says what the server said',
        /did not send/.test(refused.title) && refused.body.trim().length > 0,
        JSON.stringify([refused.title, refused.body.slice(0, 60)]));
  check('AND THE WORDS ARE STILL IN THE BOX - a box emptied before the ' +
        'server has the reply loses the sentence on every refusal',
        (await p.inputValue('[data-reply="P:' + PLAIN + '"]')) === 'x',
        JSON.stringify(await p.inputValue('[data-reply="P:' + PLAIN + '"]')));
  check('and nothing was written',
        (await db.query(
          "SELECT count(*)::int AS n FROM msg_line" +
          " WHERE thread_id = 'T-HELP-PLAIN'"))[0].n === 2);
  /*
    THAT REFUSAL IS A 400, and the console watch at the end of this suite
    would report it as a file the screen asked for and did not get. It is
    expected exactly once, so it is accounted for here by name rather than
    by loosening the watch - a second 400 on the same endpoint, or one on
    any other, still fails.
  */
  expected400 = badRequests.filter(function (r) {
    return r === '400 ' + BASE + '/api/messages/reply';
  }).length;
  check('the refusal came back as a 400 and not as something worse',
        expected400 === 1, JSON.stringify(badRequests));
  await p.fill('[data-reply="P:' + PLAIN + '"]', '');

  /*
    WHICH QUERY A REPLY IS FILED AGAINST. Getting this wrong means somebody
    reads the answer to Tuesday's problem underneath Thursday's, which is
    the whole reason the picker is on the card.
  */
  await p.click('.thread[data-thread="P:' + BOTH + '"] .thread-row');
  await p.waitForTimeout(250);
  await p.selectOption('select[data-reply-into="P:' + BOTH + '"]',
                       'T-HELP-BOTH-A');
  await p.fill('[data-reply="P:' + BOTH + '"]', 'Release code 02 applies.');
  await p.click('[data-reply-go="P:' + BOTH + '"]');
  await p.waitForTimeout(1200);

  const filed = await db.query(
    "SELECT thread_id FROM msg_line WHERE body = 'Release code 02 applies.'");
  check('A REPLY GOES INTO THE QUERY THAT WAS CHOSEN, not the newest one',
        filed.length === 1 && filed[0].thread_id === 'T-HELP-BOTH-A',
        JSON.stringify(filed));


  // =======================================================================
  console.log('');
  console.log('  Attaching a sign-in conversation to an account');
  // =======================================================================
  await p.click('.thread[data-thread="P:' + BOTH + '"] [data-attach]');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 20000 });
  const dialog = await p.evaluate(function () {
    return {
      title: document.getElementById('modalTitle').textContent,
      body: document.getElementById('modalBody').textContent,
      confirm: document.getElementById('modalConfirm').textContent,
      cancelShown: !document.getElementById('modalCancel').hidden,
      focused: document.activeElement &&
               document.activeElement.id
    };
  });
  check('IT ASKS FIRST, and the question says what the button cannot know',
        /Attach this to their account\?/.test(dialog.title) &&
        /not proof of anything/.test(dialog.body) &&
        /ringing them, or in SAP/.test(dialog.body),
        JSON.stringify([dialog.title, dialog.body.slice(0, 60)]));
  check('with Cancel holding the focus, so Enter attaches nothing',
        dialog.cancelShown && dialog.focused === 'modalCancel',
        JSON.stringify(dialog.focused));

  await p.click('#modalCancel');
  await p.waitForTimeout(400);
  let stillLoose = await db.query(
    "SELECT verified FROM msg_thread WHERE thread_id = 'T-HELP-BOTH-B'");
  check('AND CANCEL ATTACHES NOTHING',
        stillLoose[0].verified === false);

  await p.click('.thread[data-thread="P:' + BOTH + '"] [data-attach]');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 20000 });
  await p.click('#modalConfirm');
  await p.waitForTimeout(1500);
  stillLoose = await db.query(
    "SELECT verified FROM msg_thread WHERE thread_id = 'T-HELP-BOTH-B'");
  check('confirming attaches it to the account',
        stillLoose[0].verified === true);

  c = await cards(p);
  check('AND THE CARD STOPS SAYING IT CAME FROM THE SIGN-IN PAGE, because ' +
        'it is theirs now',
        c['P:' + BOTH] && !c['P:' + BOTH].presignin &&
        c['P:' + BOTH].pre === '' && c['P:' + BOTH].attach === null,
        JSON.stringify([c['P:' + BOTH].classes, c['P:' + BOTH].pre]));
  check('and the reply box stops warning that they will not see it',
        !/they will not see it/.test(c['P:' + BOTH].placeholder),
        JSON.stringify(c['P:' + BOTH].placeholder));


  // =======================================================================
  console.log('');
  console.log('  Deleting, which is MASTER only');
  // =======================================================================
  check('AN ADMIN IS OFFERED NO BIN AT ALL - deleting destroys the ' +
        'conversation for the person who wrote it too',
        Object.keys(c).every(function (k) { return !c[k].bin; }),
        JSON.stringify(Object.keys(c).filter(function (k) { return c[k].bin; })));

  await open(p, 'MASTER');
  c = await cards(p);
  check('a master is',
        Object.keys(c).length > 0 &&
        Object.keys(c).every(function (k) { return c[k].bin; }));

  await p.click('.thread[data-thread="U:' + STRANGER + '"] .thread-del');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 20000 });
  const binDialog = await p.evaluate(function () {
    return {
      title: document.getElementById('modalTitle').textContent,
      subtitle: document.getElementById('modalSub').textContent,
      body: document.getElementById('modalBody').textContent,
      danger: !document.getElementById('modal').classList.contains('is-info'),
      confirm: document.getElementById('modalConfirm').textContent
    };
  });
  check('THE DIALOG SAYS WHAT IT DOES TO THEM, which is the part that is ' +
        'easy to forget',
        /destroys it for/.test(binDialog.body) &&
        /their own message bar/.test(binDialog.body) &&
        /every answer they were given/.test(binDialog.body),
        JSON.stringify(binDialog.body.slice(0, 90)));
  check('it names the person, and wears the danger treatment',
        binDialog.subtitle.indexOf(STRANGER) !== -1 && binDialog.danger,
        JSON.stringify([binDialog.subtitle, binDialog.danger]));

  await p.click('#modalCancel');
  await p.waitForTimeout(400);
  check('AND CANCEL DELETES NOTHING',
        (await db.query(
          "SELECT 1 FROM msg_thread WHERE thread_id = 'T-HELP-STRANGER'")
        ).length === 1);

  await p.click('.thread[data-thread="U:' + STRANGER + '"] .thread-del');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 20000 });
  await p.click('#modalConfirm');
  await p.waitForTimeout(1500);
  check('confirming destroys the conversation and its lines',
        (await db.query(
          "SELECT 1 FROM msg_thread WHERE thread_id = 'T-HELP-STRANGER'")
        ).length === 0 &&
        (await db.query(
          "SELECT 1 FROM msg_line WHERE thread_id = 'T-HELP-STRANGER'")
        ).length === 0);
  c = await cards(p);
  check('and the card goes with it',
        !c['U:' + STRANGER], JSON.stringify(Object.keys(c)));

  /*
    THE BIN LIVES INSIDE THE ROW THAT OPENS THE CARD, so a click on it must
    not do both. App.html guards the same thing from the other side.
  */
  const openBefore = Object.keys(c)
    .filter(function (k) { return c[k].open; }).join(',');
  await p.click('.thread[data-thread="P:' + PLAIN + '"] .thread-del');
  await p.waitForSelector('#modalBackdrop:not([hidden])', { timeout: 20000 });
  await p.click('#modalCancel');
  await p.waitForTimeout(400);
  const afterBin = await cards(p);
  const openAfter = Object.keys(afterBin)
    .filter(function (k) { return afterBin[k].open; }).join(',');
  check('PRESSING THE BIN DOES NOT ALSO OPEN THE CARD IT SITS IN - it is ' +
        'inside the row that opens it, and means something else entirely',
        openAfter === openBefore,
        JSON.stringify([openBefore, openAfter]));


  // =======================================================================
  console.log('');
  console.log('  What a viewer sees');
  // =======================================================================
  await open(p, 'USER');
  check('THE FAQ IS STILL THEIRS - it is published, and it is on the ' +
        'sign-in page where nobody is signed in at all',
        await p.isVisible('#faqList') &&
        (await p.evaluate(function () {
          return document.querySelectorAll('.faq-item').length;
        })) === says.boot.faq.length);
  /*
    BY NAME, NOT BY ATTRIBUTE. `[data-admin-only]` matches two elements -
    this card and the Help item the shell marks in its own sidebar - and a
    bare selector resolves to the shell's, which is hidden for a viewer
    anyway. That check passes while the card is plainly on screen. It did,
    on the Summary screen, and it did here until a mutation said so.
  */
  check('AND THE INBOX IS NOT',
        await p.isHidden('#inboxCard'),
        'inboxCard.hidden=' + await p.evaluate(function () {
          return document.getElementById('inboxCard').hidden;
        }));
  check('and it is the only thing on the page a viewer loses',
        (await p.evaluate(function () {
          return Array.prototype.slice.call(
            document.getElementById('page')
              .querySelectorAll('[data-admin-only]'))
            .map(function (el) { return el.id || el.className; });
        })).join(',') === 'inboxCard');
  /*
    AND THE SERVER DID NOT HAND IT OVER EITHER. The screen hiding a card
    is a courtesy; the boot not fetching the conversations is the part
    that matters, because a viewer who opens the console must not find
    everybody's post sitting in a payload that was sent and then hidden.
  */
  const asViewer = await (await fetch(BASE + '/api/help/boot', {
    headers: { Authorization: 'Bearer ' + signToken(VIEWER_ID, 'USER') }
  })).json();
  check('A VIEWER\'S BOOT CARRIES NO CONVERSATIONS AT ALL - hiding a card ' +
        'that was already sent is not privacy, it is decoration',
        asViewer.ok === true && asViewer.canAnswer === false &&
        asViewer.canDelete === false &&
        (asViewer.threads || []).length === 0 && asViewer.waiting === 0,
        JSON.stringify({ canAnswer: asViewer.canAnswer,
                         threads: (asViewer.threads || []).length,
                         waiting: asViewer.waiting }));
  check('but it does carry the FAQ, which is published',
        (asViewer.faq || []).length === says.boot.faq.length,
        JSON.stringify((asViewer.faq || []).length));
  check('nothing was fetched that would have been refused anyway',
        !badRequests.some(function (r) { return /403/.test(r); }),
        JSON.stringify(badRequests.filter(function (r) {
          return /403/.test(r); })));
  check('the admin-only sweep did not reach into the shell',
        await p.isVisible('.nav-item[data-view="kpi1"]') &&
        await p.isVisible('#operatorName'));
  check('and a viewer has no Help badge to be wrong about',
        await p.evaluate(function () {
          const el = document.getElementById('helpBadge');
          return !el || el.hidden;
        }));


  // =======================================================================
  console.log('');
  console.log('  The refresh that the original never had');
  // =======================================================================
  await open(p, 'ADMIN');
  check('the inbox refreshes itself every sixty seconds',
        await p.evaluate(function () {
          return window.__helpScreen.pollMs === 60000;
        }));
  check('AND NOT WHILE A REPLY IS HALF TYPED - an auto-refresh that eats a ' +
        'sentence is an auto-refresh people turn off',
        await p.evaluate(async function () {
          const s = window.__helpScreen;
          const card = document.querySelector('.thread');
          card.querySelector('.thread-row').click();
          await new Promise(function (r) { setTimeout(r, 150); });
          const box = card.querySelector('[data-reply]');
          box.value = 'half a sentence';
          const busy = s.inboxBusy();
          box.value = '';
          return busy === true && s.inboxBusy() === false;
        }));
  /*
    AGAINST A REAL DIALOG, not a hidden attribute flipped by hand.

    The first version of this check looked for #modalBackdrop and returned
    the string 'no modal in the page' when it was not there - and
    dialog.js injects its markup lazily, so on a page load where no dialog
    had been opened it was not there. A non-empty string is truthy, so the
    check passed without testing anything, and the mutation that made
    inboxBusy ignore dialogs altogether went straight through.
  */
  const dialogGuard = await p.evaluate(async function () {
    const s = window.__helpScreen;
    const pending = easDialog.tell({ title: 'Probe', body: '<p>Probe.</p>' });
    await new Promise(function (r) { setTimeout(r, 150); });

    const back = document.getElementById('modalBackdrop');
    const openNow = Boolean(back) && !back.hidden;
    const busyWhileOpen = s.inboxBusy();

    document.getElementById('modalConfirm').click();
    await pending;
    await new Promise(function (r) { setTimeout(r, 150); });
    const busyAfter = s.inboxBusy();

    return { openNow: openNow, busyWhileOpen: busyWhileOpen,
             busyAfter: busyAfter };
  });
  check('nor while a dialog is open over it, which is a decision in progress',
        dialogGuard.openNow === true &&
        dialogGuard.busyWhileOpen === true &&
        dialogGuard.busyAfter === false,
        JSON.stringify(dialogGuard));

  /*
    THE REFRESH ITSELF, driven rather than waited for. Sixty seconds is
    longer than this suite should sit still, and the tick does nothing the
    call below does not.
  */
  await db.query(
    `INSERT INTO msg_line (message_id, thread_id, at, side, author, body,
                           author_name, files)
     VALUES ('T-HELP-PLAIN-late','T-HELP-PLAIN', now(),'USER',$1,
             'It is still dumping.','Plain Person','[]'::jsonb)`, [PLAIN]);
  await db.query(
    `UPDATE msg_thread SET last_message_at = now(), last_message_by = $1,
            waiting_for_team = 1 WHERE thread_id = 'T-HELP-PLAIN'`, [PLAIN]);
  await p.evaluate(function () { return window.__helpScreen.loadInbox(); });
  await p.waitForTimeout(800);
  c = await cards(p);
  says = await serverSays('ADMIN');
  check('A QUERY THAT ARRIVED FROM SOMEBODY ELSE APPEARS without a reload - ' +
        'the badge polled and the list did not, which is the worst pairing ' +
        'of the two',
        c['P:' + PLAIN].bubbles.length === 3 &&
        /still dumping/.test(c['P:' + PLAIN].bubbles[2].text),
        JSON.stringify(c['P:' + PLAIN].bubbles.length));
  check('the pill comes back on, because they spoke last again',
        c['P:' + PLAIN].waiting === true);
  check('and the badge moves with the list, not apart from it',
        (await p.textContent('#helpBadge')) === String(says.inbox.waiting),
        JSON.stringify([await p.textContent('#helpBadge'), says.inbox.waiting]));


  // =======================================================================
  console.log('');
  console.log('  Signing out');
  // =======================================================================
  await p.click('#signOut');
  await p.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  check('signing out puts the sign-in box back and takes the screen away',
        await p.isHidden('#page') && await p.isVisible('#signinCard'));
  check('and the token is gone from this tab',
        (await p.evaluate(function () {
          return sessionStorage.getItem('easToken');
        })) === null);
  check('AND THE POLL STOPS - a timer still running against a signed-out ' +
        'tab is a 401 every minute for as long as it is left open',
        (await p.evaluate(function () {
          return window.__helpScreen.polling();
        })) === false);
  check('and the screen is holding nothing of theirs any more',
        await p.evaluate(function () {
          const s = window.__helpScreen.state;
          return s.token === '' && s.boot === null && s.threads.length === 0;
        }));


  // =======================================================================
  console.log('');
  console.log('  Nothing on fire in the console');
  // =======================================================================
  check('the page threw nothing', thrown.length === 0, thrown.join(' | '));
  /*
    The one 400 this suite asks for is subtracted by name, not by making
    the filter vaguer: anything else, including a second refusal on the
    same endpoint, still fails.
  */
  let allowed = expected400;
  const unexpected = badRequests.filter(function (r) {
    if (/cdnjs\.cloudflare\.com/.test(r)) return false;
    if (allowed > 0 && r === '400 ' + BASE + '/api/messages/reply') {
      allowed--;
      return false;
    }
    return true;
  });
  check('every file the screen asked for was served',
        unexpected.length === 0, unexpected.slice(0, 4).join(' | '));

  await context.close();
  await b.close();

  await sweep();
  check('no test conversations are left behind',
        (await db.query("SELECT count(*)::int AS n FROM msg_thread" +
                        " WHERE thread_id LIKE 'T-HELP-%'"))[0].n === 0);
  check('no test lines are left behind',
        (await db.query("SELECT count(*)::int AS n FROM msg_line" +
                        " WHERE thread_id LIKE 'T-HELP-%'"))[0].n === 0);
  check('and no test accounts are left behind',
        (await db.query(
          'SELECT count(*)::int AS n FROM account WHERE employee_id = ANY($1)',
          [PEOPLE]))[0].n === 0);

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  recap();
  console.log('');
  await db.pool.end();
  process.exit(fail ? 1 : 0);
}


main().catch(async function (err) {
  console.error('\n  Failed: ' + err.message + '\n' + err.stack + '\n');
  recap();
  try { await sweep(); } catch (e) { /* best effort */ }
  try { await db.pool.end(); } catch (e) { /* best effort */ }
  process.exit(1);
});
