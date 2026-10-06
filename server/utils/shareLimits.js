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
};
