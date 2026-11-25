/**
 * accounts.js - who may open the dashboard, and everything that has happened
 * to the logins.
 * ===========================================================================
 *
 * The MASTER half of src/Auth.gs: masterListAccounts, masterSetRole,
 * masterRemoveAccount, masterResetPassword, masterGrantToEmployeeId,
 * masterSetDetails, masterAuditLog, logAuth and pruneAuthLog - over
 * PostgreSQL instead of a spreadsheet tab and a script property.
 *
 * EVERY ONE OF THESE IS MASTER-ONLY, CHECKED ON THE SERVER. The Accounts
 * screen is hidden from everyone else, but hiding is a courtesy: the API is
 * a URL and `curl` does not read our stylesheet. The guard in server.js is
 * what actually holds, and these functions take the actor's employee ID so
 * that every row they write says who did it.
 *
 * ON SEEING PEOPLE'S PASSWORDS. There is no function for it here and there
 * cannot be one, because the passwords are not kept. What is stored is a
 * scrypt hash, which can confirm a password typed at the sign-in and cannot
 * be run backwards into the password itself. Auth.gs says it plainly and it
 * is worth repeating: that is not an oversight to be patched, it is the
 * single thing standing between a copy of this database and everyone's
 * password, and people reuse passwords. The need behind the request -
 * somebody is locked out and has to get back in - is served completely by
 * resetPassword() below.
 */

const crypto = require('crypto');
const db = require('./db');
const { hashPassword } = require('./password');
const { rankOf, ROLE_RANK } = require('./auth');

/* From Auth.gs. An employee ID is digits, because that is what it is. */
const EMP_ID_MIN = 4;
const EMP_ID_MAX = 12;

/* CONFIG.AUTH_LOG_DAYS in Config.gs. */
const AUTH_LOG_DAYS = 30;

/* MIN_PASSWORD in Auth.gs. */
const MIN_PASSWORD = 6;

const ROLES = ['USER', 'ADMIN', 'MASTER'];

/*
  The address test from masterSetDetails. Deliberately loose: it is here to
  catch a typo, not to decide what the internet considers a valid address.
*/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;


/** cleanName from Config.gs: one space between words, 60 characters. */
function cleanName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 60);
}

function isRealRole(role) {
  return ROLES.indexOf(String(role || '').toUpperCase()) !== -1;
}


// ===========================================================================
// THE LOG
// ===========================================================================

/**
 * One line in the sign-in log. NEVER THROWS.
 *
 * Auth.gs: "An account action that half-succeeded because the log was
 * unreachable would be worse than an action with no line written about it."
 * That holds here with one extra edge - this is called from the sign-in
 * path, and a database hiccup while writing a log row must not turn a
 * correct password into a failed login.
 *
 * Returns nothing and is deliberately not awaited by its callers where the
 * caller's own answer does not depend on it.
 */
async function logAuth(employeeId, event, role, detail) {
  try {
    await db.query(
      `INSERT INTO auth_log (employee_id, event, role, detail)
       VALUES ($1, $2, $3, $4)`,
      [String(employeeId == null ? '' : employeeId),
       String(event || ''), String(role || ''), String(detail || '')]);
  } catch (e) {
    // Deliberately silent, as Auth.gs is. Logged to the console so it is not
    // invisible to whoever is looking at the server.
    console.error('[accounts] could not write the auth log: ' + e.message);
  }
}


/**
 * Drops sign-in history older than AUTH_LOG_DAYS.
 *
 * ONE DIFFERENCE FROM pruneAuthLog IN Auth.gs, and it is the interesting
 * kind: the original deletes only a PREFIX of the sheet, and explains at
 * length why not "every row older than the cutoff" - if a clock skews or
 * somebody pastes a row in by hand the sheet stops being sorted, and a rule
 * that deletes by age alone would reach past fresh rows to get at an old
 * one, taking the fresh ones with it.
 *
 * That defect cannot happen here. deleteRows(2, n) is positional: it removes
 * n rows from the top whatever is in them, so being sorted is load-bearing.
 * A DELETE ... WHERE at < cutoff is a predicate applied to each row on its
 * own, so an out-of-order row is simply judged on its own date. The careful
 * rule was a workaround for the sheet, not for the policy, and carrying it
 * over would mean leaving genuinely expired rows behind to no purpose.
 *
 * @return {number} how many rows were removed
 */
