const crypto = require('crypto');

const LoginFailure = require('../models/LoginFailure');
const { hmacKey } = require('./auditConfig');

const LOGIN_ATTEMPT_LIMIT = 3;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const MAX_EMAIL_CHARS = 254;

const normalize = (email) => String(email ?? '').trim().toLowerCase().slice(0, MAX_EMAIL_CHARS);

function loginKey(email) {
  return crypto.createHmac('sha256', hmacKey()).update(`warden-login-failures:${normalize(email)}`).digest('hex');
}

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

async function clearLoginFailures(email) {
  await LoginFailure.deleteOne({ key: loginKey(email) });
}

module.exports = { reserveLoginAttempt, clearLoginFailures, loginKey, LOGIN_ATTEMPT_LIMIT, LOGIN_WINDOW_MS, LOGIN_LOCK_MS };
