const crypto = require('crypto');

const User = require('../models/User');
const ResetTicket = require('../models/ResetTicket');
const {
  deriveEncryptionKey,
  generateDEK,
  fingerprintDEK,
  unwrapKey,
  generateRecoveryKey,
  normalizeRecoveryKey,
  hashRecoveryKey,
  verifyRecoveryKey,
} = require('../utils/crypto');
const { validatePassword } = require('../utils/passwordPolicy');
const { normalizeRecipient } = require('../utils/email');
const { PURPOSES, startChallenge, consumeChallenge, resendChallenge, FAILURE_MESSAGE } = require('../utils/otpChallenge');
const { extractRecoverySalt, finalizeReset, wipeVault, finishReset } = require('../utils/accountReset');
const { consumeBudget, budgetRetryAfterSeconds } = require('../middleware/rateLimit');
const { ipKey } = require('../utils/clientIp');

const GENERIC_START_MESSAGE = "If an account exists for this address, we've sent a 6-digit code.";
const TICKET_BYTES = 32;
const TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_TICKET_ATTEMPTS = 5;
const MAX_EMAIL_LENGTH = 254;

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status, ...(status >= 500 ? { expose: true } : {}) }, extra);
}
const badRequest = (message) => httpError(400, message);
const passwordPolicyError = (errors) => httpError(400, 'Password does not meet the security requirements.', { errors });
const ticketInvalid = () =>
  httpError(401, 'This reset session is invalid or has expired. Please start again.', { code: 'RESET_TICKET_INVALID' });
const ticketDead = () =>
  httpError(401, 'Too many incorrect recovery keys. Please start again.', { code: 'RESET_TICKET_INVALID' });
const wrongRecoveryKey = () => httpError(401, 'That recovery key is incorrect. Nothing was changed.');
const keyOnlyFailure = () => httpError(401, 'The email or recovery key is incorrect.');

const hashTicket = (ticket) => crypto.createHash('sha256').update(ticket).digest('hex');

function decoyUserId(seed) {
  const digest = crypto.createHash('sha256').update(`warden-reset-decoy:${seed}`).digest();
  return digest.subarray(0, 12).toString('hex');
}

function validateNewPassword(newPassword) {
  if (!newPassword || typeof newPassword !== 'string') throw badRequest('A new password is required.');
  const { valid, errors } = validatePassword(newPassword);
  if (!valid) throw passwordPolicyError(errors);
}

const DUMMY_RECOVERY_HASH = hashRecoveryKey(generateRecoveryKey());
const DUMMY_RECOVERY_KEY = generateRecoveryKey();

const startReset = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string') throw badRequest('email is required.');

  const normalized = normalizeRecipient(email);
  const seed = (normalized || email.trim().toLowerCase()).slice(0, MAX_EMAIL_LENGTH);

  const user = normalized ? await User.findOne({ email: normalized }) : null;
  const real = Boolean(user && user.emailVerified);

  const challenge = real
    ? await startChallenge({ user, secret: crypto.randomBytes(32), purpose: PURPOSES.passwordReset })
    : await startChallenge({
        user: { _id: decoyUserId(seed), email: seed },
        secret: crypto.randomBytes(32),
        purpose: PURPOSES.passwordReset,
        decoy: true,
      });

  res.status(200).json({ message: GENERIC_START_MESSAGE, ...challenge });
});

const resendResetCode = asyncHandler(async (req, res) => {
  res.status(200).json(
    await resendChallenge({
      challengeToken: req.body.challengeToken,
      purpose: PURPOSES.passwordReset,
      findUser: (id) => User.findById(id),
    })
  );
});

const verifyResetCode = asyncHandler(async (req, res) => {
  const { claimed } = await consumeChallenge({
    challengeToken: req.body.challengeToken,
    code: req.body.code,
    purpose: PURPOSES.passwordReset,
  });
  if (claimed.decoy) throw httpError(401, FAILURE_MESSAGE);

  const user = await User.findById(claimed.userId);
  if (!user || !user.emailVerified) throw httpError(401, FAILURE_MESSAGE);

  await ResetTicket.deleteMany({ userId: user._id });
  const ticket = crypto.randomBytes(TICKET_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
  await ResetTicket.create({ userId: user._id, tokenHash: hashTicket(ticket), expiresAt });

  res.status(200).json({ resetTicket: ticket, expiresAt });
});

function ticketFilter(ticket) {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 200) return null;
  return { tokenHash: hashTicket(ticket), expiresAt: { $gt: new Date() } };
}

const resetWithRecoveryKey = asyncHandler(async (req, res) => {
  const { resetTicket, recoveryKey, newPassword } = req.body;
  const filter = ticketFilter(resetTicket);
  if (!filter) throw ticketInvalid();
  if (typeof recoveryKey !== 'string') throw badRequest('Your recovery key is required.');
  validateNewPassword(newPassword);

  const ticket = await ResetTicket.findOneAndUpdate(
    { ...filter, attempts: { $lt: MAX_TICKET_ATTEMPTS } },
    { $inc: { attempts: 1 } },
    { new: true }
  );
  if (!ticket) {
    await ResetTicket.deleteMany({ ...filter, attempts: { $gte: MAX_TICKET_ATTEMPTS } });
    throw ticketInvalid();
  }

  const fail = async () => {
    if (ticket.attempts >= MAX_TICKET_ATTEMPTS) {
      await ResetTicket.deleteOne({ _id: ticket._id });
      throw ticketDead();
    }
    throw wrongRecoveryKey();
  };

  const user = await User.findById(ticket.userId);
  if (!user || !user.emailVerified) {
    await ResetTicket.deleteOne({ _id: ticket._id });
    throw ticketInvalid();
  }

  const dek = recoverDek(user, recoveryKey);
  if (!dek) return fail();

  if (!(await ResetTicket.findOneAndDelete({ _id: ticket._id }))) throw ticketInvalid();

  await finalizeReset(user, dek, newPassword);
  await finishReset(req, res, user, { method: 'recovery-key' });
  res.status(200).json({ success: true, message: 'Password reset. Please log in.' });
});

