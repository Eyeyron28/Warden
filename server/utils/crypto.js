const crypto = require('crypto');

/**
 * Warden crypto utilities.
 *
 * Everything here uses Node's built-in `crypto` module only - no bcrypt,
 * no argon2, no native bindings to compile on Windows. Key derivation uses
 * scrypt, which (like Argon2) is memory-hard: brute-forcing it requires
 * both CPU time and a large amount of RAM per guess, which makes GPU/ASIC
 * cracking far less effective than it is against a fast hash like SHA-256.
 *
 * Every function in this file is pure: no DB access, no file I/O, no
 * routes. That's deliberate - it keeps this module trivial to unit test
 * in isolation and keeps the security-critical logic in one small,
 * auditable place.
 */

// scrypt cost parameters. N is the CPU/memory cost (must be a power of 2),
// r is block size, p is parallelization. N=2^15 with r=8 needs ~32MB of
// RAM per derivation, which is why maxmem is raised above Node's 32MB
// default - without that, scrypt() throws.
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

const PASSWORD_HASH_KEYLEN = 64; // 512-bit verification hash
const ENCRYPTION_KEY_KEYLEN = 32; // 256-bit key, required by AES-256

const AES_ALGORITHM = 'aes-256-gcm';
const GCM_IV_LENGTH = 12; // 96-bit IV, the size GCM is designed for

const RECOVERY_KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars,
// excludes 0/O/1/I/L so a handwritten copy can't be misread. 32 divides
// evenly into 256, so mapping a random byte with `% 32` introduces no
// modulo bias.

/**
 * Derives a key from a password/salt pair via scrypt, with a `context`
 * label mixed into the salt so different callers (password hashing vs.
 * encryption key derivation) never produce the same output even when
 * given the exact same password and salt. Internal helper - not exported.
 *
 * @param {string} password
 * @param {string} salt - hex string
 * @param {string} context - domain-separation label, e.g. "password-hash"
 * @param {number} keylen - desired output length in bytes
 * @returns {Buffer}
 */
function scryptDerive(password, salt, context, keylen) {
  const saltInput = Buffer.from(`${salt}:${context}`, 'utf8');
  return crypto.scryptSync(password, saltInput, keylen, SCRYPT_PARAMS);
}

/**
 * Compares two hex-encoded strings in constant time. Returns `false`
 * (instead of throwing) when the lengths differ, since
 * `crypto.timingSafeEqual` requires equal-length buffers and a length
 * mismatch here just means a malformed/corrupted stored hash, not a
 * secret worth protecting via constant-time comparison.
 *
 * @param {string} aHex
 * @param {string} bHex
 * @returns {boolean}
 */
