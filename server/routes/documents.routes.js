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

const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  defParamCharset: 'utf8',
});

const uploadFields = upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'thumb', maxCount: 1 },
]);

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

router.use(requireSession);

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

router.post('/star', starLimit, setStarred);
router.get('/recent', recentLimit, listRecent);
router.post('/batch/move', batchMoveLimit, batchMove);
router.post('/batch/trash', batchTrashLimit, batchTrash);
router.get('/:id/details', detailsLimit, getDetails);
router.post('/:id/quarantine/release', releaseLimit, releaseHeld);
router.put('/:id/note', noteLimit, setNote);
router.post('/:id/versions', versionUploadLimit, handleUpload, uploadVersion);
router.post('/:id/versions/:versionId/restore', versionRestoreLimit, restoreVersion);
router.delete('/:id/versions/:versionId', versionDeleteLimit, deleteVersion);
router.get('/:id/versions/:versionId/download', versionDownloadLimit, downloadVersion);

router.delete('/folders', deleteFolder);
router.delete('/:id', deleteDocument);
router.post('/', uploadRateLimit, handleUpload, createDocument);
router.get('/', listDocuments);
router.get('/expiring', listExpiringDocuments);
router.get('/folders', listFolders);
router.get('/folders/children', listFolderChildren);
router.get('/photos', listPhotos);
router.get('/storage', getStorage);
router.post('/folders', createFolder);
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
