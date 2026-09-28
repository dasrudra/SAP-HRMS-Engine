/**
 * Auth.gs — who is using the app, and what they are allowed to do.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 * There are two boundaries here, and confusing them is the one way to get
 * this badly wrong.
 *
 *   1. WHO CAN REACH THE APP AT ALL is decided by the deployment's "Who has
 *      access" setting, which is Google's own sign-in. That is the real
 *      security perimeter, and it is strong. Nothing in this file adds to it.
 *
 *   2. WHAT THEY CAN DO ONCE INSIDE is decided here. This is a ROLE GATE,
 *      not a secret store. A password shared with thirty-seven people is a
 *      password everyone has by the end of the month — that is not cynicism,
 *      it is arithmetic. So this file must never be the only thing standing
 *      between an outsider and the data. Keep the deployment restricted to
 *      the company domain and this does the job it is meant for: stopping an
 *      ordinary user from deleting an upload by accident or on a whim.
 *
 * THE RULE THAT MATTERS
 * In an Apps Script web app EVERY GLOBAL FUNCTION IS AN ENDPOINT. Anyone who
 * can open the page can type
 *
 *     google.script.run.clearAllTickets()
 *
 * into the browser console. Hiding a button changes nothing. That is why the
 * checks live in the server functions and not only in the interface — the
 * interface hiding is a courtesy, these guards are the control.
 *
 * WHERE THE PASSWORDS LIVE
 * In Script Properties, salted and hashed, never in this file. The repository
 * is public; code belongs in it and credentials do not.
 */


/**
 * Is this request coming through the /dev URL?
 *
 * /dev is already locked down by Google to people with EDIT ACCESS to the
 * script project — you cannot open it otherwise. That is a stronger control
 * than any password here, so asking a developer to sign in on top of it adds
 * nothing and gets in the way. /dev is always admin.
 *
 * /exec is the opposite: it is the link the whole team uses, and that is
 * where the two roles matter.
 *
 * FAILS CLOSED. If the URL cannot be read for any reason we treat it as
 * production and ask for the login, because the failure that costs something
 * is handing out admin by accident — not making a developer type a password.
 */
function isDevUrl() {
  try {
    return /\/dev\/?$/.test(ScriptApp.getService().getUrl() || '');
  } catch (e) {
    return false;
  }
}


/** Roles, in increasing order of what they may do. */
const ROLE_USER  = 'USER';
const ROLE_ADMIN = 'ADMIN';

/** Script Property holding every account, as JSON. */
const ACCOUNTS_KEY = 'EAS_ACCOUNTS';

/** Script Property holding the one Google account allowed to run maintenance. */
const OWNER_KEY = 'EAS_OWNER_EMAIL';

/** User Property holding this person's signed-in session. */
const SESSION_KEY = 'EAS_SESSION';

/** How long a sign-in lasts before it has to be done again. */
const SESSION_HOURS = 12;

/**
 * How many times the hash is folded over itself.
 *
 * SHA-256 on its own is fast, which is exactly wrong for a password — fast is
 * what a brute-force attack wants. Repeating it makes each guess cost more.
 * This is NOT bcrypt or PBKDF2, which is what a real credential store would
 * use; Apps Script has neither. It is enough for an internal role gate behind
 * Google sign-in, and it would not be enough for anything facing the public.
 */
const HASH_ROUNDS = 600;

/** Wrong attempts allowed before that account is held off for a while. */
const MAX_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;


// ---------------------------------------------------------------------------
// SETUP — run these by hand from the editor
// ---------------------------------------------------------------------------

/**
 * Creates the two starting accounts. Run once, from the Apps Script editor.
 *
 * Safe to run again: it replaces whatever is there, which is also how you
 * reset a forgotten password.
 */
function seedCredentials() {
  setAccount('admin', 'easadmin', ROLE_ADMIN);
  setAccount('user',  'easuser',  ROLE_USER);

  const owner = Session.getEffectiveUser().getEmail();
  if (owner) {
    PropertiesService.getScriptProperties().setProperty(OWNER_KEY, owner);
  }

  Logger.log('');
  Logger.log('=========================================================');
  Logger.log(' ACCOUNTS CREATED');
  Logger.log('   admin / easadmin    full access');
  Logger.log('   user  / easuser     read only');
  Logger.log('   maintenance owner:  %s', owner || '(could not read — set it by hand)');
  Logger.log('=========================================================');
  Logger.log('');
  Logger.log('The passwords are stored hashed. This log line is the only place');
  Logger.log('they appear in plain text — it disappears when you close the editor.');
}


