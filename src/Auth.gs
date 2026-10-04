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


/**
 * Roles, in increasing order of what they may do.
 *
 *   USER    reads every screen, filters, compares, downloads reports
 *   ADMIN   all of that, plus upload, delete and rebuild
 *   MASTER  all of that, plus the accounts themselves: who exists, who is an
 *           admin, resetting a forgotten password, and the sign-in log
 *
 * Nested, not parallel: a MASTER passes every ADMIN guard, so no endpoint has
 * to list two roles and none can be left listing one.
 */
const ROLE_USER   = 'USER';
const ROLE_ADMIN  = 'ADMIN';
const ROLE_MASTER = 'MASTER';

/** Highest first, so rank comparisons read the way the words do. */
const ROLE_RANK = { USER: 1, ADMIN: 2, MASTER: 3 };

function rankOf(role) {
  return ROLE_RANK[String(role || '').toUpperCase()] || 0;
}

/** Is this a real role a token may carry? SETUP deliberately is not. */
function isRealRole(role) {
  return rankOf(role) > 0;
}


/**
 * The shared credential everybody starts with.
 *
 * It is not an account. Signing in with it proves only that you were given
 * the link and the starting password - it gets you to the "create your
 * account" card and nowhere else. The dashboard itself is never reachable
 * with it, which is the whole reason it can stay a shared secret.
 */
const BOOTSTRAP_USER = 'user';

/** How long the create-your-account card has before it has to be re-earned. */
const SETUP_MINUTES = 20;

/** What an employee ID has to look like. Digits, because that is what they are. */
const EMP_ID_MIN = 4;
const EMP_ID_MAX = 12;

/** The shortest password that will be accepted. */
const MIN_PASSWORD = 6;

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
 * @param {boolean} [dev]  marks the developer shortcut, so the badge can say
 *                         DEV and nobody mistakes it for an ordinary sign-in
 * @return {string} payload.signature
 */
function issueToken(username, role, dev) {
  const payload = {
    u: username,
    r: role,
    x: Date.now() + (SESSION_HOURS * 3600000)
  };
  if (dev) payload.d = 1;
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
  // A setup token carries s:1 and the role of nobody. It is checked by
  // setupFromToken() and must never be mistaken for a session - otherwise the
  // shared bootstrap password would be a way into the dashboard rather than
  // only into the card that creates an account.
  if (payload.s) return null;
  if (!isRealRole(payload.r)) return null;
  if (!payload.x || Date.now() > payload.x) return null;

  return payload;
}


/**
 * Reads back a SETUP token - the short-lived one handed out when somebody
 * signs in with the shared starting password.
 *
 * Deliberately a separate function from sessionFromToken rather than a flag
 * on it. These two tokens are allowed to do completely different things, and
 * the one place that could confuse them is a single function that returns
 * both.
 */
function setupFromToken(token) {
  const raw = String(token == null ? '' : token);
  const dot = raw.indexOf('.');
  if (dot < 1) return null;

  const body = raw.slice(0, dot);
  const given = raw.slice(dot + 1);
  if (!given || given !== signatureOf(body)) return null;

  let payload;
  try {
    payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(body)).getDataAsString());
  } catch (e) {
    return null;
  }

  if (!payload || !payload.s) return null;
  if (!payload.x || Date.now() > payload.x) return null;
  return payload;
}


