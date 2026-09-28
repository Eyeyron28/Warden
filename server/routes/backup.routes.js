const express = require('express');
const router = express.Router();

const requireSession = require('../middleware/requireSession');
const User = require('../models/User');
const { exportBackup, importBackup, getStatus } = require('../controllers/backup.controller');

// asyncHandler-style wrapper (see controllers) so User.exists()'s rejection
// reaches errorHandler instead of crashing the process.
const asyncMiddleware = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// POST /import is the one route on this router reachable two different
// ways, decided by whether a User document exists yet:
//   - No User (fresh install): no session can possibly exist either, so
//     this lets the request through without requireSession. The
//     controller itself never trusts that alone - it requires the
//     backup's own master password and verifies it unwraps the manifest's
//     wrappedDEKPassword BEFORE writing anything (see importBackup).
//   - A User already exists: falls through to the exact same
//     requireSession every other route on this router has - an
//     authenticated owner is still required to import into a vault that
//     already exists.
// This has to be registered before the blanket router.use(requireSession)
// below, same ordering reason as documents.routes.js's phone-delete
// exception - once a request matches a route, later middleware on this
// router never runs for it.
async function importAuthGate(req, res, next) {
  const userExists = await User.exists({});
  if (!userExists) return next();
  return requireSession(req, res, next);
}
router.post('/import', asyncMiddleware(importAuthGate), importBackup);

// Every route below requires an unlocked vault session - exporting the
// vault's contents (even as ciphertext) shouldn't be reachable without one.
router.use(requireSession);

router.post('/export', exportBackup);
router.get('/status', getStatus);

module.exports = router;