/**
 * Adds or replaces one account.
 *
 * This is how the individual logins get created later: call it once per
 * person. No code change is needed for that — the accounts live in Script
 * Properties, not in this file.
 *
 * @param {string} username
 * @param {string} password
 * @param {string} role  ROLE_ADMIN or ROLE_USER
 */
function setAccount(username, password, role) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new Error('A username is required.');
  if (!password) throw new Error('A password is required.');
  if (role !== ROLE_ADMIN && role !== ROLE_USER) {
    throw new Error('Role must be ' + ROLE_ADMIN + ' or ' + ROLE_USER + '.');
  }

  const accounts = readAccounts();
  const salt = Utilities.getUuid();

  accounts[name] = { role: role, salt: salt, hash: hashOf(password, salt) };
  writeAccounts(accounts);

  Logger.log('Account "%s" saved with role %s.', name, role);
}


/** Removes an account. The last admin cannot be removed. */
function removeAccount(username) {
  const name = String(username || '').trim().toLowerCase();
  const accounts = readAccounts();
  if (!accounts[name]) {
    Logger.log('No account called "%s".', name);
    return;
  }

  const adminsLeft = Object.keys(accounts).filter(function (k) {
    return k !== name && accounts[k].role === ROLE_ADMIN;
  }).length;
  if (accounts[name].role === ROLE_ADMIN && adminsLeft === 0) {
    throw new Error('That is the only admin account — removing it would lock ' +
                    'everyone out of uploads and deletes. Create another admin first.');
  }

  delete accounts[name];
  writeAccounts(accounts);
  Logger.log('Account "%s" removed.', name);
}


/** Lists the accounts. Names and roles only — never the hashes. */
function listAccounts() {
  const accounts = readAccounts();
  Object.keys(accounts).sort().forEach(function (name) {
    Logger.log('  %-20s %s', name, accounts[name].role);
  });
  if (!Object.keys(accounts).length) {
    Logger.log('No accounts yet. Run seedCredentials().');
  }
}


// ---------------------------------------------------------------------------
// THE THREE FUNCTIONS THE BROWSER CALLS
// ---------------------------------------------------------------------------

/**
 * Signs in. Deliberately NOT guarded — it is how you get past the guard.
 *
 * @return {{ok: boolean, role: string, username: string, message: string}}
 */
function login(username, password) {
  const name = String(username || '').trim().toLowerCase();

  const held = lockoutRemaining(name);
  if (held > 0) {
    return { ok: false, role: '', username: '',
             message: 'Too many wrong attempts. Try again in ' + held +
                      ' minute' + (held === 1 ? '' : 's') + '.' };
  }

  const account = readAccounts()[name];

  // The same message whether the username is wrong or the password is: a
  // different one tells anyone probing which usernames exist.
  const wrong = { ok: false, role: '', username: '',
                  message: 'That username and password do not match.' };

  if (!account) { recordFailure(name); return wrong; }
  if (hashOf(String(password || ''), account.salt) !== account.hash) {
    recordFailure(name);
    return wrong;
  }

  clearFailures(name);
  PropertiesService.getUserProperties().setProperty(SESSION_KEY, JSON.stringify({
    u: name, r: account.role, at: Date.now()
  }));

  return { ok: true, role: account.role, username: name, message: '' };
}


/** Signs out. */
function logout() {
  PropertiesService.getUserProperties().deleteProperty(SESSION_KEY);
  return { ok: true };
}


/**
 * Who is signed in, if anyone. Also NOT guarded — the page calls it first,
 * before it knows whether to show the app or the login card.
 *
 * @return {{signedIn: boolean, role: string, username: string}}
 */
function getSession() {
  const session = currentSession();
  return session
    ? { signedIn: true, role: session.r, username: session.u,
        mode: session.dev ? 'DEV' : 'EXEC' }
    : { signedIn: false, role: '', username: '', mode: 'EXEC' };
}


// ---------------------------------------------------------------------------
// THE GUARDS — called at the top of every function that matters
// ---------------------------------------------------------------------------

/**
 * Throws unless somebody is signed in.
 *
 * The message is written for the person who will see it in a dialog, not for
 * a log file: it says what to do, not what went wrong.
 */
function requireSignedIn() {
  if (!currentSession()) {
    throw new Error('Your session has ended. Reload the page and sign in again.');
  }
}