async function pruneAuthLog(days) {
  const window = Number(days) > 0 ? Number(days) : AUTH_LOG_DAYS;
  const rows = await db.query(
    `DELETE FROM auth_log
      WHERE at < now() - ($1 || ' days')::interval
      RETURNING id`, [String(window)]);
  if (rows.length) {
    console.log('[accounts] sign-in log: removed ' + rows.length +
                ' row(s) older than ' + window + ' days.');
  }
  return rows.length;
}


/**
 * The sign-in log, newest first.
 *
 * Pruned before it is read, as masterAuditLog does, so what comes back is
 * already inside the window and the table does not quietly grow for months
 * between backups. A prune that fails is not a reason to refuse the log: a
 * full log is better than no log.
 */
async function auditLog(limit) {
  const want = Math.min(Math.max(Number(limit) || 200, 1), 1000);

  try { await pruneAuthLog(); }
  catch (e) { console.error('[accounts] prune failed: ' + e.message); }

  const rows = await db.query(
    `SELECT at, employee_id, event, role, detail
       FROM auth_log
      ORDER BY at DESC, id DESC
      LIMIT $1`, [want]);

  return rows.map(function (r) {
    return {
      when: r.at ? r.at.toISOString() : '',
      username: r.employee_id,
      event: r.event,
      role: r.role,
      detail: r.detail
    };
  });
}


// ===========================================================================
// READING THE ACCOUNTS
// ===========================================================================

/**
 * Everyone, with enough about each to manage them. NEVER A HASH.
 *
 * `fullName` comes from the account and falls back to the roster. Auth.gs
 * has only the account's copy, because Apps Script has no roster to join
 * to; here `team` is the organisation's own record of a person's name and
 * `account.full_name` is what they asked to be called. The account's answer
 * wins where there is one, which is the same precedence the messenger uses.
 */
async function listAccounts() {
  const rows = await db.query(`
    SELECT a.employee_id, a.role, a.created_at, a.password_set,
           a.last_login_at, a.sign_ins, a.must_change, a.note, a.email,
           COALESCE(NULLIF(a.full_name, ''), t.full_name, '') AS full_name
      FROM account a
      LEFT JOIN team t ON t.employee_id = a.employee_id
     ORDER BY a.employee_id`);

  return rows.map(function (a) {
    return {
      username: a.employee_id,
      role: a.role,
      created: a.created_at ? a.created_at.toISOString() : '',
      passwordSet: a.password_set ? a.password_set.toISOString() : '',
      lastSignIn: a.last_login_at ? a.last_login_at.toISOString() : '',
      signIns: Number(a.sign_ins) || 0,
      mustChange: Boolean(a.must_change),
      note: a.note || '',
      fullName: a.full_name || '',
      email: a.email || '',
      /*
        WHETHER THIS ACCOUNT'S EMAIL ACTUALLY MATTERS. An address on a
        viewer is stored and simply not written to - only admins and
        masters are told when somebody asks a question - and the screen
        says so rather than leaving somebody to wonder why they hear
        nothing.
      */
      alerted: rankOf(a.role) >= ROLE_RANK.ADMIN && Boolean(a.email)
    };
  });
}


/**
 * The addresses a new query is emailed to.
 *
 * Ported from alertEmailList in Auth.gs, minus its second source. The
 * original also reads a script property, because "not every address belongs
 * to an account: a shared team inbox, somebody's second address, a manager
 * who is not an admin." There is no properties store here and no screen
 * that sets one, so adding a column for it now would be a column nothing
 * maintains. The accounts are the list that maintains itself, which is the
 * whole reason the email column exists.
 *
 * Deduplicated case-insensitively: the same address typed two ways is one
 * person who would otherwise be emailed twice.
 */
async function alertEmails() {
  const rows = await db.query(
    `SELECT email, role FROM account WHERE email <> ''`);

  const seen = Object.create(null);
  const out = [];
  rows.forEach(function (r) {
    if (rankOf(r.role) < ROLE_RANK.ADMIN) return;
    const address = String(r.email || '').trim();
    if (!EMAIL.test(address)) return;
    const key = address.toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(address);
  });
  return out;
}


