const crypto = require('crypto');

const OtpChallenge = require('../models/OtpChallenge');
const { sendEmail } = require('./email');
const { templates } = require('./emailTemplates');
const { otpTtlMinutes } = require('./otpConfig');
const { hmacKey } = require('./auditConfig');
const { generateCode, newSalt, hashCode, codeMatches } = require('./otp');

/**
 * The emailed code that proves an address BEFORE an account exists for it.
 *
 * There is no user, no vault key and no password here - only a pending challenge, found by an HMAC of the address (never
 * the address itself). It holds: the code as a salted HMAC, an attempt counter, a resend counter and an expiry. At most one
 * live code per address (a new start replaces the old one); five guesses, then it is gone; single use; three resends, 60
 * seconds apart. Mongo removes it after its expiry, so a mailbox nobody owns leaves nothing behind.
 */

const PURPOSE = 'signup';
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const RESEND_GAP_MS = 60 * 1000;

const subjectKeyFor = (email) => crypto.createHmac('sha256', hmacKey()).update(`warden-signup:${String(email).trim().toLowerCase()}`).digest('hex');

/** Creates (or replaces) the pending code for this address and emails it. Returns whether the mail was handed over. */
async function issueSignupCode(email) {
  const subjectKey = subjectKeyFor(email);
  const ttlMinutes = otpTtlMinutes();
  const code = generateCode();
  const salt = newSalt();
  const now = new Date();
  await OtpChallenge.findOneAndUpdate(
    { purpose: PURPOSE, subjectKey },
    {
      $set: {
        codeHash: hashCode(salt, code),
        salt,
        lastSentAt: now,
        expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
        attempts: 0,
        resendCount: 0,
        decoy: false,
      },
    },
    { upsert: true, new: true }
  );
  const sent = await sendEmail({ to: email, ...templates.signupCode({ code, ttlMinutes }) });
  if (!sent) await OtpChallenge.deleteOne({ purpose: PURPOSE, subjectKey });
  return sent;
}

/**
 * A new code for an address that has a pending one, if the gap and the cap allow it - decided in ONE conditional update, so
 * parallel resends cannot beat either. Returns { sent, challenge } ; sent is false when there was nothing to resend.
 */
async function resendSignupCode(email) {
  const subjectKey = subjectKeyFor(email);
  const ttlMinutes = otpTtlMinutes();
  const code = generateCode();
  const salt = newSalt();
  const now = new Date();
  const updated = await OtpChallenge.findOneAndUpdate(
    {
      purpose: PURPOSE,
      subjectKey,
      expiresAt: { $gt: now },
      resendCount: { $lt: MAX_RESENDS },
      lastSentAt: { $lte: new Date(now.getTime() - RESEND_GAP_MS) },
    },
    {
      $set: { codeHash: hashCode(salt, code), salt, lastSentAt: now, expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000) },
      $inc: { resendCount: 1 },
    },
    { new: true }
  );
  if (!updated) return { sent: false };
  const sent = await sendEmail({ to: email, ...templates.signupCode({ code, ttlMinutes }) });
  return { sent, challenge: updated };
}

/** Whether an address has a live pending code (used only to decide whether a resend can do anything). */
async function hasPendingSignup(email) {
  return Boolean(await OtpChallenge.findOne({ purpose: PURPOSE, subjectKey: subjectKeyFor(email), expiresAt: { $gt: new Date() } }));
}

/**
 * Checks a submitted code. The guess is counted BEFORE it is looked at, atomically, and only against a live code with
 * attempts left; a right code is NOT used up here (see consumeSignupCode). With no pending code the same comparison is
 * done against a dummy, so the time does not say whether one exists.
 * @returns {Promise<{ ok: boolean, id: any }>}
 */
async function checkSignupCode(email, code) {
  const challenge = await OtpChallenge.findOneAndUpdate(
    { purpose: PURPOSE, subjectKey: subjectKeyFor(email), attempts: { $lt: MAX_ATTEMPTS }, expiresAt: { $gt: new Date() } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!challenge) {
    codeMatches('00'.repeat(16), '00'.repeat(32), typeof code === 'string' ? code : '');
    return { ok: false, id: null };
  }
  if (!codeMatches(challenge.salt, challenge.codeHash, code)) {
    if (challenge.attempts >= MAX_ATTEMPTS) await OtpChallenge.deleteOne({ _id: challenge._id });
    return { ok: false, id: null };
  }
  return { ok: true, id: challenge._id };
}

/** Uses up a code that checkSignupCode accepted. Only one caller can ever get true for a given code. */
async function consumeSignupCode(id) {
  if (!id) return false;
  return Boolean(await OtpChallenge.findOneAndDelete({ _id: id }));
}

module.exports = { PURPOSE, MAX_ATTEMPTS, MAX_RESENDS, RESEND_GAP_MS, subjectKeyFor, issueSignupCode, resendSignupCode, hasPendingSignup, checkSignupCode, consumeSignupCode };
