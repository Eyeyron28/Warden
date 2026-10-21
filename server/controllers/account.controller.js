const crypto = require('crypto');

const User = require('../models/User');
const Session = require('../models/Session');
const TrustedDevice = require('../models/TrustedDevice');
const Device = require('../models/Device');
const { recordEvent } = require('../utils/audit');
const mongoose = require('mongoose');
const { currentTokenHash, clearTrustCookie } = require('../utils/trustedDevice');
const { sendEmail } = require('../utils/email');
const { templates } = require('../utils/emailTemplates');
const { PURPOSES, startChallenge, consumeChallenge, resendChallenge } = require('../utils/otpChallenge');
const { deleteAccountData } = require('../utils/accountDeletion');
const { checkPasswordWithLockout } = require('./auth.controller');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  if (status >= 500) error.expose = true;
  return error;
}

async function currentUser(req) {
  const user = await User.findById(req.userId);
  if (!user) throw httpError(401, 'Session expired or invalid. Please log in again.');
  return user;
}

const deleteChallenge = asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || !password) {
    throw httpError(400, 'Your password is required.');
  }
  const user = await currentUser(req);
  await checkPasswordWithLockout(user, password);

  res.status(200).json(
    await startChallenge({ user, secret: crypto.randomBytes(32), purpose: PURPOSES.deleteAccount })
  );
});

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

const deleteAccount = asyncHandler(async (req, res) => {
  const { challengeToken, code, emailConfirmation } = req.body;
  if (typeof challengeToken !== 'string' || typeof code !== 'string' || typeof emailConfirmation !== 'string') {
    throw httpError(400, 'The code and the account email are required.');
  }

  const user = await User.findById(req.userId);
  if (!user) {
    await Session.deleteMany({ userId: req.userId });
    await deleteAccountData(req.userId);
    clearTrustCookie(req, res, req.userId);
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
    console.error('Account deletion did not finish; it can be retried.');
    throw httpError(500, 'We couldn’t finish deleting your account. Nothing else has changed; please try again.');
  }

  console.log('An account was deleted.');

  await sendEmail({ to: email, ...templates.accountDeleted({ when: new Date() }) }).catch(() => false);

  clearTrustCookie(req, res, req.userId);
  res.status(200).json({ success: true });
});

const listTrustedDevices = asyncHandler(async (req, res) => {
  const mine = currentTokenHash(req, req.userId);
  const rows = await TrustedDevice.find({ userId: req.userId, expiresAt: { $gt: new Date() } });
  const devices = rows
    .map((row) => ({
      id: String(row._id),
      label: row.label,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      current: mine !== null && row.tokenHash === mine,
    }))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.status(200).json({ devices });
});

const removeTrustedDevice = asyncHandler(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw httpError(404, 'Not found.');
  const row = await TrustedDevice.findOne({ _id: req.params.id, userId: req.userId });
  if (!row) throw httpError(404, 'Not found.');
  await TrustedDevice.deleteOne({ _id: row._id, userId: req.userId });
  if (row.deviceId) await Device.updateOne({ _id: row.deviceId, userId: req.userId }, { $set: { trusted: false } });
  if (row.tokenHash === currentTokenHash(req, req.userId)) clearTrustCookie(req, res, req.userId);
  await recordEvent(req, 'trusted_removed', { targetId: row.deviceId || null });
  res.status(204).send();
});

const removeAllTrustedDevices = asyncHandler(async (req, res) => {
  const result = await TrustedDevice.deleteMany({ userId: req.userId });
  await Device.updateMany({ userId: req.userId }, { $set: { trusted: false } });
  clearTrustCookie(req, res, req.userId);
  await recordEvent(req, 'trusted_removed');
  res.status(200).json({ removed: result?.deletedCount ?? 0 });
});

module.exports = {
  deleteChallenge,
  resendDeleteCode,
  deleteAccount,
  listTrustedDevices,
  removeTrustedDevice,
  removeAllTrustedDevices,
};
