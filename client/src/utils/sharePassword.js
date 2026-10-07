import * as scryptModule from 'scrypt-js';

import { base64ToBytes } from './shareCrypto.js';

/**
 * Link passwords, entirely in the browser. The password never leaves it.
 *
 * From the typed password and a per-share random salt, scrypt (cost N=2^15,
 * r=8, p=1 - the server refuses anything weaker) makes one 32-byte master
 * secret. Two values are then split off it with HMAC-SHA-256 under DIFFERENT
 * labels, so neither reveals the other:
 *
 *   wrap key  = HMAC(master, "warden-share-wrap-v1")    locks the share key
 *   verifier  = HMAC(master, "warden-share-verify-v1")  proves the password to
 *                                                        the server, which keeps
 *                                                        only SHA-256 of it
 *
 * The share key is wrapped with AES-256-GCM (fresh IV, the share id bound in as
 * additional data): iv (12) || ciphertext (32) || tag (16) = 60 bytes. The
 * server stores that wrapped key, the salt, the cost and the verifier's hash -
 * never the password, the wrap key or the share key.
 */

// scrypt-js is CommonJS: Vite exposes `scrypt` as a named export, Node's own ESM
// loader (used by the unit tests) only as `default.scrypt`.
//
// The SYNCHRONOUS form is used on purpose: the async one yields to the event
// loop all through the computation, and browsers clamp every such yield to ~4ms,
// which turned a ~0.2s derivation into ~10s. The synchronous call blocks the
// page for a fraction of a second instead (see deriveShareSecrets).
const syncScrypt = scryptModule.syncScrypt ?? scryptModule.default.syncScrypt;

export const KDF_PARAMS = { N: 2 ** 15, r: 8, p: 1 };

const WRAP_LABEL = 'warden-share-wrap-v1';
const VERIFY_LABEL = 'warden-share-verify-v1';
const encoder = new TextEncoder();

export function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

/**
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {{ N: number, r: number, p: number }} [params]
 * @returns {Promise<{ wrapKey: CryptoKey, verifier: string }>} verifier is base64
 */
export async function deriveShareSecrets(password, salt, params = KDF_PARAMS) {
  // Let the caller's "working..." state paint before the page is busy.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const master = syncScrypt(encoder.encode(password.normalize('NFKC')), salt, params.N, params.r, params.p, 32);
  const hmacKey = await crypto.subtle.importKey('raw', master, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = async (label) => new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(label)));
  const [wrapBytes, verifierBytes] = await Promise.all([sign(WRAP_LABEL), sign(VERIFY_LABEL)]);
  const wrapKey = await crypto.subtle.importKey('raw', wrapBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { wrapKey, verifier: toBase64(verifierBytes) };
}

/** Locks the 32-byte share key under the wrap key. Returns base64 of iv || ct || tag. */
export async function wrapShareKey(shareKeyBytes, wrapKey, shareId) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`${shareId}:key`), tagLength: 128 },
      wrapKey,
      shareKeyBytes
    )
  );
  const blob = new Uint8Array(iv.length + sealed.length);
  blob.set(iv);
  blob.set(sealed, iv.length);
  return toBase64(blob);
}

/** The inverse. Rejects (never returns garbage) if the password was wrong. */
export async function unwrapShareKey(wrappedBase64, wrapKey, shareId) {
  const blob = base64ToBytes(wrappedBase64);
  const key = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: blob.subarray(0, 12), additionalData: encoder.encode(`${shareId}:key`), tagLength: 128 },
    wrapKey,
    blob.subarray(12)
  );
  return new Uint8Array(key);
}

const LINK_KEY_RE = /^#k=([A-Za-z0-9_-]{43})$/;
const SHARE_PATH_RE = /^\/shared\/([0-9a-f]{32})$/;

/**
 * Reads a share link the owner pasted: its share id and, if present, its key
 * text. Returns null for anything that is not a share link.
 * @returns {{ shareId: string, keyText: string | null } | null}
 */
export function parseShareLink(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    return null;
  }
  const match = SHARE_PATH_RE.exec(url.pathname);
  if (!match) return null;
  const key = LINK_KEY_RE.exec(url.hash);
  return { shareId: match[1], keyText: key ? key[1] : null };
}

/** base64url (no padding) of raw bytes, the form used after `#k=`. */
export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Rough strength gate for the UI (the server cannot see the password). */
export function passwordProblem(password) {
  if (password.length < 8) return 'Use at least 8 characters.';
  if (/^(.)\1+$/.test(password)) return 'Choose something less repetitive.';
  return '';
}