/** How many masters there are, which several guards below turn on. */
async function countMasters() {
  const rows = await db.query(
    `SELECT count(*)::int AS n FROM account WHERE role = 'MASTER'`);
  return rows[0].n;
}


async function accountOf(employeeId) {
  const rows = await db.query(
    'SELECT employee_id, role, email, full_name FROM account WHERE employee_id = $1',
    [employeeId]);
  return rows[0] || null;
}


/**
 * An error whose text was written here, on purpose, for a person to read.
 *
 * fail() in server.js refuses to send err.message to a browser, and it is
 * right to: a PostgreSQL error names tables, columns and constraints. But
 * "That is the only master account" is not a failure, it is the server
 * declining with a reason - and flattening it to "could not change that
 * role" would leave the Accounts screen saying something went wrong when
 * nothing did, and hide the one thing the master needs to know.
 *
 * The marker is a property on the error rather than a pattern fail()
 * matches, so a database message can never be mistaken for one of these.
 */
function said(message) {
  const err = new Error(message);
  err.said = true;
  return err;
}

/** The same message every caller gives for an ID that is not enrolled. */
function noSuchAccount(employeeId) {
  return said('No account for employee ID ' + employeeId + '.');
}


// ===========================================================================
// CHANGING THEM
// ===========================================================================

/**
 * Gives or takes away admin.
 *
 * MASTER can be granted here too, so a second master can be made without
 * anybody opening a terminal - but see the two guards, which are the whole
 * point of the function.
 *
 * @param {string} actor the signed-in master's employee ID, from the token
 */
async function setRole(actor, employeeId, role) {
  const id = String(employeeId || '').trim();
  const want = String(role || '').toUpperCase();

  if (!isRealRole(want)) throw said('Unknown role: ' + role);

  const account = await accountOf(id);
  if (!account) throw noSuchAccount(employeeId);

  /*
    STANDING ON THE BRANCH YOU ARE SAWING. Demoting yourself is allowed only
    while somebody else can still do this job.
  */
  if (id === actor && rankOf(want) < ROLE_RANK.MASTER) {
    throw said('That would remove your own master access. Give it to ' +
               'somebody else first, then step down.');
  }
  if (account.role === 'MASTER' && want !== 'MASTER' &&
      (await countMasters()) <= 1) {
    throw said('That is the only master account. Make another one ' +
               'first, or the accounts become unmanageable from the ' +
               'dashboard.');
  }

  await db.query('UPDATE account SET role = $1 WHERE employee_id = $2',
                 [want, id]);
  await logAuth(id, 'ROLE', want, 'set by ' + actor);
  return { username: id, role: want };
}


/** Takes an account off altogether. */
async function removeAccount(actor, employeeId) {
  const id = String(employeeId || '').trim();

  const account = await accountOf(id);
  if (!account) throw noSuchAccount(employeeId);

  if (id === actor) {
    throw said('That is the account you are signed in with.');
  }
  if (account.role === 'MASTER' && (await countMasters()) <= 1) {
    throw said('That is the only master account.');
  }

  await db.query('DELETE FROM account WHERE employee_id = $1', [id]);
  /*
    WRITTEN AFTER THE DELETE, and the log has no foreign key to account for
    exactly this row - see the note in db/18-accounts.sql. A log that loses
    the record of a removal when the removal happens is not a log.
  */
  await logAuth(id, 'REMOVED', account.role, 'by ' + actor);
  return { username: id };
}


/**
 * A one-time password, for a reset or an invitation.
 *
 * THE ORIGINAL USES A CONSTANT and this does not, which is a deviation
 * worth being explicit about. Auth.gs resets everybody to RESET_PASSWORD -
 * the literal string 'easuser' - and that is safe there because signing in
 * with it is caught by mustChange and leads straight to the card that sets
 * a password of their own, so the constant is only ever good for the one
 * step between the reset and the choosing.
 *
 * In this port that enforcement is ported too, but a shared constant is
 * still a worse answer than it was: the API is a URL on the network rather
 * than a script behind a Google sign-in, and a known string that opens any
 * freshly-reset account is a door anybody can try. A random one costs
 * nothing - the master reads it off the screen and passes it on exactly as
 * before - and it is only good for one account and only until that person
 * chooses their own.
 *
 * No I, l, 1, O or 0, because this gets read aloud and written down.
 */
function oneTimePassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}


/**
 * Sets somebody a new password, for when they have forgotten theirs.
 *
 * The new password is returned ONCE, in the answer to this call, so it can
 * be read off the screen and passed on. It is not stored anywhere it can be
 * read back from, and reloading the Accounts screen will not show it again.
 */
async function resetPassword(actor, employeeId) {
  const id = String(employeeId || '').trim();

  const account = await accountOf(id);
  if (!account) throw noSuchAccount(employeeId);

  const password = oneTimePassword();
  await db.query(
    `UPDATE account
        SET password_hash = $1, password_set = now(), must_change = true
      WHERE employee_id = $2`,
    [hashPassword(password), id]);

  await logAuth(id, 'RESET', account.role, 'by ' + actor);
  return { username: id, password: password };
}


/**
 * Gives an employee ID a role, whether or not that person has signed up yet.
 *
 * This is the shape the request actually takes: somebody's manager asks for
 * them to be made an admin, and what is to hand is an employee ID, not an
 * account. If the account exists its role changes. If it does not, the ID is
 * written down with that role and a one-time password, so the first thing
 * its owner does is set a password of their own - and they arrive already an
 * admin.
 *
 * THE ONE THING THIS CANNOT DO that Auth.gs can: write down an employee ID
 * that is not on the roster. account.employee_id is a foreign key to
 * team.employee_id, and PORT-INVENTORY records the consequence as a
 * deliberate simplification - "somebody with no employee ID can no longer
 * have a login at all". The failure is caught here so it reads as the fact
 * it is rather than as a constraint violation.
 */
async function grantToEmployeeId(actor, employeeId, role) {
  const id = String(employeeId || '').trim();
  const want = String(role || '').toUpperCase();

  if (!/^[0-9]+$/.test(id)) {
    throw said('An employee ID is digits only.');
  }
  if (id.length < EMP_ID_MIN || id.length > EMP_ID_MAX) {
    throw said('That employee ID should be between ' + EMP_ID_MIN +
               ' and ' + EMP_ID_MAX + ' digits.');
  }
  if (!isRealRole(want)) throw said('Unknown role: ' + role);

  if (await accountOf(id)) {
    const out = await setRole(actor, id, want);
    return { username: out.username, role: out.role, invited: false };
  }

  const onRoster = await db.query(
    'SELECT 1 FROM team WHERE employee_id = $1', [id]);
  if (!onRoster.length) {
    throw said('Employee ID ' + id + ' is not on the roster, so there ' +
               'is nobody to give access to. Add them to the team ' +
               'first, then come back.');
  }

  const password = oneTimePassword();
  await db.query(
    `INSERT INTO account (employee_id, password_hash, role, must_change, note)
     VALUES ($1, $2, $3, true, $4)`,
    [id, hashPassword(password), want,
     'added by ' + actor + ' before they signed in']);

  await logAuth(id, 'INVITED', want, 'by ' + actor);
  return { username: id, role: want, invited: true, password: password };
}


/**
 * The master correcting a name, or setting where somebody's alerts go.
 *
 * MASTER, NOT ADMIN. An admin who could edit the email column could point a
 * colleague's notifications somewhere else, and the Accounts screen is
 * master-only for exactly this family of reasons.
 *
 * Either field may be left out - passing null or undefined leaves that one
 * alone, so setting an email does not blank a name. Passing an empty string
 * clears it on purpose, which is how a wrong address is removed.
 */
async function setDetails(actor, employeeId, fullName, email) {
  const id = String(employeeId || '').trim();

  const account = await accountOf(id);
  if (!account) throw noSuchAccount(employeeId);

  const sets = [];
  const args = [];

  if (fullName !== undefined && fullName !== null) {
    args.push(cleanName(fullName));
    sets.push('full_name = $' + args.length);
  }

  if (email !== undefined && email !== null) {
    const address = String(email).trim();
    if (address && !EMAIL.test(address)) {
      throw said('That does not look like an email address: ' + address);
    }
    args.push(address);
    sets.push('email = $' + args.length);
  }

  /*
    NOTHING TO SET IS NOT AN ERROR, and it must not become an UPDATE with an
    empty SET clause - which is a syntax error, not a no-op. The screen sends
    one field at a time, so this is the path taken by anything else.
  */
  if (sets.length) {
    args.push(id);
    await db.query('UPDATE account SET ' + sets.join(', ') +
                   ' WHERE employee_id = $' + args.length, args);
    await logAuth(id, 'DETAILS', account.role, 'by ' + actor);
  }

  const now = await accountOf(id);
  return {
    username: id,
    fullName: now.full_name || '',
    email: now.email || '',
    alerted: rankOf(now.role) >= ROLE_RANK.ADMIN && Boolean(now.email)
  };
}


