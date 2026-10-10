const crypto = require('crypto');

/**
 * Helpers for what may be written to the server log. The rule: no recipient address, no connection string, no secret.
 * A short hash is enough to tell two log lines are about the same mailbox without saying whose it is.
 */

/** Removes email addresses and database connection strings from text that is about to be logged. */
function scrubForLog(text) {
  return String(text ?? '')
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, '[database address]')
    .replace(/[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+/g, '[address]')
    .slice(0, 300);
}

/** Eight hex characters of a SHA-256 of the lowercased value: a correlation id, not a way back to the address. */
function shortHash(value) {
  return crypto.createHash('sha256').update(String(value ?? '').trim().toLowerCase()).digest('hex').slice(0, 8);
}

module.exports = { scrubForLog, shortHash };
