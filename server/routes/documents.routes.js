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
  deleteFolder,
  updateDocument,
  viewDocument,
  deleteDocument,
} = require('../controllers/documents.controller');

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB - IDs, contracts, PDFs, not videos

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
      const error = new Error('File exceeds the 20MB size limit.');
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
router.get('/:id/view', viewDocument);
router.patch('/:id', updateDocument);

module.exports = router;
