const express = require('express');

const requireSession = require('../middleware/requireSession');
const {
  createShare,
  createBulkShare,
  listShares,
  getUsage,
  revokeShare,
} = require('../controllers/shares.controller');

// Two routers, mounted at two different prefixes in server.js, rather than
// one router carrying every route: /:id/share and /:id/shares have no common
// prefix with /api/shares, and mounting one broad router risks it matching
// paths under an unrelated prefix (e.g. /api/auth/*) before that router's
// own requireSession-free routes get a chance to run.

// Owner-only document sub-resource: create/list shares for a specific
// document. Mounted at /api/documents alongside documents.routes.
const documentSharesRoutes = express.Router();
documentSharesRoutes.use(requireSession);
documentSharesRoutes.post('/:id/share', createShare);
documentSharesRoutes.get('/:id/shares', listShares);

// Owner-only management of shares, addressed by the share's own id.
// Mounted at /api/shares. (The public, unauthenticated routes that serve a
// share's ciphertext are a separate router: routes/sharedView.routes.js.)
const shareRoutes = express.Router();
shareRoutes.use(requireSession);
shareRoutes.post('/', createBulkShare);
shareRoutes.get('/usage', getUsage);
shareRoutes.delete('/:shareId', revokeShare);

module.exports = { documentSharesRoutes, shareTokenRoutes: shareRoutes };
