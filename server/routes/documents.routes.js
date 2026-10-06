const express = require('express');
const multer = require('multer');
const router = express.Router();

const requireSession = require('../middleware/requireSession');
const requireSessionOrDeviceAuth = require('../middleware/requireSessionOrDeviceAuth');
const {
  createDocument,
  listDocuments,
  listExpiringDocuments,
  listFolders,
  createFolder,
  renameFolder,
  deleteFolder,
  moveItems,
  updateDocument,
  viewDocument,
  deleteDocument,
} = require('../controllers/documents.controller');

// 4MB, down from the old local-only 20MB cap: Vercel Hobby caps a whole
// request body at 4.5MB, so a single upload has to fit comfortably under
// that (plus the small multipart envelope around it) - see server.js's
// own express.json limit comment for the matching reasoning on the
// JSON/base64 upload path (POST /api/sync/push).
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;

// Memory storage only: the file buffer stays in RAM for encryption and is
// never written to a temp file on disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

// Wraps multer so a file-too-large rejection comes back as a normal JSON
// error (via the shared errorHandler) instead of multer's raw error shape.
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      const error = new Error('File exceeds the 4MB size limit.');
      error.status = 413;
      return next(error);
    }

    next(err);
  });
}

// Per-document delete and folder-marker cleanup are the routes a paired
// phone may also call (with its deviceToken) - it has to be registered before the blanket
// requireSession below, and after the more specific DELETE /folders so
// "folders" isn't captured as an :id.
router.delete('/folders', requireSessionOrDeviceAuth, deleteFolder);
router.delete('/:id', requireSessionOrDeviceAuth, deleteDocument);

// Every route below requires an unlocked vault session.
router.use(requireSession);

router.post('/', handleUpload, createDocument);
router.get('/', listDocuments);
router.get('/expiring', listExpiringDocuments);
router.get('/folders', listFolders);
router.post('/folders', createFolder);
// Registered before PATCH /:id so "folders" is never captured as an id.
router.patch('/folders', renameFolder);
router.post('/move', moveItems);
router.get('/:id/view', viewDocument);
router.patch('/:id', updateDocument);

module.exports = router;
