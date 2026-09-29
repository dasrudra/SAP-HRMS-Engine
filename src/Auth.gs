/**
 * Auth.gs - who is using the app, and what they are allowed to do.
 *
 * THIS FILE IS DELIBERATELY PLAIN ASCII. No em-dashes, no arrows, no curly
 * quotes. Pasting a .gs file through Notepad has already corrupted one of
 * these files once: Windows saved the em-dash on line 2 of Code.gs as a byte
 * Apps Script could not read, and the whole project stopped compiling with
 * "Invalid or unexpected token". Comments are not worth that, so the whole
 * project is now ASCII and cannot break that way again.
 *
 *
 * HOW SIGNING IN WORKS, AND WHY IT WORKS THIS WAY
 *
 * The dashboard is published to "Anyone", because not everyone at Youngone
 * has a Google account and they still have to be able to open the link. That
 * single fact decides the whole design, because it rules out the two places
 * Apps Script would normally keep a session:
 *
 *   - PropertiesService.getUserProperties() keeps one store per person, but
 *     only while Google knows who the person IS. Published to "Anyone" there
 *     is nobody to know, so every visitor shares one store. An earlier build
 *     kept the session there, which meant one person signing in as admin
 *     would have made every other visitor an admin. That is the bug this
 *     file was rewritten to remove, not a theoretical one.
 *
 *   - Browser storage inside the page is no better. An Apps Script web app
 *     runs in a sandboxed iframe served from a googleusercontent.com address
 *     that is regenerated on each load, so localStorage written on one load
 *     usually cannot be read on the next.
 *
 * So the session is not stored on the server at all. Signing in returns a
 * SIGNED TOKEN, the browser hands it back on every call, and the server
 * checks the signature. Nothing is remembered between calls, which is exactly
 * why it is safe for anonymous visitors: there is no shared store to leak
 * through, and two people holding two tokens are simply two different people.
 *
 *   token = payload . signature
 *   payload   = base64({ u: username, r: role, x: expiry })
 *   signature = HMAC-SHA256(payload, secret held in Script Properties)
 *
 * The signature is what makes it safe to let the browser hold it. Changing
 * the role from USER to ADMIN, or pushing the expiry out, changes the
 * payload, and the signature then does not match. Forging one needs the
 * secret, which never leaves Script Properties and is never sent to a
 * browser.
 *
 *
 * WHAT THIS IS NOT
 * It is a ROLE GATE, not a secret store. A password shared with thirty-seven
 * people is a password everyone has by the end of the month - that is not
 * cynicism, it is arithmetic. It stops an ordinary user uploading or deleting.
 * It is not a wall against a determined outsider, and the data behind it
 * should be treated as readable by anyone who is given the link and the
 * viewer password.
 *
 *
 * THE RULE THAT MATTERS
 * In an Apps Script web app EVERY GLOBAL FUNCTION IS AN ENDPOINT. Anyone who
 * can open the page can type
 *
 *     google.script.run.deleteUpload('anything')
 *
 * into the browser console. Hiding a button changes nothing. That is why
 * every endpoint takes the token as its first argument and checks it before
 * doing anything - the interface hiding is a courtesy, these guards are the
 * control.
 */


/** Roles, in increasing order of what they may do. */
const ROLE_USER  = 'USER';
const ROLE_ADMIN = 'ADMIN';

/** Script Property holding every account, as JSON. */
const ACCOUNTS_KEY = 'EAS_ACCOUNTS';

/** Script Property holding the one Google account allowed to run maintenance. */
const OWNER_KEY = 'EAS_OWNER_EMAIL';

/** Script Property holding the key every token is signed with. */
const TOKEN_SECRET_KEY = 'EAS_TOKEN_SECRET';

/**
 * How long a sign-in lasts.
 *
 * Two hours, as asked for. What that means in practice, and why:
 *
 *   refresh the page            stays signed in - the token travels in the
 *                               address bar, so a reload carries it back
 *   close the tab and reopen    signs in again - the fresh link has no token
 *                               on it
 *   two hours after signing in  signs in again - the expiry is inside the
 *                               signed payload, so it cannot be edited
 *
 * Changing this number changes only NEW sign-ins. Tokens already issued keep
 * the expiry they were stamped with.
 */
