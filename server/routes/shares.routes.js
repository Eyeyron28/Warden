const express = require('express');

const requireSession = require('../middleware/requireSession');
const {
  createShare,
  listShares,
  revokeShare,
  revokeShareById,
} = require('../controllers/shares.controller');

// Two routers, mounted at two different prefixes in server.js, rather than
// one router carrying all three routes: /:id/share, /:id/shares, and
// /:token/revoke share no common prefix of their own, and mounting a
// single router broadly enough to cover all three would risk it also
// matching paths under an unrelated prefix (e.g. /api/auth/*) before that
// router's own requireSession-free routes get a chance to run.

// Owner-only document sub-resource: create/list share links for a
// specific document. Mounted at /api/documents alongside documents.routes.
const documentSharesRoutes = express.Router();
documentSharesRoutes.use(requireSession);
documentSharesRoutes.post('/:id/share', createShare);
documentSharesRoutes.get('/:id/shares', listShares);

// Owner-only management of a share token by its own id. Mounted at
// /api/shares. (The public, unauthenticated "consume a share token to
// view a document" route is a separate, later pass - it does not belong
// on this owner-only router.)
const shareTokenRoutes = express.Router();
shareTokenRoutes.use(requireSession);
// Registered before the shorter /:token/revoke pattern is irrelevant here
// (different segment counts, so Express can't confuse the two), but kept
// grouped together since they're the two ways to revoke the same thing.
shareTokenRoutes.post('/id/:shareId/revoke', revokeShareById);
shareTokenRoutes.post('/:token/revoke', revokeShare);

module.exports = { documentSharesRoutes, shareTokenRoutes };
