const OtpChallenge = require('../models/OtpChallenge');
const { sendEmail } = require('./email');
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

/**
 * Emailed one-time-code challenges, shared by everything that needs one.
 *
 * Every challenge has a PURPOSE, stored on the record and part of every
 * lookup, so a code issued for one thing can never satisfy another: a login
 * code cannot authorise deleting an account and a delete-account code cannot
 * log anyone in (each consumer asks for its own purpose, and the lookup then
 * simply finds nothing).
 *
 * The challengeKey is never stored; it exists only inside the challengeToken
 * (`<challengeId>.<challengeKey>`) given to the browser. What the key wraps
 * depends on the purpose: the vault key for a login (so no session exists
 * until the code is right), a throwaway random value for deletion (a delete
 * challenge never involves the vault key at all).
 */

const PURPOSES = { login: 'login', deleteAccount: 'delete-account', passwordReset: 'password-reset' };

const MAX_ATTEMPTS = 5; // guesses per challenge, then it is deleted
const MAX_RESENDS = 3; // per challenge
const RESEND_COOLDOWN_MS = 60 * 1000;
const EMAILS_PER_HOUR = 5; // per account, across all challenges and purposes
const EMAIL_WINDOW_MS = 60 * 60 * 1000;

// One message for every way a code check can fail - wrong, expired, too many
// tries, already used, wrong purpose, unknown or tampered challenge.
const FAILURE_MESSAGE = 'That code is incorrect or has expired.';

function httpError(status, message, extra = {}) {
  const error = new Error(message);
  error.status = status;
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
  return templates.signInCode(input);
}

// How long a real send takes (smoothed), so the look-alike made for an address
// with no account can wait about as long and the two cannot be told apart by timing.
let sendMs = null;
const noteSendDuration = (ms) => {
  sendMs = sendMs === null ? ms : sendMs * 0.7 + ms * 0.3;
};
const expectedSendMs = () => (sendMs === null ? (process.env.SMTP_HOST ? 700 : 0) : sendMs);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

function payload(challenge, challengeKey) {
  return {
    otpRequired: true,
    // <challengeId>.<challengeKey>. The key is not stored on the server.
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

/**
 * Creates a challenge and emails the code.
 * @param {{ user: { _id: any, email: string }, secret: Buffer, purpose: string }} args
 *   `secret` is what the challengeKey wraps (the DEK for logins).
 * @returns the payload to hand to the browser
 */
async function startChallenge({ user, secret, purpose, decoy = false }) {
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
    codeHash: hashCode(salt, code),
    salt,
    lastSentAt: now,
    wrappedDek: wrapped.wrappedKey,
    wrappedDekIv: wrapped.iv,
    wrappedDekAuthTag: wrapped.authTag,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60 * 1000),
  });

  if (decoy) {
    // Nothing is sent and the code is thrown away; only the time is matched.
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

/**
 * Checks a submitted code and, if right, CONSUMES the challenge (single use)
 * and returns what it wrapped. At most 5 guesses per challenge, each counted
 * atomically before it is checked; the 5th wrong one deletes it. Every
 * failure throws the same 401. `userId`, when given, must also match (delete
 * challenges belong to one signed-in account).
 *
 * @returns {Promise<{ claimed: object, secret: Buffer }>}
 */
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

  // Count this guess BEFORE looking at it, and only against a challenge that
  // is still alive, of this purpose, and not out of attempts.
  const challenge = await OtpChallenge.findOneAndUpdate(filter, { $inc: { attempts: 1 } }, { new: true });
  if (!challenge) {
    // Missing, expired or out of attempts: make sure a dead one is gone. Only
    // when it is really dead - never delete a live challenge of another
    // purpose or owner just because someone presented its id.
    await OtpChallenge.deleteOne({
      _id: parsed.challengeId,
      $or: [{ attempts: { $gte: MAX_ATTEMPTS } }, { expiresAt: { $lte: new Date() } }],
    });
    throw failure();
  }

  if (!codeMatches(challenge.salt, challenge.codeHash, code)) {
    if (challenge.attempts >= MAX_ATTEMPTS) await OtpChallenge.deleteOne({ _id: challenge._id });
    throw failure();
  }

  // Correct code: claim the challenge. Only one request can ever get it.
  const claimed = await OtpChallenge.findOneAndDelete({ _id: challenge._id });
  if (!claimed) throw failure();

  let secret;
  try {
    secret = unwrapKey(claimed.wrappedDek, parsed.challengeKey, claimed.wrappedDekIv, claimed.wrappedDekAuthTag);
  } catch {
    // A challengeKey that does not match (tampered, or from another login).
    throw failure();
  }
  return { claimed, secret };
}

/**
 * A new code for the same challenge; the previous code stops working. 60
 * seconds between sends, 3 resends per challenge, 5 emails per hour per
 * account. The caller must hold the challenge key, so an id alone cannot make
 * the server send mail.
 *
 * @param {{ challengeToken: string, purpose: string, userId?: any, findUser: (id: any) => Promise<any> }} args
 */
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
  // Swap in the new code only if nobody else has resent in the meantime.
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