function recoverDek(user, recoveryKey, { dummy = false } = {}) {
  const normalized = normalizeRecoveryKey(recoveryKey);
  const stored = dummy ? DUMMY_RECOVERY_HASH : user.recoveryKeyHash;
  const ok = verifyRecoveryKey(normalized || DUMMY_RECOVERY_KEY, stored);
  if (!ok || !normalized || dummy) return null;
  try {
    const kek = deriveEncryptionKey(normalized, extractRecoverySalt(user.recoveryKeyHash));
    const dek = unwrapKey(user.wrappedDEKRecovery, kek, user.wrappedDEKRecoveryIv, user.wrappedDEKRecoveryAuthTag);
    return fingerprintDEK(dek) === user.dekFingerprint ? dek : null;
  } catch {
    return null;
  }
}

const resetWithWipe = asyncHandler(async (req, res) => {
  const { resetTicket, confirmEmail, newPassword } = req.body;
  const filter = ticketFilter(resetTicket);
  if (!filter) throw ticketInvalid();
  if (typeof confirmEmail !== 'string') throw badRequest('Type your account email to confirm.');
  validateNewPassword(newPassword);

  const ticket = await ResetTicket.findOne(filter);
  if (!ticket) throw ticketInvalid();
  const user = await User.findById(ticket.userId);
  if (!user || !user.emailVerified) throw ticketInvalid();

  if (confirmEmail.trim().toLowerCase() !== user.email) {
    throw badRequest('The email you typed does not match this account.');
  }

  if (!(await ResetTicket.findOneAndDelete({ _id: ticket._id }))) throw ticketInvalid();

  const dek = generateDEK();
  const newRecoveryKey = generateRecoveryKey();
  await wipeVault(user._id);
  await finalizeReset(user, dek, newPassword, { newRecoveryKey });
  await finishReset(req, res, user, { method: 'wipe' });

  res.status(200).json({ success: true, message: 'Password reset. Please log in.', recoveryKey: newRecoveryKey, documentsWiped: true });
});

const KEY_ONLY_EMAIL_BUDGETS = [
  { name: 'rk-gap-10s', max: 1, windowMs: 10 * 1000 },
  { name: 'rk-gap-2m', max: 2, windowMs: 2 * 60 * 1000 },
  { name: 'rk-gap-10m', max: 3, windowMs: 10 * 60 * 1000 },
  { name: 'rk-fail-1h', max: 5, windowMs: 60 * 60 * 1000 },
];
const KEY_ONLY_IP_BUDGETS = [{ name: 'rk-ip-1h', max: 10, windowMs: 60 * 60 * 1000 }];

async function keyOnlyReserve(emailKey, ip) {
  const budgets = [
    ...KEY_ONLY_IP_BUDGETS.map((b) => ({ ...b, key: ip })),
    ...KEY_ONLY_EMAIL_BUDGETS.map((b) => ({ ...b, key: emailKey })),
  ];
  let wait = 0;
  for (const b of budgets) {
    // eslint-disable-next-line no-await-in-loop
    const allowed = await consumeBudget({ name: b.name, key: b.key, max: b.max, windowMs: b.windowMs });
    if (!allowed) {
      // eslint-disable-next-line no-await-in-loop
      wait = Math.max(wait, await budgetRetryAfterSeconds({ name: b.name, key: b.key, max: b.max }));
      break;
    }
  }
  return wait;
}

const resetWithRecoveryKeyOnly = asyncHandler(async (req, res) => {
  const { email, recoveryKey, newPassword } = req.body;
  if (typeof email !== 'string' || typeof recoveryKey !== 'string') {
    throw badRequest('Your email and recovery key are required.');
  }
  validateNewPassword(newPassword);

  const emailKey = (normalizeRecipient(email) || email.trim().toLowerCase()).slice(0, MAX_EMAIL_LENGTH);
  const ip = ipKey(req.ip);

  const wait = await keyOnlyReserve(emailKey, ip);
  if (wait > 0) {
    throw httpError(429, 'Too many attempts. Please try again later.', { retryAfterSeconds: wait });
  }

  const user = await User.findOne({ email: emailKey });
  const real = Boolean(user && user.emailVerified);
  const dek = real ? recoverDek(user, recoveryKey) : recoverDek({}, recoveryKey, { dummy: true });
  if (!real || !dek) {
    throw keyOnlyFailure();
  }

  await finalizeReset(user, dek, newPassword);
  await finishReset(req, res, user, { method: 'recovery-key' });
  res.status(200).json({ success: true, message: 'Password reset. Please log in.' });
});

const goneResetLink = (req, res) => {
  res.status(410).json({
    success: false,
    error: { message: 'This way of resetting a password has been replaced. Go to "Forgot password" to get a new code.' },
  });
};

module.exports = {
  startReset,
  resendResetCode,
  verifyResetCode,
  resetWithRecoveryKey,
  resetWithWipe,
  resetWithRecoveryKeyOnly,
  goneResetLink,
  GENERIC_START_MESSAGE,
  MAX_TICKET_ATTEMPTS,
  // exported for tests
  KEY_ONLY_EMAIL_BUDGETS,
};
