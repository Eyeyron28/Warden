const crypto = require('crypto');

const OtpChallenge = require('../models/OtpChallenge');
const { sendEmail } = require('./email');
const { templates } = require('./emailTemplates');
const { otpTtlMinutes } = require('./otpConfig');
const { hmacKey } = require('./auditConfig');
const { generateCode, newSalt, hashCode, codeMatches } = require('./otp');
const { logSecurity } = require('./securityLog');

const PURPOSE = 'signup';
const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const RESEND_GAP_MS = 60 * 1000;

const subjectKeyFor = (email) => crypto.createHmac('sha256', hmacKey()).update(`warden-signup:${String(email).trim().toLowerCase()}`).digest('hex');

async function issueSignupCode(email, consent = null) {
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
        ...(consent ? { consent } : {}),
      },
    },
    { upsert: true, new: true }
  );
  const sent = await sendEmail({ to: email, ...templates.signupCode({ code, ttlMinutes }) });
  if (!sent) await OtpChallenge.deleteOne({ purpose: PURPOSE, subjectKey });
  return sent;
}

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

async function hasPendingSignup(email) {
  return Boolean(await OtpChallenge.findOne({ purpose: PURPOSE, subjectKey: subjectKeyFor(email), expiresAt: { $gt: new Date() } }));
}

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
    if (challenge.attempts >= 3) logSecurity('code_failures', { bucket: 'signup', count: challenge.attempts, subject: String(challenge._id) });
    if (challenge.attempts >= MAX_ATTEMPTS) await OtpChallenge.deleteOne({ _id: challenge._id });
    return { ok: false, id: null };
  }
  return { ok: true, id: challenge._id, consent: challenge.consent || null };
}

async function consumeSignupCode(id) {
  if (!id) return false;
  return Boolean(await OtpChallenge.findOneAndDelete({ _id: id }));
}

module.exports = { PURPOSE, MAX_ATTEMPTS, MAX_RESENDS, RESEND_GAP_MS, subjectKeyFor, issueSignupCode, resendSignupCode, hasPendingSignup, checkSignupCode, consumeSignupCode };
