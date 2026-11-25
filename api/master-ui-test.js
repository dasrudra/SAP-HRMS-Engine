/**
 * THE ACCOUNTS SCREEN, DRIVEN IN A REAL BROWSER AGAINST THE REAL SERVER.
 *
 *   Terminal 3:  npm start
 *   Terminal 2:  node master-ui-test.js
 *
 * accounts-test.js proves the endpoints and the guards. This proves the
 * screen: that the table says what the accounts say, that every button asks
 * before it acts, that the one-time passwords are shown once and are not
 * sitting in the page afterwards, and that somebody still on a password a
 * colleague chose cannot get past the card that replaces it.
 *
 * ITS FIXTURE IS SCOPED TO 2099 AND SWEPT AT BOTH ENDS, and like
 * accounts-test.js it refuses to start if any ID it would delete is outside
 * the reserved block.
 *
 * WHAT IT DELIBERATELY DOES NOT TEST: anything that depends on how many
 * masters the database has. That is accounts-test.js's job, it is a fact
 * about the whole system rather than about this fixture, and asserting it
 * here would fail on exactly the machines that have real accounts.
 */
require('dotenv').config();
const db = require('./db');
const accounts = require('./accounts');
const { signToken } = require('./auth');
const { hashPassword } = require('./password');
const browser = require('../tests/harness/browser');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const PAGE = BASE + '/master.html';

const MASTER = '20990811';
const ADMIN = '20990812';
const VIEWER = '20990813';
const WAITING = '20990814';   // must_change, never signed in
const NEWBIE = '20990815';    // on the roster, no account - for the grant
const OFF_ROSTER = '20990816';

const MINE = [MASTER, ADMIN, VIEWER, WAITING, NEWBIE, OFF_ROSTER];

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); return; }
  fail++;
  const line = name + (detail === undefined ? '' : '   ' + detail);
  failures.push(line);
  console.log('  FAIL ' + line);
}

function recap() {
  if (!failures.length) return;
  console.log('');
  console.log('  ' + failures.length + ' failed:');
  failures.forEach(function (line) { console.log('    - ' + line); });
}


function refuseIfNotReserved() {
  const bad = MINE.filter(function (id) { return !/^2099\d{4}$/.test(id); });
  if (bad.length) {
    throw new Error('These are not reserved test IDs and this suite deletes ' +
                    'accounts: ' + bad.join(', '));
  }
}

async function sweep() {
  await db.query('DELETE FROM account WHERE employee_id = ANY($1)', [MINE]);
  await db.query('DELETE FROM auth_log WHERE employee_id = ANY($1)', [MINE]);
  await db.query('DELETE FROM team WHERE employee_id = ANY($1)', [MINE]);
}

async function seed() {
  const people = [
    [MASTER,  'Test Master Eight', 'MASTER', false, '',                      3],
    [ADMIN,   'Test Admin Eight',  'ADMIN',  false, 'admin811@example.com',  7],
    [VIEWER,  'Test Viewer Eight', 'USER',   false, '',                      2],
    [WAITING, 'Test Waiting Eight','USER',   true,  '',                      0]
  ];
  for (const [id, name, role, must, email, signIns] of people) {
    await db.query(
      `INSERT INTO team (employee_id, full_name, designation, sub_department)
       VALUES ($1, $2, 'Test', 'Test') ON CONFLICT (employee_id) DO NOTHING`,
      [id, name]);
    await db.query(
      `INSERT INTO account (employee_id, password_hash, role, must_change,
                            full_name, email, sign_ins, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $7 = 0 THEN NULL ELSE now() END)`,
      [id, hashPassword('fixture-' + id), role, must, name, email, signIns]);
  }
  // On the roster, no account - so the grant has somebody to invite.
  await db.query(
    `INSERT INTO team (employee_id, full_name, designation, sub_department)
     VALUES ($1, 'Test Newbie Eight', 'Test', 'Test')
     ON CONFLICT (employee_id) DO NOTHING`, [NEWBIE]);

  await accounts.logAuth(VIEWER, 'SIGNIN', 'USER', '');
  await accounts.logAuth(VIEWER, 'ROLE', 'USER', 'set by ' + MASTER);
}


