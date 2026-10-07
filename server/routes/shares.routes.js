const express = require('express');

const requireSession = require('../middleware/requireSession');
const {
  createShare,
  createBulkShare,
  listShares,
  listAllShares,
  getUsage,
  updateShare,
  setPassword,
  getProtection,
  getOwnerManifest,
  removePassword,
  revokeShare,
  stopAllShares,
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

// Owner-only management of shares (the share manager), addressed by the
// share's own id. Mounted at /api/shares. (The public, unauthenticated routes
// that serve a share's ciphertext are a separate router: sharedView.routes.js.)
// Another account's share is a 404 on every one of these.
const shareRoutes = express.Router();
shareRoutes.use(requireSession);
shareRoutes.post('/', createBulkShare);
shareRoutes.get('/', listAllShares);
shareRoutes.delete('/', stopAllShares);
shareRoutes.get('/usage', getUsage);
shareRoutes.patch('/:shareId', updateShare);
shareRoutes.get('/:shareId/manifest', getOwnerManifest);
shareRoutes.get('/:shareId/protection', getProtection);
shareRoutes.put('/:shareId/password', setPassword);
shareRoutes.delete('/:shareId/password', removePassword);
shareRoutes.delete('/:shareId', revokeShare);

module.exports = { documentSharesRoutes, shareTokenRoutes: shareRoutes };
