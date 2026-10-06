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

function base64UrlToBytes(text) {
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
  const plain = await decryptBlob(key, shareId, 'manifest', base64ToBytes(manifestBase64));
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (parsed?.v !== 1 || !Array.isArray(parsed.files)) throw new Error('Unrecognised manifest.');
  return parsed.files.map((file) => ({
    id: String(file.id),
    name: String(file.name ?? 'file'),
    mime: String(file.mime ?? 'application/octet-stream'),
    folder: String(file.folder ?? 'root'),
    size: Number.isFinite(file.size) ? file.size : 0,
  }));
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

/** A file name safe to hand to a download attribute. */
export function safeDownloadName(name) {
  let cleaned = '';
  for (const char of String(name)) {
    const code = char.codePointAt(0);
    const control = code < 32 || code === 127;
    cleaned += control || '/\\:*?"<>|'.includes(char) ? '_' : char;
  }
  cleaned = cleaned.trim().replace(/^\.+/, '').slice(0, 120);
  return cleaned || 'file';
}