// ===========================================================================
// WHAT THE SIGN-IN PATH NEEDS
// ===========================================================================

/**
 * Whether this person is still on a password somebody else chose.
 *
 * READ FROM THE DATABASE, NEVER FROM THE TOKEN, and that is the whole
 * reason it is a function rather than a claim. A token is a snapshot signed
 * for eight hours; must_change is cleared the moment they choose their own
 * password, and a token issued before that would go on saying they had not
 * for the rest of the day. The card would keep reappearing on a password
 * they had already set.
 *
 * Unknown reads as false: an account that has gone is not an account that
 * must change its password, and a boot call is not worth failing over this.
 */
async function mustChangeFor(employeeId) {
  try {
    const rows = await db.query(
      'SELECT must_change FROM account WHERE employee_id = $1', [employeeId]);
    return rows.length ? Boolean(rows[0].must_change) : false;
  } catch (e) {
    console.error('[accounts] could not read must_change: ' + e.message);
    return false;
  }
}


/**
 * Records a successful sign-in: the clock, the counter and the log row.
 *
 * ONE STATEMENT FOR THE TWO COLUMNS. last_login_at and sign_ins answer
 * different questions - when, and how often - and an account that got one
 * without the other would be an account whose history quietly disagreed
 * with itself.
 */
async function noteSignIn(employeeId, role) {
  await db.query(
    `UPDATE account
        SET last_login_at = now(), sign_ins = sign_ins + 1
      WHERE employee_id = $1`, [employeeId]);
  await logAuth(employeeId, 'SIGNIN', role, '');
}


/**
 * Somebody changing their own password.
 *
 * Ported from changeMyPassword in Auth.gs. THEIR OWN AND NOBODY ELSE'S: the
 * employee ID comes from the signed token and never from the request body,
 * so this cannot be pointed at a colleague.
 *
 * The current password is required even when must_change is set. Auth.gs
 * asks for it too, and the reason is the one that matters here: after a
 * reset, the current password is the one-time password, and requiring it
 * proves that whoever is typing is the person the master actually handed it
 * to - rather than somebody who walked up to an unlocked screen.
 */
async function changeMyPassword(employeeId, current, next, confirm) {
  const { verifyPassword } = require('./password');

  const rows = await db.query(
    'SELECT password_hash, role FROM account WHERE employee_id = $1',
    [employeeId]);
  if (!rows.length) throw noSuchAccount(employeeId);

  if (!verifyPassword(String(current || ''), rows[0].password_hash)) {
    throw said('That is not your current password.');
  }

  const want = String(next || '');
  if (want.length < MIN_PASSWORD) {
    throw said('A password needs at least ' + MIN_PASSWORD +
               ' characters.');
  }
  if (want !== String(confirm || '')) {
    throw said('The two new passwords are not the same.');
  }
  if (want === String(current || '')) {
    throw said('That is the password you already have.');
  }

  await db.query(
    `UPDATE account
        SET password_hash = $1, password_set = now(), must_change = false
      WHERE employee_id = $2`, [hashPassword(want), employeeId]);

  await logAuth(employeeId, 'PASSWORD', rows[0].role,
                'changed by the account holder');
  return { username: employeeId };
}


module.exports = {
  logAuth, pruneAuthLog, auditLog,
  listAccounts, alertEmails, countMasters,
  setRole, removeAccount, resetPassword, grantToEmployeeId, setDetails,
  noteSignIn, changeMyPassword, mustChangeFor,
  oneTimePassword, cleanName, isRealRole, said,
  AUTH_LOG_DAYS, EMP_ID_MIN, EMP_ID_MAX, MIN_PASSWORD
};