/** Throws unless the person signed in is an admin. */
function requireAdmin() {
  const session = currentSession();
  if (!session) {
    throw new Error('Your session has ended. Reload the page and sign in again.');
  }
  if (session.r !== ROLE_ADMIN) {
    throw new Error('That action needs the admin login. You are signed in as a ' +
                    'viewer, which can read everything but cannot upload, delete ' +
                    'or rebuild.');
  }
}


/**
 * Throws unless the Google account running this owns the app.
 *
 * For the maintenance functions that are run from the EDITOR rather than the
 * browser — setup, compaction, wiping the tickets. They have no web session
 * to check, and they are the most destructive things in the project, so they
 * are tied to one Google account instead.
 *
 * Fails closed: if the email cannot be read, nobody gets through.
 */
function requireOwner() {
  const owner = PropertiesService.getScriptProperties().getProperty(OWNER_KEY);
  if (!owner) {
    throw new Error('No maintenance owner is set. Run seedCredentials() from ' +
                    'the editor first.');
  }

  let who = '';
  try { who = Session.getActiveUser().getEmail() || ''; } catch (e) { who = ''; }

  if (!who || who.toLowerCase() !== owner.toLowerCase()) {
    throw new Error('This function can only be run by the account that owns ' +
                    'the app. It is not available from the dashboard.');
  }
}


/** The signed-in role, or '' — for code that wants to branch, not throw. */
function currentRole() {
  const session = currentSession();
  return session ? session.r : '';
}


// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/**
 * The live session, or null.
 *
 * Sessions expire. Without that, signing in once on a shared machine leaves
 * an admin session sitting there for anyone who opens the browser next.
 */
function currentSession() {
  // On /dev, everyone is an admin and nobody signs in. Deciding it here means
  // requireSignedIn() and requireAdmin() both follow automatically — there is
  // no second copy of this rule to forget about.
  if (isDevUrl()) {
    return { u: 'developer', r: ROLE_ADMIN, at: Date.now(), dev: true };
  }

  const raw = PropertiesService.getUserProperties().getProperty(SESSION_KEY);
  if (!raw) return null;

  let session;
  try { session = JSON.parse(raw); } catch (e) { return null; }
  if (!session || !session.r) return null;

  const ageHours = (Date.now() - (session.at || 0)) / 3600000;
  if (ageHours > SESSION_HOURS) {
    PropertiesService.getUserProperties().deleteProperty(SESSION_KEY);
    return null;
  }

  return session;
}


function readAccounts() {
  const raw = PropertiesService.getScriptProperties().getProperty(ACCOUNTS_KEY);
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}


function writeAccounts(accounts) {
  PropertiesService.getScriptProperties()
    .setProperty(ACCOUNTS_KEY, JSON.stringify(accounts));
}


/**
 * Salted, repeated SHA-256.
 *
 * The salt is per account, so two people choosing the same password do not
 * end up with the same hash — which is what makes a stolen properties dump
 * worth less than it looks.
 */
function hashOf(password, salt) {
  let digest = String(salt) + '\u0000' + String(password);
  for (let i = 0; i < HASH_ROUNDS; i++) {
    digest = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, digest));
  }
  return digest;
}


/**
 * Wrong-attempt tracking, per Google account rather than per username.
 *
 * Per username would let anyone lock out the whole team by guessing "admin"
 * wrongly eight times. Per Google account, a person can only lock out
 * themselves, which is the behaviour you want.
 */
function attemptKey(name) {
  return 'EAS_FAILED_' + name;
}


function recordFailure(name) {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty(attemptKey(name));
  let record = { n: 0, at: 0 };
  if (raw) { try { record = JSON.parse(raw); } catch (e) { /* start over */ } }

  record.n = (record.n || 0) + 1;
  record.at = Date.now();
  props.setProperty(attemptKey(name), JSON.stringify(record));
}


function clearFailures(name) {
  PropertiesService.getUserProperties().deleteProperty(attemptKey(name));
}


/** Minutes still to wait, or 0. */
function lockoutRemaining(name) {
  const raw = PropertiesService.getUserProperties().getProperty(attemptKey(name));
  if (!raw) return 0;

  let record;
  try { record = JSON.parse(raw); } catch (e) { return 0; }
  if (!record || (record.n || 0) < MAX_ATTEMPTS) return 0;

  const waitedMin = (Date.now() - (record.at || 0)) / 60000;
  if (waitedMin >= LOCKOUT_MINUTES) {
    clearFailures(name);
    return 0;
  }
  return Math.ceil(LOCKOUT_MINUTES - waitedMin);
}