function timingSafeEqualHex(aHex, bHex) {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Generates a cryptographically random salt.
 *
 * Used both as the password-hashing salt and as the base input for
 * encryption-key derivation (see `deriveEncryptionKey`). Generated once,
 * at first-run setup, and stored alongside the user record.
 *
 * @param {number} [length=16] - salt length in bytes
 * @returns {string} hex-encoded salt
 */
function generateSalt(length = 16) {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Derives a verification hash of the master password using scrypt.
 *
 * This hash is only ever used to check "did the user type the right
 * password" - it is never used as an encryption key itself (see
 * `deriveEncryptionKey` for why those two must stay separate).
 *
 * @param {string} password - the plaintext master password
 * @param {string} salt - hex string from `generateSalt()`
 * @returns {string} hex-encoded hash
 */
function hashPassword(password, salt) {
  return scryptDerive(password, salt, 'password-hash', PASSWORD_HASH_KEYLEN).toString('hex');
}

/**
 * Verifies a password attempt against a stored hash.
 *
 * Re-derives the hash from the attempt and compares it using
 * `crypto.timingSafeEqual` rather than `===`. A plain string comparison
 * exits as soon as it finds a mismatched byte, so an attacker measuring
 * response times could learn the hash one byte at a time; a
 * constant-time comparison always takes the same amount of time
 * regardless of where (or whether) the mismatch is.
 *
 * @param {string} password - the plaintext password attempt
 * @param {string} salt - hex string, same salt used to create storedHash
 * @param {string} storedHash - hex-encoded hash from `hashPassword()`
 * @returns {boolean}
 */
function verifyPassword(password, salt, storedHash) {
  const attemptHash = hashPassword(password, salt);
  return timingSafeEqualHex(attemptHash, storedHash);
}

/**
 * Derives the AES-256 encryption key used to encrypt/decrypt documents.
 *
 * IMPORTANT: this must use a different scrypt derivation than
 * `hashPassword`, even though both start from the same master password
 * and salt. If they produced the same output, anyone who obtained the
 * stored `passwordHash` (e.g. via a DB leak) would have effectively
 * obtained the encryption key too. Mixing a distinct context label
 * ("encryption-key" vs "password-hash") into the scrypt salt ensures the
 * two derivations are cryptographically independent - the password hash
 * and the encryption key just happen to share an origin, not a value.
 *
 * The returned key exists only in memory for the lifetime of an unlocked
 * session; it is never persisted.
 *
 * @param {string} password - the plaintext master password
 * @param {string} salt - hex string from `generateSalt()`
 * @returns {Buffer} 32-byte AES-256 key
 */
function deriveEncryptionKey(password, salt) {
  return scryptDerive(password, salt, 'encryption-key', ENCRYPTION_KEY_KEYLEN);
}

/**
 * Encrypts a file buffer with AES-256-GCM.
 *
 * GCM is an authenticated mode: alongside the ciphertext it produces an
 * `authTag` that lets `decryptFile` detect whether the data was altered
 * or corrupted, instead of silently returning garbage plaintext. A fresh
 * random IV is generated per call - reusing an IV with the same key is
 * what breaks GCM's security guarantees, so every encrypted file gets
 * its own.
 *
 * @param {Buffer} buffer - the plaintext file content
 * @param {Buffer} key - 32-byte AES-256 key from `deriveEncryptionKey()`
 * @returns {{ ciphertext: string, iv: string, authTag: string }} all base64
 */
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

/**
 * Decrypts a file previously encrypted with `encryptFile`.
 *
 * Throws a clear error if the auth tag doesn't match, which happens if
 * the ciphertext was tampered with, corrupted, or paired with the wrong
 * key/IV/tag - callers should treat that as "this file cannot be
 * trusted", not attempt to use whatever partial output comes back.
 *
 * @param {string} ciphertext - base64, from `encryptFile()`
 * @param {Buffer} key - 32-byte AES-256 key from `deriveEncryptionKey()`
 * @param {string} iv - base64, from `encryptFile()`
 * @param {string} authTag - base64, from `encryptFile()`
 * @returns {Buffer} the decrypted plaintext file content
 */
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

/**
 * Generates a random, human-copyable recovery key formatted like
 * "XXXX-XXXX-XXXX-XXXX", shown to the user once at setup as a fallback
 * if they forget their master password.
 *
 * Uses a restricted 32-character alphabet (no 0/O/1/I/L) so a key
 * written down on paper is harder to misread. 16 characters from a
 * 32-symbol alphabet is 80 bits of entropy - far beyond what's
 * brute-forceable, even before it goes through scrypt in
 * `hashRecoveryKey`.
 *
 * @returns {string} formatted recovery key
 */
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

/**
 * Hashes a recovery key for storage, in the same spirit as
 * `hashPassword`. Unlike `hashPassword`, the salt isn't stored in its
 * own field on the User model - there's only a single `recoveryKeyHash`
 * field - so this generates its own salt and returns it embedded in the
 * output as `${salt}:${hash}`. `verifyRecoveryKey` parses that format
 * back out.
 *
 * @param {string} recoveryKey - the plaintext recovery key, as shown once
 * @returns {string} self-contained `${salt}:${hash}` string to store
 */
function hashRecoveryKey(recoveryKey) {
  const salt = generateSalt();
  const hash = scryptDerive(recoveryKey, salt, 'recovery-key', PASSWORD_HASH_KEYLEN).toString(
    'hex'
  );
  return `${salt}:${hash}`;
}

/**
 * Verifies a recovery key attempt against a stored `hashRecoveryKey()`
 * output, again using a constant-time comparison rather than `===`.
 *
 * @param {string} recoveryKey - the plaintext recovery key attempt
 * @param {string} storedHash - `${salt}:${hash}` string from `hashRecoveryKey()`
 * @returns {boolean}
 */
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
  generateRecoveryKey,
  hashRecoveryKey,
  verifyRecoveryKey,
};