/** Opens the screen already signed in as `id`. */
async function open(p, id, role) {
  await p.goto(BASE + '/master.html');
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                   signToken(id, role));
  await p.goto(PAGE);
}

/** Opens it and waits for the table to be drawn. */
async function openReady(p, id, role) {
  await open(p, id, role);
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await p.waitForFunction(function () {
    const body = document.querySelector('#masterTable tbody');
    return body && !/Loading/.test(body.textContent);
  }, null, { timeout: 20000 });
  await p.waitForTimeout(200);
}

/** The row for an employee ID, as the screen has drawn it. */
async function row(p, id) {
  return p.evaluate(function (want) {
    const tr = Array.prototype.slice.call(
      document.querySelectorAll('#masterTable tbody tr'))
      .filter(function (r) {
        const first = r.querySelector('td');
        return first && first.textContent.trim() === want;
      })[0];
    if (!tr) return null;
    const cells = Array.prototype.slice.call(tr.querySelectorAll('td'));
    return {
      id: cells[0].textContent.trim(),
      name: (tr.querySelector('[data-detail="name"]') || {}).value,
      namePlaceholder: (tr.querySelector('[data-detail="name"]') || {}).placeholder,
      role: cells[2].textContent.trim(),
      status: cells[3].textContent.trim(),
      email: (tr.querySelector('[data-detail="email"]') || {}).value,
      emailPlaceholder: (tr.querySelector('[data-detail="email"]') || {}).placeholder,
      emailNote: (tr.querySelector('.cell-note') || {}).textContent || '',
      lastSignIn: cells[5].textContent.trim(),
      actions: Array.prototype.slice.call(tr.querySelectorAll('[data-master]'))
        .map(function (b) { return b.dataset.master; })
    };
  }, id);
}

/** The order the table put them in. */
async function idsOnScreen(p) {
  return p.evaluate(function () {
    return Array.prototype.slice.call(
      document.querySelectorAll('#masterTable tbody tr'))
      .map(function (r) {
        const c = r.querySelector('td');
        return c ? c.textContent.trim() : '';
      });
  });
}

async function dialogText(p) {
  return p.evaluate(function () {
    const back = document.getElementById('modalBackdrop');
    if (!back || back.hidden) return null;
    return {
      title: (document.getElementById('modalTitle') || {}).textContent || '',
      body: (document.getElementById('modalBody') || {}).textContent || '',
      confirm: (document.getElementById('modalConfirm') || {}).textContent || '',
      danger: !document.getElementById('modal').classList.contains('is-info'),
      hasCancel: !document.getElementById('modalCancel').hidden
    };
  });
}

async function clickDialog(p, which) {
  await p.click('#' + (which === 'cancel' ? 'modalCancel' : 'modalConfirm'));
}

async function closedDialog(p) {
  await p.waitForFunction(function () {
    const back = document.getElementById('modalBackdrop');
    return !back || back.hidden;
  }, null, { timeout: 20000 });
}

/** Waits for the table to be redrawn after an action. */
async function redrawn(p, id, want) {
  await p.waitForFunction(function (args) {
    const tr = Array.prototype.slice.call(
      document.querySelectorAll('#masterTable tbody tr'))
      .filter(function (r) {
        const c = r.querySelector('td');
        return c && c.textContent.trim() === args.id;
      })[0];
    return tr && tr.querySelectorAll('td')[2].textContent.trim() === args.want;
  }, { id: id, want: want }, { timeout: 20000 });
}


