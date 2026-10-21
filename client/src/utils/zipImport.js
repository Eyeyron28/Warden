import { sanitizeDownloadName } from './fileNames.js';
import { readZipEntries } from './zipNames.js';
import { uniqueName } from './zipExport.js';
import { limitCodeOf, limitMessage, retrySeconds } from './uploadLimits.js';

export const IMPORT_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 1000,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxDepth: 12,
  maxRatio: 100,
  ratioFloor: 1024 * 1024,
});

export const IMPORT_CONCURRENCY = 2;

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

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
    if (/\.zip$/i.test(parsed.segments[parsed.segments.length - 1] || '')) {
      skipped.push({ path: entry.name, reason: 'A zip inside a zip is not imported' });
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

export function looksLikeZipBomb(bytes, limits = IMPORT_LIMITS) {
  if (!(bytes instanceof Uint8Array) || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const inner = inspectZip(bytes, limits);
  return !inner.ok && ['suspicious-compression', 'too-big-uncompressed', 'too-many-entries', 'too-big'].includes(inner.reason);
}

export async function runImport({ bytes, plan, JSZip, uploadFile, createFolder, signal, onProgress = () => {}, onResult = () => {}, concurrency = IMPORT_CONCURRENCY, limits = IMPORT_LIMITS }) {
  const zip = await JSZip.loadAsync(bytes);
  const failures = [];
  let uploaded = 0;
  let held = 0;
  let done = 0;
  let quotaHit = false;
  let limitHit = null;
  const total = plan.files.length;
  const report = (current) => onProgress({ done, total, uploaded, current });

  const withFiles = new Set();
  for (const { dir } of plan.files) {
    const parts = dir ? dir.split('/') : [];
    for (let n = 1; n <= parts.length; n += 1) withFiles.add(parts.slice(0, n).join('/'));
  }
  for (const path of plan.folders) {
    if (signal?.aborted) break;
    if (withFiles.has(path)) continue;
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
    while (next < plan.files.length && !signal?.aborted && !quotaHit && !limitHit) {
      const item = plan.files[next];
      next += 1;
      const shown = item.dir ? `${item.dir}/${item.name}` : item.name;
      report(shown);
      try {
        const entry = zip.file(item.entry);
        if (!entry) throw new Error('Not found in the zip');
        // eslint-disable-next-line no-await-in-loop
        const data = await entry.async('uint8array');
        if (data.length > limits.maxFileBytes) throw new Error('Larger than the 4 MB a file can be');
        if (/\.zip$/i.test(item.name) && looksLikeZipBomb(data, limits)) {
          const reason = 'A zip inside the zip that looks like a decompression bomb, skipped';
          failures.push({ path: shown, reason });
          onResult({ path: shown, status: 'failed', reason, size: item.size });
        } else {
          // eslint-disable-next-line no-await-in-loop
          const stored = await uploadFile(new File([data], item.name), item.dir);
          if (stored?.held) {
            held += 1;
            onResult({ path: shown, status: 'held', size: item.size, reasons: (stored.reasons || []).map((r) => r.code) });
          } else {
            uploaded += 1;
            onResult({ path: shown, status: 'imported', size: item.size, ...(stored?.nameChanged ? { savedAs: stored.filename } : {}) });
          }
        }
      } catch (error) {
        const code = error?.response?.data?.error?.code;
        if (error?.response?.status === 413 && code === 'STORAGE_QUOTA') {
          quotaHit = true;
          const reason = 'Your storage is full (the rest were not tried)';
          failures.push({ path: shown, reason });
          onResult({ path: shown, status: 'failed', reason, size: item.size });
        } else if (limitCodeOf(error)) {
          const stop = limitCodeOf(error);
          limitHit ??= { code: stop, message: limitMessage(stop, { seconds: retrySeconds(error), message: error.response.data.error.message }) };
          const reason = `Not saved: ${limitHit.message}`;
          failures.push({ path: shown, reason });
          onResult({ path: shown, status: 'failed', reason, size: item.size });
        } else if (code === 'USE_IMPORT') {
          const reason = 'A zip inside a zip is not imported';
          failures.push({ path: shown, reason });
          onResult({ path: shown, status: 'failed', reason, size: item.size });
        } else if (code === 'FILE_BLOCKED') {
          const reason = 'Not saved: it matches a rule that Warden refuses outright';
          failures.push({ path: shown, reason });
          onResult({ path: shown, status: 'refused', reason, size: item.size, reasons: (error.response.data.error.reasons || []).map((r) => r.code) });
        } else {
          const reason = error?.response?.data?.error?.message || error?.message || 'Could not be uploaded';
          failures.push({ path: shown, reason });
          onResult({ path: shown, status: 'failed', reason, size: item.size, sessionEnded: error?.response?.status === 401 });
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
  if (limitHit) {
    for (let i = next; i < plan.files.length; i += 1) {
      const item = plan.files[i];
      const path = item.dir ? `${item.dir}/${item.name}` : item.name;
      const reason = 'Not sent: the import stopped at the upload limit';
      failures.push({ path, reason });
      onResult({ path, status: 'failed', reason, size: item.size });
    }
  }
  return { uploaded, held, failures, cancelled: Boolean(signal?.aborted), quotaHit, limitHit };
}
