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

/**
 * Forgot password, built around the emailed code:
 *
 *   start   -> a 6-digit "password-reset" code is emailed (same answer for every address)
 *   verify  -> the right code buys a single-use RESET TICKET (never a session)
 *   with-key / wipe -> spend the ticket: re-wrap the vault under a new password
 *              using the recovery key, or erase the vault and start a new one
 *   key-only -> "Try another way": the recovery key alone, no email, strict limits
 *
 * Every successful reset ends in utils/accountReset.js finishReset(): sessions
 * and trusted browsers revoked, pending tickets and codes dropped, owner told.
 * Nobody is logged in by a reset.
 */

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

// A look-alike for addresses with no verified account. The id is derived from
// the address, so repeating the request behaves the way it would for a real
// account (the per-account email limit counts the same way).
function decoyUserId(seed) {
  const digest = crypto.createHash('sha256').update(`warden-reset-decoy:${seed}`).digest();
  return digest.subarray(0, 12).toString('hex');
}

function validateNewPassword(newPassword) {
  if (!newPassword || typeof newPassword !== 'string') throw badRequest('A new password is required.');
  const { valid, errors } = validatePassword(newPassword);
  if (!valid) throw passwordPolicyError(errors);
}

// A fixed, never-matching hash so an unknown address costs the same scrypt work
// as a real one (computed once; only the time it takes matters).
const DUMMY_RECOVERY_HASH = hashRecoveryKey(generateRecoveryKey());
const DUMMY_RECOVERY_KEY = generateRecoveryKey();

// ---- 1. start -------------------------------------------------------------

const startReset = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string') throw badRequest('email is required.');

  const normalized = normalizeRecipient(email);
  const seed = (normalized || email.trim().toLowerCase()).slice(0, MAX_EMAIL_LENGTH);

  const user = normalized ? await User.findOne({ email: normalized }) : null;
  const real = Boolean(user && user.emailVerified);

  // What the challenge key wraps is a throwaway value: a reset code never touches the vault key.
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

// ---- 2. verify the code -> ticket ----------------------------------------

