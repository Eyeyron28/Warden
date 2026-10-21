const crypto = require('crypto');

const { wrapKey, unwrapKey } = require('../crypto');

const HALF_BYTES = 32;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const xor = (a, b) => {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) out[i] = a[i] ^ b[i];
  return out;
};

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function encodeKit(k1) {
  return base32(k1).match(/.{1,4}/g).join('-');
}

function parseKit(text) {
  if (typeof text !== 'string' || text.length > 200) return null;
  const clean = text.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean) || clean.length !== Math.ceil((HALF_BYTES * 8) / 5)) return null;
  const bytes = fromBase32(clean);
  return bytes && bytes.length === HALF_BYTES ? bytes : null;
}

const hashKit = (k1, saltHex) => crypto.createHash('sha256').update(Buffer.concat([k1, Buffer.from(saltHex, 'hex')])).digest('hex');

function createSplit(dek) {
  const k1 = crypto.randomBytes(HALF_BYTES);
  const k2 = crypto.randomBytes(HALF_BYTES);
  const kitSalt = crypto.randomBytes(16).toString('hex');
  const wrapped = wrapKey(dek, xor(k1, k2));
  return {
    k1,
    stored: {
      k2,
      kitSalt,
      kitHash: hashKit(k1, kitSalt),
      wrappedDek: wrapped.wrappedKey,
      wrappedDekIv: wrapped.iv,
      wrappedDekAuthTag: wrapped.authTag,
    },
  };
}

function kitMatches(access, k1) {
  const salt = access?.kitSalt || '00'.repeat(16);
  const expected = Buffer.from(access?.kitHash || '00'.repeat(32), 'hex');
  const actual = Buffer.from(hashKit(k1 || Buffer.alloc(HALF_BYTES), salt), 'hex');
  const equal = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  return Boolean(access && k1 && equal);
}

function unwrapWithKit(access, k1) {
  try {
    const e = xor(k1, access.k2);
    return unwrapKey(access.wrappedDek, e, access.wrappedDekIv, access.wrappedDekAuthTag);
  } catch {
    return null;
  }
}

module.exports = { HALF_BYTES, createSplit, encodeKit, parseKit, kitMatches, unwrapWithKit, xor };
