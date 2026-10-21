const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const PASSWORD_HASH_KEYLEN = 64;
const ENCRYPTION_KEY_KEYLEN = 32;

const AES_ALGORITHM = 'aes-256-gcm';
const GCM_IV_LENGTH = 12;

const RECOVERY_KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function scryptDerive(password, salt, context, keylen) {
  const saltInput = Buffer.from(`${salt}:${context}`, 'utf8');
  return crypto.scryptSync(password, saltInput, keylen, SCRYPT_PARAMS);
}

function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function generateSalt(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

function hashPassword(password, salt) {
  return scryptDerive(password, salt, 'password-hash', PASSWORD_HASH_KEYLEN).toString('hex');
}

function verifyPassword(password, salt, storedHash) {
  const attemptHash = hashPassword(password, salt);
  return timingSafeEqualHex(attemptHash, storedHash);
}

function deriveEncryptionKey(password, salt) {
  return scryptDerive(password, salt, 'encryption-key', ENCRYPTION_KEY_KEYLEN);
}

function encryptFile(buffer, key) {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function decryptFile(ciphertext, key, iv, authTag) {
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch (err) {
    throw new Error('Decryption failed: data may be corrupted or tampered with.');
  }
}

function generateDEK() {
  return crypto.randomBytes(ENCRYPTION_KEY_KEYLEN);
}

function fingerprintDEK(dek) {
  return crypto.createHash('sha256').update(dek).digest('hex');
}

function wrapKey(dek, kek) {
  const iv = crypto.randomBytes(GCM_IV_LENGTH);
  const cipher = crypto.createCipheriv(AES_ALGORITHM, kek, iv);
  const wrappedKey = Buffer.concat([cipher.update(dek), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    wrappedKey: wrappedKey.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

function unwrapKey(wrappedKey, kek, iv, authTag) {
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, kek, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(wrappedKey, 'base64')),
      decipher.final(),
    ]);
  } catch (err) {
    throw new Error('Key unwrap failed: wrong password/recovery key, or the data was tampered with.');
  }
}

function generateRecoveryKey() {
  const GROUPS = 4;
  const GROUP_LENGTH = 4;
  const bytes = crypto.randomBytes(GROUPS * GROUP_LENGTH);

  let chars = '';
  for (let i = 0; i < bytes.length; i += 1) {
    chars += RECOVERY_KEY_ALPHABET[bytes[i] % RECOVERY_KEY_ALPHABET.length];
  }

  return chars.match(new RegExp(`.{${GROUP_LENGTH}}`, 'g')).join('-');
}

function normalizeRecoveryKey(input) {
  if (typeof input !== 'string' || input.length > 100) return null;
  const compact = input.replace(/[\s-]+/g, '').toUpperCase();
  if (compact.length !== 16) return null;
  for (const char of compact) if (!RECOVERY_KEY_ALPHABET.includes(char)) return null;
  return compact.match(/.{4}/g).join('-');
}

function hashRecoveryKey(recoveryKey) {
  const salt = generateSalt();
  const hash = scryptDerive(recoveryKey, salt, 'recovery-key', PASSWORD_HASH_KEYLEN).toString(
    'hex'
  );
  return `${salt}:${hash}`;
}

function verifyRecoveryKey(recoveryKey, storedHash) {
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;

  const attemptHash = scryptDerive(recoveryKey, salt, 'recovery-key', PASSWORD_HASH_KEYLEN).toString(
    'hex'
  );
  return timingSafeEqualHex(attemptHash, hash);
}

module.exports = {
  generateSalt,
  hashPassword,
  verifyPassword,
  deriveEncryptionKey,
  encryptFile,
  decryptFile,
  generateDEK,
  fingerprintDEK,
  wrapKey,
  unwrapKey,
  generateRecoveryKey,
  normalizeRecoveryKey,
  hashRecoveryKey,
  verifyRecoveryKey,
};
