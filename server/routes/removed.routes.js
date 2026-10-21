const express = require('express');

const router = express.Router();

const gone = (message) => (req, res) => {
  res.status(410).json({ success: false, error: { message } });
};

const BACKUP_GONE =
  'Backup to a drive and restore from a backup have been removed. Use Export in the app to download your files as a zip.';
router.all('/backup', gone(BACKUP_GONE));
router.all('/backup/*', gone(BACKUP_GONE));

router.all(
  '/auth/recover-via-usb',
  gone('USB recovery has been removed. Use "Forgot password" with an emailed code and your recovery key instead.')
);

const PHONE_GONE =
  'Warden is a website now: pairing a phone, phone sync and the offline phone vault have been removed. Sign in on the website instead.';
for (const prefix of ['/pair', '/pairing', '/sync', '/devices']) {
  router.all(prefix, gone(PHONE_GONE));
  router.all(`${prefix}/*`, gone(PHONE_GONE));
}
router.all('/auth/recover-via-phone', gone('Recovery through a paired phone has been removed. Use "Forgot password" with an emailed code and your recovery key.'));
router.all('/auth/recover-via-phone/*', gone('Recovery through a paired phone has been removed. Use "Forgot password" with an emailed code and your recovery key.'));

module.exports = router;