const verifyResetCode = asyncHandler(async (req, res) => {
  const { claimed } = await consumeChallenge({
    challengeToken: req.body.challengeToken,
    code: req.body.code,
    purpose: PURPOSES.passwordReset,
  });
  // A look-alike can never succeed; if one somehow matched, it fails like any wrong code.
  if (claimed.decoy) throw httpError(401, FAILURE_MESSAGE);

  const user = await User.findById(claimed.userId);
  if (!user || !user.emailVerified) throw httpError(401, FAILURE_MESSAGE);

  // One live ticket per account: a newer one replaces any older one.
  await ResetTicket.deleteMany({ userId: user._id });
  const ticket = crypto.randomBytes(TICKET_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
  await ResetTicket.create({ userId: user._id, tokenHash: hashTicket(ticket), expiresAt });

  res.status(200).json({ resetTicket: ticket, expiresAt });
});

// ---- 3. spend the ticket --------------------------------------------------

function ticketFilter(ticket) {
  if (typeof ticket !== 'string' || ticket.length < 20 || ticket.length > 200) return null;
  return { tokenHash: hashTicket(ticket), expiresAt: { $gt: new Date() } };
}

/** Option A: the recovery key keeps the vault. Verify-before-write. */
const resetWithRecoveryKey = asyncHandler(async (req, res) => {
  const { resetTicket, recoveryKey, newPassword } = req.body;
  const filter = ticketFilter(resetTicket);
  if (!filter) throw ticketInvalid();
  if (typeof recoveryKey !== 'string') throw badRequest('Your recovery key is required.');
  // A weak password is a form mistake, not a guess: it does not use up an attempt.
  validateNewPassword(newPassword);

  // Count this attempt BEFORE looking at the key, only against a live ticket with attempts left.
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

  // Single use: only one request can ever claim the ticket and write.
  if (!(await ResetTicket.findOneAndDelete({ _id: ticket._id }))) throw ticketInvalid();

  await finalizeReset(user, dek, newPassword);
  await finishReset(req, res, user, { method: 'recovery-key' });
  res.status(200).json({ success: true, message: 'Password reset. Please log in.' });
});

/**
 * The vault key, if `recoveryKey` really is this account's key - or null. Nothing
 * is written. (Normalising first: spaces, dashes and case are forgiven.)
 */
function recoverDek(user, recoveryKey, { dummy = false } = {}) {
  const normalized = normalizeRecoveryKey(recoveryKey);
  const stored = dummy ? DUMMY_RECOVERY_HASH : user.recoveryKeyHash;
  // Always run the scrypt check, with a placeholder when the input is not even key-shaped.
  const ok = verifyRecoveryKey(normalized || DUMMY_RECOVERY_KEY, stored);
  if (!ok || !normalized || dummy) return null;
  try {
    const kek = deriveEncryptionKey(normalized, extractRecoverySalt(user.recoveryKeyHash));
    const dek = unwrapKey(user.wrappedDEKRecovery, kek, user.wrappedDEKRecoveryIv, user.wrappedDEKRecoveryAuthTag);
    // Defense in depth: the key must open THIS account's vault.
    return fingerprintDEK(dek) === user.dekFingerprint ? dek : null;
  } catch {
    return null;
  }
}

/** Option B: no recovery key - erase the vault, start a new one, show a NEW recovery key once. */
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

  // The ticket proves the mailbox, so this only confirms the person means it.
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

// ---- 4. "Try another way": the recovery key alone -------------------------

// Per email: a short gap after the first attempt, a longer one after the second, longer again after the third, and a lock
// for the hour after the fifth (the delay grows with every attempt). Per IP: 10 an hour.
//
// Every attempt is COUNTED BEFORE its key is looked at (one atomic increment per budget), not after it fails. Checking a
// budget first and recording the failure afterwards let a burst of parallel requests all pass the check before any of them
// had been counted, so the limits did not hold against exactly the caller they are for. An attempt that is over a budget
// is refused without any key work. (A success ends the reset, so counting it costs nothing; the limits for failures are the
// same as before: the 1st attempt opens a 10 s gap, the 2nd a 2 min one, ... the 6th in an hour is refused.)
const KEY_ONLY_EMAIL_BUDGETS = [
  { name: 'rk-gap-10s', max: 1, windowMs: 10 * 1000 },
  { name: 'rk-gap-2m', max: 2, windowMs: 2 * 60 * 1000 },
  { name: 'rk-gap-10m', max: 3, windowMs: 10 * 60 * 1000 },
  { name: 'rk-fail-1h', max: 5, windowMs: 60 * 60 * 1000 },
];
const KEY_ONLY_IP_BUDGETS = [{ name: 'rk-ip-1h', max: 10, windowMs: 60 * 60 * 1000 }];

/** Counts this attempt against every budget, in order, and returns how many seconds to wait (0 = go ahead). */
async function keyOnlyReserve(emailKey, ip) {
  // The connection first: an attempt refused because of the connection must not use up the email's budgets (that would
  // let one noisy address lock an account out from every other address).
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
      break; // the later budgets are not charged for an attempt that is already refused
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

  // Counted first, atomically, then checked (see the budgets above).
  const wait = await keyOnlyReserve(emailKey, ip);
  if (wait > 0) {
    throw httpError(429, 'Too many attempts. Please try again later.', { retryAfterSeconds: wait });
  }

  const user = await User.findOne({ email: emailKey });
  const real = Boolean(user && user.emailVerified);
  // The same scrypt work whether or not the account exists.
  const dek = real ? recoverDek(user, recoveryKey) : recoverDek({}, recoveryKey, { dummy: true });
  if (!real || !dek) {
    throw keyOnlyFailure();
  }

  await finalizeReset(user, dek, newPassword);
  await finishReset(req, res, user, { method: 'recovery-key' });
  res.status(200).json({ success: true, message: 'Password reset. Please log in.' });
});

// ---- the removed emailed-link flow ----------------------------------------

// Old links in earlier emails (and old clients) land here: nothing is looked up
// and nothing says whether the token ever existed.
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