const SESSION_HOURS = 2;

/**
 * How many times the password hash is folded over itself.
 *
 * SHA-256 on its own is fast, which is exactly wrong for a password - fast is
 * what a brute-force attack wants. Repeating it makes each guess cost more.
 * This is NOT bcrypt or PBKDF2, which is what a real credential store would
 * use; Apps Script has neither.
 */
const HASH_ROUNDS = 600;

/**
 * Wrong-guess throttle, per username, across everybody.
 *
 * It cannot be per person: anonymous visitors cannot be told apart, which is
 * the same fact the whole token design follows from. So this is deliberately
 * loose. Twenty tries per ten minutes stops somebody grinding through a
 * password list, while being far enough above normal mistyping that real
 * users do not trip it.
 *
 * The cost of it being global: one person guessing wrongly twenty times holds
 * that username off for everyone for ten minutes. That is a nuisance, not a
 * breach, and it is the lesser of the two risks.
 */
const MAX_ATTEMPTS = 20;
const LOCKOUT_MINUTES = 10;

/**
 * User Property that makes the sign-in appear for somebody who would
 * otherwise be let straight through. Set by opening the app with ?login=1.
 * Only ever relevant on /dev, where Google does know who the visitor is.
 */
const FORCE_LOGIN_KEY = 'EAS_FORCE_LOGIN';


// ---------------------------------------------------------------------------
// TOKENS
// ---------------------------------------------------------------------------

/**
 * The key every token is signed with.
 *
 * Created on first use and then left alone. It never leaves Script Properties
 * and is never sent to a browser - a token can be read by anyone holding it,
 * but only this script can make one.
 *
 * Replacing it invalidates every token in circulation at once, which is the
 * way to throw everybody out: delete EAS_TOKEN_SECRET from Project Settings.
 *
 * @return {string}
 */
function tokenSecret() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty(TOKEN_SECRET_KEY);
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty(TOKEN_SECRET_KEY, secret);
  }
  return secret;
}


/**
 * Makes a signed token for somebody who has just proved who they are.
 *
 * @param {string} username
 * @param {string} role
 * @return {string} payload.signature
 */
function issueToken(username, role) {
  const payload = {
    u: username,
    r: role,
    x: Date.now() + (SESSION_HOURS * 3600000)
  };
  const body = Utilities.base64EncodeWebSafe(
    Utilities.newBlob(JSON.stringify(payload)).getBytes());
  return body + '.' + signatureOf(body);
}


/** The signature half of a token. */
function signatureOf(body) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, tokenSecret()));
}


/**
 * Reads a token back, or returns null.
 *
 * Null for anything wrong at all: missing, malformed, signed with a different
 * key, tampered with, or expired. The caller never learns which, because
 * there is nothing useful a legitimate user could do with the distinction and
 * something useful an attacker could.
 *
 * @param {string} token
 * @return {Object|null} { u, r, x }
 */
function sessionFromToken(token) {
  const raw = String(token == null ? '' : token);
  const dot = raw.indexOf('.');
  if (dot < 1) return null;

  const body = raw.slice(0, dot);
  const given = raw.slice(dot + 1);

  // Signature first, before the payload is trusted enough to parse.
  if (!given || given !== signatureOf(body)) return null;

  let payload;
  try {
    payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString());
  } catch (e) {
    return null;
  }

  if (!payload || !payload.r || !payload.u) return null;
  if (payload.r !== ROLE_ADMIN && payload.r !== ROLE_USER) return null;
  if (!payload.x || Date.now() > payload.x) return null;

  return payload;
}


// ---------------------------------------------------------------------------
// THE /dev SHORTCUT
// ---------------------------------------------------------------------------

