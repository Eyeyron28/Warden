const crypto = require('crypto');

/**
 * Pairing tokens and device tokens are random 256-bit bearer values. Only their
 * SHA-256 is stored, so a copy of the database cannot be used to pair a device
 * or to call the sync API; the raw value is shown once, to the one who holds
 * it (the QR on the owner's screen, or the paired phone). A fast hash is
 * enough because the input is 256 random bits, not something a person chose.
 */
const TOKEN_BYTES = 32;

const newToken = () => crypto.randomBytes(TOKEN_BYTES).toString('hex');

/** Hex SHA-256 of a raw token, or null when it is not even shaped like one. */
function hashToken(raw) {
  if (typeof raw !== 'string' || !/^[0-9a-f]{64}$/.test(raw)) return null;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

module.exports = { newToken, hashToken };
