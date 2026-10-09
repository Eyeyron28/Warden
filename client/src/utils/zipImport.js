import { sanitizeDownloadName } from './fileNames.js';
import { readZipEntries } from './zipNames.js';
import { uniqueName } from './zipExport.js';

/**
 * "Import .zip": a zip opened in the browser, its files uploaded through the NORMAL upload path
 * (same 4 MB cap, same quota, same naming and folder rules - this module only decides WHAT to
 * upload, never how).
 *
 * A zip is untrusted input. Before any library inflates anything, the central directory is read
 * (utils/zipNames.js) and the archive is refused if it looks like a bomb or an attack:
 *   - too big as a file, too many entries, or too much declared uncompressed data;
 *   - an entry that expands far beyond what it took to store (compression ratio);
 *   - encrypted or ZIP64 entries.
 * Entries whose path is unsafe (".." segments, absolute paths, drive letters, NUL) are IGNORED and
 * listed, never written anywhere. Entries are never extracted to a disk at all: each file is
 * inflated into memory, one at a time, and handed to the uploader. A ".zip" inside the zip is just
 * a file (never opened), unless its own directory looks like a bomb, in which case it is skipped.
 */

export const IMPORT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 1000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDepth: 12,
  maxRatio: 100,
  ratioFloor: 1024 * 1024, // ratios only matter for entries that expand past this
});

export const IMPORT_CONCURRENCY = 2;

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

/**
 * @returns {{ segments: string[], isDir: boolean } | { unsafe: true } | { junk: true }}
 */
export function safeZipPath(rawName) {
  if (typeof rawName !== 'string' || rawName === '' || rawName.includes('\0')) return { unsafe: true };
  if (/^[\\/]/.test(rawName) || /^[A-Za-z]:/.test(rawName)) return { unsafe: true };
  const normalized = rawName.replace(/\\/g, '/');
  const isDir = normalized.endsWith('/');
  const segments = normalized.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return { junk: true };
  if (segments.some((segment) => segment === '..')) return { unsafe: true };
  if (JUNK.test(normalized)) return { junk: true };
  return { segments, isDir };
}

const refuse = (reason, message) => ({ ok: false, reason, message });

/**
 * Looks inside a zip WITHOUT inflating it and says what an import would do.
 *
 * @param {Uint8Array} bytes
 * @returns {{ ok: false, reason: string, message: string } | {
 *   ok: true,
 *   files: Array<{ entry: string, name: string, dir: string, size: number }>,
 *   folders: string[],
 *   ignored: Array<{ path: string, reason: string }>,
 *   skipped: Array<{ path: string, reason: string }>,
 *   totalBytes: number,
 * }}
 */
export function inspectZip(bytes, limits = IMPORT_LIMITS) {
  if (!(bytes instanceof Uint8Array)) return refuse('not-a-zip', 'That is not a zip file.');
  if (bytes.length > limits.maxArchiveBytes) return refuse('too-big', 'That zip is too large to import here.');
  const directory = readZipEntries(bytes, limits.maxEntries);
  if (!directory) return refuse('not-a-zip', 'That does not look like a zip file, or it is damaged.');
  if (directory.entryCount > limits.maxEntries) {
    return refuse('too-many-entries', `That zip has too many entries (more than ${limits.maxEntries}).`);
  }

  let totalBytes = 0;
  for (const entry of directory.entries) {
    if (entry.zip64) return refuse('too-big', 'That zip uses sizes this importer will not accept.');
    totalBytes += entry.uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) {
      return refuse('too-big-uncompressed', 'That zip would expand to far more data than this importer accepts.');
    }
    if (entry.uncompressedSize > limits.ratioFloor) {
      const ratio = entry.compressedSize === 0 ? Infinity : entry.uncompressedSize / entry.compressedSize;
      if (ratio > limits.maxRatio) {
        return refuse('suspicious-compression', 'That zip is compressed in a way that looks like a decompression bomb, so it was refused.');
      }
    }
  }

  const files = [];
  const folders = new Set();
  const ignored = [];
  const skipped = [];
  const usedByDir = new Map();
  for (const entry of directory.entries) {
    const parsed = safeZipPath(entry.name);
    if (parsed.junk) continue;
    if (parsed.unsafe) {
      ignored.push({ path: entry.name, reason: 'Unsafe path (it tries to leave the folder it is in), ignored' });
      continue;
    }
    if (parsed.segments.length > limits.maxDepth) {
      ignored.push({ path: entry.name, reason: 'Folders nested too deeply, ignored' });
      continue;
    }
    const clean = parsed.segments.map((segment) => (sanitizeDownloadName(segment) === '.' ? 'file' : sanitizeDownloadName(segment)));
    if (parsed.isDir) {
      for (let i = 1; i <= clean.length; i += 1) folders.add(clean.slice(0, i).join('/'));
      continue;
    }
    if (entry.encrypted) {
      skipped.push({ path: entry.name, reason: 'Password-protected entries cannot be imported' });
      continue;
    }
    if (entry.uncompressedSize > limits.maxFileBytes) {
      skipped.push({ path: entry.name, reason: 'Larger than the 4 MB a file can be' });
      continue;
    }
    const dirParts = clean.slice(0, -1);
    for (let i = 1; i <= dirParts.length; i += 1) folders.add(dirParts.slice(0, i).join('/'));
    const dir = dirParts.join('/');
    const used = usedByDir.get(dir) || new Set();
    usedByDir.set(dir, used);
    files.push({ entry: entry.name, name: uniqueName(clean[clean.length - 1], used), dir, size: entry.uncompressedSize });
  }
  return { ok: true, files, folders: [...folders].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)), ignored, skipped, totalBytes };
}

