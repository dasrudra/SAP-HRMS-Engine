/**
 * auth.js - proving who somebody is, after they have signed in once.
 * ===========================================================================
 *
 * THE PROBLEM THIS SOLVES
 *
 * HTTP forgets. Every request arrives knowing nothing about the one before
 * it, so "I signed in two minutes ago" means nothing to the server. Asking
 * for the password on every request is not an option - it would mean the
 * browser keeping the password, which is the one thing it must never do.
 *
 * So: sign in once, and the server hands back a TOKEN. The browser sends
 * that token with each later request. The token says who you are and when
 * it stops being valid, and it is signed so it cannot be edited.
 *
 * WHAT A JWT ACTUALLY IS - three base64 pieces joined by dots:
 *
 *     eyJhbGci...  .  eyJzdWIiOi...  .  SflKxwRJSM...
 *     header          payload           signature
 *
 * THE PAYLOAD IS NOT ENCRYPTED. Anybody holding the token can read it -
 * paste one into jwt.io and see. It is signed, not hidden. So it may carry
 * an employee ID and a role; it must never carry a password, a phone number
 * or anything else private.
 *
 * The signature is what matters. Change one character of the payload - say
 * role from USER to ADMIN - and the signature no longer matches, because
 * producing a valid one needs JWT_SECRET. That is why the secret lives in
 * .env and never in the repository.
 */

const jwt = require('jsonwebtoken');

const SECRET = String(process.env.JWT_SECRET || '');
const TTL    = String(process.env.JWT_TTL || '8h');
const ISSUER = 'tvl-eas-api';

/*
  REFUSE TO START WITHOUT A REAL SECRET.

  The tempting line here is

      const SECRET = process.env.JWT_SECRET || 'dev-secret';

  and it is how real systems get broken into. It works on the laptop,
  nobody notices the fallback, and the day it goes to a server the tokens
  are signed with a string that is sitting in a public repository - so
  anybody can mint themselves an ADMIN token.

  Failing loudly at startup is the whole defence. An error on your screen
  today costs ten minutes; the fallback costs the company.
*/
if (!SECRET || SECRET.length < 32) {
  console.error('');
  console.error('  JWT_SECRET is missing or too short in api/.env');
  console.error('');
  console.error('  It must be at least 32 characters of random text.');
  console.error('  Generate one by running:');
  console.error('');
  console.error('      node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"');
  console.error('');
  console.error('  Then put it in api/.env as:   JWT_SECRET=<the output>');
  console.error('');
  process.exit(1);
}


/** Makes a token for somebody who has just proved who they are. */
function signToken(employeeId, role) {
  return jwt.sign(
    // 'sub' (subject) and 'role' are all that goes in. Nothing private.
    { sub: String(employeeId), role: String(role) },
    SECRET,
    { expiresIn: TTL, issuer: ISSUER, algorithm: 'HS256' }
  );
}


/**
 * Reads a token and returns its contents, or null.
 *
 * algorithms: ['HS256'] IS NOT OPTIONAL, and leaving it out is the most
 * famous JWT vulnerability there is. Without it the library will believe
 * the token's own header about how it was signed - including a header
 * saying "alg": "none", which means "not signed at all". An attacker writes
 * their own payload, says it needs no signature, and the server agrees.
 *
 * Naming the algorithm here means the token is checked the way WE decided,
 * not the way the token asked to be checked.
 */
function readToken(token) {
  try {
    return jwt.verify(token, SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER
    });
  } catch (e) {
    return null;   // expired, edited, wrong issuer, or not a token at all
  }
}


/**
 * Express middleware: the request stops here unless it carries a good token.
 *
 * The browser sends it as   Authorization: Bearer <token>
 */
function requireAuth(req, res, next) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer (.+)$/);

  if (!match) {
    return res.status(401).json({ ok: false, error: 'sign in first' });
  }

  const claims = readToken(match[1]);
  if (!claims) {
    // 401, not 403. 401 means "I do not know who you are" - the browser
    // should send the person back to the sign-in page. 403 would mean "I
    // know who you are and you still may not", which is a different fix.
    return res.status(401).json({ ok: false, error: 'session expired - sign in again' });
  }

  req.user = { employeeId: claims.sub, role: claims.role };
  next();
}


/**
 * Express middleware: must be an admin. Always used AFTER requireAuth.
 *
 * THE ROLE IS TAKEN FROM THE TOKEN, never from the request body or a query
 * parameter. The token was signed by this server from what the database
 * said at sign-in time. Anything the caller sends is just something the
 * caller typed.
 */
const ROLE_RANK = { USER: 1, ADMIN: 2, MASTER: 3 };

/** The number behind a role name, or 0 for anything unrecognised. */
function rankOf(role) {
  return ROLE_RANK[String(role || '').toUpperCase()] || 0;
}

function requireAdmin(req, res, next) {
  // RANK, NOT EQUALITY. The first version read role !== 'ADMIN', which
  // locks MASTER - the HIGHEST role - out of every admin screen. Copied
  // straight from Auth.gs, where ROLE_RANK is { USER: 1, ADMIN: 2,
  // MASTER: 3 } and every check asks whether a rank is high ENOUGH.
  if (!req.user || rankOf(req.user.role) < ROLE_RANK.ADMIN) {
    return res.status(403).json({ ok: false, error: 'admins only' });
  }
  next();
}

/** Master only: accounts, roles, password resets, the audit log. */
function requireMaster(req, res, next) {
  if (!req.user || rankOf(req.user.role) < ROLE_RANK.MASTER) {
    return res.status(403).json({ ok: false, error: 'masters only' });
  }
  next();
}


module.exports = { signToken, readToken, requireAuth, requireAdmin,
                   requireMaster, rankOf, ROLE_RANK };
