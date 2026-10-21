const { encryptFile, decryptFile } = require('./crypto');

const MAX_THUMB_BYTES = 40 * 1024;
const ALLOWED_THUMB_MIMES = new Set(['image/webp', 'image/jpeg']);

function encryptThumbnail(buffer, mime, dek) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > MAX_THUMB_BYTES) return null;
  if (typeof mime !== 'string' || !ALLOWED_THUMB_MIMES.has(mime)) return null;

  const { ciphertext, iv, authTag } = encryptFile(buffer, dek);
  return {
    thumbCipher: Buffer.from(ciphertext, 'base64'),
    thumbIv: iv,
    thumbAuthTag: authTag,
    thumbMime: mime,
  };
}

function decryptThumbnail(doc, dek) {
  return decryptFile(doc.thumbCipher.toString('base64'), dek, doc.thumbIv, doc.thumbAuthTag);
}

function hasThumbnail(doc) {
  return Boolean(doc.thumbMime);
}

function serializeThumbnail(doc) {
  if (!doc.thumbMime || !Buffer.isBuffer(doc.thumbCipher)) return {};
  return {
    thumbCipher: doc.thumbCipher.toString('base64'),
    thumbIv: doc.thumbIv,
    thumbAuthTag: doc.thumbAuthTag,
    thumbMime: doc.thumbMime,
  };
}

function restoreThumbnail(record) {
  const { thumbCipher, thumbIv, thumbAuthTag, thumbMime } = record || {};
  if (![thumbCipher, thumbIv, thumbAuthTag, thumbMime].every((v) => typeof v === 'string' && v)) return {};
  if (!ALLOWED_THUMB_MIMES.has(thumbMime)) return {};
  const bytes = Buffer.from(thumbCipher, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_THUMB_BYTES) return {};
  return { thumbCipher: bytes, thumbIv, thumbAuthTag, thumbMime };
}

const PREVIEW_FAILURE_REASONS = Object.freeze([
  'unsupported-type',
  'decode-failed',
  'too-large',
  'too-big-result',
  'timeout',
  'download-failed',
]);

module.exports = {
  PREVIEW_FAILURE_REASONS,
  MAX_THUMB_BYTES,
  encryptThumbnail,
  decryptThumbnail,
  hasThumbnail,
  serializeThumbnail,
  restoreThumbnail,
};
