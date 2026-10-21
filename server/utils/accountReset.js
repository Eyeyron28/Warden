const User = require('../models/User');
const Document = require('../models/Document');
const DocumentVersion = require('../models/DocumentVersion');
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
const { clearLoginFailures } = require('./loginLimiter');

function extractRecoverySalt(recoveryKeyHash) {
  return recoveryKeyHash.split(':')[0];
}

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

  const newFingerprint = fingerprintDEK(dek);
  const keyChanged = Boolean(user.dekFingerprint) && user.dekFingerprint !== newFingerprint;
  user.dekFingerprint = newFingerprint;
  user.failedAttempts = 0;
  user.lockedUntil = undefined;
  await user.save();
  await clearLoginFailures(user.email);
  if (keyChanged) await invalidateForKeyChange(user._id);
}

async function wipeVault(userId) {
  await removeShares({ ownerUserId: userId });
  await revokeAllTrustedDevices(userId);
  await Document.deleteMany({ userId });
  await DocumentVersion.deleteMany({ userId });
  await TrashFolder.deleteMany({ userId });
  await Folder.deleteMany({ userId });
  await BackupLog.deleteMany({ userId });
  await Device.deleteMany({ userId });
  await AuditEvent.deleteMany({ userId });
  await ReminderLog.deleteMany({ userId });
  await cleanupEmergencyAccess(userId);
  await User.updateOne({ _id: userId }, { $set: { auditHead: { seq: 0, hash: '', at: null } } });
}

async function finishReset(req, res, user, { method }) {
  await destroyAllSessionsForUser(user._id);
  await revokeAllTrustedDevices(user._id);
  await ResetTicket.deleteMany({ userId: user._id });
  await OtpChallenge.deleteMany({ userId: user._id });
  clearTrustCookie(req, res, user._id);

  const browser = labelFromUserAgent(req.headers?.['user-agent']);
  await recordEvent(req, 'password_changed', { userId: user._id, deviceId: null });
  await sendEmail({ to: user.email, ...templates.passwordChanged({ method, when: new Date(), browser }) }).catch(() => false);
}

module.exports = { extractRecoverySalt, finalizeReset, wipeVault, finishReset };
