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

// The phone vault: Warden is a website, so there is no paired phone, no phone sync and no offline
// copy. Everything under these prefixes answers 410. (The new "Devices & activity" API lives under
// /api/security, so /api/devices stays gone.)
const PHONE_GONE =
  'Warden is a website now: pairing a phone, phone sync and the offline phone vault have been removed. Sign in on the website instead.';
for (const prefix of ['/pair', '/pairing', '/sync', '/devices']) {
  router.all(prefix, gone(PHONE_GONE));
  router.all(`${prefix}/*`, gone(PHONE_GONE));
}
router.all('/auth/recover-via-phone', gone('Recovery through a paired phone has been removed. Use "Forgot password" with an emailed code and your recovery key.'));
router.all('/auth/recover-via-phone/*', gone('Recovery through a paired phone has been removed. Use "Forgot password" with an emailed code and your recovery key.'));

module.exports = router;