/** The short-lived token that only opens the create-your-account card. */
function issueSetupToken() {
  const payload = { u: BOOTSTRAP_USER, s: 1,
                    x: Date.now() + (SETUP_MINUTES * 60000) };
  const body = Utilities.base64EncodeWebSafe(
    Utilities.newBlob(JSON.stringify(payload)).getBytes());
  return body + '.' + signatureOf(body);
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


/**
 * The developer shortcut: a token handed out instead of a password, but ONLY
 * when it is deliberately asked for.
 *
 * NOTHING IS AUTOMATIC HERE, AND THAT IS THE WHOLE POINT.
 * An earlier build let isDevContext() waive the sign-in on its own. That was
 * wrong, and wrong in a way that was invisible: opening the ordinary /exec
 * link while signed in to the owning Google account went straight into the
 * dashboard as DEV / ADMIN with no sign-in at all - because Apps Script
 * cannot tell the owner on /exec apart from a developer on /dev, and the code
 * guessed rather than asking.
 *
 * So it no longer guesses. Every plain visit to every URL asks for the
 * sign-in. This hands out a token only when BOTH hold:
 *
 *   1. the address explicitly says ?admin=1, so it can never happen by
 *      simply opening a link, and
 *   2. isDevContext() - the script is running as the person using it, which
 *      is true on /dev and for the owner, and false for everybody else.
 *
 * Condition 2 is what makes condition 1 safe to expose: a visitor who adds
 * ?admin=1 to the /exec link gets nothing, because the app is not running as
 * them. Condition 1 is what makes condition 2 acceptable: it can only happen
 * on purpose.
 *
 * @param {Object} params  e.parameter from doGet
 * @return {string} a token, or '' for everybody else
 */
function devTokenIfAllowed(params) {
  const asked = params && params.admin === '1';
  if (!asked) return '';
  if (!isDevContext()) return '';
  // MASTER, not ADMIN. This is the ONLY route back in if the master password
  // is forgotten, and it is the one route that cannot be taken from the
  // public link - so it has to be able to reset that password.
  return issueToken('developer', ROLE_MASTER, true);
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
  // Only the shared starting credential. There is deliberately no shared
  // 'admin' account any more: admin is something granted to one employee ID
  // by the master, and a password thirty-seven people know is the opposite of
  // that. If an old one is still on the ACCOUNTS tab from before this change,
  // remove it from the Accounts screen - it will be sitting there in the list.
  setAccount(BOOTSTRAP_USER, 'easuser', ROLE_USER);

  const owner = Session.getEffectiveUser().getEmail();
  if (owner) {
    PropertiesService.getScriptProperties().setProperty(OWNER_KEY, owner);
  }
  tokenSecret();   // make the signing key now rather than on the first login

  Logger.log('');
  Logger.log('=========================================================');
  Logger.log(' STARTING CREDENTIAL CREATED');
  Logger.log('   user / easuser');
  Logger.log('');
  Logger.log(' This does NOT open the dashboard. It opens the card that');
  Logger.log(' creates an account, where each person sets their own employee');
  Logger.log(' ID and password. Give it to the team; it is meant to be shared.');
  Logger.log('');
  Logger.log('   maintenance owner:  %s', owner || '(could not read - set it by hand)');
  Logger.log('=========================================================');
  Logger.log('');
  Logger.log('NEXT: sign in with it yourself, create your own account, then run');
  Logger.log('grantMaster() with your employee ID to get the Accounts screen.');
}


/**
 * Makes one employee ID the master account. RUN THIS ONCE, from the editor.
 *
 * Edit the ID on the line below to your own, press Run, and that account can
 * then manage every other one from the dashboard. It has to be done from the
 * editor rather than from a screen, because at the point it is needed there is
 * no master yet to ask - and anything that could create the first master from
 * the browser would be a way for anybody to create one.
 *
 * The account has to exist first: sign in with the shared starting password,
 * create your account with your employee ID, then run this.
 */
function grantMaster(employeeId) {
  const id = String(employeeId || '20536723').trim().toLowerCase();

  const accounts = readAccounts();
  const account = accounts[id];
  if (!account) {
    throw new Error('No account for ' + id + ' yet. Sign in with the starting ' +
                    'password, create your account with that employee ID, then ' +
                    'run this again.');
  }

  account.role = ROLE_MASTER;
  saveAccount(id, account);
  logAuth(id, 'ROLE', ROLE_MASTER, 'granted from the editor');

  Logger.log('');
  Logger.log('=========================================================');
  Logger.log(' %s is now MASTER.', id);
  Logger.log(' Sign in with that employee ID and the Accounts screen appears.');
  Logger.log('=========================================================');
}


/**
 * Adds or replaces one account.
 *
 * This is how the individual logins get created later: call it once per
 * person. No code change is needed for that - the accounts live on the
 * ACCOUNTS tab, not in this file.
 *
 * @param {string} username
 * @param {string} password
 * @param {string} role  ROLE_ADMIN, ROLE_USER or ROLE_MASTER
 */
function setAccount(username, password, role) {
  const name = String(username || '').trim().toLowerCase();
  if (!name) throw new Error('A username is required.');
  if (!password) throw new Error('A password is required.');
  if (!isRealRole(role)) {
    throw new Error('Role must be ' + ROLE_USER + ', ' + ROLE_ADMIN +
                    ' or ' + ROLE_MASTER + '.');
  }

  const existing = readAccounts()[name];
  const now = new Date().toISOString();
  const salt = Utilities.getUuid();

  saveAccount(name, {
    role: role, salt: salt, hash: hashOf(password, salt),
    created: (existing && existing.created) || now,
    passwordSet: now,
    lastSignIn: (existing && existing.lastSignIn) || '',
    signIns: (existing && existing.signIns) || 0,
    note: (existing && existing.note) || ''
  });

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

  deleteAccountRow(name);
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

  // The shared starting credential is not a way in. It is a way to the card
  // that creates an account, and nothing else - see BOOTSTRAP_USER.
  if (name === BOOTSTRAP_USER) {
    return { ok: true, setup: true, role: '', username: '', token: '',
             setupToken: issueSetupToken(), message: '' };
  }

  recordSignIn(name);
  logAuth(name, 'SIGNIN', account.role, '');

  return {
    ok: true,
    setup: false,
    role: account.role,
    username: name,
    token: issueToken(name, account.role),
    message: ''
  };
}


/**
 * Creates somebody's own account, from the card the shared password leads to.
 *
 * NOT guarded by a session token, because the person doing it has no session
 * yet - that is the whole point. It is guarded by the SETUP token, which
 * cannot be minted without the shared password and expires in twenty minutes.
 *
 * @param {string} setupToken  from login() with the shared credential
 * @param {string} employeeId  theirs, digits only
 * @param {string} password    at least MIN_PASSWORD characters
 * @param {string} confirm     typed again
 */
function registerAccount(setupToken, employeeId, password, confirm) {
  const fail = function (message) {
    return { ok: false, role: '', username: '', token: '', message: message };
  };

  if (!setupFromToken(setupToken)) {
    return fail('This page has been open too long. Sign in again with the ' +
                'starting password and set your details straight away.');
  }

  const id = String(employeeId == null ? '' : employeeId).trim();
  if (!/^[0-9]+$/.test(id)) {
    return fail('An employee ID is digits only - the number on your ID card, ' +
                'with nothing else in it.');
  }
  if (id.length < EMP_ID_MIN || id.length > EMP_ID_MAX) {
    return fail('That employee ID does not look right. It should be between ' +
                EMP_ID_MIN + ' and ' + EMP_ID_MAX + ' digits.');
  }

  const pass = String(password == null ? '' : password);
  if (pass.length < MIN_PASSWORD) {
    return fail('Choose a password of at least ' + MIN_PASSWORD +
                ' characters. It can be anything you will remember.');
  }
  if (pass !== String(confirm == null ? '' : confirm)) {
    return fail('The two passwords are not the same. Type the second one again.');
  }

  const name = id.toLowerCase();
  const accounts = readAccounts();
  if (accounts[name]) {
    // Said plainly on purpose. Somebody registering their OWN id and being
    // told nothing useful would simply try again; and an id already being
    // taken is not a secret worth keeping from the person it belongs to.
    return fail('An account already exists for employee ID ' + id + '. Sign in ' +
                'with it, or ask for the password to be reset if it is yours ' +
                'and you have forgotten it.');
  }

  const now = new Date();
  const salt = Utilities.getUuid();
  const account = {
    role: ROLE_USER, salt: salt, hash: hashOf(pass, salt),
    created: now.toISOString(), passwordSet: now.toISOString(),
    lastSignIn: now.toISOString(), signIns: 1, note: ''
  };
  saveAccount(name, account);
  logAuth(name, 'SIGNUP', ROLE_USER, '');

  return {
    ok: true, setup: false, role: ROLE_USER, username: name,
    token: issueToken(name, ROLE_USER), message: ''
  };
}


/**
 * Changes your own password. Needs the current one, so a borrowed open tab
 * cannot be used to lock its owner out.
 */
function changeMyPassword(token, current, next, confirm) {
  const session = currentSession(token);
  if (!session) {
    throw new Error('Your session has ended. Reload the page and sign in again.');
  }

  const fail = function (message) { return { ok: false, message: message }; };
  const accounts = readAccounts();
  const account = accounts[session.u];
  if (!account) return fail('That account no longer exists.');

  if (hashOf(String(current || ''), account.salt) !== account.hash) {
    return fail('Your current password is not right.');
  }

  const pass = String(next == null ? '' : next);
  if (pass.length < MIN_PASSWORD) {
    return fail('The new password must be at least ' + MIN_PASSWORD + ' characters.');
  }
  if (pass !== String(confirm == null ? '' : confirm)) {
    return fail('The two new passwords are not the same.');
  }

  const salt = Utilities.getUuid();
  account.salt = salt;
  account.hash = hashOf(pass, salt);
  account.passwordSet = new Date().toISOString();
  saveAccount(session.u, account);
  logAuth(session.u, 'PASSWORD', account.role, 'changed by the account holder');

  return { ok: true, message: 'Your password has been changed.' };
}


/** Records that somebody got in, for the master screen's "last seen". */
function recordSignIn(name) {
  try {
    const accounts = readAccounts();
    const account = accounts[name];
    if (!account) return;
    account.lastSignIn = new Date().toISOString();
    account.signIns = (Number(account.signIns) || 0) + 1;
    saveAccount(name, account);
  } catch (e) { /* never block a sign-in over bookkeeping */ }
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
  const session = sessionFromToken(token);
  return session
    ? { signedIn: true, role: session.r, username: session.u,
        mode: session.d ? 'DEV' : 'EXEC' }
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
  // rank, not equality. A MASTER is an admin and more, and an endpoint that
  // tested for ADMIN exactly would lock the one person who can fix things out
  // of the things that need fixing.
  if (rankOf(session.r) < rankOf(ROLE_ADMIN)) {
    throw new Error('That action needs the admin login. You are signed in as a ' +
                    'viewer, which can read everything but cannot upload, delete ' +
                    'or rebuild.');
  }
}


/** Throws unless the token says MASTER. */
function requireMaster(token) {
  const session = currentSession(token);
  if (!session) {
    throw new Error('Your session has ended. Reload the page and sign in again.');
  }
  if (rankOf(session.r) < rankOf(ROLE_MASTER)) {
    throw new Error('That action is master access only. Admins can upload, ' +
                    'delete and rebuild, but accounts are managed from the ' +
                    'master login.');
  }
  return session;
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
// MASTER - managing the accounts themselves
// ---------------------------------------------------------------------------
//
// Every one of these is master-only, checked on the server. The master screen
// is hidden from everyone else in the interface, but hiding is a courtesy:
// google.script.run.masterSetRole(...) can be typed into any visitor's
// console, so the guard is what actually holds.
//
// ON SEEING PEOPLE'S PASSWORDS
// There is no endpoint for it, and there cannot be one, because the passwords
// are not kept. What is stored is a salted hash folded over itself six hundred
// times, which can confirm a password typed at the sign-in and cannot be run
// backwards into the password itself. That is not an oversight to be patched -
// it is the single thing standing between a copy of this spreadsheet and
// everyone's password, and people reuse passwords.
//
// What the operational need behind the request actually is - somebody is
// locked out and has to get back in - is served completely by
// masterResetPassword below: set them a new one, tell them, they change it.

/** Everyone, with enough about each to manage them. Never a hash. */
function masterListAccounts(token) {
  requireMaster(token);
  const accounts = readAccounts();
  return Object.keys(accounts).sort().map(function (name) {
    const a = accounts[name];
    return {
      username:    name,
      role:        a.role,
      created:     a.created || '',
      passwordSet: a.passwordSet || '',
      lastSignIn:  a.lastSignIn || '',
      signIns:     Number(a.signIns) || 0,
      hasPassword: Boolean(a.hash),
      bootstrap:   name === BOOTSTRAP_USER,
      note:        a.note || ''
    };
  });
}


/**
 * Gives or takes away admin.
 *
 * MASTER can be granted here too, so a second master can be made without
 * opening the editor - but see the guard below on removing the last one.
 */
function masterSetRole(token, employeeId, role) {
  const session = requireMaster(token);
  const name = String(employeeId || '').trim().toLowerCase();
  const want = String(role || '').toUpperCase();

  if (!isRealRole(want)) throw new Error('Unknown role: ' + role);

  const accounts = readAccounts();
  const account = accounts[name];
  if (!account) throw new Error('No account for employee ID ' + employeeId + '.');
  if (name === BOOTSTRAP_USER) {
    throw new Error('The shared starting login cannot be given a role. It ' +
                    'exists only to reach the create-your-account card.');
  }

  // Standing on the branch you are sawing. Demoting yourself is allowed only
  // while somebody else can still do this job.
  if (name === session.u && rankOf(want) < rankOf(ROLE_MASTER)) {
    throw new Error('That would remove your own master access. Give it to ' +
                    'somebody else first, then step down.');
  }
  if (account.role === ROLE_MASTER && want !== ROLE_MASTER &&
      countMasters(accounts) <= 1) {
    throw new Error('That is the only master account. Make another one first, ' +
                    'or the accounts become unmanageable from the dashboard.');
  }

  account.role = want;
  saveAccount(name, account);
  logAuth(name, 'ROLE', want, 'set by ' + session.u);
  return { ok: true, username: name, role: want };
}


/** Takes an account off altogether. */
function masterRemoveAccount(token, employeeId) {
  const session = requireMaster(token);
  const name = String(employeeId || '').trim().toLowerCase();

  const accounts = readAccounts();
  const account = accounts[name];
  if (!account) throw new Error('No account for employee ID ' + employeeId + '.');
  if (name === BOOTSTRAP_USER) {
    throw new Error('The shared starting login cannot be removed - nobody new ' +
                    'could create an account without it.');
  }
  if (name === session.u) {
    throw new Error('That is the account you are signed in with.');
  }
  if (account.role === ROLE_MASTER && countMasters(accounts) <= 1) {
    throw new Error('That is the only master account.');
  }

  deleteAccountRow(name);
  logAuth(name, 'REMOVED', account.role, 'by ' + session.u);
  return { ok: true, username: name };
}


/**
 * Sets somebody a new password, for when they have forgotten theirs.
 *
 * The new password is returned ONCE, in the answer to this call, so it can be
 * read off the screen and passed on. It is not stored anywhere in a form that
 * can be read back, and reloading the master screen will not show it again.
 */
function masterResetPassword(token, employeeId, newPassword) {
  const session = requireMaster(token);
  const name = String(employeeId || '').trim().toLowerCase();

  const accounts = readAccounts();
  const account = accounts[name];
  if (!account) throw new Error('No account for employee ID ' + employeeId + '.');

  let pass = String(newPassword == null ? '' : newPassword).trim();
  if (!pass) pass = generatedPassword();
  if (pass.length < MIN_PASSWORD) {
    throw new Error('A password must be at least ' + MIN_PASSWORD + ' characters.');
  }

  const salt = Utilities.getUuid();
  account.salt = salt;
  account.hash = hashOf(pass, salt);
  account.passwordSet = new Date().toISOString();
  saveAccount(name, account);
  clearFailures(name);
  logAuth(name, 'RESET', account.role, 'by ' + session.u);

  return { ok: true, username: name, password: pass };
}


/** The sign-in log, newest first. */
function masterAuditLog(token, limit) {
  requireMaster(token);
  const want = Math.min(Math.max(Number(limit) || 200, 1), 1000);

  let sheet;
  try { sheet = authLogTab(); } catch (e) { return []; }

  const last = sheet.getLastRow();
  if (last < 2) return [];

  const from = Math.max(2, last - want + 1);
  const rows = sheet.getRange(from, 1, last - from + 1, AUTH_LOG_COLUMNS.length)
                    .getValues();

  return rows.map(function (r) {
    return {
      when:     r[0] instanceof Date ? r[0].toISOString() : String(r[0] || ''),
      username: String(r[1] || ''),
      event:    String(r[2] || ''),
      role:     String(r[3] || ''),
      detail:   String(r[4] || '')
    };
  }).reverse();
}


function countMasters(accounts) {
  return Object.keys(accounts).filter(function (k) {
    return accounts[k].role === ROLE_MASTER;
  }).length;
}


/** A readable one-off password, for a reset nobody had to think up. */
function generatedPassword() {
  // No l, 1, O or 0 - these get read off a screen and typed by somebody else.
  const letters = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += letters.charAt(Math.floor(Math.random() * letters.length));
  }
  for (let i = 0; i < 3; i++) {
    out += digits.charAt(Math.floor(Math.random() * digits.length));
  }
  return out;
}


// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

/*
  WHERE ACCOUNTS LIVE, AND WHY THEY MOVED

  They were one JSON blob in Script Properties. That was right for two shared
  logins and wrong for a company: a Script Property value is capped at 9KB,
  which is about seventy accounts with a salt and a hash each. Running into
  that cap would not have failed loudly - setProperty would have thrown on
  whoever happened to be registering at the time, and the account before them
  would have been the last one that worked.

  They now live on a tab of the same spreadsheet everything else uses, which
  also happens to be what makes the master screen possible: who exists, who
  signed up when, who last signed in. The tab creates itself on first use, so
  nothing has to be re-run to upgrade.

  The old Script Properties blob is still read once, to carry existing
  accounts across, and then left alone rather than deleted - if this ever has
  to be rolled back, the old store is still sitting there intact.
*/

const ACCOUNTS_TAB = 'ACCOUNTS';
const AUTH_LOG_TAB = 'AUTH_LOG';

const ACCOUNT_COLUMNS = ['Employee ID', 'Role', 'Salt', 'Hash', 'Created',
                         'Password Set', 'Last Sign In', 'Sign Ins', 'Note'];
const AUTH_LOG_COLUMNS = ['When', 'Employee ID', 'Event', 'Role', 'Detail'];


/** A tab, made if it is not there yet. */
function authTab(name, headers) {
  const id = getSpreadsheetId();
  if (!id) {
    throw new Error('No spreadsheet is connected, so accounts cannot be read. ' +
                    'Run setupDatabase() from the editor.');
  }
  const book = SpreadsheetApp.openById(id);
  let sheet = book.getSheetByName(name);
  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
         .setFontWeight('bold');
    sheet.setFrozenRows(1);
    // Employee IDs are digits but they are NOT numbers - an ID with a leading
    // zero must keep it, and none of them is ever added up.
    sheet.getRange(2, 1, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
  }
  return sheet;
}


function accountsTab() { return authTab(ACCOUNTS_TAB, ACCOUNT_COLUMNS); }
function authLogTab()  { return authTab(AUTH_LOG_TAB,  AUTH_LOG_COLUMNS); }


/**
 * Every account, keyed by username, in the shape the rest of this file expects.
 *
 * Reads the sheet, and folds in anything still sitting in the old Script
 * Properties blob that the sheet has not got. That fold is what makes the move
 * invisible: the existing admin and user logins keep working on the first load
 * after this ships, with nothing run by hand.
 */
function readAccounts() {
  const out = {};

  const raw = PropertiesService.getScriptProperties().getProperty(ACCOUNTS_KEY);
  if (raw) {
    try {
      const legacy = JSON.parse(raw) || {};
      Object.keys(legacy).forEach(function (name) {
        out[name] = {
          role: legacy[name].role, salt: legacy[name].salt, hash: legacy[name].hash,
          created: '', passwordSet: '', lastSignIn: '', signIns: 0, note: 'legacy'
        };
      });
    } catch (e) { /* an unreadable blob is not a reason to lock everyone out */ }
  }

  let rows = [];
  try {
    const sheet = accountsTab();
    const last = sheet.getLastRow();
    if (last >= 2) {
      rows = sheet.getRange(2, 1, last - 1, ACCOUNT_COLUMNS.length).getValues();
    }
  } catch (e) {
    // No spreadsheet. The legacy accounts above still let somebody in to fix
    // it, which is better than nobody being able to sign in at all.
    return out;
  }

  rows.forEach(function (r) {
    const name = String(r[0] || '').trim().toLowerCase();
    if (!name) return;
    out[name] = {
      role:        String(r[1] || ROLE_USER).toUpperCase(),
      salt:        String(r[2] || ''),
      hash:        String(r[3] || ''),
      created:     r[4] ? String(r[4]) : '',
      passwordSet: r[5] ? String(r[5]) : '',
      lastSignIn:  r[6] ? String(r[6]) : '',
      signIns:     Number(r[7]) || 0,
      note:        String(r[8] || '')
    };
  });

  return out;
}


/** The row number an account sits on, or 0. */
function accountRow(sheet, name) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim().toLowerCase() === name) return i + 2;
  }
  return 0;
}