async function main() {
  refuseIfNotReserved();

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
  let expecting403 = false;
  p.on('pageerror', function (e) { thrown.push(String(e.message || e)); });
  p.on('console', function (m) {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      thrown.push(m.text());
    }
  });
  p.on('response', function (r) {
    if (expecting403 && r.status() === 403) return;
    if (r.status() >= 400) badRequests.push(r.status() + ' ' + r.url());
  });
  p.on('requestfailed', function (r) {
    const why = (r.failure() || {}).errorText || '';
    if (/ERR_ABORTED/.test(why)) return;
    badRequests.push('could not be reached: ' + r.url() + ' (' + why + ')');
  });


  // =======================================================================
  console.log('');
  console.log('  Who gets in');
  // =======================================================================
  expecting403 = true;
  await open(p, ADMIN, 'ADMIN');
  await p.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  check('AN ADMIN IS TURNED AWAY, by the server rather than by the nav',
        await p.isVisible('#signinCard') && await p.isHidden('#page'));
  check('and is told why, rather than shown a blank sign-in card',
        /[Cc]ould not open/.test(await p.textContent('#signinWhy')),
        await p.textContent('#signinWhy'));

  await open(p, VIEWER, 'USER');
  await p.waitForSelector('#signinCard:not([hidden])', { timeout: 20000 });
  check('so is a viewer', await p.isVisible('#signinCard'));
  expecting403 = false;

  await openReady(p, MASTER, 'MASTER');
  check('a master gets the screen', await p.isVisible('#page'));
  check('the shell lights Accounts',
        await p.evaluate(function () {
          const lit = document.querySelector('.nav-item.is-active');
          return lit && lit.getAttribute('data-view') === 'master';
        }));
  check('and the top bar names it',
        (await p.textContent('#viewLabel')) === 'Accounts',
        await p.textContent('#viewLabel'));


  // =======================================================================
  console.log('');
  console.log('  The people table');
  // =======================================================================
  const master = await row(p, MASTER);
  const admin = await row(p, ADMIN);
  const viewer = await row(p, VIEWER);
  const waiting = await row(p, WAITING);

  check('every fixture account is on screen',
        master && admin && viewer && waiting,
        JSON.stringify([master, admin, viewer, waiting].map(Boolean)));

  check('THE ROLE IS A WORD, NOT A DATABASE VALUE',
        master.role === 'Master' && admin.role === 'Admin' &&
        viewer.role === 'Viewer',
        [master.role, admin.role, viewer.role].join(' / '));

  check('THREE STATES ARE TOLD APART',
        viewer.status === 'Active' &&
        waiting.status === 'Not signed in yet',
        viewer.status + ' / ' + waiting.status);

  check('an admin is invited to add an address',
        admin.emailPlaceholder === 'add one to be emailed',
        admin.emailPlaceholder);
  check('AND A VIEWER IS TOLD THEIRS WOULD NOT BE USED',
        viewer.emailPlaceholder === 'not used for a viewer',
        viewer.emailPlaceholder);

  check('the actions offered depend on the role',
        viewer.actions.join() === 'admin,reset,remove' &&
        admin.actions.join() === 'viewer,reset,remove' &&
        master.actions.join() === 'reset,remove',
        JSON.stringify({ viewer: viewer.actions, admin: admin.actions,
                         master: master.actions }));

  /*
    NEWEST SIGN-IN AT THE TOP, and anybody who has never signed in at the
    bottom. WAITING has no last_login_at at all, so it is the one that has
    to sort last among the fixture.
  */
  const order = await idsOnScreen(p);
  const mine = order.filter(function (id) { return MINE.indexOf(id) !== -1; });
  check('NEWEST SIGN-IN FIRST, and never-signed-in last',
        mine.indexOf(WAITING) === mine.length - 1,
        JSON.stringify(mine));


  // =======================================================================
  console.log('');
  console.log('  The filters');
  // =======================================================================
  await p.selectOption('#fMasterRole', 'ADMIN');
  await p.waitForTimeout(150);
  let shown = (await idsOnScreen(p)).filter(function (id) {
    return MINE.indexOf(id) !== -1;
  });
  check('filtering by role keeps only that role',
        shown.indexOf(ADMIN) !== -1 && shown.indexOf(VIEWER) === -1,
        JSON.stringify(shown));

  await p.selectOption('#fMasterRole', '');
  await p.fill('#fMasterId', VIEWER);
  await p.waitForTimeout(150);
  shown = (await idsOnScreen(p)).filter(function (id) {
    return MINE.indexOf(id) !== -1;
  });
  check('and searching narrows to the one ID',
        shown.length === 1 && shown[0] === VIEWER, JSON.stringify(shown));

  check('THE COUNT SAYS HOW MANY OF HOW MANY',
        / of /.test(await p.textContent('#cMaster')),
        await p.textContent('#cMaster'));

  await p.click('#fMasterReset');
  await p.waitForTimeout(150);
  check('and Reset puts them all back',
        (await idsOnScreen(p)).length > shown.length);


  // =======================================================================
  console.log('');
  console.log('  Giving and taking away admin');
  // =======================================================================
  await p.click('[data-master="admin"][data-id="' + VIEWER + '"]');
  let dlg = await dialogText(p);
  check('making somebody an admin asks first',
        dlg && /Give .* admin access\?/.test(dlg.title), JSON.stringify(dlg));
  check('AND DOES NOT WEAR A BIN - only removing a login is destructive',
        dlg && dlg.danger === false, JSON.stringify(dlg && dlg.danger));
  check('the button says what it does',
        dlg.confirm === 'Give admin access', dlg.confirm);

  await clickDialog(p, 'cancel');
  await closedDialog(p);
  check('CANCEL REALLY CANCELS',
        (await row(p, VIEWER)).role === 'Viewer');

  await p.click('[data-master="admin"][data-id="' + VIEWER + '"]');
  await clickDialog(p, 'confirm');
  await closedDialog(p);
  await redrawn(p, VIEWER, 'Admin');
  check('and confirming makes them one', (await row(p, VIEWER)).role === 'Admin');
  check('THE ROW REDREW ITSELF - the actions swap over with the role',
        (await row(p, VIEWER)).actions.join() === 'viewer,reset,remove',
        JSON.stringify((await row(p, VIEWER)).actions));
  check('and their email placeholder changes with it',
        (await row(p, VIEWER)).emailPlaceholder === 'add one to be emailed');

  await p.click('[data-master="viewer"][data-id="' + VIEWER + '"]');
  await clickDialog(p, 'confirm');
  await closedDialog(p);
  await redrawn(p, VIEWER, 'Viewer');
  check('and it can be taken away again',
        (await row(p, VIEWER)).role === 'Viewer');


  // =======================================================================
  console.log('');
  console.log('  Resetting a password');
  // =======================================================================
  await p.click('[data-master="reset"][data-id="' + VIEWER + '"]');
  dlg = await dialogText(p);
  check('a reset asks first', dlg && /Reset the password/.test(dlg.title),
        JSON.stringify(dlg && dlg.title));
  await clickDialog(p, 'confirm');

  await p.waitForFunction(function () {
    const t = document.getElementById('modalTitle');
    return t && /Password reset for/.test(t.textContent);
  }, null, { timeout: 20000 });
  dlg = await dialogText(p);
  check('THE NEW PASSWORD IS SHOWN ONCE, and the dialog says so',
        /shown here and nowhere else/i.test(dlg.body), dlg.body.slice(0, 120));
  check('with no Cancel on it - there is nothing to cancel',
        dlg.hasCancel === false);

  const shownPassword = await p.evaluate(function () {
    const el = document.querySelector('.new-password');
    return el ? el.textContent.trim() : '';
  });
  check('and it is a real password',
        shownPassword.length >= 8 && !/[Il1O0]/.test(shownPassword),
        shownPassword);

  await clickDialog(p, 'confirm');
  await closedDialog(p);

  check('IT IS NOT LEFT LYING IN THE PAGE after the dialog closes',
        (await p.content()).indexOf(shownPassword) === -1);

  await p.waitForFunction(function (args) {
    const tr = Array.prototype.slice.call(
      document.querySelectorAll('#masterTable tbody tr'))
      .filter(function (r) {
        const c = r.querySelector('td');
        return c && c.textContent.trim() === args;
      })[0];
    return tr && /Must set a password/.test(tr.textContent);
  }, VIEWER, { timeout: 20000 });
  check('and the row now says they must set their own',
        /Must set a password/.test((await row(p, VIEWER)).status),
        (await row(p, VIEWER)).status);


  // =======================================================================
  console.log('');
  console.log('  Names and addresses, typed into the cell');
  // =======================================================================
  await p.fill('[data-detail="name"][data-id="' + ADMIN + '"]', '  Spaced   Out  ');
  await p.press('[data-detail="name"][data-id="' + ADMIN + '"]', 'Tab');
  await p.waitForFunction(function (args) {
    const box = document.querySelector('[data-detail="name"][data-id="' + args + '"]');
    return box && box.value === 'Spaced Out';
  }, ADMIN, { timeout: 20000 });
  check('A NAME IS TIDIED BY THE SERVER AND THE BOX SHOWS THE TIDIED ONE',
        (await row(p, ADMIN)).name === 'Spaced Out',
        (await row(p, ADMIN)).name);

  await p.fill('[data-detail="email"][data-id="' + ADMIN + '"]', 'not-an-address');
  await p.press('[data-detail="email"][data-id="' + ADMIN + '"]', 'Tab');
  await p.waitForFunction(function () {
    const t = document.getElementById('modalTitle');
    const back = document.getElementById('modalBackdrop');
    return back && !back.hidden && /could not be saved/i.test(t.textContent);
  }, null, { timeout: 20000 });
  dlg = await dialogText(p);
  check('A BAD ADDRESS IS REFUSED IN THE SERVER\'S OWN WORDS',
        /does not look like an email/.test(dlg.body), dlg.body);
  await clickDialog(p, 'confirm');
  await closedDialog(p);
  check('and the box is marked so it can be found again',
        await p.evaluate(function (args) {
          const box = document.querySelector(
            '[data-detail="email"][data-id="' + args + '"]');
          return box && box.classList.contains('is-bad');
        }, ADMIN));

  check('AND THE NAME BESIDE IT WAS NOT BLANKED by the refusal',
        (await row(p, ADMIN)).name === 'Spaced Out');


  // =======================================================================
  console.log('');
  console.log('  Writing somebody down before they arrive');
  // =======================================================================
  await p.fill('#grantId', 'abc');
  await p.click('#grantGo');
  await p.waitForTimeout(200);
  check('an employee ID of letters is refused without troubling the server',
        /digits only/.test(await p.textContent('#grantNote')),
        await p.textContent('#grantNote'));

  await p.fill('#grantId', OFF_ROSTER);
  await p.selectOption('#grantRole', 'USER');
  await p.click('#grantGo');
  await p.waitForFunction(function () {
    const n = document.getElementById('grantNote');
    return n && /roster/.test(n.textContent);
  }, null, { timeout: 20000 });
  check('AN ID THAT IS NOT ON THE ROSTER IS REFUSED IN PLAIN WORDS',
        /not on the roster/.test(await p.textContent('#grantNote')),
        await p.textContent('#grantNote'));

  await p.fill('#grantId', NEWBIE);
  await p.selectOption('#grantRole', 'ADMIN');
  await p.click('#grantGo');
  await p.waitForFunction(function () {
    const t = document.getElementById('modalTitle');
    const back = document.getElementById('modalBackdrop');
    return back && !back.hidden && /can now sign in/.test(t.textContent);
  }, null, { timeout: 20000 });
  dlg = await dialogText(p);
  check('a new ID is written down and the password shown once',
        /shown here and nowhere else/i.test(dlg.body), dlg.body.slice(0, 100));

  const invited = await p.evaluate(function () {
    const el = document.querySelector('.new-password');
    return el ? el.textContent.trim() : '';
  });
  await clickDialog(p, 'confirm');
  await closedDialog(p);

  check('THE BOX IS EMPTIED, so the next one is not granted by accident',
        (await p.inputValue('#grantId')) === '');
  check('and they are in the table, already holding the access',
        (await row(p, NEWBIE)) &&
        (await row(p, NEWBIE)).role === 'Admin',
        JSON.stringify(await row(p, NEWBIE)));
  check('marked as not signed in yet',
        /Not signed in yet/.test((await row(p, NEWBIE)).status),
        (await row(p, NEWBIE)).status);


  // =======================================================================
  console.log('');
  console.log('  The sign-in log');
  // =======================================================================
  const log = await p.evaluate(function () {
    return Array.prototype.slice.call(
      document.querySelectorAll('#masterLog tbody tr'))
      .map(function (r) {
        const c = Array.prototype.slice.call(r.querySelectorAll('td'));
        return { when: c[0].textContent.trim(), id: c[1].textContent.trim(),
                 name: c[2].textContent.trim(), what: c[3].textContent.trim(),
                 detail: c[5].textContent.trim() };
      });
  });
  const ourLog = log.filter(function (r) { return MINE.indexOf(r.id) !== -1; });

  check('the log has our rows in it', ourLog.length > 0, String(ourLog.length));
  check('AN EVENT IS A SENTENCE, not a stored keyword',
        ourLog.some(function (r) { return r.what === 'Password reset'; }) &&
        !ourLog.some(function (r) { return /^[A-Z]+$/.test(r.what); }),
        JSON.stringify(ourLog.slice(0, 4).map(function (r) { return r.what; })));

  check('THE NAME COMES FROM THE ACCOUNTS TABLE, not from the log',
        ourLog.filter(function (r) { return r.id === ADMIN; })
              .every(function (r) { return r.name === 'Spaced Out'; }),
        JSON.stringify(ourLog.filter(function (r) { return r.id === ADMIN; })
                             .map(function (r) { return r.name; })));

  check('and it says who did it',
        ourLog.some(function (r) { return /by 20990811/.test(r.detail); }),
        JSON.stringify(ourLog.map(function (r) { return r.detail; }).slice(0, 5)));

  check('NO PASSWORD IS ANYWHERE IN THE LOG',
        !(await p.textContent('#masterLog')).includes(shownPassword) &&
        !(await p.textContent('#masterLog')).includes(invited));


  // =======================================================================
  console.log('');
  console.log('  The sign-ups box');
  // =======================================================================
  check('it says new logins are closed',
        (await p.textContent('#signupState')).trim() === 'Closed');
  check('AND THE BUTTON SAYS IT IS NOT PORTED rather than pretending to work',
        await p.evaluate(function () {
          const b = document.getElementById('signupToggle');
          return b.disabled && /not ported/i.test(b.getAttribute('title') || '');
        }));
  check('with the count beside it',
        /have a login/.test(await p.textContent('#signupNote')),
        await p.textContent('#signupNote'));


  // =======================================================================
  console.log('');
  console.log('  Removing a login');
  // =======================================================================
  await p.click('[data-master="remove"][data-id="' + NEWBIE + '"]');
  dlg = await dialogText(p);
  check('removing asks first', dlg && /Remove the login/.test(dlg.title),
        JSON.stringify(dlg && dlg.title));
  check('AND THIS ONE DOES WEAR A BIN', dlg.danger === true);
  await clickDialog(p, 'confirm');
  await closedDialog(p);

  await p.waitForFunction(function (args) {
    return !Array.prototype.slice.call(
      document.querySelectorAll('#masterTable tbody tr'))
      .some(function (r) {
        const c = r.querySelector('td');
        return c && c.textContent.trim() === args;
      });
  }, NEWBIE, { timeout: 20000 });
  check('and the row goes', (await row(p, NEWBIE)) === null);

  check('THE LOG KEEPS THE ROW ABOUT THE REMOVAL',
        /Account removed/.test(await p.textContent('#masterLog')));


  // =======================================================================
  console.log('');
  console.log('  The password somebody else chose');
  // =======================================================================
  /*
    THE CARD IS WHAT MAKES A RESET TEMPORARY. Without it, "Reset password"
    hands somebody a password a colleague chose and knows, and they keep
    it. WAITING has must_change set and has never signed in, which is
    exactly the state an invitation leaves somebody in.
  */
  await p.goto(BASE + '/uploads.html');
  await p.evaluate(function (t) { sessionStorage.setItem('easToken', t); },
                   signToken(WAITING, 'USER'));
  await p.goto(BASE + '/uploads.html');
  await p.waitForSelector('#shellMustChange', { timeout: 20000 });
  check('SOMEBODY STILL ON A PASSWORD SOMEBODY ELSE CHOSE IS ASKED TO ' +
        'REPLACE IT, on whatever screen they land on',
        await p.isVisible('#shellMustChange'));
  check('and it says whose password it was',
        /set for you/i.test(await p.textContent('#shellMustChange')),
        (await p.textContent('#shellMustChange')).slice(0, 80));
  check('THERE IS NO WAY PAST IT BUT THROUGH - no Cancel',
        await p.evaluate(function () {
          return document.querySelectorAll('#shellMustChange button').length === 1;
        }));

  await p.fill('#mcCurrent', 'not the right one');
  await p.fill('#mcNext', 'a-good-new-one');
  await p.fill('#mcConfirm', 'a-good-new-one');
  await p.click('#mcGo');
  await p.waitForFunction(function () {
    const w = document.getElementById('mcWhy');
    return w && w.textContent.trim().length > 0;
  }, null, { timeout: 20000 });
  check('the password they were given has to be right',
        /not your current password/.test(await p.textContent('#mcWhy')),
        await p.textContent('#mcWhy'));
  check('AND THE CARD IS STILL THERE', await p.isVisible('#shellMustChange'));

  await p.fill('#mcCurrent', 'fixture-' + WAITING);
  await p.fill('#mcNext', 'short');
  await p.fill('#mcConfirm', 'short');
  await p.click('#mcGo');
  await p.waitForFunction(function () {
    const w = document.getElementById('mcWhy');
    return w && /at least/.test(w.textContent);
  }, null, { timeout: 20000 });
  check('a short one is refused, in the server\'s words',
        /at least/.test(await p.textContent('#mcWhy')),
        await p.textContent('#mcWhy'));

  await p.fill('#mcNext', 'a-good-new-one');
  await p.fill('#mcConfirm', 'a-different-one');
  await p.click('#mcGo');
  await p.waitForFunction(function () {
    const w = document.getElementById('mcWhy');
    return w && /not the same/.test(w.textContent);
  }, null, { timeout: 20000 });
  check('and two that disagree are refused',
        /not the same/.test(await p.textContent('#mcWhy')));

  await p.fill('#mcConfirm', 'a-good-new-one');
  await p.click('#mcGo');
  await p.waitForFunction(function () {
    return !document.getElementById('shellMustChange');
  }, null, { timeout: 20000 });
  check('A GOOD ONE CLEARS THE CARD', true);

  const after = await db.query(
    'SELECT must_change FROM account WHERE employee_id = $1', [WAITING]);
  check('and the flag is cleared in the database',
        after[0].must_change === false);

  await p.goto(BASE + '/uploads.html');
  await p.waitForSelector('#page:not([hidden])', { timeout: 20000 });
  await p.waitForTimeout(400);
  check('SO A RELOAD DOES NOT ASK AGAIN - which is the whole point of ' +
        'reading the flag from the database rather than from the token',
        await p.evaluate(function () {
          return !document.getElementById('shellMustChange');
        }));


  // =======================================================================
  console.log('');
  console.log('  Nothing on fire in the console');
  // =======================================================================
  check('the page threw nothing', thrown.length === 0, thrown.join(' | '));
  /*
    400 AND 403 ARE THIS SUITE'S OWN DOING. It types a nonsense email
    address, grants to somebody who is not on the roster, and gets a
    password wrong on purpose - and the server declining each of those is
    the behaviour being tested, not a fault. uploads-ui-test.js says the
    same about its 403s. What this check is for is a file the page expects
    and the server does not serve, which is how a screen quietly loses its
    stylesheet.
  */
  const unexpected = badRequests.filter(function (r) {
    return !/cdnjs\.cloudflare\.com/.test(r) &&
           !/^40[03] /.test(r);
  });
  check('every file the screen asked for was served',
        unexpected.length === 0, unexpected.slice(0, 4).join(' | '));

  await context.close();
  await b.close();

  await sweep();
  check('no test accounts are left behind',
        (await db.query(
          'SELECT count(*)::int AS n FROM account WHERE employee_id = ANY($1)',
          [MINE]))[0].n === 0);
  check('no test log rows are left behind',
        (await db.query(
          'SELECT count(*)::int AS n FROM auth_log WHERE employee_id = ANY($1)',
          [MINE]))[0].n === 0);

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
