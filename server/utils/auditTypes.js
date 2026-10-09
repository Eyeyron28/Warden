// Every kind of event the activity log can hold. One list, used by the model, the controllers and the tests.
const EVENT_TYPES = Object.freeze([
  'login', 'login_failed', 'logout', 'otp_sent', 'password_changed', 'trusted_added', 'trusted_removed', 'device_signed_out',
  'upload', 'view', 'download', 'rename', 'move', 'delete', 'restore', 'trash_emptied', 'export', 'import',
  'share_created', 'share_revoked', 'share_opened', 'share_downloaded', 'shares_stopped_all', 'account_export',
  'expiry_set', 'expiry_cleared',
]);

module.exports = { EVENT_TYPES };
