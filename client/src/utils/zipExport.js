import { downloadName, sanitizeDownloadName, splitName } from './fileNames.js';

/**
 * "Export my files": every live file in the vault as a .zip, built in the browser.
 *
 * Files come through the normal authenticated download path one at a time (two at a time, to be
 * exact), each at most 4 MB, and go into the zip with their folder structure and original name.
 * Names are sanitised for the zip (and a missing extension is recovered from the file's bytes,
 * exactly as a normal download does); two files with the same name in one folder become
 * "name (2).ext". Empty folders are included. Trash, shares and thumbnails are not.
 *
 * The zip is NOT encrypted - the UI says so.
 */

export const EXPORT_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const EXPORT_CONCURRENCY = 2;

/** warden-export-YYYY-MM-DD.zip (the local date). */
export function exportFileName(date = new Date()) {
  const two = (n) => String(n).padStart(2, '0');
  return `warden-export-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.zip`;
}

/** One safe path segment (no separators, no reserved characters, never "." or ".."). */
export function zipSegment(name) {
  const clean = sanitizeDownloadName(name);
  return clean === '.' || clean === '..' ? 'file' : clean;
}

/**
 * `name` made unique among `used` (a Set of lower-cased names already taken in one folder), keeping
 * the extension: "a.pdf" -> "a (2).pdf" -> "a (3).pdf". Adds the winner to `used`.
 */
export function uniqueName(name, used) {
  const key = (value) => value.toLowerCase();
  if (!used.has(key(name))) {
    used.add(key(name));
    return name;
  }
  const { base, ext } = splitName(name);
  for (let n = 2; ; n += 1) {
    const candidate = ext ? `${base} (${n}).${ext}` : `${base} (${n})`;
    if (!used.has(key(candidate))) {
      used.add(key(candidate));
      return candidate;
    }
  }
}

/**
 * Maps every vault folder path ("Taxes/2024") to its path inside the zip, sanitising each segment and
 * keeping siblings distinct. '' (the top level) maps to ''. Parents come before children.
 *
 * @param {string[]} folderPaths all folder paths, including empty ones ("root" and "" are the top level)
 * @returns {Map<string, string>}
 */
export function planFolders(folderPaths) {
  const wanted = new Set();
  for (const raw of folderPaths) {
    const path = String(raw ?? '').replace(/^\/+|\/+$/g, '');
    if (!path || path === 'root') continue;
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i += 1) wanted.add(parts.slice(0, i).join('/'));
  }
  const ordered = [...wanted].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const mapped = new Map([['', '']]);
  const usedByParent = new Map();
  for (const path of ordered) {
    const parts = path.split('/');
    const parent = parts.slice(0, -1).join('/');
    const used = usedByParent.get(parent) || new Set();
    usedByParent.set(parent, used);
    const segment = uniqueName(zipSegment(parts[parts.length - 1]), used);
    const parentZip = mapped.get(parent) ?? '';
    mapped.set(path, parentZip ? `${parentZip}/${segment}` : segment);
  }
  return mapped;
}

const topLevel = (folder) => (!folder || folder === 'root' ? '' : String(folder).replace(/^\/+|\/+$/g, ''));

/**
 * Decides what goes where, before anything is downloaded.
 * @returns {{ folders: Map<string,string>, files: Array<{ doc: object, dir: string }>, tooLarge: object[] }}
 */
export function planExport(documents, folderPaths) {
  const folders = planFolders([...folderPaths, ...documents.map((doc) => topLevel(doc.folder))]);
  const files = [];
  const tooLarge = [];
  for (const doc of documents) {
    if (Number.isFinite(doc.size) && doc.size > EXPORT_MAX_FILE_BYTES) {
      tooLarge.push(doc);
      continue;
    }
    files.push({ doc, dir: folders.get(topLevel(doc.folder)) ?? '' });
  }
  return { folders, files, tooLarge };
}

/**
 * Builds the zip. Dependencies are passed in: `JSZip` (the library), `fetchBytes(id, { signal })`
 * (the authenticated download), and `onProgress({ phase, done, total, bytes, current })`.
 *
 * A file that cannot be fetched (or is over 4 MB) is skipped and LISTED in `failures` - never dropped
 * silently - and, when there are failures, a "warden-export-report.txt" is added to the zip too.
 * Cancelling (via `signal`) stops after the files already started and resolves { cancelled: true }.
 *
 * @returns {Promise<{ cancelled: true } | { cancelled: false, blob: Blob, added: number, bytes: number, failures: Array<{ path: string, reason: string }> }>}
 */
export async function buildExportZip({ documents, folderPaths, fetchBytes, JSZip, onProgress = () => {}, signal, concurrency = EXPORT_CONCURRENCY }) {
  const { folders, files, tooLarge } = planExport(documents, folderPaths);
  const zip = new JSZip();
  for (const zipPath of folders.values()) if (zipPath) zip.folder(zipPath);

  const failures = tooLarge.map((doc) => ({ path: doc.filename, reason: 'Larger than 4 MB (the limit for a file in Warden)' }));
  const usedNames = new Map(); // dir -> Set of taken names (lower-case)
  let added = 0;
  let bytesTotal = 0;
  let done = 0;
  const total = files.length + tooLarge.length;
  done += tooLarge.length;
  let next = 0;

  const report = (current) => onProgress({ phase: 'downloading', done, total, bytes: bytesTotal, current });
  report('');

  const worker = async () => {
    while (next < files.length && !signal?.aborted) {
      const { doc, dir } = files[next];
      next += 1;
      report(doc.filename);
      try {
        // eslint-disable-next-line no-await-in-loop
        const { bytes } = await fetchBytes(doc.id, { signal });
        if (bytes.length > EXPORT_MAX_FILE_BYTES) throw new Error('Larger than 4 MB');
        const used = usedNames.get(dir) || new Set();
        usedNames.set(dir, used);
        const name = uniqueName(downloadName(doc.filename, bytes), used);
        zip.file(dir ? `${dir}/${name}` : name, bytes, { date: new Date(doc.updatedAt || doc.createdAt || Date.now()) });
        added += 1;
        bytesTotal += bytes.length;
      } catch (error) {
        if (signal?.aborted) return;
        const status = error?.response?.status;
        failures.push({
          path: dir ? `${dir}/${doc.filename}` : doc.filename,
          reason: status ? `The server answered ${status}` : error?.message || 'Could not be downloaded',
        });
      }
      done += 1;
      report('');
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (signal?.aborted) return { cancelled: true };

  if (failures.length > 0) {
    zip.file(
      'warden-export-report.txt',
      ['These files could not be added to this export:', '', ...failures.map((f) => `- ${f.path}: ${f.reason}`), ''].join('\n')
    );
  }

  onProgress({ phase: 'zipping', done: total, total, bytes: bytesTotal, current: '' });
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 }, streamFiles: true });
  return { cancelled: false, blob, added, bytes: bytesTotal, failures };
}
