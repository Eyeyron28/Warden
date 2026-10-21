const crypto = require('crypto');

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function generateShareKey() {
  return crypto.randomBytes(KEY_BYTES);
}

function aadFor(shareId, slot) {
  return Buffer.from(`${shareId}:${slot}`, 'utf8');
}

function encryptForShare(plaintext, key, shareId, slot) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aadFor(shareId, slot));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

function pack({ ciphertext, iv, authTag }) {
  return Buffer.concat([iv, ciphertext, authTag]);
}

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
  return crypto.randomBytes(16).toString('hex');
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
