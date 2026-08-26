const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const ShareToken = require('../models/ShareToken');
const { generateSalt, deriveEncryptionKey, wrapKey } = require('../utils/crypto');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function documentNotFound() {
  const error = new Error('Document not found.');
  error.status = 404;
  return error;
}

function assertValidId(id, label = 'document') {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw badRequest(`Invalid ${label} id.`);
  }
}

const SHARE_TOKEN_BYTES = 32;

/**
 * POST /api/documents/:id/share
 * Body: { durationHours }
 * Owner-only (requireSession, mounted in routes/shares.routes.js): creates
 * a new share token for this document, valid for durationHours from now.
 * The public-facing "view a shared document" endpoint that actually
 * consumes this token is a separate, unauthenticated pass with its own
 * trust boundary - this one only ever runs for the unlocked vault owner.
 */
const createShare = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findById(req.params.id);
  if (!document) {
    throw documentNotFound();
  }

  const hours = Number(req.body.durationHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw badRequest('durationHours must be a positive number of hours.');
  }

  const token = crypto.randomBytes(SHARE_TOKEN_BYTES).toString('hex');
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

  // Wrap a COPY of the vault's DEK (available here via req.session -
  // requireSession already unwrapped it for this owner's unlocked
  // session) under a key derived from this specific token, so
  // GET /api/shared/:token can unwrap it later using only the token from
  // the URL - no session, no password, no recovery key involved at all.
  const shareSalt = generateSalt();
  const shareKek = deriveEncryptionKey(token, shareSalt);
  const wrappedShare = wrapKey(req.session.encryptionKey, shareKek);

  const shareToken = await ShareToken.create({
    documentId: document._id,
    token,
    expiresAt,
    wrappedDEKShare: wrappedShare.wrappedKey,
    wrappedDEKShareIv: wrappedShare.iv,
    wrappedDEKShareAuthTag: wrappedShare.authTag,
    wrappedDEKShareSalt: shareSalt,
  });

  // Built from the request's own host rather than a hardcoded origin, so
  // the link is correct whether the owner reached the API via localhost
  // or the PC's LAN IP - whichever address got the owner here is the one
  // a recipient on the same network needs too.
  const shareUrl = `${req.protocol}://${req.get('host')}/shared/${shareToken.token}`;

  res.status(201).json({
    token: shareToken.token,
    expiresAt: shareToken.expiresAt,
    shareUrl,
  });
});

/**
 * GET /api/documents/:id/shares
 * Lists this document's currently-active (non-revoked, non-expired) share
 * links, so the owner can see what's out there before deciding to revoke
 * anything.
 */
const listShares = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);

  const document = await Document.findById(req.params.id);
  if (!document) {
    throw documentNotFound();
  }

  const shares = await ShareToken.find({
    documentId: document._id,
    revoked: false,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  res.status(200).json(
    shares.map((share) => ({
      id: share._id,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
    }))
  );
});

/**
 * POST /api/shares/:token/revoke
 * Idempotent by design: the caller is asking for an end state ("this link
 * no longer works"), not reporting a transition, so an already-revoked,
 * already-expired, or even unrecognized token all just return success
 * rather than needing the caller to distinguish those cases.
 */
const revokeShare = asyncHandler(async (req, res) => {
  await ShareToken.updateOne({ token: req.params.token }, { $set: { revoked: true } });
  res.status(200).json({ success: true });
});

/**
 * POST /api/shares/id/:shareId/revoke
 * Same idempotent behavior as revokeShare above, addressed by the
 * ShareToken's own _id instead of its token. GET /api/documents/:id/shares
 * deliberately never re-exposes a share's raw token after creation (the
 * same one-time-secret hygiene as the recovery key never being shown
 * again) - this is what lets the owner revoke a share from that list
 * without the frontend ever having to hold or redisplay the live token.
 */
const revokeShareById = asyncHandler(async (req, res) => {
  assertValidId(req.params.shareId, 'share');
  await ShareToken.updateOne({ _id: req.params.shareId }, { $set: { revoked: true } });
  res.status(200).json({ success: true });
});

module.exports = {
  createShare,
  listShares,
  revokeShare,
  revokeShareById,
};
