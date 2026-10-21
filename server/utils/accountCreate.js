const {
  generateSalt,
  hashPassword,
  deriveEncryptionKey,
  generateDEK,
  fingerprintDEK,
  wrapKey,
  generateRecoveryKey,
  hashRecoveryKey,
} = require('./crypto');
const { extractRecoverySalt } = require('./accountReset');

function buildAccountFields(password) {
  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);

  const recoveryKey = generateRecoveryKey();
  const recoveryKeyHash = hashRecoveryKey(recoveryKey);
  const recoverySalt = extractRecoverySalt(recoveryKeyHash);

  const dek = generateDEK();
  const wrappedPassword = wrapKey(dek, deriveEncryptionKey(password, salt));
  const wrappedRecovery = wrapKey(dek, deriveEncryptionKey(recoveryKey, recoverySalt));

  return {
    recoveryKey,
    dek,
    fields: {
      passwordHash,
      salt,
      recoveryKeyHash,
      wrappedDEKPassword: wrappedPassword.wrappedKey,
      wrappedDEKPasswordIv: wrappedPassword.iv,
      wrappedDEKPasswordAuthTag: wrappedPassword.authTag,
      wrappedDEKRecovery: wrappedRecovery.wrappedKey,
      wrappedDEKRecoveryIv: wrappedRecovery.iv,
      wrappedDEKRecoveryAuthTag: wrappedRecovery.authTag,
      dekFingerprint: fingerprintDEK(dek),
    },
  };
}

const isDuplicateKey = (error) => Boolean(error && (error.code === 11000 || /E11000/.test(String(error.message))));

module.exports = { buildAccountFields, isDuplicateKey };
