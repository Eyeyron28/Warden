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

const MAX_SHARE_ENTRIES = 500;

/**
 * The one place a share link is issued - both POST /api/documents/:id/share
 * (a single document) and POST /api/shares (a set, e.g. a whole folder's
 * contents) call this, so a single-file share is just an entries array of
 * length 1 rather than a parallel code path.
 *
 * Owner-only (requireSession, mounted in routes/shares.routes.js): creates
 * a new share token covering `documentIds`, valid for durationHours from
 * now. The public-facing endpoints that consume it live in
 * controllers/sharedView.controller.js with their own trust boundary.
 */
async function issueShare(req, res, documentIds) {
  const rawHours = req.body.durationHours;
  if (typeof rawHours !== 'number' && typeof rawHours !== 'string') {
    throw badRequest('durationHours must be a positive number of hours.');
  }
  const hours = Number(rawHours);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw badRequest('durationHours must be a positive number of hours.');
  }

  if (!documentIds.every((id) => typeof id === 'string')) {
    throw badRequest('Invalid document id.');
  }
  const uniqueIds = [...new Set(documentIds)];
  if (uniqueIds.length === 0) {
    throw badRequest('At least one document is required.');
  }
  if (uniqueIds.length > MAX_SHARE_ENTRIES) {
    throw badRequest(`A share link can include at most ${MAX_SHARE_ENTRIES} documents.`);
  }
  uniqueIds.forEach((id) => assertValidId(id));

  const documents = await Document.find({ _id: { $in: uniqueIds } }).select('filename mimeType');
  if (documents.length !== uniqueIds.length) {
    throw documentNotFound();
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
  // session) under a key derived from this specific token, so the public
  // /api/shared/:token routes can unwrap it later using only the token
  // from the URL - no session, no password, no recovery key involved at
  // all. Every document is encrypted under this same DEK, so one wrap per
  // link covers every entry.
  const shareSalt = generateSalt();
  const shareKek = deriveEncryptionKey(token, shareSalt);
  const wrappedShare = wrapKey(req.session.encryptionKey, shareKek);

  const shareToken = await ShareToken.create({
    entries: documents.map((doc) => ({
      documentId: doc._id,
      filename: doc.filename,
      mimeType: doc.mimeType,
    })),
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
    id: shareToken._id,
    token: shareToken.token,
    expiresAt: shareToken.expiresAt,
    shareUrl,
    entryCount: documents.length,
  });
}

/**
 * POST /api/documents/:id/share
 * Body: { durationHours }
 */
const createShare = asyncHandler(async (req, res) => {
  assertValidId(req.params.id);
  await issueShare(req, res, [req.params.id]);
});

/**
 * POST /api/shares
 * Body: { documentIds: string[], durationHours }
 * One link covering many documents (the client resolves a folder selection
 * to its nested documents before calling this).
 */
const createBulkShare = asyncHandler(async (req, res) => {
  const { documentIds } = req.body;
  if (!Array.isArray(documentIds)) {
    throw badRequest('documentIds must be an array.');
  }
  await issueShare(req, res, documentIds);
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
    // Covers links that include this document among several, plus legacy
    // single-document links that predate `entries`.
    $or: [{ 'entries.documentId': document._id }, { documentId: document._id }],
    revoked: false,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  res.status(200).json(
    shares.map((share) => ({
      id: share._id,
      expiresAt: share.expiresAt,
      createdAt: share.createdAt,
      entryCount: share.getDocumentIds().length,
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
  createBulkShare,
  listShares,
  revokeShare,
  revokeShareById,
};
