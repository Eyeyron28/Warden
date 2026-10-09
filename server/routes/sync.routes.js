const express = require('express');
const multer = require('multer');

const requireDeviceAuth = require('../middleware/requireDeviceAuth');
const {
  listSyncDocuments,
  listSyncFolders,
  getSyncDocumentContent,
  pushSyncDocument,
  pushSyncFolder,
  syncMoved,
  MAX_BLOB_BYTES,
} = require('../controllers/sync.controller');

// requireDeviceAuth is applied per-route rather than via a blanket
// router.use(), so this router stays correct whatever else is mounted at
// /api/sync later.
const router = express.Router();

// Memory only, one file of at most 4 MiB per request - the same cap as an
// upload, and under the host's 4.5 MB request limit with room for the envelope.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BLOB_BYTES, files: 1, fields: 12, fieldSize: 4096 },
  defParamCharset: 'utf8',
});

function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      const error = new Error('File exceeds the 4MB size limit.');
      error.status = 413;
      return next(error);
    }
    const error = new Error('The upload could not be read.');
    error.status = 400;
    return next(error);
  });
}

router.get('/documents', requireDeviceAuth, listSyncDocuments);
router.get('/documents/:id/content', requireDeviceAuth, getSyncDocumentContent);
// Auth first, so an unpaired caller cannot make the server buffer a 4 MiB body.
router.post('/documents', requireDeviceAuth, handleUpload, pushSyncDocument);
router.get('/folders', requireDeviceAuth, listSyncFolders);
router.post('/folders', requireDeviceAuth, pushSyncFolder);
// The old unpaginated endpoints.
router.post('/pull', syncMoved);
router.post('/push', syncMoved);

module.exports = router;
