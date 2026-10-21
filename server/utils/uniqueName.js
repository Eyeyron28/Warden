const Document = require('../models/Document');
const { MAX_STORED_NAME, splitName } = require('./fileNames');

const keyOf = (name) => String(name).normalize('NFC').trim().toLowerCase();
const length = (text) => [...text].length;

function withCounter(base, ext, counter) {
  const suffix = ` (${counter})${ext ? `.${ext}` : ''}`;
  const room = MAX_STORED_NAME - length(suffix);
  const shortened = length(base) > room ? [...base].slice(0, Math.max(1, room)).join('').trimEnd() : base;
  return `${shortened}${suffix}`;
}

function pickFreeName(wanted, takenNames) {
  const taken = new Set([...takenNames].map(keyOf));
  if (!taken.has(keyOf(wanted))) return { name: wanted, changed: false };
  const { base, ext } = splitName(wanted);
  for (let counter = 1; counter < 100000; counter += 1) {
    const candidate = withCounter(base, ext, counter);
    if (!taken.has(keyOf(candidate))) return { name: candidate, changed: true };
  }
  throw Object.assign(new Error('Too many files with the same name in this folder.'), { status: 409 });
}

async function freeName({ userId, folder, wanted, excludeId = null }) {
  const filter = { userId, folder, deletedAt: null };
  if (excludeId) filter._id = { $ne: excludeId };
  const rows = await Document.find(filter).select('filename').lean();
  return pickFreeName(wanted, rows.map((row) => row.filename));
}

module.exports = { freeName, pickFreeName, withCounter, keyOf };
