const crypto = require('crypto');

const LoginFailure = require('../models/LoginFailure');
const { hmacKey } = require('./auditConfig');

/**
 * The login lockout: 3 password checks per 5-minute window, then the address is locked for 5 minutes.
 *
 * Two properties matter more than the numbers:
 *
 *  1. It is the same for every address typed. The counter is keyed by an HMAC of the normalized email, so an address
 *     with no account is counted, locked and answered exactly like a real one (no "locked" for real accounts only).
 *  2. It is atomic. An attempt is RESERVED by one findOneAndUpdate (a pipeline update) that, in a single step on the
 *     stored document, reads the lock, resets or advances the window, counts the attempt, sets the lock when the
 *     limit is reached, and reports whether this attempt may be checked at all. 20 parallel requests therefore get
 *     exactly 3 checks between them; there is no read-then-save for them to slip through.
 */

const LOGIN_ATTEMPT_LIMIT = 3;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const MAX_EMAIL_CHARS = 254;

const normalize = (email) => String(email ?? '').trim().toLowerCase().slice(0, MAX_EMAIL_CHARS);

function loginKey(email) {
  return crypto.createHmac('sha256', hmacKey()).update(`warden-login-failures:${normalize(email)}`).digest('hex');
}

/**
 * Counts one password attempt for this address and says what to do with it.
 * @returns {Promise<{ granted: boolean, locked: boolean, lockedUntil: Date|null }>}
 *   granted: check the password. locked: the lock is on after this attempt (a failure now is the locking one, or the
 *   attempt was refused because it was already on). lockedUntil: when it ends.
 */
async function reserveLoginAttempt(email, { now = new Date() } = {}) {
  const epoch = new Date(0);
  const windowEnd = new Date(now.getTime() + LOGIN_WINDOW_MS);
  const lockEnd = new Date(now.getTime() + LOGIN_LOCK_MS);
  const doc = await LoginFailure.findOneAndUpdate(
    { key: loginKey(email) },
    [
      {
        $set: {
          _locked: { $gt: [{ $ifNull: ['$lockedUntil', epoch] }, now] },
          _open: { $gt: [{ $ifNull: ['$windowExpiresAt', epoch] }, now] },
        },
      },
      {
        $set: {
          granted: { $not: ['$_locked'] },
          count: {
            $cond: ['$_locked', { $ifNull: ['$count', 0] }, { $cond: ['$_open', { $add: [{ $ifNull: ['$count', 0] }, 1] }, 1] }],
          },
          windowExpiresAt: { $cond: [{ $or: ['$_locked', '$_open'] }, { $ifNull: ['$windowExpiresAt', windowEnd] }, windowEnd] },
        },
      },
      {
        $set: {
          lockedUntil: {
            $cond: ['$_locked', '$lockedUntil', { $cond: [{ $gte: ['$count', LOGIN_ATTEMPT_LIMIT] }, lockEnd, null] }],
          },
        },
      },
      { $set: { expireAt: { $max: ['$windowExpiresAt', '$lockedUntil'] } } },
      { $unset: ['_locked', '_open'] },
    ],
    { upsert: true, new: true }
  );
  const lockedUntil = doc.lockedUntil && doc.lockedUntil.getTime() > now.getTime() ? doc.lockedUntil : null;
  return { granted: Boolean(doc.granted), locked: Boolean(lockedUntil), lockedUntil };
}

/** A correct password (or a completed reset) clears the count and any lock for this address. */
async function clearLoginFailures(email) {
  await LoginFailure.deleteOne({ key: loginKey(email) });
}

module.exports = { reserveLoginAttempt, clearLoginFailures, loginKey, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS, LOGIN_LOCK_MS };