/** Whether a file that is itself a zip declares a bomb-like directory (it is never opened, only judged). */
export function looksLikeZipBomb(bytes, limits = IMPORT_LIMITS) {
  if (!(bytes instanceof Uint8Array) || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const inner = inspectZip(bytes, limits);
  return !inner.ok && ['suspicious-compression', 'too-big-uncompressed', 'too-many-entries', 'too-big'].includes(inner.reason);
}

/**
 * Uploads what `inspectZip` found. `uploadFile(file, folder)` is the normal upload (it enforces the
 * quota, the 4 MB cap and the naming rules and creates the folder); `createFolder(path)` makes the
 * empty ones. Quota exhaustion stops the rest (everything after it would fail the same way).
 *
 * @returns {Promise<{ uploaded: number, failures: Array<{ path: string, reason: string }>, cancelled: boolean, quotaHit: boolean }>}
 */
export async function runImport({ bytes, plan, JSZip, uploadFile, createFolder, signal, onProgress = () => {}, concurrency = IMPORT_CONCURRENCY, limits = IMPORT_LIMITS }) {
  const zip = await JSZip.loadAsync(bytes);
  const failures = [];
  let uploaded = 0;
  let done = 0;
  let quotaHit = false;
  const total = plan.files.length;
  const report = (current) => onProgress({ done, total, uploaded, current });

  // Folders first, so the empty ones exist too. A folder that is already there is fine.
  const withFiles = new Set();
  for (const { dir } of plan.files) {
    const parts = dir ? dir.split('/') : [];
    for (let n = 1; n <= parts.length; n += 1) withFiles.add(parts.slice(0, n).join('/')); // a file's folders come with it
  }
  for (const path of plan.folders) {
    if (signal?.aborted) break;
    if (withFiles.has(path)) continue; // uploading into it creates it
    try {
      // eslint-disable-next-line no-await-in-loop
      await createFolder(path);
    } catch (error) {
      if (error?.response?.status !== 409) failures.push({ path: `${path}/`, reason: error?.response?.data?.error?.message || 'The folder could not be created' });
    }
  }

  let next = 0;
  report('');
  const worker = async () => {
    while (next < plan.files.length && !signal?.aborted && !quotaHit) {
      const item = plan.files[next];
      next += 1;
      const shown = item.dir ? `${item.dir}/${item.name}` : item.name;
      report(shown);
      try {
        const entry = zip.file(item.entry);
        if (!entry) throw new Error('Not found in the zip');
        // eslint-disable-next-line no-await-in-loop
        const data = await entry.async('uint8array'); // JSZip fails if this differs from the declared size
        if (data.length > limits.maxFileBytes) throw new Error('Larger than the 4 MB a file can be');
        if (/\.zip$/i.test(item.name) && looksLikeZipBomb(data, limits)) {
          failures.push({ path: shown, reason: 'A zip inside the zip that looks like a decompression bomb, skipped' });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await uploadFile(new File([data], item.name), item.dir);
          uploaded += 1;
        }
      } catch (error) {
        const code = error?.response?.data?.error?.code;
        if (error?.response?.status === 413 && code === 'STORAGE_QUOTA') {
          quotaHit = true;
          failures.push({ path: shown, reason: 'Your storage is full (the rest were not tried)' });
        } else {
          failures.push({ path: shown, reason: error?.response?.data?.error?.message || error?.message || 'Could not be uploaded' });
        }
      }
      done += 1;
      report('');
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (quotaHit) {
    for (let i = next; i < plan.files.length; i += 1) {
      const item = plan.files[i];
      failures.push({ path: item.dir ? `${item.dir}/${item.name}` : item.name, reason: 'Not uploaded: your storage is full' });
    }
  }
  return { uploaded, failures, cancelled: Boolean(signal?.aborted), quotaHit };
}
