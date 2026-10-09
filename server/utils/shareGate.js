const crypto = require('crypto');

const ShareAccess = require('../models/ShareAccess');
const OtpChallenge = require('../models/OtpChallenge');
const User = require('../models/User');
const { sendEmail } = require('./email');
const { templates } = require('./emailTemplates');
const { consumeBudget } = require('../middleware/rateLimit');
const { otpTtlMinutes } = require('./otpConfig');
const { generateCode, newSalt, hashCode, codeMatches } = require('./otp');
const limits = require('./shareLimits');

/**
 * The gates in front of a share's ciphertext: an optional emailed code and an
 * optional password. Neither of them is a key - the share key is still the
 * thing that opens the files, and it still never reaches the server. These
 * only control who the server will HAND the encrypted copies (and, for a
 * password share, the wrapped key) to.
 *
 * A visitor first opens an "access" (an unguessable token, stored hashed,
 * short-lived). Each gate they pass is recorded on it. Ciphertext of a gated
 * share is served only to an access that has passed every gate.
 */

const ACCESS_TTL_MS = limits.ACCESS_TTL_MINUTES * 60 * 1000;
const PURPOSE = 'share-email';
const CODE_FAILURE = 'That code is incorrect or has expired.';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function httpError(status, message, extra = {}) {
  return Object.assign(Object.assign(new Error(message), { status }), extra);
}

/** "j***@example.com": enough to recognise the mailbox, not to reuse it. */
function maskEmail(address) {
  const [local, domain] = String(address).split('@');
  if (!domain) return '';
  return `${local[0]}${'*'.repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`;
}

/** Opens a visitor's access session; returns the token once. */
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

/** The access record for a token on this share, or null. */
async function findAccess(shareId, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  return ShareAccess.findOne({ shareId, tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
}

/** Has this access passed every gate the share has? */
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
  // Only the code. Not the link, not any key, not who shared it, not what was shared.
  return sendEmail({ to: share.recipientEmail, ...templates.shareCode({ code, ttlMinutes }) });
}

/**
 * Emails the visitor a 6-digit code for this share. The first call starts a
 * challenge; later calls are RESENDS (60 s apart, 3 per challenge) that replace
 * the code. Across all visitors a share sends at most 5 code emails per hour.
 */
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
    // Swap in the new code only if nobody else has resent in the meantime.
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

/**
 * Checks a code for this visitor's access. At most 5 guesses per challenge
 * (counted atomically before it is checked, the 5th wrong one deletes it), the
 * code is consumed by use, and every failure is the same 401. Only a
 * share-email challenge for THIS share and THIS access can be used here, so a
 * login or delete-account code never opens anything.
 */
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
    if (challenge.attempts >= limits.SHARE_CODE_MAX_ATTEMPTS) await OtpChallenge.deleteOne({ _id: challenge._id });
    throw failure();
  }
  // Correct: use it up (single use) and record the gate as passed.
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
