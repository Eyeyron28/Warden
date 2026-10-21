const OtpChallenge = require('../../models/OtpChallenge');
const { sendEmail } = require('../email');
const { templates } = require('../emailTemplates');
const { otpTtlMinutes } = require('../otpConfig');
const { generateCode, newSalt, hashCode, codeMatches } = require('../otp');

const PURPOSES = { request: 'emergency-request', session: 'emergency-session' };
const MAX_ATTEMPTS = 5;

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

async function checkContactCode({ access, purpose, code }) {
  if (!access) {
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

async function consumeContactCode(id) {
  if (!id) return false;
  return Boolean(await OtpChallenge.findOneAndDelete({ _id: id }));
}

module.exports = { PURPOSES, MAX_ATTEMPTS, issueContactCode, checkContactCode, consumeContactCode };
