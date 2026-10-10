const OtpChallenge = require('../../models/OtpChallenge');
const { sendEmail } = require('../email');
const { templates } = require('../emailTemplates');
const { otpTtlMinutes } = require('../otpConfig');
const { generateCode, newSalt, hashCode, codeMatches } = require('../otp');

/**
 * The two emailed codes a trusted CONTACT uses. The contact has no account and no challenge token (an endpoint
 * that handed out a token only when the details matched would reveal whether they do), so a code is found by the
 * setup it belongs to: at most one live code per (setup, purpose); the code is stored only as a salted HMAC; five
 * guesses, then it is gone; single use; same TTL as every other emailed code.
 *
 *   emergency-request   to ask for access
 *   emergency-session   to start a session once the wait has ended
 */

const PURPOSES = { request: 'emergency-request', session: 'emergency-session' };
const MAX_ATTEMPTS = 5;

/** Creates a fresh code for this setup and purpose (replacing any older one) and emails it to `to`. */
async function issueContactCode({ access, purpose, to }) {
  const ttlMinutes = otpTtlMinutes();
  const code = generateCode();
  const salt = newSalt();
  const now = new Date();
  await OtpChallenge.deleteMany({ userId: access.userId, purpose, accessId: String(access._id) });
  const challenge = await OtpChallenge.create({
    userId: access.userId,
    purpose,
    accessId: String(access._id),
    decoy: false,
    codeHash: hashCode(salt, code),
    salt,
    lastSentAt: now,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
  });
  const message =
    purpose === PURPOSES.request
      ? templates.emergencyContactRequestCode({ code, ttlMinutes })
      : templates.emergencyContactSessionCode({ code, ttlMinutes });
  const sent = await sendEmail({ to, ...message });
  if (!sent) await OtpChallenge.deleteOne({ _id: challenge._id });
  return sent;
}

/**
 * Checks a submitted code for this setup. Counts the guess first. With `consume: false` a right code is NOT used up
 * (so a start-session attempted too early does not waste it); call consumeContactCode when everything else passed.
 * `access` may be null (no such setup): the same work is done and the answer is false.
 * @returns {Promise<{ ok: boolean, id: any }>}
 */
async function checkContactCode({ access, purpose, code }) {
  if (!access) {
    // Same cost as a real check, so an unknown account cannot be told apart by timing.
    codeMatches('00'.repeat(16), '00'.repeat(32), typeof code === 'string' ? code : '');
    return { ok: false, id: null };
  }
  const challenge = await OtpChallenge.findOneAndUpdate(
    { userId: access.userId, purpose, accessId: String(access._id), attempts: { $lt: MAX_ATTEMPTS }, expiresAt: { $gt: new Date() } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!challenge) return { ok: false, id: null };
  if (!codeMatches(challenge.salt, challenge.codeHash, code)) {
    if (challenge.attempts >= MAX_ATTEMPTS) await OtpChallenge.deleteOne({ _id: challenge._id });
    return { ok: false, id: null };
  }
  return { ok: true, id: challenge._id };
}

/** Uses up a code that checkContactCode accepted. Only one caller can ever get true for a given code. */
async function consumeContactCode(id) {
  if (!id) return false;
  return Boolean(await OtpChallenge.findOneAndDelete({ _id: id }));
}

module.exports = { PURPOSES, MAX_ATTEMPTS, issueContactCode, checkContactCode, consumeContactCode };
