const crypto = require('crypto');

const Document = require('../models/Document');
const ShareToken = require('../models/ShareToken');
const { deriveEncryptionKey, unwrapKey, decryptFile } = require('../utils/crypto');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Deliberately generic and byte-identical for every failure mode - a
// token that never existed, one that's expired, one that's revoked, one
// whose documents have all since been deleted from the vault, and a
// document that isn't part of this link all produce this exact same
// response. Distinguishing them would leak information to someone probing
// token guesses without helping a legitimate recipient in any way.
function invalidShareLink() {
  const error = new Error('This link is invalid or has expired.');
  error.status = 404;
  return error;
}

/**
 * Shared by both public routes below: validates the token (exists, not
 * revoked, not expired), loads every still-existing document the link
 * covers, and unwraps the DEK copy that was wrapped under a key derived
 * from this exact token (see models/ShareToken.js). Deriving that same key
 * from the token in the URL and unwrapping is the entire "authentication"
 * these routes have - there is no unlocked session here, so no
 * req.session.encryptionKey to read the vault's DEK from the way every
 * other document route does.
 *
 * A link with several entries is still one token/one wrap: every document
 * is encrypted under the same DEK. Deleted documents simply drop out of the
 * link; if none remain, the link is treated as invalid.
 */
async function resolveShare(token) {
  const shareToken = await ShareToken.findOne({ token });

  if (!shareToken || shareToken.revoked || shareToken.expiresAt.getTime() <= Date.now()) {
    throw invalidShareLink();
  }

  const documents = await Document.find({ _id: { $in: shareToken.getDocumentIds() } });
  if (documents.length === 0) {
    throw invalidShareLink();
  }

  let dek;
  try {
    const shareKek = deriveEncryptionKey(shareToken.token, shareToken.wrappedDEKShareSalt);
    dek = unwrapKey(
      shareToken.wrappedDEKShare,
      shareKek,
      shareToken.wrappedDEKShareIv,
      shareToken.wrappedDEKShareAuthTag
    );
  } catch (err) {
    // Only reachable if the stored wrapped-DEK record itself is corrupt/
    // tampered with, since the KEK is otherwise always re-derivable from
    // the very token that just matched above. Still folded into the same
    // generic response rather than a 500 - "this link doesn't work" is
    // all a caller here should ever be able to tell.
    throw invalidShareLink();
  }

  return { shareToken, documents, dek };
}

/**
 * GET /api/shared/:token
 * Deliberately NOT behind requireSession - the token in the URL is the only
 * credential. Returns the manifest of every file this link covers; the
 * bytes themselves come from GET /api/shared/:token/files/:documentId.
 * (Ciphertext GCM length equals plaintext length, so the encrypted blob's
 * size is the file's size.)
 */
const viewSharedManifest = asyncHandler(async (req, res) => {
  const { shareToken, documents } = await resolveShare(req.params.token);

  res.status(200).json({
    expiresAt: shareToken.expiresAt,
    entries: documents.map((doc) => ({
      id: doc._id,
      filename: doc.filename,
      mimeType: doc.mimeType || 'application/octet-stream',
      size: doc.encryptedBlob.length,
    })),
  });
});

/**
 * GET /api/shared/:token/files/:documentId
 * Decrypts and streams one file from the link. The document must be one of
 * the link's own entries - a valid token can never be used to read some
 * other document in the vault.
 */
const viewSharedFile = asyncHandler(async (req, res) => {
  const { documents, dek } = await resolveShare(req.params.token);

  const document = documents.find((doc) => String(doc._id) === req.params.documentId);
  if (!document) {
    throw invalidShareLink();
  }

  const plaintext = decryptFile(
    document.encryptedBlob.toString('base64'),
    dek,
    document.iv,
    document.authTag
  );

  // Same integrity check as the authenticated view endpoint: a checksum
  // mismatch means the plaintext doesn't match what was originally
  // uploaded, independent of whether the AES-GCM authTag itself checked
  // out, so it's a hard failure rather than served anyway.
  const actualChecksum = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (actualChecksum !== document.checksum) {
    const error = new Error('Integrity check failed: this document may be corrupted.');
    error.status = 500;
    throw error;
  }

  res.setHeader('Content-Type', document.mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(document.filename)}"`
  );
  res.status(200).send(plaintext);
});

module.exports = { viewSharedManifest, viewSharedFile };