/** Adds or replaces one account on the sheet. */
function saveAccount(name, account) {
  const sheet = accountsTab();
  const row = [name, account.role, account.salt, account.hash,
               account.created || '', account.passwordSet || '',
               account.lastSignIn || '', account.signIns || 0,
               account.note || ''];
  const at = accountRow(sheet, name);
  const target = at || sheet.getLastRow() + 1;
  sheet.getRange(target, 1, 1, ACCOUNT_COLUMNS.length).setValues([row]);
  sheet.getRange(target, 1).setNumberFormat('@');
}


/** Takes one account off the sheet. */
function deleteAccountRow(name) {
  const sheet = accountsTab();
  const at = accountRow(sheet, name);
  if (at) sheet.deleteRow(at);
}


/**
 * Still here because the editor-run helpers below write whole maps.
 *
 * Writes each account individually rather than replacing the tab, so a
 * half-finished write cannot empty it.
 */
function writeAccounts(accounts) {
  Object.keys(accounts).forEach(function (name) {
    saveAccount(name, accounts[name]);
  });
}


/**
 * One line in the sign-in log.
 *
 * Never throws. An account action that half-succeeded because the log was
 * unreachable would be worse than an action with no line written about it.
 */
function logAuth(name, event, role, detail) {
  try {
    const sheet = authLogTab();
    sheet.appendRow([new Date(), String(name || ''), String(event || ''),
                     String(role || ''), String(detail || '')]);
  } catch (e) { /* deliberately silent */ }
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
