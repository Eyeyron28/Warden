const crypto = require('crypto');

const Document = require('../models/Document');
const ShareToken = require('../models/ShareToken');
const { deriveEncryptionKey, unwrapKey, decryptFile } = require('../utils/crypto');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Deliberately generic and byte-identical for every failure mode - a
// token that never existed, one that's expired, one that's revoked, and
// one whose document has since been deleted from the vault all produce
// this exact same response. Distinguishing them would leak information
// to someone probing token guesses without helping a legitimate
// recipient in any way.
function invalidShareLink() {
  const error = new Error('This link is invalid or has expired.');
  error.status = 404;
  return error;
}

/**
 * GET /api/shared/:token
 * Deliberately NOT behind requireSession - the ONE route in the app meant
 * to work with zero credentials beyond the token in the URL. There is no
 * unlocked session here, so there's no req.session.encryptionKey to read
 * the vault's DEK from the way every other document route does.
 *
 * Instead, this unwraps the COPY of the DEK that POST /api/documents/:id/
 * share already wrapped under a key derived from this exact token (see
 * models/ShareToken.js). Deriving that same key from the token in the URL
 * and unwrapping is the entire "authentication" this route has - and
 * because that wrapping is unique per share record, this token can only
 * ever unwrap the one document it was created for.
 */
const viewSharedDocument = asyncHandler(async (req, res) => {
  const shareToken = await ShareToken.findOne({ token: req.params.token });

  if (!shareToken || shareToken.revoked || shareToken.expiresAt.getTime() <= Date.now()) {
    throw invalidShareLink();
  }

  const document = await Document.findById(shareToken.documentId);
  if (!document) {
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

module.exports = { viewSharedDocument };
