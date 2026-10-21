import * as scryptModule from 'scrypt-js';

import { base64ToBytes } from './shareCrypto.js';

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

export async function deriveShareSecrets(password, salt, params = KDF_PARAMS) {
  await new Promise((resolve) => setTimeout(resolve, 30));
  const master = syncScrypt(encoder.encode(password.normalize('NFKC')), salt, params.N, params.r, params.p, 32);
  const hmacKey = await crypto.subtle.importKey('raw', master, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = async (label) => new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(label)));
  const [wrapBytes, verifierBytes] = await Promise.all([sign(WRAP_LABEL), sign(VERIFY_LABEL)]);
  const wrapKey = await crypto.subtle.importKey('raw', wrapBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { wrapKey, verifier: toBase64(verifierBytes) };
}

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

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function passwordProblem(password) {
  if (password !== password.trim()) return 'Remove the spaces at the start or end.';
  if (password.length < 8) return 'Use at least 8 characters.';
  if (/^(.)\1+$/.test(password)) return 'Choose something less repetitive.';
  return '';
}
