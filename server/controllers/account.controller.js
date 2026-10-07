const crypto = require('crypto');

const User = require('../models/User');
const Session = require('../models/Session');
const { sendEmail } = require('../utils/email');
const { PURPOSES, startChallenge, consumeChallenge, resendChallenge } = require('../utils/otpChallenge');
const { deleteAccountData } = require('../utils/accountDeletion');
const { checkPasswordWithLockout } = require('./auth.controller');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function currentUser(req) {
  const user = await User.findById(req.userId);
  // A valid session for an account that no longer exists can only be left
  // over from an interrupted deletion; there is nothing to authorise.
  if (!user) throw httpError(401, 'Session expired or invalid. Please log in again.');
  return user;
}

/**
 * POST /api/account/delete-challenge
 * requireSession. Body: { password }
 * Step 1 of deleting an account: the master password is checked AGAIN (with
 * the same lockout as login), then a code is emailed. This code is for
 * deletion only - it cannot be used to log in, and a login code cannot be
 * used here (utils/otpChallenge.js keeps them apart by purpose). Nothing is
 * deleted by this call.
 */
const deleteChallenge = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || !password) {
    throw httpError(400, 'Your password is required.');
  }
  const user = await currentUser(req);
  await checkPasswordWithLockout(user, password);

  // A delete challenge never involves the vault key: what the challenge key
  // wraps is a throwaway random value.
  res.status(200).json(
    await startChallenge({ user, secret: crypto.randomBytes(32), purpose: PURPOSES.deleteAccount })
  );
});

/**
 * POST /api/account/resend-delete-code
 * requireSession. Body: { challengeToken }
 */
const resendDeleteCode = asyncHandler(async (req, res) => {
  res.status(200).json(
    await resendChallenge({
      challengeToken: req.body.challengeToken,
      purpose: PURPOSES.deleteAccount,
      userId: req.userId,
      findUser: (id) => User.findById(id),
    })
  );
});

/**
 * DELETE /api/account
 * requireSession. Body: { challengeToken, code, emailConfirmation }
 * Permanently deletes the account and everything it owns. Needs ALL of: the
 * session, a delete-account code (single use, 5 guesses), and the account's
 * email typed exactly. The email is checked first, so a typo does not burn a
 * code attempt. Safe to retry: see utils/accountDeletion.js.
 */
const deleteAccount = asyncHandler(async (req, res) => {
  const { challengeToken, code, emailConfirmation } = req.body;
  if (typeof challengeToken !== 'string' || typeof code !== 'string' || typeof emailConfirmation !== 'string') {
    throw httpError(400, 'The code and the account email are required.');
  }

  const user = await User.findById(req.userId);
  if (!user) {
    // An earlier attempt got as far as removing the account but not every
    // leftover: finish the cleanup. Nothing here can touch anyone else.
    await Session.deleteMany({ userId: req.userId });
    await deleteAccountData(req.userId);
    res.status(200).json({ success: true });
    return;
  }

  if (emailConfirmation.trim().toLowerCase() !== user.email) {
    throw httpError(400, 'The email you typed does not match this account.');
  }

  await consumeChallenge({
    challengeToken,
    code,
    purpose: PURPOSES.deleteAccount,
    userId: req.userId,
  });

  const email = user.email;
  try {
    await deleteAccountData(user._id, { email });
  } catch (err) {
    // Whatever was removed stays removed; the rest is untouched and the whole
    // operation can simply be run again (with a new code).
    console.error('Account deletion did not finish; it can be retried.');
    throw httpError(500, 'We couldn’t finish deleting your account. Nothing else has changed; please try again.');
  }

  // No email address, id or content in the log.
  console.log('An account was deleted.');

  // Best effort, and never allowed to undo the deletion. We can only promise
  // what the server held; this message is not a copy of any of it.
  await sendEmail({
    to: email,
    subject: 'Your Warden account has been deleted',
    text:
      'Your Warden account and all of its data have been permanently deleted. ' +
      'We have no copy of your documents and cannot recover them. ' +
      'This message is only a confirmation; if you did not do this, contact us right away.',
  }).catch(() => false);

  res.status(200).json({ success: true });
});

module.exports = { deleteChallenge, resendDeleteCode, deleteAccount };
