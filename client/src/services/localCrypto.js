import scryptJs from 'scrypt-js';

import { checkPin } from '../utils/pinRules.js';

const { syncScrypt } = scryptJs;

/**
 * One scrypt derivation. In a browser it runs in a Web Worker (services/
 * scryptWorker.js: synchronous scrypt, no main-thread stall and none of
 * scrypt-js's setTimeout pauses); where there is no Worker (the Node test
 * runner) it runs in place.
 */
function runScrypt(password, salt, N, r, p, length) {
  if (typeof Worker === 'undefined') return Promise.resolve(syncScrypt(password, salt, N, r, p, length));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./scryptWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.key);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Key derivation failed.'));
    };
    worker.postMessage({ password, salt, N, r, p, length });
  });
}

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

/**
 * How a phone PIN is turned into a key. Stored WITH every wrap (the `kdf` field
 * of the device record), so a wrap always opens with the cost it was made with
 * and the cost can be raised later without breaking old ones.
 *
 * Version 2: scrypt N=2^16, r=8, p=1 (64 MiB of memory, about twice the work of
 * the first version) with its own salt context. A device record with no `kdf`
 * is a version-1 wrap: N=2^15, and the key shared with the server's scheme.
 * 64 MiB is also the ceiling for a JavaScript scrypt on a phone browser, which
 * is why the cost is not pushed higher.
 */
export const PIN_KDF = Object.freeze({ v: 2, name: 'scrypt', N: 2 ** 16, r: 8, p: 1 });
export const LEGACY_PIN_KDF = Object.freeze({ v: 1, name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });

const saltContext = (kdf) => (kdf.v === 1 ? 'encryption-key' : 'warden-phone-pin-v2');
const ENCRYPTION_KEY_KEYLEN = 32; // 256-bit key, required by AES-256
const GCM_TAG_LENGTH_BITS = 128; // 16-byte AES-GCM auth tag, same as server's authTag
const GCM_IV_LENGTH_BYTES = 12; // 96-bit IV, same as server's GCM_IV_LENGTH

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
 * Derives a key-encryption key (KEK) from a shared secret and a salt -
 * the exact client-side counterpart of the server's
 * `deriveEncryptionKey(secret, salt)` (server/utils/crypto.js). The
 * "secret" is just a string as far as scrypt cares; the two exported
 * wrappers below exist so call sites read clearly (a PIN vs. a one-time
 * phone-recovery token are conceptually different secrets, even though
 * the derivation is identical).
 *
 * @param {string} secret
 * @param {string} saltHex
 * @returns {Promise<Uint8Array>} 32-byte KEK
 */
async function deriveKey(secret, saltHex, kdf = LEGACY_PIN_KDF) {
  const password = new TextEncoder().encode(secret);
  // Version 1 matches scryptDerive()'s `${salt}:${context}` input in
  // server/utils/crypto.js (context "encryption-key"); it is also what the
  // phone-recovery one-time token uses. Version 2 is client-only.
  const salt = new TextEncoder().encode(`${saltHex}:${saltContext(kdf)}`);
  return runScrypt(password, salt, kdf.N, kdf.r, kdf.p, ENCRYPTION_KEY_KEYLEN);
}

/**
 * @param {string} pin
 * @param {string} saltHex - `wrappedDEKPhonePinSalt` of the device record
 * @param {{ v: number, N: number, r: number, p: number }} [kdf] - the record's `kdf`; absent means version 1
 * @returns {Promise<Uint8Array>} 32-byte KEK
 */
export async function deriveKeyFromPin(pin, saltHex, kdf = LEGACY_PIN_KDF) {
  return deriveKey(pin, saltHex, kdf);
}

