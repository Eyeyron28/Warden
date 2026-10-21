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

const documentSharesRoutes = express.Router();
documentSharesRoutes.use(requireSession);
documentSharesRoutes.post('/:id/share', createShare);
documentSharesRoutes.get('/:id/shares', listShares);

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
