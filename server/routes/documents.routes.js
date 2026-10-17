const express = require('express');
const multer = require('multer');
const router = express.Router();

const requireSession = require('../middleware/requireSession');
const createRateLimiter = require('../middleware/rateLimit');
const { uploadRateLimit } = require('../utils/uploadLimits');
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
  recordDownload,
  getThumbnail,
  putThumbnail,
  markThumbnailFailed,
  retryFailedThumbnails,
  deleteDocument,
  listPhotos,
  getStorage,
  listFolderChildren,
} = require('../controllers/documents.controller');
const { setStarred, listRecent, getDetails, batchMove, batchTrash } = require('../controllers/driveBasics.controller');
const { releaseHeld } = require('../controllers/quarantine.controller');
const { setNote, uploadVersion, restoreVersion, deleteVersion, downloadVersion } = require('../controllers/notesVersions.controller');

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
  // Browsers send file names as UTF-8; the default (latin1) turns "Résumé 履歴.pdf" into mojibake.
  defParamCharset: 'utf8',
});

// An upload carries the document under "file" and, optionally, a small
// preview image under "thumb" (drawn by the browser from the plaintext
// before it leaves the page; the controller encrypts it - see
// utils/thumbnails.js). Anything else in the multipart body is rejected by
// multer as an unexpected field.
const uploadFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
]);

// Wraps multer so a file-too-large rejection comes back as a normal JSON
// error (via the shared errorHandler) instead of multer's raw error shape.
function handleUpload(req, res, next) {
  uploadFields(req, res, (err) => {
    if (!err) return next();

    if (err.code === 'LIMIT_FILE_SIZE') {
      const error = new Error('File exceeds the 4MB size limit.');
      error.status = 413;
      return next(error);
    }

    next(err);
  });
}

// Every route below requires an unlocked vault session.
router.use(requireSession);

// Stars, Recent, the details panel and the batch actions: each has its OWN per-account budget (a bucket of its own, counted by
// the signed-in account), after the session check, so a flood on one cannot use up another's.
const perAccount = (name, max) =>
  createRateLimiter({ name, max, windowMs: 60 * 60 * 1000, keyFn: (req) => (req.userId ? String(req.userId) : null) });
const starLimit = perAccount('docs-star', 600);
const recentLimit = perAccount('docs-recent', 300);
const detailsLimit = perAccount('docs-details', 900);
const batchMoveLimit = perAccount('docs-batch-move', 120);
const batchTrashLimit = perAccount('docs-batch-trash', 120);
const noteLimit = perAccount('docs-note', 300);
const versionUploadLimit = perAccount('docs-version-upload', 60);
const versionRestoreLimit = perAccount('docs-version-restore', 120);
const versionDeleteLimit = perAccount('docs-version-delete', 120);
const versionDownloadLimit = perAccount('docs-version-download', 300);
const releaseLimit = perAccount('docs-quarantine-release', 60);

// Registered before the routes with an :id so "recent" and "batch" are never captured as one.
router.post('/star', starLimit, setStarred);
router.get('/recent', recentLimit, listRecent);
router.post('/batch/move', batchMoveLimit, batchMove);
router.post('/batch/trash', batchTrashLimit, batchTrash);
router.get('/:id/details', detailsLimit, getDetails);
router.post('/:id/quarantine/release', releaseLimit, releaseHeld);
// Private notes and version history: also each its own bucket, counted per account.
router.put('/:id/note', noteLimit, setNote);
router.post('/:id/versions', versionUploadLimit, handleUpload, uploadVersion);
router.post('/:id/versions/:versionId/restore', versionRestoreLimit, restoreVersion);
router.delete('/:id/versions/:versionId', versionDeleteLimit, deleteVersion);
router.get('/:id/versions/:versionId/download', versionDownloadLimit, downloadVersion);

router.delete('/folders', deleteFolder);
router.delete('/:id', deleteDocument);
// The speed limits run first, before the body is read, scanned or encrypted (a refused upload still counts).
router.post('/', uploadRateLimit, handleUpload, createDocument);
router.get('/', listDocuments);
router.get('/expiring', listExpiringDocuments);
router.get('/folders', listFolders);
router.get('/folders/children', listFolderChildren);
router.get('/photos', listPhotos);
router.get('/storage', getStorage);
router.post('/folders', createFolder);
// Registered before PATCH /:id so "folders" is never captured as an id.
router.patch('/folders', renameFolder);
router.post('/move', moveItems);
router.get('/:id/view', viewDocument);
router.post('/:id/downloaded', recordDownload);
router.get('/:id/thumbnail', getThumbnail);
router.put('/:id/thumbnail', handleUpload, putThumbnail);
router.post('/thumbnails/retry', retryFailedThumbnails);
router.post('/:id/thumbnail-failed', markThumbnailFailed);
router.patch('/:id', updateDocument);

module.exports = router;
