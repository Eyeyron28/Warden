// Limits for share links. Atlas M0 is small (512MB), and every share holds
// its own encrypted copies of the files, so storage is capped three ways.
const MB = 1024 * 1024;

module.exports = {
  MAX_SHARE_BYTES: 20 * MB, // total plaintext (= ciphertext) bytes in one share
  MAX_USER_SHARE_BYTES: 60 * MB, // across all of one user's active shares
  MAX_ACTIVE_SHARES: 20, // per user
  MAX_SHARE_FILES: 500,
  DEFAULT_DURATION_HOURS: 24 * 7,
  MAX_DURATION_HOURS: 24 * 30,
  MAX_DOWNLOADS: 100, // optional per-share download limit: 1 to 100
  PENDING_MINUTES: 15, // a password share stays hidden this long while the browser finishes it
  ACCESS_TTL_MINUTES: 60, // how long a visitor's gate progress lasts
  SHARE_EMAILS_PER_HOUR: 5, // code emails per share
  SHARE_CODE_MAX_ATTEMPTS: 5,
  SHARE_CODE_MAX_RESENDS: 3,
  SHARE_CODE_RESEND_COOLDOWN_MS: 60 * 1000,
  PASSWORD_ATTEMPTS: 5, // wrong password guesses per share per window
  PASSWORD_WINDOW_MS: 15 * 60 * 1000,
  // Accepted scrypt cost for a link password (the browser chooses; the server
  // refuses anything weaker).
  MIN_KDF_N: 2 ** 15,
  MAX_KDF_N: 2 ** 17,
};
