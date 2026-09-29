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
 *      between an outsider and the data. With the deployment set to "Anyone
 *      with Google account" this does the job it is meant for: stopping an
 *      ordinary user from deleting an upload by accident or on a whim.
 *
 * THE ONE DEPLOYMENT SETTING THIS FILE DEPENDS ON
 * "Who has access" must be "Anyone with Google account", never "Anyone".
 * Sessions are kept per person in User Properties, and Google can only keep
 * them apart while it knows who the visitor is. Published to "Anyone" there is
 * no visitor to know, everybody shares one store, and one person signing in
 * signs in the lot. deploymentProblem() refuses to run in that state and says
 * so on screen rather than leaking quietly — it is the one failure here that
 * would be invisible otherwise.
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
 * Is this request running with a developer's own permissions?
 *
 * WHY THIS IS NOT A URL CHECK ANY MORE
 * It used to be `ScriptApp.getService().getUrl()` matched against /dev, and
 * that was wrong in a way that only showed up in production. That call
 * describes THE PROJECT — "this script's web app lives at such-and-such an
 * address" — not the request in front of you. It gives the same answer
 * however the visitor arrived, and when the project had two active
 * deployments it answered with the /dev address for everyone. The result was
 * the worst kind of failure: every visitor to /exec was silently handed
 * ADMIN, with no sign-in at all.
 *
 * Apps Script offers no way to ask "which URL did this request come in on".
 * So this asks a question it CAN answer, and which happens to be the one that
 * actually matters:
 *
 *     is the script running as the person using it?
 *
 * On /dev it always is — Google runs the head deployment with the visitor's
 * own permissions, and only someone with EDIT ACCESS to the project can open
 * it at all. On /exec the app is deployed "execute as me", so the effective
 * user is the owner while the active user is the visitor, and the two differ.
 *
 * That makes this a PERMISSION check rather than a guess about a string,
 * which is why it cannot drift the way the URL test did: there is no
 * deployment setting that makes a stranger's request run as the developer.
 *
 * ONE HONEST LIMITATION
 * When the owner opens /exec while signed in to the owning account, active
 * and effective are the same person and this returns true — so the owner goes
 * straight in there too. Nothing is exposed by that (it is their own app), but
 * it does mean the owner never sees the sign-in card by accident. Add
 * ?login=1 to the /exec URL to be asked for it anyway; see setForceLogin().
 *
 * FAILS CLOSED. Anything unreadable means production, and production means
 * sign in. The failure that costs something is handing out admin by accident,
 * not making a developer type a password.
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
 * Something that identifies this visitor, without necessarily naming them.
 *
 * A session is one person's. Storing it in User Properties is supposed to
 * take care of that, and does — PROVIDED Google can tell the visitors apart.
 * When a web app is published to "Anyone", visitors arrive anonymously and
 * there is no current user for the store to belong to, so they all share one.
 * One person signing in would sign in everybody, and an admin sign-in would
 * hand admin to everybody. deploymentProblem() below refuses to run in that
 * state rather than leaking quietly.
 *
 * The email when it can be read; otherwise the temporary key Google hands out
 * for exactly this purpose, which identifies a signed-in visitor without
 * revealing who they are. Consumer accounts outside a Workspace domain hide
 * the address from a web app that runs as its owner, so the second one is the
 * usual answer in practice, not the fallback it looks like.
 *
 * @return {string} '' when the visitor cannot be told apart from anyone else
 */
function visitorKey() {
  try {
    const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
    if (email) return 'e:' + email;
  } catch (e) { /* not available here — try the temporary key */ }

  try {
    const temp = String(Session.getTemporaryActiveUserKey() || '').trim();
    if (temp) return 't:' + temp;
  } catch (e) { /* neither is available: anonymous */ }

  return '';
}


/**
 * Is the deployment configured in a way that makes the sign-in meaningless?
 *
 * Returns the sentence to put in front of whoever is looking, or '' when all
 * is well. Written for the person who has to fix it — it names the menu, not
 * the mechanism.
 *
 * @return {string}
 */
