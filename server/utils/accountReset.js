const Document = require('../models/Document');
const Folder = require('../models/Folder');
const TrashFolder = require('../models/TrashFolder');
const BackupLog = require('../models/BackupLog');
const PairedDevice = require('../models/PairedDevice');
const PairingToken = require('../models/PairingToken');
const RecoveryRequestToken = require('../models/RecoveryRequestToken');
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

  user.dekFingerprint = fingerprintDEK(dek);
  user.failedAttempts = 0;
  user.lockedUntil = undefined;
  await user.save();
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
  await PairedDevice.deleteMany({ userId });
  await PairingToken.deleteMany({ userId });
  await RecoveryRequestToken.deleteMany({ userId });
  await revokeAllTrustedDevices(userId);
  // Then the data.
  await Document.deleteMany({ userId });
  await TrashFolder.deleteMany({ userId });
  await Folder.deleteMany({ userId });
  await BackupLog.deleteMany({ userId });
}

const NOTICES = {
  'recovery-key':
    'Your Warden password was changed using your recovery key. Your documents were kept.',
  wipe:
    'Your Warden password was reset without your recovery key. Your previous vault was erased and replaced by a new, empty one with a new recovery key.',
};

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
  await RecoveryRequestToken.deleteMany({ userId: user._id });
  clearTrustCookie(req, res);

  const when = new Date().toUTCString();
  const browser = labelFromUserAgent(req.headers?.['user-agent']);
  // Best effort: the reset has happened either way.
  await sendEmail({
    to: user.email,
    subject: 'Your Warden password was changed',
    text:
      `${NOTICES[method] || NOTICES['recovery-key']}\n\n` +
      `When: ${when}\nBrowser: ${browser}\n\n` +
      'Every device that was signed in has been signed out, and trusted browsers were removed. ' +
      'The next login needs your new password and an emailed code.\n\n' +
      (method === 'wipe'
        ? "If this wasn't you, someone can read this mailbox: secure your email account first, then contact whoever runs this Warden."
        : "If this wasn't you, someone has your recovery key. Contact whoever runs this Warden right away, and treat the documents in this vault as exposed."),
  }).catch(() => false);
}

module.exports = { extractRecoverySalt, finalizeReset, wipeVault, finishReset };
