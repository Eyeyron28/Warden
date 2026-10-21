const crypto = require('crypto');

const CODE_DIGITS = 6;
const SALT_BYTES = 16;
const CHALLENGE_KEY_BYTES = 32;

function generateCode() {
  return String(crypto.randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

function newSalt() {
  return crypto.randomBytes(SALT_BYTES).toString('hex');
}

function hashCode(salt, code) {
  return crypto.createHmac('sha256', Buffer.from(salt, 'hex')).update(code, 'utf8').digest('hex');
}

function codeMatches(salt, storedHashHex, submitted) {
  if (typeof submitted !== 'string' || !/^\d{6}$/.test(submitted)) return false;
  const expected = Buffer.from(storedHashHex, 'hex');
  const actual = Buffer.from(hashCode(salt, submitted), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function newChallengeKey() {
  return crypto.randomBytes(CHALLENGE_KEY_BYTES);
}

const TOKEN_RE = /^([0-9a-f]{24})\.([0-9a-f]{64})$/;

function parseChallengeToken(token) {
  if (typeof token !== 'string') return null;
  const match = TOKEN_RE.exec(token);
  return match ? { challengeId: match[1], challengeKey: Buffer.from(match[2], 'hex') } : null;
}

function buildChallengeToken(challengeId, challengeKey) {
  return `${challengeId}.${challengeKey.toString('hex')}`;
}

module.exports = {
  CODE_DIGITS,
  generateCode,
  newSalt,
  hashCode,
  codeMatches,
  newChallengeKey,
  parseChallengeToken,
  buildChallengeToken,
};
