const OtpChallenge = require('../models/OtpChallenge');
const { sendEmail } = require('./email');
const { logSecurity } = require('./securityLog');
const { templates } = require('./emailTemplates');
const { consumeBudget } = require('../middleware/rateLimit');
const { otpTtlMinutes } = require('./otpConfig');
const { wrapKey, unwrapKey } = require('./crypto');
const {
  generateCode,
  newSalt,
  hashCode,
  codeMatches,
  newChallengeKey,
  parseChallengeToken,
  buildChallengeToken,
} = require('./otp');

const PURPOSES = { login: 'login', deleteAccount: 'delete-account', passwordReset: 'password-reset', emergencySetup: 'emergency-setup' };

const MAX_ATTEMPTS = 5;
const MAX_RESENDS = 3;
const RESEND_COOLDOWN_MS = 60 * 1000;
const EMAILS_PER_HOUR = 5;
const EMAIL_WINDOW_MS = 60 * 60 * 1000;

const FAILURE_MESSAGE = 'That code is incorrect or has expired.';

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
  if (status >= 500) error.expose = true;
  return Object.assign(error, extra);
}

const failure = () => httpError(401, FAILURE_MESSAGE);
const tooManyEmails = () =>
  httpError(429, 'Too many codes have been requested for this account. Please try again later.');
const emailNotSent = () => httpError(503, 'We couldn’t send the code email. Please try again shortly.');

function emailFor(purpose, code, ttlMinutes) {
  const input = { code, ttlMinutes };
  if (purpose === PURPOSES.passwordReset) return templates.passwordResetCode(input);
  if (purpose === PURPOSES.deleteAccount) return templates.deleteAccountCode(input);
  if (purpose === PURPOSES.emergencySetup) return templates.emergencyOwnerSetupCode(input);
  return templates.signInCode(input);
}

let sendMs = null;
const noteSendDuration = (ms) => {
  sendMs = sendMs === null ? ms : sendMs * 0.7 + ms * 0.3;
};
const expectedSendMs = () => (sendMs === null ? (process.env.SMTP_HOST ? 700 : 0) : sendMs);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function payload(challenge, challengeKey) {
  return {
    otpRequired: true,
    challengeToken: buildChallengeToken(String(challenge._id), challengeKey),
    codeLength: 6,
    expiresAt: challenge.expiresAt,
    resendAvailableAt: new Date(challenge.lastSentAt.getTime() + RESEND_COOLDOWN_MS),
    resendsLeft: Math.max(0, MAX_RESENDS - challenge.resendCount),
  };
}

function spendEmailBudget(userId) {
  return consumeBudget({
    name: 'otp-email-account',
    key: String(userId),
    max: EMAILS_PER_HOUR,
    windowMs: EMAIL_WINDOW_MS,
  });
}

async function startChallenge({ user, secret, purpose, decoy = false, accessId = null }) {
  const ttlMinutes = otpTtlMinutes();
  if (!(await spendEmailBudget(user._id))) throw tooManyEmails();

  const code = generateCode();
  const salt = newSalt();
  const challengeKey = newChallengeKey();
  const wrapped = wrapKey(secret, challengeKey);
  const now = new Date();

  const challenge = await OtpChallenge.create({
    userId: user._id,
    purpose,
    decoy,
    ...(accessId ? { accessId } : {}),
    codeHash: hashCode(salt, code),
    salt,
    lastSentAt: now,
    wrappedDek: wrapped.wrappedKey,
    wrappedDekIv: wrapped.iv,
    wrappedDekAuthTag: wrapped.authTag,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
  });

  if (decoy) {
    await wait(expectedSendMs() * (0.85 + Math.random() * 0.3));
    return payload(challenge, challengeKey);
  }
  const message = emailFor(purpose, code, ttlMinutes);
  const startedAt = Date.now();
  if (!(await sendEmail({ to: user.email, ...message }))) {
    await OtpChallenge.deleteOne({ _id: challenge._id });
    throw emailNotSent();
  }
  noteSendDuration(Date.now() - startedAt);
  return payload(challenge, challengeKey);
}

