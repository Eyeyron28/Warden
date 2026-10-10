const User = require('../models/User');
const Document = require('../models/Document');
const Folder = require('../models/Folder');
const TrashFolder = require('../models/TrashFolder');
const BackupLog = require('../models/BackupLog');
const OtpChallenge = require('../models/OtpChallenge');
const ResetTicket = require('../models/ResetTicket');
const {
  generateSalt,
  hashPassword,
  deriveEncryptionKey,
  fingerprintDEK,
  wrapKey,
  hashRecoveryKey,
} = require('./crypto');
const { removeShares } = require('./shareCleanup');
const { destroyAllSessionsForUser } = require('./sessionStore');
const { revokeAllTrustedDevices, clearTrustCookie, labelFromUserAgent } = require('./trustedDevice');
const { sendEmail } = require('./email');
const { templates } = require('./emailTemplates');
const { recordEvent } = require('./audit');
const Device = require('../models/Device');
const AuditEvent = require('../models/AuditEvent');
const ReminderLog = require('../models/ReminderLog');
const { cleanupForUser: cleanupEmergencyAccess, invalidateForKeyChange } = require('./emergency/service');

/**
 * What every password reset ends with, whichever way it started (recovery key
 * after an emailed code, "start over", recovery key alone, phone recovery).
 */

// The recovery key's own salt isn't stored in a separate field - it's
// embedded in recoveryKeyHash as `${salt}:${hash}` (see hashRecoveryKey)
// and doubles as the salt used to derive the recovery-key KEK.
function extractRecoverySalt(recoveryKeyHash) {
  return recoveryKeyHash.split(':')[0];
}

/**
 * Re-wrap `dek` under a freshly-derived password KEK and replace
 * wrappedDEKPassword/passwordHash/salt, and clear any active lockout. If
 * `newRecoveryKey` is given, also replaces recoveryKeyHash/wrappedDEKRecovery
 * (the start-over path, where the OLD recovery key would otherwise keep
 * "working" while unwrapping a vault key that no longer exists).
 *
 * Callers MUST have already verified `dek` is correct for this account
 * before calling this (or, for the start-over path, generated it fresh
 * themselves) - this function only writes.
 */
async function finalizeReset(user, dek, newPassword, { newRecoveryKey } = {}) {
  const newSalt = generateSalt();
  const newPasswordHash = hashPassword(newPassword, newSalt);
  const newPasswordKek = deriveEncryptionKey(newPassword, newSalt);
  const rewrappedPassword = wrapKey(dek, newPasswordKek);

  user.salt = newSalt;
  user.passwordHash = newPasswordHash;
  user.wrappedDEKPassword = rewrappedPassword.wrappedKey;
  user.wrappedDEKPasswordIv = rewrappedPassword.iv;
  user.wrappedDEKPasswordAuthTag = rewrappedPassword.authTag;

  if (newRecoveryKey) {
    const recoveryKeyHash = hashRecoveryKey(newRecoveryKey);
    const recoverySalt = extractRecoverySalt(recoveryKeyHash);
    const recoveryKek = deriveEncryptionKey(newRecoveryKey, recoverySalt);
    const wrappedRecovery = wrapKey(dek, recoveryKek);

    user.recoveryKeyHash = recoveryKeyHash;
    user.wrappedDEKRecovery = wrappedRecovery.wrappedKey;
    user.wrappedDEKRecoveryIv = wrappedRecovery.iv;
    user.wrappedDEKRecoveryAuthTag = wrappedRecovery.authTag;
  }

  // A password change or a new recovery key re-wraps the SAME vault key, so Emergency Access (wrapped under its own
  // key) keeps working. If the vault key itself is different from the one on record, the old setup can never open
  // this vault: remove it and tell the owner.
  const newFingerprint = fingerprintDEK(dek);
  const keyChanged = Boolean(user.dekFingerprint) && user.dekFingerprint !== newFingerprint;
  user.dekFingerprint = newFingerprint;
  user.failedAttempts = 0;
  user.lockedUntil = undefined;
  await user.save();
  if (keyChanged) await invalidateForKeyChange(user._id);
}

/**
 * The "start over" erase: everything the server holds for this account's
 * vault, in an order that can simply be run again if it is interrupted (every
 * step is a delete-by-filter). The account itself (email, verified state)
 * stays; its vault key, recovery key and password are replaced by the caller.
 *
 * Documents carry the ciphertext AND the encrypted thumbnails; Trash is the
 * same collection plus TrashFolder entries.
 */
async function wipeVault(userId) {
  // Anything that grants access to the old vault first.
  await removeShares({ ownerUserId: userId });
  await revokeAllTrustedDevices(userId);
  // Then the data.
  await Document.deleteMany({ userId });
  await TrashFolder.deleteMany({ userId });
  await Folder.deleteMany({ userId });
  await BackupLog.deleteMany({ userId });
  // The devices and the activity log belong to the old vault too, and the chain starts again.
  await Device.deleteMany({ userId });
  await AuditEvent.deleteMany({ userId });
  await ReminderLog.deleteMany({ userId });
  // Emergency Access belonged to the old vault key: the setup, its requests and any open emergency session go too.
  await cleanupEmergencyAccess(userId);
  await User.updateOne({ _id: userId }, { $set: { auditHead: { seq: 0, hash: '', at: null } } });
}

/**
 * After ANY successful reset: nothing from before the reset keeps working, this
 * browser's "trusted" cookie goes too, and the owner is told. Does NOT log
 * anyone in - the person goes back to the login page and uses the new password
 * plus the normal emailed code.
 *
 * The notification contains no link and no token: just what happened, when, and
 * from what kind of browser (never an IP address).
 */
async function finishReset(req, res, user, { method }) {
  await destroyAllSessionsForUser(user._id); // sessions (and, with them, trusted browsers)
  await revokeAllTrustedDevices(user._id);
  await ResetTicket.deleteMany({ userId: user._id });
  await OtpChallenge.deleteMany({ userId: user._id });
  clearTrustCookie(req, res, user._id);

  const browser = labelFromUserAgent(req.headers?.['user-agent']);
  // Best effort: the reset has happened either way.
  await recordEvent(req, 'password_changed', { userId: user._id, deviceId: null });
  await sendEmail({ to: user.email, ...templates.passwordChanged({ method, when: new Date(), browser }) }).catch(() => false);
}

module.exports = { extractRecoverySalt, finalizeReset, wipeVault, finishReset };
