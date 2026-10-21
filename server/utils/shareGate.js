const crypto = require('crypto');

const ShareAccess = require('../models/ShareAccess');
const OtpChallenge = require('../models/OtpChallenge');
const User = require('../models/User');
const { sendEmail } = require('./email');
const { logSecurity } = require('./securityLog');
const { templates } = require('./emailTemplates');
const { consumeBudget } = require('../middleware/rateLimit');
const { otpTtlMinutes } = require('./otpConfig');
const { generateCode, newSalt, hashCode, codeMatches } = require('./otp');
const limits = require('./shareLimits');

const ACCESS_TTL_MS = limits.ACCESS_TTL_MINUTES * 60 * 1000;
const PURPOSE = 'share-email';
const CODE_FAILURE = 'That code is incorrect or has expired.';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function httpError(status, message, extra = {}) {
  return Object.assign(Object.assign(new Error(message), { status, ...(status >= 500 ? { expose: true } : {}) }), extra);
}

function maskEmail(address) {
  const [local, domain] = String(address).split('@');
  if (!domain) return '';
  return `${local[0]}${'*'.repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`;
}

async function issueAccess(share) {
  const accessToken = crypto.randomBytes(32).toString('hex');
  const record = await ShareAccess.create({
    shareId: share.shareId,
    tokenHash: sha256(accessToken),
    emailOk: !share.recipientEmail,
    passwordOk: !share.passwordVerifierHash,
    expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
  });
  return { accessToken, record };
}

async function findAccess(shareId, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  return ShareAccess.findOne({ shareId, tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
}

const isCleared = (share, access) =>
  Boolean(access) && (!share.recipientEmail || access.emailOk) && (!share.passwordVerifierHash || access.passwordOk);

const isGated = (share) => Boolean(share.recipientEmail || share.passwordVerifierHash);

function codePayload(challenge) {
  return {
    sent: true,
    expiresAt: challenge.expiresAt,
    resendAvailableAt: new Date(challenge.lastSentAt.getTime() + limits.SHARE_CODE_RESEND_COOLDOWN_MS),
    resendsLeft: Math.max(0, limits.SHARE_CODE_MAX_RESENDS - challenge.resendCount),
  };
}

async function sendCodeEmail(share, code, ttlMinutes) {
  return sendEmail({ to: share.recipientEmail, ...templates.shareCode({ code, ttlMinutes }) });
}

async function sendShareCode(share, access) {
  if (!share.recipientEmail) throw httpError(400, 'This link does not need a code.');
  const ttlMinutes = otpTtlMinutes();

  const existing = await OtpChallenge.findOne({
    purpose: PURPOSE,
    shareId: share.shareId,
    accessId: String(access._id),
    expiresAt: { $gt: new Date() },
  });

  if (existing) {
    if (existing.resendCount >= limits.SHARE_CODE_MAX_RESENDS) {
      throw httpError(429, 'No more codes can be sent for this visit. Open the link again to start over.');
    }
    const waitMs = existing.lastSentAt.getTime() + limits.SHARE_CODE_RESEND_COOLDOWN_MS - Date.now();
    if (waitMs > 0) {
      throw httpError(429, 'Please wait before requesting another code.', { retryAfterSeconds: Math.ceil(waitMs / 1000) });
    }
  }

  if (!(await consumeBudget({ name: 'share-email', key: share.shareId, max: limits.SHARE_EMAILS_PER_HOUR, windowMs: 3600 * 1000 }))) {
    throw httpError(429, 'Too many codes have been requested for this link. Please try again later.');
  }

  const code = generateCode();
  const salt = newSalt();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  let challenge;
  if (existing) {
    challenge = await OtpChallenge.findOneAndUpdate(
      { _id: existing._id, resendCount: existing.resendCount, lastSentAt: existing.lastSentAt },
      { $set: { codeHash: hashCode(salt, code), salt, lastSentAt: now, expiresAt }, $inc: { resendCount: 1 } },
      { new: true }
    );
    if (!challenge) throw httpError(429, 'Please wait before requesting another code.');
  } else {
    challenge = await OtpChallenge.create({
      userId: share.ownerUserId,
      purpose: PURPOSE,
      shareId: share.shareId,
      accessId: String(access._id),
      codeHash: hashCode(salt, code),
      salt,
      lastSentAt: now,
      expiresAt,
    });
  }

  if (!(await sendCodeEmail(share, code, ttlMinutes))) {
    if (!existing) await OtpChallenge.deleteOne({ _id: challenge._id });
    throw httpError(503, 'We couldn’t send the code email. Please try again shortly.');
  }
  return codePayload(challenge);
}

async function verifyShareCode(share, access, code) {
  const failure = () => httpError(401, CODE_FAILURE);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw failure();

  const challenge = await OtpChallenge.findOneAndUpdate(
    {
      purpose: PURPOSE,
      shareId: share.shareId,
      accessId: String(access._id),
      attempts: { $lt: limits.SHARE_CODE_MAX_ATTEMPTS },
      expiresAt: { $gt: new Date() },
    },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!challenge) throw failure();

  if (!codeMatches(challenge.salt, challenge.codeHash, code)) {
    if (challenge.attempts >= 3) logSecurity('code_failures', { bucket: 'share-email', count: challenge.attempts, subject: String(challenge._id) });
    if (challenge.attempts >= limits.SHARE_CODE_MAX_ATTEMPTS) await OtpChallenge.deleteOne({ _id: challenge._id });
    throw failure();
  }
  const claimed = await OtpChallenge.findOneAndDelete({ _id: challenge._id });
  if (!claimed) throw failure();
  await ShareAccess.updateOne({ _id: access._id }, { $set: { emailOk: true } });
}

module.exports = {
  maskEmail,
  issueAccess,
  findAccess,
  isCleared,
  isGated,
  sendShareCode,
  verifyShareCode,
  sha256,
};
