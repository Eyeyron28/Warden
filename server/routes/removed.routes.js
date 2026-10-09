const express = require('express');

const router = express.Router();

// Features that were taken out. Nothing is looked up and nothing is written: the old
// URLs just answer 410 with a plain message, so an old client or script gets a clear
// answer instead of a confusing 404.
const gone = (message) => (req, res) => {
  res.status(410).json({ success: false, error: { message } });
};

// Server-disk backup and restore (USB). A hosted server cannot write to or read from a
// folder on the person's own computer; "Export my files" (a zip built in the browser)
// replaces it.
const BACKUP_GONE =
  'Backup to a drive and restore from a backup have been removed. Use Export in the app to download your files as a zip.';
router.all('/backup', gone(BACKUP_GONE));
router.all('/backup/*', gone(BACKUP_GONE));

// Recovery from a USB backup.
router.all(
  '/auth/recover-via-usb',
  gone('USB recovery has been removed. Use "Forgot password" with an emailed code and your recovery key instead.')
);

module.exports = router;
