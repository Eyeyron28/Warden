const crypto = require('crypto');

/**
 * Encryption for share links. A share has its OWN random 256-bit key, made
 * fresh at creation, returned to the owner once inside the link fragment
 * (`#k=...`) and never stored by the server - not in the database, logs or
 * any cache. Nothing here is derived from the vault key; the server only
 * ever uses the vault key (for that one request) to read the owner's file
 * before re-encrypting a copy under the share key.
 *
 * Format of every encrypted blob: AES-256-GCM, fresh 12-byte IV per blob,
 * and the shareId (plus the file id, for files) bound in as additional
 * authenticated data so a ciphertext can't be swapped into another share or
 * slot. The browser decrypts with Web Crypto, which wants ciphertext||tag
 * with the IV supplied separately; `pack` produces iv || ciphertext || tag.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function generateShareKey() {
  return crypto.randomBytes(KEY_BYTES);
}

function aadFor(shareId, slot) {
  return Buffer.from(`${shareId}:${slot}`, 'utf8');
}

/** @returns {{ ciphertext: Buffer, iv: Buffer, authTag: Buffer }} */
function encryptForShare(plaintext, key, shareId, slot) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(shareId, slot));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

/** iv || ciphertext || tag, as one buffer. */
function pack({ ciphertext, iv, authTag }) {
  return Buffer.concat([iv, ciphertext, authTag]);
}

/** Inverse of encryptForShare + pack. Throws if the key, shareId or slot is wrong. */
function unpackAndDecrypt(blob, key, shareId, slot) {
  if (!Buffer.isBuffer(blob) || blob.length < IV_BYTES + TAG_BYTES) throw new Error('Blob too short.');
  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(blob.length - TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES, blob.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aadFor(shareId, slot));
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function newShareId() {
  return crypto.randomBytes(16).toString('hex'); // 128-bit, 32 hex chars
}

function newFileId() {
  return crypto.randomBytes(8).toString('hex');
}

const SHARE_ID_RE = /^[0-9a-f]{32}$/;
const FILE_ID_RE = /^[0-9a-f]{16}$/;

module.exports = {
  generateShareKey,
  encryptForShare,
  pack,
  unpackAndDecrypt,
  toBase64Url,
  newShareId,
  newFileId,
  SHARE_ID_RE,
  FILE_ID_RE,
  IV_BYTES,
  TAG_BYTES,
};
