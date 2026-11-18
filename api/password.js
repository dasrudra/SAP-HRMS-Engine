/**
 * password.js - turning a password into something safe to store.
 * ===========================================================================
 *
 * THE ONE RULE: A PASSWORD IS NEVER STORED. NOT ENCRYPTED - NEVER STORED.
 *
 * Encryption can be undone by whoever holds the key, and on the day somebody
 * copies your database they usually have the code too. What is stored here
 * is a HASH: a one-way result that can be checked against a password but
 * cannot be turned back into one.
 *
 * When somebody signs in, their typed password is hashed again with the same
 * salt and the two results are compared. At no point does the server know,
 * or need to know, what the password actually is.
 *
 * WHY scrypt
 *
 * An ordinary hash like SHA-256 is the wrong tool: it is designed to be
 * FAST, and a graphics card will try billions of SHA-256 guesses a second.
 * scrypt is deliberately slow AND deliberately memory-hungry, which is what
 * defeats that hardware - a GPU has thousands of cores but not thousands of
 * spare 64MB blocks to give each of them.
 *
 * It is built into Node. No package to install, nothing to compile - which
 * on a managed Windows laptop matters more than it sounds.
 *
 * WHY THE COST IS WHAT IT IS
 *
 * Measured on a real machine while writing this:
 *
 *      N=2^14    59 ms    16 MB
 *      N=2^15   114 ms    32 MB
 *      N=2^16   204 ms    64 MB      <-- chosen
 *      N=2^17   418 ms   128 MB      <-- OWASP's stated minimum
 *
 * OWASP recommends 2^17. This file defaults to 2^16, and that is a
 * deliberate, stated trade-off rather than an oversight:
 *
 *   every login holds N*r*128 bytes for its duration. At 2^17 that is 128MB
 *   EACH. Thirty-six people arriving at 9am and signing in within the same
 *   few seconds would need gigabytes, and the small host this will run on
 *   has hundreds of megabytes. A server that runs out of memory and refuses
 *   everybody is not more secure than one notch lower on the cost parameter.
 *
 * 2^16 is still far beyond bcrypt's common settings. Raise it with
 * SCRYPT_N in .env once the real host's memory is known - old hashes keep
 * working, because each one records the cost it was made with.
 */

const crypto = require('crypto');

const KEY_BYTES  = 32;
const SALT_BYTES = 16;

const N = Number(process.env.SCRYPT_N || 65536);   // 2^16
const R = 8;
const P = 1;

/*
  maxmem MUST be set explicitly and this is a trap worth knowing about.
  Node's default limit is 32MB, and N=2^16 needs 64MB - so without this
  line every hash fails with "Invalid scrypt params", which reads like a
  bug in the parameters rather than a ceiling on memory.

  The formula is 128 * N * r. Doubled, so raising SCRYPT_N one notch does
  not immediately hit the ceiling again.
*/
function maxmemFor(n) {
  return 128 * n * R * 2;
}


/**
 * Hashes a password for storage.
 *
 * The result is self-describing:
 *
 *     scrypt$65536$8$1$<salt base64>$<hash base64>
 *
 * The cost parameters travel WITH the hash. That is what lets the cost be
 * raised later without locking anybody out: a password stored at 2^16 is
 * still checked at 2^16, while new ones use the new setting. A bare hash
 * with the parameters only in the code is a decision that can never be
 * revisited.
 */
function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword needs a non-empty string');
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(plain, salt, KEY_BYTES,
                                { N: N, r: R, p: P, maxmem: maxmemFor(N) });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')]
         .join('$');
}


/**
 * Checks a typed password against a stored hash. Never throws.
 *
 * RETURNS FALSE FOR ANYTHING IT DOES NOT UNDERSTAND - a malformed row, an
 * unknown algorithm, a truncated hash. A verifier that throws on bad input
 * turns a damaged database row into a 500, and a 500 on the login endpoint
 * tells an attacker which accounts have interesting data in them.
 */
function verifyPassword(plain, stored) {
  try {
    if (typeof plain !== 'string' || typeof stored !== 'string') return false;

    const bits = stored.split('$');
    if (bits.length !== 6) return false;
    if (bits[0] !== 'scrypt') return false;

    const n = Number(bits[1]);
    const r = Number(bits[2]);
    const p = Number(bits[3]);
    // A hostile or corrupt row must not be able to ask for 64GB of memory
    // and take the server down with it.
    if (!(n > 1 && n <= 1048576) || !(r > 0 && r <= 32) || !(p > 0 && p <= 16)) {
      return false;
    }

    const salt = Buffer.from(bits[4], 'base64');
    const want = Buffer.from(bits[5], 'base64');
    if (salt.length === 0 || want.length === 0) return false;

    const got = crypto.scryptSync(plain, salt, want.length,
                                  { N: n, r: r, p: p, maxmem: maxmemFor(n) });

    /*
      timingSafeEqual, NOT ===.

      Comparing two buffers with === or a loop stops at the first byte that
      differs, so a wrong guess beginning with the right byte takes very
      slightly longer to reject. Measured over many attempts that difference
      leaks the hash one byte at a time. timingSafeEqual always reads every
      byte, so every wrong answer costs exactly the same.

      It throws if the lengths differ, hence the check first.
    */
    if (got.length !== want.length) return false;
    return crypto.timingSafeEqual(got, want);

  } catch (e) {
    return false;
  }
}


/**
 * Whether a stored hash was made with weaker settings than today's.
 *
 * Call it after a SUCCESSFUL login - that is the only moment the plain
 * password is in hand - and re-hash if it says yes. That way the whole
 * estate drifts up to the current cost as people sign in, with nobody
 * locked out and nobody asked to change anything.
 */
function needsRehash(stored) {
  try {
    const bits = String(stored).split('$');
    if (bits.length !== 6 || bits[0] !== 'scrypt') return true;
    return Number(bits[1]) < N || Number(bits[2]) !== R || Number(bits[3]) !== P;
  } catch (e) {
    return true;
  }
}


module.exports = { hashPassword, verifyPassword, needsRehash, PARAMS: { N, R, P } };