/**
 * Is this request running with a developer's own permissions?
 *
 * WHY THIS IS NOT A URL CHECK
 * It used to be ScriptApp.getService().getUrl() matched against /dev, and
 * that was wrong in a way that only showed up in production. That call
 * describes THE PROJECT - "this script's web app lives at such-and-such an
 * address" - not the request in front of you. It answers the same way however
 * the visitor arrived, and with two active deployments it answered "/dev" for
 * everyone. Every visitor to /exec was silently handed ADMIN.
 *
 * Apps Script offers no way to ask which URL a request came in on. So this
 * asks a question it CAN answer, and which is the one that actually matters:
 * is the script running as the person using it? On /dev it always is, and
 * only someone with EDIT ACCESS to the project can open /dev at all. On /exec
 * the app runs as its owner while the visitor is somebody else - and with the
 * deployment published to "Anyone" there is usually no visitor identity at
 * all, so this is simply false and the sign-in appears.
 *
 * FAILS CLOSED. Anything unreadable means production, and production means
 * sign in.
 */
function isDevContext() {
  let active = '';
  let effective = '';

  try {
    active = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (e) {
    return false;
  }
  if (!active) return false;

  try {
    effective = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  } catch (e) {
    return false;
  }

  return Boolean(effective) && active === effective;
}


/** Is this browser set to ask for the sign-in even where it need not? */
function forceLoginOn() {
  try {
    return PropertiesService.getUserProperties()
      .getProperty(FORCE_LOGIN_KEY) === '1';
  } catch (e) {
    return false;
  }
}


/**
 * Turns the sign-in on for a developer who would otherwise be let straight in.
 *
 * Called from doGet() when the URL carries ?login=1, and switched off again
 * with ?login=0. A real server-side switch, not a screen that merely looks
 * locked: while it is on, the developer genuinely holds whatever role they
 * signed in with, which is the only way to check what a viewer really sees.
 *
 * @param {boolean} on
 */
function setForceLogin(on) {
  const props = PropertiesService.getUserProperties();
  if (on) {
    props.setProperty(FORCE_LOGIN_KEY, '1');
  } else {
    props.deleteProperty(FORCE_LOGIN_KEY);
  }
  return { ok: true, forced: Boolean(on) };
}


// ---------------------------------------------------------------------------
// SETUP - run these by hand from the editor
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
  tokenSecret();   // make the signing key now rather than on the first login

  Logger.log('');
  Logger.log('=========================================================');
  Logger.log(' ACCOUNTS CREATED');
  Logger.log('   admin / easadmin    full access');
  Logger.log('   user  / easuser     read only');
  Logger.log('   maintenance owner:  %s', owner || '(could not read - set it by hand)');
  Logger.log('=========================================================');
  Logger.log('');
  Logger.log('The passwords are stored hashed. This log line is the only place');
  Logger.log('they appear in plain text - it disappears when you close the editor.');
}


/**
 * Adds or replaces one account.
 *
 * This is how the individual logins get created later: call it once per
 * person. No code change is needed for that - the accounts live in Script
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
    throw new Error('That is the only admin account - removing it would lock ' +
                    'everyone out of uploads and deletes. Create another admin first.');
  }

  delete accounts[name];
  writeAccounts(accounts);
  Logger.log('Account "%s" removed.', name);
}


/** Lists the accounts. Names and roles only - never the hashes. */
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
 * Signs in. Deliberately NOT guarded - it is how you get past the guard.
 *
 * @return {{ok: boolean, role: string, username: string, token: string,
 *           message: string}}
 */
function login(username, password) {
  const name = String(username || '').trim().toLowerCase();

  const held = lockoutRemaining(name);
  if (held > 0) {
    return { ok: false, role: '', username: '', token: '',
             message: 'Too many wrong attempts on this username. Try again in ' +
                      held + ' minute' + (held === 1 ? '' : 's') + '.' };
  }

  const account = readAccounts()[name];

  // The same message whether the username is wrong or the password is: a
  // different one tells anyone probing which usernames exist.
  const wrong = { ok: false, role: '', username: '', token: '',
                  message: 'That username and password do not match.' };

  if (!account) { recordFailure(name); return wrong; }
  if (hashOf(String(password || ''), account.salt) !== account.hash) {
    recordFailure(name);
    return wrong;
  }

  clearFailures(name);
  return {
    ok: true,
    role: account.role,
    username: name,
    token: issueToken(name, account.role),
    message: ''
  };
}


