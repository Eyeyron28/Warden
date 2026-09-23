const crypto = require('crypto');
const mongoose = require('mongoose');

const Document = require('../models/Document');
const ShareToken = require('../models/ShareToken');
const { generateSalt, deriveEncryptionKey, wrapKey } = require('../utils/crypto');
const { resolveLanIp } = require('../utils/network');

// The frontend's own dev-server port (vite.config.js, README) - there's
// no env var for it today, same as pairing.controller.js hardcoding a
// fallback for its own PORT. /shared/:token is a React Router route
// served by Vite, not this Express app, so the share link must point
// there, never at this server's own port.
const FRONTEND_PORT = 5173;

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

  // Same fail-loudly-if-undetermined guarantee as POST /api/pair/init:
  // a share link built from an unreachable address (e.g. silently
  // falling back to "localhost") would look fine to the owner and then
  // not work for whoever they send it to, with nothing telling them why.
  const lanIp = resolveLanIp();
  if (!lanIp) {
    const error = new Error(
      "Could not determine this PC's LAN address. Set the LAN_IP environment variable (see .env.example) and restart the server."
    );
    error.status = 500;
    throw error;
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

  // Root cause of a past bug (also true of the pairing QR before it was
  // fixed the same way): building this from the request's own host, or
  // from the owner's browser tab (window.location.origin), captures
  // whatever the OWNER happened to be browsing from at that moment -
  // often "localhost", which means nothing to a recipient on a different
  // device. lanIp (resolveLanIp, shared with pairing.controller.js) is
  // this PC's actual LAN-reachable address regardless of how the owner
  // themselves got here, and FRONTEND_PORT points at the React route
  // that serves /shared/:token, not this API's own port.
  const shareUrl = `${req.protocol}://${lanIp}:${FRONTEND_PORT}/shared/${shareToken.token}`;

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
