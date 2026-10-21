const crypto = require('crypto');

function scrubForLog(text) {
  return String(text ?? '')
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, '[database address]')
    .replace(/[^\s<>"',;:()[\]]+@[^\s<>"',;:()[\]]+/g, '[address]')
    .slice(0, 300);
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value ?? '').trim().toLowerCase()).digest('hex').slice(0, 8);
}

module.exports = { scrubForLog, shortHash };