/**
 * Used by phone-based PC recovery (PhoneVault.jsx "Help recover PC
 * vault"): `token` is the short-lived recoveryToken shown on the
 * locked-out PC and typed into this phone - known to both sides only
 * because the owner physically copied it from one screen to the other,
 * which is what makes deriving a KEK from it a legitimate one-time
 * shared secret rather than something an attacker could guess.
 *
 * @param {string} token - the PC's displayed recovery code
 * @param {string} saltHex - freshly generated by this phone for this one request
 * @returns {Promise<Uint8Array>} 32-byte KEK
 */
export async function deriveKeyFromToken(token, saltHex) {
  return deriveKey(token, saltHex);
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
 * Full local-unlock flow: derive the KEK from the PIN with the cost the wrap was
 * made with, unwrap the DEK, and hold it in the module-level variable above for
 * this page's use. Throws "Incorrect PIN." on a wrong PIN. Attempt limiting
 * lives with the PIN screen (utils/pinLockout.js).
 *
 * Says whether the wrap should be redone: it was made with the old cost, or the
 * PIN that just opened it no longer meets the rules (shorter than 6, or on the
 * block list). The caller then makes the owner choose a new PIN and calls
 * rewrapWithNewPin.
 *
 * @param {string} pin
 * @param {{ wrappedDEKPhonePin: string, wrappedDEKPhonePinIv: string, wrappedDEKPhonePinAuthTag: string, wrappedDEKPhonePinSalt: string, kdf?: object }} deviceAuth
 * @returns {Promise<{ needsNewPin: boolean, reason: 'old-kdf' | 'weak-pin' | null }>}
 */
export async function unlockLocalVault(pin, deviceAuth) {
  const kdf = deviceAuth.kdf || LEGACY_PIN_KDF;
  const kek = await deriveKeyFromPin(pin, deviceAuth.wrappedDEKPhonePinSalt, kdf);
  const dek = await unwrapDEK(
    deviceAuth.wrappedDEKPhonePin,
    deviceAuth.wrappedDEKPhonePinIv,
    deviceAuth.wrappedDEKPhonePinAuthTag,
    kek
  );
  unwrappedDEK = dek;
  if (!deviceAuth.kdf || deviceAuth.kdf.v < PIN_KDF.v || deviceAuth.kdf.N < PIN_KDF.N) {
    return { needsNewPin: true, reason: 'old-kdf' };
  }
  if (!checkPin(pin).ok) return { needsNewPin: true, reason: 'weak-pin' };
  return { needsNewPin: false, reason: null };
}

/**
 * Wraps a vault key under a PIN with the current cost and a fresh salt and iv.
 * Used when pairing (the key just arrived from the server) and when an old wrap
 * is upgraded. Returns the fields of the device record that describe the wrap.
 *
 * @param {Uint8Array} dek
 * @param {string} pin
 */
export async function wrapDekForPin(dek, pin) {
  const salt = generateSaltHex();
  const kek = await deriveKeyFromPin(pin, salt, PIN_KDF);
  const wrapped = await wrapDEK(dek, kek);
  return {
    wrappedDEKPhonePin: wrapped.wrappedKey,
    wrappedDEKPhonePinIv: wrapped.iv,
    wrappedDEKPhonePinAuthTag: wrapped.authTag,
    wrappedDEKPhonePinSalt: salt,
    kdf: { ...PIN_KDF },
  };
}

/** Re-wraps the key already unlocked in memory under a new PIN (the forced PIN change). */
export async function rewrapWithNewPin(newPin) {
  if (!unwrappedDEK) throw new Error('Local vault is locked.');
  return wrapDekForPin(unwrappedDEK, newPin);
}

export function isLocallyUnlocked() {
  return unwrappedDEK !== null;
}

/**
 * Read access to the DEK currently unwrapped in memory - used exclusively
 * by phone-based PC recovery (PhoneVault.jsx "Help recover PC vault") to
 * pass it straight into wrapDEK below. The module-private variable itself
 * still never leaves this file any other way; this just hands the
 * ALREADY-in-memory bytes to code that's about to re-wrap and transmit
 * them, the same trust boundary decryptDocument/encryptDocument already
 * cross for every document operation on this page.
 *
 * @returns {Uint8Array | null}
 */
export function getUnwrappedDEK() {
  return unwrappedDEK;
}

/**
 * Encrypts (wraps) a key with another key via SubtleCrypto AES-256-GCM -
 * the client-side counterpart of the server's `wrapKey()` (server/utils/
 * crypto.js), same algorithm encryptDocument already uses for file
 * content. Used by phone-based PC recovery to wrap this phone's live DEK
 * under a fresh one-time KEK (see deriveKeyFromToken) before sending it
 * over the network - the raw DEK itself is never transmitted, only this
 * wrapped form, and only ever alongside a fresh random IV.
 *
 * @param {Uint8Array} dek
 * @param {Uint8Array} kek
 * @returns {Promise<{ wrappedKey: string, iv: string, authTag: string }>} all base64
 */
export async function wrapDEK(dek, kek) {
  const cryptoKey = await crypto.subtle.importKey('raw', kek, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH_BYTES));

  const combined = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: GCM_TAG_LENGTH_BITS }, cryptoKey, dek)
  );

  const tagBytes = GCM_TAG_LENGTH_BITS / 8;
  const wrappedKey = combined.slice(0, combined.length - tagBytes);
  const authTag = combined.slice(combined.length - tagBytes);

  return {
    wrappedKey: bytesToBase64(wrappedKey),
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
  };
}