/**
 * Signs out.
 *
 * There is nothing to delete on the server - a token is not stored anywhere,
 * which is the point. The browser throws its copy away and the token then
 * dies of old age on its own. Kept as a real call so the page has one thing
 * to wait for, and so this stays the place to hook a revocation list if one
 * is ever needed.
 */
function logout() {
  return { ok: true };
}


/**
 * Who is signed in, if anyone. Also NOT guarded - the page calls it first,
 * before it knows whether to show the app or the sign-in card.
 *
 * @param {string} token  whatever the browser is holding, possibly nothing
 * @return {{signedIn: boolean, role: string, username: string, mode: string}}
 */
function getSession(token) {
  if (isDevContext() && !forceLoginOn()) {
    return { signedIn: true, role: ROLE_ADMIN, username: 'developer',
             mode: 'DEV' };
  }

  const session = sessionFromToken(token);
  return session
    ? { signedIn: true, role: session.r, username: session.u, mode: 'EXEC' }
    : { signedIn: false, role: '', username: '', mode: 'EXEC' };
}


// ---------------------------------------------------------------------------
// THE GUARDS - called at the top of every function that matters
// ---------------------------------------------------------------------------

/**
 * The live session behind a token, or null.
 *
 * One place where the /dev shortcut and the token are weighed against each
 * other, so requireSignedIn() and requireAdmin() cannot disagree about it.
 *
 * @param {string} token
 * @return {Object|null}
 */
function currentSession(token) {
  if (isDevContext() && !forceLoginOn()) {
    return { u: 'developer', r: ROLE_ADMIN, dev: true };
  }
  return sessionFromToken(token);
}


/**
 * Throws unless the token is good.
 *
 * The message is written for the person who will see it in a dialog, not for
 * a log file: it says what to do, not what went wrong. Both of the ways a
 * session ends - two hours passing, or the page being reopened without one -
 * land here, and "sign in again" is the answer to both.
 */
function requireSignedIn(token) {
  if (!currentSession(token)) {
    throw new Error('Your session has ended. Reload the page and sign in again.');
  }
}


/** Throws unless the token says ADMIN. */
function requireAdmin(token) {
  const session = currentSession(token);
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
 * browser - setup, compaction, wiping the tickets. They have no token to
 * check, and they are the most destructive things in the project, so they are
 * tied to one Google account instead. A token can never reach them, whatever
 * role it carries.
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


/** The role behind a token, or '' - for code that wants to branch, not throw. */
function currentRole(token) {
  const session = currentSession(token);
  return session ? session.r : '';
}


// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

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
 * end up with the same hash - which is what makes a stolen properties dump
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
 * Wrong-attempt tracking, in the script cache rather than in properties.
 *
 * The cache expires entries by itself, so a lockout lifts without anything
 * having to remember to clear it, and a burst of wrong guesses cannot leave
 * rubbish behind in Script Properties for good.
 */
function attemptKey(name) {
  return 'EAS_FAILED_' + name;
}


function recordFailure(name) {
  const cache = CacheService.getScriptCache();
  const raw = cache.get(attemptKey(name));

  let count = 0;
  if (raw) { count = parseInt(raw, 10) || 0; }
  count++;

  // Re-stamping the expiry on each failure is what makes the lockout a
  // rolling window: guessing again during it extends it rather than waiting
  // it out while still guessing.
  cache.put(attemptKey(name), String(count), LOCKOUT_MINUTES * 60);
}


function clearFailures(name) {
  CacheService.getScriptCache().remove(attemptKey(name));
}


/** Minutes still to wait, or 0. */
function lockoutRemaining(name) {
  const raw = CacheService.getScriptCache().get(attemptKey(name));
  if (!raw) return 0;

  const count = parseInt(raw, 10) || 0;
  if (count < MAX_ATTEMPTS) return 0;

  // The cache does not report how long is left on an entry, and the window is
  // re-stamped on every failure anyway, so the honest answer is the whole
  // window rather than a countdown that would be wrong.
  return LOCKOUT_MINUTES;
}