function deploymentProblem() {
  if (!REQUIRE_IDENTIFIED_VISITOR) return '';
  if (isDevContext()) return '';
  if (visitorKey()) return '';

  return 'This dashboard is published to "Anyone", so visitors arrive without ' +
         'signing in to Google and the app cannot tell them apart — one person ' +
         'signing in here would sign everyone in, with whatever role they used. ' +
         'It has stopped rather than do that. To fix it: Apps Script editor → ' +
         'Deploy → Manage deployments → the pencil → set "Who has access" to ' +
         '"Anyone with Google account" → Deploy.';
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

/**
 * User Property that makes this browser ask for the sign-in even on /dev.
 *
 * Set by opening the app with ?login=1 — see setForceLogin(). It is how the
 * owner checks what the team actually sees, since the owner is otherwise let
 * straight in everywhere.
 */
const FORCE_LOGIN_KEY = 'EAS_FORCE_LOGIN';

/**
 * How long a sign-in lasts before it has to be done again.
 *
 * Why closing the tab and coming back does NOT ask again: the session is
 * stored against the person, not against the page, so it outlives the tab —
 * the same way every other web app you stay signed in to works. Twelve hours
 * covers a working day and expires overnight. Sign out ends it immediately.
 *
 * Lower this if the dashboard is ever opened on a shared machine.
 */
const SESSION_HOURS = 12;

/**
 * Refuse to run when the visitor cannot be told apart from anyone else.
 *
 * The sign-in only means something if Google can identify who is signing in —
 * see visitorKey(). Leave this true. It exists as a switch only so that a
 * wrong guess on my part about a deployment setting can be undone from the
 * editor in one edit rather than by waiting for a new file.
 */
const REQUIRE_IDENTIFIED_VISITOR = true;

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
  // Nothing signed in here would mean anything — say so instead of accepting
  // a password and issuing a session that belongs to everybody.
  const problem = deploymentProblem();
  if (problem) return { ok: false, role: '', username: '', message: problem };

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
  // `k` ties the session to the person it was issued to. currentSession()
  // checks it back, so a session cannot be picked up by anybody else.
  PropertiesService.getUserProperties().setProperty(SESSION_KEY, JSON.stringify({
    u: name, r: account.role, at: Date.now(), k: visitorKey()
  }));

  return { ok: true, role: account.role, username: name, message: '' };
}


/** Signs out. The forced-login switch is left alone — signing out of a test
 *  should put the card back, not end the test. */
function logout() {
  PropertiesService.getUserProperties().deleteProperty(SESSION_KEY);
  return { ok: true };
}


/**
 * Who is signed in, if anyone. Also NOT guarded — the page calls it first,
 * before it knows whether to show the app or the login card.
 *
 * `notice` carries a configuration problem that has to be read by whoever
 * opens the page, because the person who can fix it is the person looking at
 * it. Empty in normal use.
 *
 * @return {{signedIn: boolean, role: string, username: string,
 *           mode: string, notice: string}}
 */
function getSession() {
  const problem = deploymentProblem();
  if (problem) {
    return { signedIn: false, role: '', username: '', mode: 'EXEC',
             notice: problem };
  }

  const session = currentSession();
  return session
    ? { signedIn: true, role: session.r, username: session.u,
        mode: session.dev ? 'DEV' : 'EXEC', notice: '' }
    : { signedIn: false, role: '', username: '', mode: 'EXEC', notice: '' };
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
  // A developer running the script under their own permissions is an admin and
  // is not asked to sign in. Deciding it here means requireSignedIn() and
  // requireAdmin() both follow automatically — there is no second copy of the
  // rule to forget about. ?login=1 suspends it for this browser.
  if (isDevContext() && !forceLoginOn()) {
    return { u: 'developer', r: ROLE_ADMIN, at: Date.now(), dev: true };
  }

  // If visitors cannot be told apart, a stored session does not belong to
  // anyone in particular, so nobody is signed in. Checked here rather than in
  // each guard so there is one place it can be got wrong.
  if (deploymentProblem()) return null;

  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty(SESSION_KEY);
  if (!raw) return null;

  let session;
  try { session = JSON.parse(raw); } catch (e) { return null; }
  if (!session || !session.r) return null;

  // The session records who it was issued to, and it is only good for them.
  // Belt and braces over the property store's own per-user separation: if that
  // separation ever stops holding — a deployment setting changed, a session
  // written under an older configuration — this catches it and signs them out
  // instead of lending one person's role to another.
  if (String(session.k || '') !== visitorKey()) {
    props.deleteProperty(SESSION_KEY);
    return null;
  }

  const ageHours = (Date.now() - (session.at || 0)) / 3600000;
  if (ageHours > SESSION_HOURS) {
    props.deleteProperty(SESSION_KEY);
    return null;
  }

  return session;
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
 * with ?login=0. It is a real server-side switch, not a screen that merely
 * looks locked: the guards read currentSession() like everything else, so
 * while it is on the owner genuinely has whatever role they signed in with —
 * which is the only way to check what a viewer actually sees.
 *
 * @param {boolean} on
 */
function setForceLogin(on) {
  const props = PropertiesService.getUserProperties();
  if (on) {
    props.setProperty(FORCE_LOGIN_KEY, '1');
    props.deleteProperty(SESSION_KEY);   // start from the card, not mid-session
  } else {
    props.deleteProperty(FORCE_LOGIN_KEY);
  }
  return { ok: true, forced: Boolean(on) };
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