async function consumeChallenge({ challengeToken, code, purpose, userId }) {
  const parsed = parseChallengeToken(challengeToken);
  if (!parsed || typeof code !== 'string') throw failure();

  const filter = {
    _id: parsed.challengeId,
    purpose,
    attempts: { $lt: MAX_ATTEMPTS },
    expiresAt: { $gt: new Date() },
  };
  if (userId) filter.userId = userId;

  const challenge = await OtpChallenge.findOneAndUpdate(filter, { $inc: { attempts: 1 } }, { new: true });
  if (!challenge) {
    await OtpChallenge.deleteOne({
      _id: parsed.challengeId,
      $or: [{ attempts: { $gte: MAX_ATTEMPTS } }, { expiresAt: { $lte: new Date() } }],
    });
    throw failure();
  }

  if (!codeMatches(challenge.salt, challenge.codeHash, code)) {
    if (challenge.attempts >= 3) logSecurity('code_failures', { bucket: challenge.purpose, count: challenge.attempts, subject: String(challenge._id) });
    if (challenge.attempts >= MAX_ATTEMPTS) await OtpChallenge.deleteOne({ _id: challenge._id });
    throw failure();
  }

  const claimed = await OtpChallenge.findOneAndDelete({ _id: challenge._id });
  if (!claimed) throw failure();

  let secret;
  try {
    secret = unwrapKey(claimed.wrappedDek, parsed.challengeKey, claimed.wrappedDekIv, claimed.wrappedDekAuthTag);
  } catch {
    throw failure();
  }
  return { claimed, secret };
}

async function resendChallenge({ challengeToken, purpose, userId, findUser }) {
  const parsed = parseChallengeToken(challengeToken);
  if (!parsed) throw failure();

  const lookup = { _id: parsed.challengeId, purpose, expiresAt: { $gt: new Date() } };
  if (userId) lookup.userId = userId;
  const challenge = await OtpChallenge.findOne(lookup);
  if (!challenge) throw failure();
  try {
    unwrapKey(challenge.wrappedDek, parsed.challengeKey, challenge.wrappedDekIv, challenge.wrappedDekAuthTag);
  } catch {
    throw failure();
  }

  if (challenge.resendCount >= MAX_RESENDS) {
    throw httpError(429, 'No more codes can be sent for this login. Go back and start again.');
  }
  const waitMs = challenge.lastSentAt.getTime() + RESEND_COOLDOWN_MS - Date.now();
  if (waitMs > 0) {
    throw httpError(429, 'Please wait before requesting another code.', {
      retryAfterSeconds: Math.ceil(waitMs / 1000),
    });
  }

  const user = challenge.decoy ? { _id: challenge.userId } : await findUser(challenge.userId);
  if (!user) throw failure();
  if (!(await spendEmailBudget(user._id))) throw tooManyEmails();

  const ttlMinutes = otpTtlMinutes();
  const code = generateCode();
  const salt = newSalt();
  const now = new Date();
  const updated = await OtpChallenge.findOneAndUpdate(
    { _id: challenge._id, resendCount: challenge.resendCount, lastSentAt: challenge.lastSentAt },
    {
      $set: {
        codeHash: hashCode(salt, code),
        salt,
        lastSentAt: now,
        expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
      },
      $inc: { resendCount: 1 },
    },
    { new: true }
  );
  if (!updated) throw failure();

  if (challenge.decoy) {
    await wait(expectedSendMs() * (0.85 + Math.random() * 0.3));
    return payload(updated, parsed.challengeKey);
  }
  const startedAt = Date.now();
  if (!(await sendEmail({ to: user.email, ...emailFor(purpose, code, ttlMinutes) }))) throw emailNotSent();
  noteSendDuration(Date.now() - startedAt);
  return payload(updated, parsed.challengeKey);
}

module.exports = {
  PURPOSES,
  FAILURE_MESSAGE,
  expectedSendMs,
  startChallenge,
  consumeChallenge,
  resendChallenge,
};