/**
 * A fresh random salt for a one-time KEK derivation (see
 * deriveKeyFromToken) - the client-side counterpart of the server's
 * `generateSalt()` (server/utils/crypto.js), same length and hex format.
 *
 * @returns {string} hex-encoded salt
 */
export function generateSaltHex() {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
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

/**
 * Encrypts a file's plaintext bytes using the DEK currently unwrapped in
 * memory - the phone-side counterpart of the server's `encryptFile`
 * (server/utils/crypto.js), same AES-256-GCM algorithm. WebCrypto's
 * AES-GCM encrypt appends the auth tag to the ciphertext; the last 16
 * bytes are split off here so the result matches the separate
 * ciphertext/iv/authTag shape used everywhere else in this app (the
 * Document model, the sync pull/push payloads, saveDocumentLocally).
 *
 * Throws "Local vault is locked." if called with no DEK unwrapped - the
 * add-document UI should never be reachable in that state, but this is
 * the same self-guard decryptDocument already has, not a new check.
 *
 * @param {ArrayBuffer} plaintext
 * @returns {Promise<{ ciphertext: ArrayBuffer, iv: string, authTag: string }>} iv/authTag are base64
 */
export async function encryptDocument(plaintext) {
  if (!unwrappedDEK) {
    throw new Error('Local vault is locked.');
  }

  const cryptoKey = await crypto.subtle.importKey('raw', unwrappedDEK, 'AES-GCM', false, [
    'encrypt',
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LENGTH_BYTES));

  const combined = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: GCM_TAG_LENGTH_BITS },
      cryptoKey,
      plaintext
    )
  );

  const tagBytes = GCM_TAG_LENGTH_BITS / 8;
  const ciphertext = combined.slice(0, combined.length - tagBytes);
  const authTag = combined.slice(combined.length - tagBytes);

  return {
    ciphertext: ciphertext.buffer,
    iv: bytesToBase64(iv),
    authTag: bytesToBase64(authTag),
  };
}

/**
 * SHA-256 of the original plaintext, hex-encoded - the exact format the
 * server's createDocument stores as `checksum` (documents.controller.js),
 * so a document added on the phone carries the same integrity signal a
 * PC upload does.
 *
 * @param {ArrayBuffer} plaintext
 * @returns {Promise<string>} hex-encoded SHA-256 digest
 */
export async function computeChecksum(plaintext) {
  const digest = await crypto.subtle.digest('SHA-256', plaintext);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export { base64ToBytes, bytesToBase64 };
