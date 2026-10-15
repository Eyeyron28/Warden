const Document = require('../models/Document');
const { MAX_STORED_NAME, splitName } = require('./fileNames');

/**
 * Same-name files get a counter: "report.pdf", then "report (1).pdf", "report (2).pdf" ... in the same folder.
 *
 * Rules (each has a test, server/test/unique-names.test.js):
 *  - only the LAST extension is kept apart ("archive.tar.gz" becomes "archive.tar (1).gz");
 *  - names are compared case-insensitively and by Unicode composition, the way folder names are compared (toNameKey), and a
 *    name that differs only in capital letters or accents-as-one-character-or-two counts as taken;
 *  - files in Trash are not "taken" (they are not in the folder);
 *  - the whole name stays within MAX_STORED_NAME characters: the BASE is shortened, never the counter or the extension.
 *
 * It does not lock anything: two uploads of the same name that reach the database at the same instant can both be given the same
 * number. Nothing is overwritten (each is its own document), and the owner can rename one (docs/KNOWN-LIMITS.md).
 */
const keyOf = (name) => String(name).normalize('NFC').trim().toLowerCase();
const length = (text) => [...text].length;

/** The name with " (n)" before its extension, the base cut down so the whole fits. */
function withCounter(base, ext, counter) {
  const suffix = ` (${counter})${ext ? `.${ext}` : ''}`;
  const room = MAX_STORED_NAME - length(suffix);
  const shortened = length(base) > room ? [...base].slice(0, Math.max(1, room)).join('').trimEnd() : base;
  return `${shortened}${suffix}`;
}

/** The first free name among a set of names already taken (compared by keyOf). Pure; the database part is freeName. */
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

/**
 * A free file name in a folder of one account.
 * @param {{ userId: any, folder: string, wanted: string, excludeId?: any }} options `folder` is the Document.folder value
 *   ("root" for the top level); `excludeId` is a file that is being renamed (it does not clash with itself).
 * @returns {Promise<{ name: string, changed: boolean }>}
 */
async function freeName({ userId, folder, wanted, excludeId = null }) {
  const filter = { userId, folder, deletedAt: null };
  if (excludeId) filter._id = { $ne: excludeId };
  const rows = await Document.find(filter).select('filename').lean();
  return pickFreeName(wanted, rows.map((row) => row.filename));
}

module.exports = { freeName, pickFreeName, withCounter, keyOf };
