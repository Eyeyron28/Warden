import { scrypt } from 'scrypt-js';

/**
 * Phone-side crypto: unwraps the DEK locally using the PIN set during
 * pairing, entirely offline (no server call). Deliberately uses
 * `scrypt-js` rather than SubtleCrypto's PBKDF2 - the DEK was wrapped
 * server-side with Node's built-in `crypto.scryptSync` (see
 * server/utils/crypto.js), and unwrapping it here requires deriving the
 * IDENTICAL key bytes. A different KDF like PBKDF2 would derive a
 * completely different key and silently fail to unwrap anything; SubtleCrypto
 * has no scrypt implementation at all, hence the extra dependency.
 *
 * Parameters below (N/r/p, keylen, and the `${salt}:encryption-key`
 * salt-input format) must stay byte-for-byte identical to
 * `SCRYPT_PARAMS`/`deriveEncryptionKey` in server/utils/crypto.js.
 */

const SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const ENCRYPTION_KEY_KEYLEN = 32; // 256-bit key, required by AES-256
const GCM_TAG_LENGTH_BITS = 128; // 16-byte AES-GCM auth tag, same as server's authTag

// The unwrapped DEK, kept ONLY in memory for this page's lifetime - never
// written to localStorage/IndexedDB. Mirrors the server's in-memory
// sessionStore: closing the tab or reloading loses it, same as locking
// the vault does server-side.
let unwrappedDEK = null;

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Derives a key-encryption key (KEK) from the phone's PIN and the salt
 * generated for it at pairing time (`wrappedDEKPhonePinSalt`) - the exact
 * client-side counterpart of the server's `deriveEncryptionKey(phonePin,
 * pinSalt)` call in controllers/pairing.controller.js.
 *
 * @param {string} pin
 * @param {string} saltHex
 * @returns {Promise<Uint8Array>} 32-byte KEK
 */
export async function deriveKeyFromPin(pin, saltHex) {
  const password = new TextEncoder().encode(pin);
  // Must match scryptDerive()'s `${salt}:${context}` salt-input format in
  // server/utils/crypto.js, with the same "encryption-key" context label
  // deriveEncryptionKey uses (as opposed to "password-hash").
  const salt = new TextEncoder().encode(`${saltHex}:encryption-key`);
  return scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P, ENCRYPTION_KEY_KEYLEN);
}

/**
 * Decrypts (unwraps) a key wrapped with the server's `wrapKey()` -
 * AES-256-GCM via SubtleCrypto, which IS natively supported in the
 * browser. Node's crypto keeps the auth tag separate from the ciphertext;
 * WebCrypto expects them concatenated (ciphertext || tag) for decrypt, so
 * they're joined here before calling `subtle.decrypt`.
 *
 * Throws if the KEK is wrong (e.g. a mistyped PIN) or the data was
 * tampered with - SubtleCrypto rejects on auth tag mismatch, same
 * guarantee as the server's `unwrapKey`.
 *
 * @param {string} wrappedKeyBase64
 * @param {string} ivBase64
 * @param {string} authTagBase64
 * @param {Uint8Array} kek
 * @returns {Promise<Uint8Array>}
 */
export async function unwrapDEK(wrappedKeyBase64, ivBase64, authTagBase64, kek) {
  const cryptoKey = await crypto.subtle.importKey('raw', kek, 'AES-GCM', false, ['decrypt']);

  const ciphertext = base64ToBytes(wrappedKeyBase64);
  const authTag = base64ToBytes(authTagBase64);
  const iv = base64ToBytes(ivBase64);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: GCM_TAG_LENGTH_BITS },
      cryptoKey,
      combined
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error('Incorrect PIN.');
  }
}

/**
 * Full local-unlock flow: derive the KEK from the PIN, unwrap the DEK,
 * and hold it in the module-level variable above for this page's use.
 * Throws "Incorrect PIN." (via unwrapDEK) on a wrong PIN - deliberately
 * no lockout logic here, this is a phone convenience layer, not the
 * vault's primary security boundary (the real boundary is the master
 * password this device's PIN was set up with).
 *
 * @param {string} pin
 * @param {{ wrappedDEKPhonePin: string, wrappedDEKPhonePinIv: string, wrappedDEKPhonePinAuthTag: string, wrappedDEKPhonePinSalt: string }} deviceAuth
 */
export async function unlockLocalVault(pin, deviceAuth) {
  const kek = await deriveKeyFromPin(pin, deviceAuth.wrappedDEKPhonePinSalt);
  const dek = await unwrapDEK(
    deviceAuth.wrappedDEKPhonePin,
    deviceAuth.wrappedDEKPhonePinIv,
    deviceAuth.wrappedDEKPhonePinAuthTag,
    kek
  );
  unwrappedDEK = dek;
}

export function isLocallyUnlocked() {
  return unwrappedDEK !== null;
}

/**
 * Clears the in-memory DEK, e.g. when the user taps "Lock" or navigates
 * away - the local equivalent of the PC vault's logout/lock action.
 */
export function lockLocalVault() {
  unwrappedDEK = null;
}

/**
 * Decrypts a document's encryptedBlob using the DEK currently unwrapped
 * in memory - the same AES-256-GCM-via-SubtleCrypto approach as
 * unwrapDEK, just operating on file content instead of a wrapped key.
 * Throws if the vault isn't currently unlocked, or if decryption fails
 * (wrong key, or the data was tampered with/corrupted).
 *
 * @param {ArrayBuffer} encryptedBlob
 * @param {string} ivBase64
 * @param {string} authTagBase64
 * @returns {Promise<ArrayBuffer>} the decrypted plaintext file content
 */
export async function decryptDocument(encryptedBlob, ivBase64, authTagBase64) {
  if (!unwrappedDEK) {
    throw new Error('Local vault is locked.');
  }

  const cryptoKey = await crypto.subtle.importKey('raw', unwrappedDEK, 'AES-GCM', false, [
    'decrypt',
  ]);

  const ciphertext = new Uint8Array(encryptedBlob);
  const authTag = base64ToBytes(authTagBase64);
  const iv = base64ToBytes(ivBase64);

  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);

  try {
    return await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: GCM_TAG_LENGTH_BITS },
      cryptoKey,
      combined
    );
  } catch {
    throw new Error('Could not decrypt this document: it may be corrupted.');
  }
}

export { base64ToBytes, bytesToBase64 };
