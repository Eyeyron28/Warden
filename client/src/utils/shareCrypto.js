/**
 * Browser side of share links. The share key lives only in the link's
 * #fragment (`#k=<base64url>`), which browsers never send to any server; the
 * viewer reads it once, removes it from the address bar, and decrypts here
 * with Web Crypto. The server only ever holds ciphertext.
 *
 * Every blob is iv (12) || ciphertext || tag (16), AES-256-GCM, with
 * `${shareId}:${slot}` as additional authenticated data (slot is "manifest"
 * or the file id) - the exact counterpart of server/utils/shareCrypto.js.
 */

const KEY_FRAGMENT_RE = /^#k=([A-Za-z0-9_-]{43})$/; // 32 bytes, unpadded base64url
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The key text from a location.hash, or null if it is missing or malformed. */
export function readKeyFromHash(hash) {
  const match = KEY_FRAGMENT_RE.exec(typeof hash === 'string' ? hash : '');
  return match ? match[1] : null;
}

export function base64UrlToBytes(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return base64ToBytes(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A decrypt-only, non-extractable AES-GCM key from the fragment's key text. */
export function importShareKey(keyText) {
  return crypto.subtle.importKey('raw', base64UrlToBytes(keyText), 'AES-GCM', false, ['decrypt']);
}

/** The same key from raw bytes (a password share: unwrapped from the wrapped key). */
export function importShareKeyBytes(bytes) {
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['decrypt']);
}

/**
 * Decrypts one blob. Rejects (never returns garbage) when the key, shareId or
 * slot is wrong or the data was altered.
 *
 * @param {CryptoKey} key
 * @param {string} shareId
 * @param {string} slot "manifest" or a file id
 * @param {Uint8Array | ArrayBuffer} blob iv || ciphertext || tag
 * @returns {Promise<ArrayBuffer>}
 */
export function decryptBlob(key, shareId, slot, blob) {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.length < IV_BYTES + TAG_BYTES) return Promise.reject(new Error('Blob too short.'));
  return crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes.subarray(0, IV_BYTES),
      additionalData: new TextEncoder().encode(`${shareId}:${slot}`),
      tagLength: TAG_BYTES * 8,
    },
    key,
    bytes.subarray(IV_BYTES)
  );
}

/**
 * Decrypts and validates the manifest. Everything in it is attacker-
 * influenced (it is whatever the owner's files were named), so it is reduced
 * to plain strings and numbers here and only ever rendered as text.
 *
 * @returns {Promise<Array<{ id: string, name: string, mime: string, folder: string, size: number }>>}
 */
export async function decryptManifest(key, shareId, manifestBase64) {
  return (await decryptManifestInfo(key, shareId, manifestBase64)).files;
}

/**
 * The same, plus the optional purpose (manifest v2): { files, purpose, sharedAt }. The purpose is untrusted text
 * like everything in here: cut to 60 characters, stripped of control characters, and only ever rendered as text.
 */
export async function decryptManifestInfo(key, shareId, manifestBase64) {
  const plain = await decryptBlob(key, shareId, 'manifest', base64ToBytes(manifestBase64));
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if ((parsed?.v !== 1 && parsed?.v !== 2) || !Array.isArray(parsed.files)) throw new Error('Unrecognised manifest.');
  const files = parsed.files.map((file) => ({
    id: String(file.id),
    name: String(file.name ?? 'file'),
    mime: String(file.mime ?? 'application/octet-stream'),
    folder: String(file.folder ?? 'root'),
    size: Number.isFinite(file.size) ? file.size : 0,
  }));
  const purpose =
    parsed.v === 2 && typeof parsed.purpose === 'string'
      ? [...parsed.purpose.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, 60).join('')
      : '';
  const sharedAt = parsed.v === 2 && /^\d{4}-\d{2}-\d{2}$/.test(String(parsed.sharedAt)) ? String(parsed.sharedAt) : '';
  return { files, purpose: purpose || null, sharedAt: purpose ? sharedAt : '' };
}

// What may be previewed inline from a blob URL. Anything else - html, svg,
// scripts, unknown types - is download-only and typed as opaque bytes.
const SIGNATURES = {
  'image/png': [[0x89, 0x50, 0x4e, 0x47]],
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]],
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
};

/**
 * 'image' | 'pdf' | null. Only a small allowlist of types, and only when the
 * file's own first bytes match that type, so a file merely LABELLED
 * image/png cannot be rendered as something else.
 */
export function previewKind(mime, bytes) {
  const signatures = SIGNATURES[mime];
  if (!signatures) return null;
  const head = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const matches = signatures.some((sig) => sig.every((byte, i) => head[i] === byte));
  if (!matches) return null;
  if (mime === 'image/webp') {
    // RIFF....WEBP
    const tag = String.fromCharCode(head[8], head[9], head[10], head[11]);
    if (tag !== 'WEBP') return null;
  }
  return mime === 'application/pdf' ? 'pdf' : 'image';
}

/** A file name safe to hand to a download attribute (the one shared implementation: utils/fileNames.js). */
export { sanitizeDownloadName as safeDownloadName } from './fileNames.js';
