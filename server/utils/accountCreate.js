
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

/**
 * Everything a brand-new account is made of: the vault key (DEK), locked once under the password and once under a fresh
 * recovery key, and the password hash. Pure computation - nothing is written and nothing is sent. The crypto here is exactly
 * what signup has always done (same key sizes, same scrypt parameters, same recovery key format).
 *
 * @returns {{ fields: object, recoveryKey: string, dek: Buffer }} `fields` goes into User.create (with email and
 *   emailVerified); `recoveryKey` is shown to the person once and never stored; `dek` signs them in.
 */
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

// MongoDB's unique-index violation (also what the in-memory test fakes throw).
const isDuplicateKey = (error) => Boolean(error && (error.code === 11000 || /E11000/.test(String(error.message))));

module.exports = { buildAccountFields, isDuplicateKey };
