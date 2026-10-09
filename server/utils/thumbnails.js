const { encryptFile, decryptFile } = require('./crypto');

/**
 * Document preview thumbnails. The browser draws a small WebP/JPEG from the
 * plaintext file at upload time and sends it alongside the upload; this
 * module only ever sees those bytes opaquely - it never decodes, resizes or
 * inspects an image, and it never stores one in the clear. What it does is
 * validate size and declared type, encrypt with the account's DEK (the same
 * AES-256-GCM helper the file itself goes through, with its own random IV),
 * and decrypt again for the owner's own session.
 *
 * Thumbnails are optional everywhere: a document without them is valid, and
 * anything wrong with a submitted thumbnail just means "no thumbnail" - it
 * must never fail the upload it rode in on.
 */

// The client aims for 30KB; this is the hard server-side ceiling.
const MAX_THUMB_BYTES = 40 * 1024;
const ALLOWED_THUMB_MIMES = new Set(['image/webp', 'image/jpeg']);

/**
 * @param {Buffer|undefined} buffer thumbnail bytes as uploaded
 * @param {string|undefined} mime declared type
 * @param {Buffer} dek the session's data encryption key
 * @returns {{thumbCipher: Buffer, thumbIv: string, thumbAuthTag: string, thumbMime: string}|null}
 *   null when absent or invalid (never throws for a bad thumbnail)
 */
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

/** Thumbnail fields in the base64/JSON form sync and backup both use; {} if none. */
function serializeThumbnail(doc) {
  if (!doc.thumbMime || !Buffer.isBuffer(doc.thumbCipher)) return {};
  return {
    thumbCipher: doc.thumbCipher.toString('base64'),
    thumbIv: doc.thumbIv,
    thumbAuthTag: doc.thumbAuthTag,
    thumbMime: doc.thumbMime,
  };
}

/**
 * Reads thumbnail fields back from a backup record, for Document.create.
 * Already ciphertext (nothing to encrypt), so it only validates shape and
 * size; a malformed or oversized one is dropped rather than aborting the
 * restore - the document itself is the point, the preview is optional.
 */
function restoreThumbnail(record) {
  const { thumbCipher, thumbIv, thumbAuthTag, thumbMime } = record || {};
  if (![thumbCipher, thumbIv, thumbAuthTag, thumbMime].every((v) => typeof v === 'string' && v)) return {};
  if (!ALLOWED_THUMB_MIMES.has(thumbMime)) return {};
  const bytes = Buffer.from(thumbCipher, 'base64');
  // GCM adds no ciphertext expansion, so the ciphertext is as long as the plaintext.
  if (bytes.length === 0 || bytes.length > MAX_THUMB_BYTES) return {};
  return { thumbCipher: bytes, thumbIv, thumbAuthTag, thumbMime };
}

// Why a preview could not be made. Reported by the browser that tried; the server only
// stores a code from this list (anything else is refused), never free text.
const PREVIEW_FAILURE_REASONS = Object.freeze([
  'unsupported-type', // not an image or PDF the browser may draw (SVG, HEIC, documents...)
  'decode-failed', // looked like one, but is corrupt or cannot be decoded
  'too-large', // over the 4MB the previews work on
  'too-big-result', // could not be shrunk under the thumbnail size limit
  'timeout', // took too long to draw
  'download-failed', // the file itself could not be fetched or decrypted
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
