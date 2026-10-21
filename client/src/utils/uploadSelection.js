import { MAX_FILE_BYTES, validateUpload } from './transferRules.js';
import { uploadFitsMessage } from './storageUsage.js';
import { formatBytes } from './listing.js';

export const MAX_FILES_PER_UPLOAD = 10;

export const isZipName = (name) => /\.zip$/i.test(String(name || '').trim());
export const ZIP_ROW_REASON = 'Zips go through Export / Import';
export const ZIP_MESSAGE = 'Zip files go through Export / Import, so every file inside is checked. Use Export / Import to add this zip.';
export const ZIP_REFUSAL = Object.freeze({ message: 'Not saved', code: 'refused', retryable: false, refused: true, reasons: [{ code: 'PLAIN_ZIP', text: 'Zip files go through Export / Import, so every file inside is checked.' }] });
export const zipsNotAdded = (n) => `${n} ${n === 1 ? 'zip' : 'zips'} not added: use Export / Import.`;

export const fileKey = (file) => `${file.name}\u0000${file.size}\u0000${file.lastModified}`;

export function rowError(file) {
  if (isZipName(file.name)) return ZIP_ROW_REASON;
  if (!file.size) return 'Empty file';
  if (file.size > MAX_FILE_BYTES) return 'Over 4 MB';
  const check = validateUpload(file);
  return check.ok ? '' : check.reason;
}

export function addFiles(items, files, nextId = items.reduce((max, row) => Math.max(max, row.id), 0) + 1) {
  const rows = [...items];
  const seen = new Set(rows.filter((row) => !row.duplicate).map((row) => fileKey(row.file)));
  let overflow = 0;
  let added = 0;
  let duplicates = 0;
  let id = nextId;
  for (const file of Array.from(files)) {
    if (rows.length >= MAX_FILES_PER_UPLOAD) {
      overflow += 1;
      continue;
    }
    const key = fileKey(file);
    if (seen.has(key)) {
      rows.push({ id: id++, file, error: 'Already added', duplicate: true });
      duplicates += 1;
    } else {
      seen.add(key);
      rows.push({ id: id++, file, error: rowError(file), duplicate: false, zip: isZipName(file.name) });
    }
    added += 1;
  }
  return { items: rows, overflow, added, duplicates };
}

export const removeItem = (items, id) => items.filter((row) => row.id !== id);

export const replaceFile = (items, id, file) => items.map((row) => (row.id === id ? { ...row, file, error: rowError(file), duplicate: false, zip: false } : row));

export const overflowMessage = (overflow) => (overflow > 0 ? `Only ${MAX_FILES_PER_UPLOAD} files at a time. ${overflow} ${overflow === 1 ? 'was' : 'were'} not added.` : '');

export const submitLabel = (count) => (count > 1 ? `Encrypt & upload ${count} files` : 'Encrypt & upload');

function documentLimitMessage(usage, adding) {
  const limit = Number(usage?.documentLimit);
  const held = Number(usage?.documentCount);
  if (!Number.isFinite(limit) || !Number.isFinite(held) || held + adding <= limit) return '';
  const room = Math.max(0, limit - held);
  const todo = 'Delete some files or empty the Trash.';
  return room === 0 ? `You have reached the limit of ${limit} files. ${todo}` : `You can add ${room} more ${room === 1 ? 'file' : 'files'} (the limit is ${limit}). ${todo}`;
}

export function summarize(items, usage = null) {
  const valid = items.filter((row) => !row.error);
  const validBytes = valid.reduce((sum, row) => sum + row.file.size, 0);
  const totalBytes = items.reduce((sum, row) => sum + row.file.size, 0);
  const quotaMessage = valid.length > 0 ? uploadFitsMessage(usage, validBytes) || documentLimitMessage(usage, valid.length) : '';
  return {
    valid,
    validBytes,
    quotaMessage,
    counter: `${items.length} of ${MAX_FILES_PER_UPLOAD} files · ${formatBytes(totalBytes)}`,
    canAddMore: items.length < MAX_FILES_PER_UPLOAD,
    canUpload: valid.length > 0 && !quotaMessage,
  };
}
