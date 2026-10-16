import api from './api.js';
import { fetchCached, peek } from './dataCache.js';
import { setFolderStyles } from './folderStyles.js';
import { quarantineCount } from './quarantineCount.js';
import { generateThumbnail } from '../utils/thumbnail.js';
import { newUploadKey } from '../utils/uuid.js';
import { filenameFromDisposition, sanitizeDownloadName } from '../utils/fileNames.js';

/**
 * GET /api/documents
 * @returns {Promise<Array<{ id: string, filename: string, folder: string, expiryDate: string|null, daysUntilExpiry: number|null, expiryStatus: 'expired'|'expiring_soon'|'ok', syncStatus: string, createdAt: string }>>}
 */
export function listDocuments(options) {
  return fetchCached('documents', async () => (await api.get('/documents')).data, options);
}

/** What the last list answer was (this tab, this session), or undefined: a page's first state, refreshed after. */
export const peekDocuments = () => peek('documents');

/**
 * GET /api/documents/expiring - same shape as listDocuments, filtered to
 * expired/expiring_soon documents and sorted soonest-first. Not wired into
 * any view yet; this is what a future reminders widget would call.
 */
export function listExpiringDocuments(options) {
  return fetchCached('documents/expiring', async () => (await api.get('/documents/expiring')).data, options);
}

export const peekExpiringDocuments = () => peek('documents/expiring');

/**
 * GET /api/documents/folders - distinct folder names currently in use,
 * plus "root", sorted with "root" first. Used to populate the folder
 * filter and the edit form's folder combobox suggestions.
 * @returns {Promise<Array<string>>}
 */
export function listFolders(options) {
  return fetchCached('documents/folders', async () => (await api.get('/documents/folders')).data, options);
}

export const peekFolders = () => peek('documents/folders');

/**
 * POST /api/documents/folders
 * Creates an empty folder (Drive-style "New folder") so it shows up in
 * the folder tabs/filters before any document has been filed into it.
 * @param {string} name
 * @returns {Promise<{ name: string }>}
 */
export async function createFolder(name, style = {}) {
  const { data } = await api.post('/documents/folders', { name, ...pickStyle(style) });
  return data;
}

/**
 * PATCH /api/documents/folders - renames a folder in place; everything
 * nested inside follows. 409 with error.code "FOLDER_EXISTS" if a sibling
 * already has that name (compared case-insensitively).
 * @param {string} path - the folder's current full path
 * @param {string} name - the new name (one segment, no "/" or "\")
 * @returns {Promise<{ path: string }>} the folder's new full path
 */
export async function renameFolder(path, name, style = {}) {
  const { data } = await api.patch('/documents/folders', { path, ...(name === undefined ? {} : { name }), ...pickStyle(style) });
  return data;
}

/** Only the look's own fields ever go out (null = back to the default look; the server checks them against its lists). */
function pickStyle(style) {
  const out = {};
  if (style && 'color' in style) out.color = style.color || null;
  if (style && 'icon' in style) out.icon = style.icon || null;
  return out;
}

/** PATCH /api/documents/folders with only a colour and/or icon: the folder keeps its path and name. */
export async function setFolderStyle(path, style) {
  return renameFolder(path, undefined, style);
}

/**
 * POST /api/documents/move
 * @param {Array<{ type: 'file', id: string } | { type: 'folder', path: string }>} items
 * @param {string} destination - folder path, "" for the top level
 * @returns {Promise<{
 *   destination: string,
 *   movedCount: number,
 *   results: Array<{ type: string, id?: string, path?: string, name?: string,
 *     status: 'moved'|'unchanged'|'conflict'|'invalid'|'not_found', message?: string, newPath?: string }>,
 * }>} per-item outcome - a name clash is reported, never overwritten
 */
export async function moveItems(items, destination) {
  const { data } = await api.post('/documents/move', { items, destination });
  return data;
}

/**
 * PATCH /api/documents/:id
 * Metadata-only edit - filename and/or expiryDate (changing a document's
 * folder only happens through moveItems). Callers
 * should only include the fields that actually changed; the backend
 * leaves anything omitted untouched.
 * @param {string} id
 * @param {{ filename?: string, folder?: string, expiryDate?: string|null }} updates
 * @returns {Promise<object>} the updated document, same shape as listDocuments entries
 */
export async function updateDocument(id, updates) {
  const { data } = await api.patch(`/documents/${id}`, updates);
  return data;
}

/**
 * POST /api/documents (multipart/form-data)
 * @param {{ file: File, folder?: string, expiryDate?: string }} params
 * @param {(percent: number) => void} [onProgress]
 */
// Same cap as the server (routes/documents.routes.js). Checked here too because a
// body past the host's own request limit (4.5MB on Vercel) is refused by the
// platform before the app sees it, with a reply that carries no message.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const TOO_LARGE_MESSAGE = 'File exceeds the 4MB size limit.';

// XMLHttpRequest, explicitly, for every upload: it is the one browser transport that reports how many bytes have been sent (fetch
// cannot). Where there is no XMLHttpRequest (the tests, which supply their own transport) the default applies.
const XHR_ONLY = typeof XMLHttpRequest === 'undefined' ? {} : { adapter: 'xhr' };

/** Told when a preview that was drawn AFTER an upload has been stored, so a list can show it without asking again. */
export const THUMBNAIL_READY = 'warden:thumbnail-ready';

// Previews are drawn one at a time after the uploads, never before one is sent: drawing the first page of a PDF means loading
// pdf.js, which used to be waited for before the file even started to go. At most a few wait; the rest are made by the
// "Background previews" setting or when the file is opened.
const MAX_QUEUED_PREVIEWS = 3;
let previewQueue = Promise.resolve();
let queuedPreviews = 0;

function drawPreviewLater(file, id) {
  if (queuedPreviews >= MAX_QUEUED_PREVIEWS) return;
  queuedPreviews += 1;
  previewQueue = previewQueue
    .then(async () => {
      const thumb = await generateThumbnail(file); // never throws
      if (!thumb) return;
      await putThumbnail(id, thumb);
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(THUMBNAIL_READY, { detail: { id } }));
    })
    .catch(() => {
      // A preview is a nicety; the file is saved either way.
    })
    .finally(() => {
      queuedPreviews -= 1;
    });
}

/**
 * Uploads one file through POST /api/documents.
 *
 * Each call makes a fresh `uploadKey` (a UUID) and sends it with the file: if the same request reaches the server twice (a retry
 * after a slow answer) the server stores ONE file and answers with it. `signal` (an AbortSignal) cancels the request. The preview
 * is drawn after the file is saved, not before it is sent. The answer carries the final name: `nameChanged` is true when a
 * same-named file made the server add a counter ("report (1).pdf").
 *
 * @param {{ file: File, folder?: string, expiryDate?: string, signal?: AbortSignal, preview?: boolean }} params
 * @param {(percent: number) => void} [onProgress] real bytes sent, 0 to 100
 */
export async function uploadDocument({ file, folder, expiryDate, signal, preview = true, uploadKey }, onProgress) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(TOO_LARGE_MESSAGE), { response: { status: 413, data: { error: { message: TOO_LARGE_MESSAGE } } } });
  }
  const formData = new FormData();
  // A retry passes the same key again, so a file the server already saved is answered, not duplicated.
  formData.append('uploadKey', uploadKey || newUploadKey());
  if (folder) formData.append('folder', folder);
  if (expiryDate) formData.append('expiryDate', expiryDate);
  // The file goes last: the small fields are read first.
  formData.append('file', file);

  try {
    const { data } = await api.post('/documents', formData, {
      signal,
      ...XHR_ONLY,
      onUploadProgress: (event) => {
        if (onProgress && event.total) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      },
    });
    if (preview && data?.id && !data.replayed) drawPreviewLater(file, data.id);
    return data;
  } catch (err) {
    // The platform's own "payload too large" has no JSON body to read a message from.
    if (err?.response?.status === 413 && !err.response.data?.error?.message) {
      err.response.data = { error: { message: TOO_LARGE_MESSAGE } };
    }
    throw err;
  }
}

/** The sentence shown when the server gave an upload (or a rename) a counter. */
export function renamedNotice(result) {
  if (!result?.nameChanged) return '';
  return `A file with this name already exists. Saved as "${result.filename ?? result.name}".`;
}

/**
 * PUT /api/documents/:id/thumbnail - adds a preview to an existing
 * document, drawn by the browser from a plaintext copy it already has.
 * @param {string} id
 * @param {Blob} thumb
 */
export async function putThumbnail(id, thumb) {
  const formData = new FormData();
  formData.append('thumb', thumb, 'thumb');
  const { data } = await api.put(`/documents/${id}/thumbnail`, formData);
  return data;
}

/**
 * POST /api/documents/:id/thumbnail-failed - records that a preview could not be made, so the
 * file is not tried again on every run. `reason` is one of the server's fixed codes.
 */
export async function markThumbnailFailed(id, reason, kind) {
  const { data } = await api.post(`/documents/${id}/thumbnail-failed`, { reason, kind });
  return data;
}

/** POST /api/documents/thumbnails/retry - forget recorded preview failures ("Try again"). */
export async function retryFailedThumbnails() {
  const { data } = await api.post('/documents/thumbnails/retry');
  return data;
}

/**
 * GET /api/documents/:id/view - decrypts server-side and streams the file
 * back. Returns the raw blob plus the filename/content-type the server
 * reported, so the caller can open or save it.
 */
export async function fetchDocumentBlob(id) {
  const response = await api.get(`/documents/${id}/view`, { responseType: 'blob' });

  const filename = filenameFromDisposition(response.headers['content-disposition']);

  return {
    blob: response.data,
    filename,
    contentType: response.headers['content-type'],
  };
}

/**
 * GET /api/documents/:id/view as raw bytes. The server answers with an opaque
 * content type on purpose; what the bytes ARE is decided in the browser by
 * sniffing them (utils/previewType.js), never from anything the response or the
 * stored name claims. Pass `signal` to cancel (e.g. when moving to the next file).
 * @returns {Promise<{ bytes: Uint8Array, filename: string }>}
 */
export async function fetchDocumentBytes(id, { signal, purpose } = {}) {
  // purpose: "download" counts as a download, "silent" (an export, or drawing a preview) counts as nothing, and
  // leaving it out is a normal view. The server reads it as ?for=.
  const response = await api.get(`/documents/${id}/view`, {
    responseType: 'arraybuffer',
    signal,
    ...(purpose ? { params: { for: purpose } } : {}),
  });
  const filename = filenameFromDisposition(response.headers['content-disposition']);
  return { bytes: new Uint8Array(response.data), filename };
}

/** POST /api/documents/:id/downloaded - a download of bytes the preview already holds still counts as one. */
export async function recordDownload(id) {
  try {
    await api.post(`/documents/${id}/downloaded`);
  } catch {
    // counting is best effort; the file was saved
  }
}

/**
 * Saves bytes as a file. Only ever called from an explicit Download button or
 * menu item - clicking a file opens its preview and never downloads. The Blob
 * is typed application/octet-stream so the browser can't treat it as anything.
 */
export function downloadBytes(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeDownloadName(filename);
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * GET /api/documents/photos - every image (decided by sniffing the bytes, not
 * the name), newest first. `pending` is how many older files are still waiting
 * to be classified; ask again until it is 0.
 * @returns {Promise<{ photos: object[], pending: number }>}
 */
export async function listPhotos() {
  const { data } = await api.get('/documents/photos');
  return data;
}

/**
 * GET /api/documents/storage
 * @returns {Promise<{ fileBytes: number, fileCount: number, trashBytes: number, trashCount: number }>}
 */
export async function getStorage() {
  const { data } = await api.get('/documents/storage');
  return data;
}

/**
 * GET /api/documents/folders/children?path= - one level of the folder tree
 * (for the sidebar), loaded when a folder is expanded.
 * @returns {Promise<{ path: string, folders: Array<{ name: string, path: string, hasChildren: boolean }> }>}
 */
export function listFolderChildren(path = '', options) {
  return fetchCached(
    `documents/folders/children:${path}`,
    async () => {
      const { data } = await api.get('/documents/folders/children', { params: { path } });
      // The top-level answer also holds the look of every styled folder (see services/folderStyles.js).
      if (path === '' && data?.styles) setFolderStyles(data.styles);
      // ... and how many files are held in Quarantine (the sidebar badge).
      if (path === '') quarantineCount.set(data?.heldCount);
      return data;
    },
    options
  );
}

export const peekFolderChildren = (path = '') => peek(`documents/folders/children:${path}`);

/**
 * DELETE /api/documents/:id - moves the file to Trash (kept encrypted for 30
 * days, its share links stop at once).
 */
export async function deleteDocument(id) {
  await api.delete(`/documents/${id}`);
}

/** Splits a long list into batches the server accepts (at most 50 files each). */
export const BATCH_SIZE = 50;
const chunk = (list, size = BATCH_SIZE) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/**
 * POST /api/documents/star - stars or unstars files (50 at a time; a longer list goes out in several requests).
 * @returns {Promise<number>} how many of them were the caller's
 */
export async function starDocuments(ids, starred) {
  let updated = 0;
  for (const batch of chunk(ids)) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await api.post('/documents/star', { ids: batch, starred });
    updated += data.updatedCount;
  }
  return updated;
}

/**
 * POST /api/documents/batch/move - files only, 50 per request, with a result for each id.
 * @returns {Promise<{ destination: string, movedCount: number, results: object[] }>}
 */
export async function batchMoveDocuments(ids, destination) {
  const total = { destination, movedCount: 0, results: [] };
  for (const batch of chunk(ids)) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await api.post('/documents/batch/move', { ids: batch, destination });
    total.destination = data.destination;
    total.movedCount += data.movedCount;
    total.results.push(...data.results);
  }
  return total;
}

/**
 * POST /api/documents/batch/trash - files only, 50 per request.
 * @returns {Promise<{ trashedCount: number, results: object[] }>}
 */
export async function batchTrashDocuments(ids) {
  const total = { trashedCount: 0, results: [] };
  for (const batch of chunk(ids)) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await api.post('/documents/batch/trash', { ids: batch });
    total.trashedCount += data.trashedCount;
    total.results.push(...data.results);
  }
  return total;
}

/**
 * GET /api/documents/recent - the last 30 files uploaded, opened or changed, with the device that last opened each.
 * @returns {Promise<{ retentionDays: number, items: object[] }>}
 */
export function listRecent(options) {
  return fetchCached('documents/recent', async () => (await api.get('/documents/recent')).data, options);
}

/**
 * GET /api/documents/:id/details - everything the details panel shows, in one answer. Kept in the page cache, which every
 * write empties, so reopening a file's panel costs nothing and a changed file is never shown stale.
 */
export function getDocumentDetails(id, options) {
  return fetchCached(`documents/details:${id}`, async () => (await api.get(`/documents/${id}/details`)).data, { maxAgeMs: 30000, ...options });
}
export const peekDocumentDetails = (id) => peek(`documents/details:${id}`);

/** The longest private note the server accepts (characters). */
export const MAX_NOTE_CHARS = 2000;

/**
 * PUT /api/documents/:id/note - sets, changes (text) or clears (null or empty) the file's private note. The server encrypts it
 * with the vault key; it comes back only in the details answer.
 * @returns {Promise<{ id: string, hasNote: boolean, note: string|null }>}
 */
export async function setDocumentNote(id, note) {
  const { data } = await api.put(`/documents/${id}/note`, { note: note && note.trim() ? note : null });
  return data;
}

/**
 * POST /api/documents/:id/versions - "Upload new version": replaces the file's contents (same id, name, folder, expiry, star, note and
 * share links); what it held is kept as a previous version. The same 4 MB cap, preview and server checks as a new upload.
 */
export async function uploadNewVersion(id, file, onProgress, { signal } = {}) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(TOO_LARGE_MESSAGE), { response: { status: 413, data: { error: { message: TOO_LARGE_MESSAGE } } } });
  }
  const formData = new FormData();
  formData.append('file', file);
  const thumb = await generateThumbnail(file);
  if (thumb) formData.append('thumb', thumb, 'thumb');
  try {
    const { data } = await api.post(`/documents/${id}/versions`, formData, {
      signal,
      ...XHR_ONLY,
      onUploadProgress: (event) => {
        if (onProgress && event.total) onProgress(Math.round((event.loaded / event.total) * 100));
      },
    });
    return data;
  } catch (err) {
    if (err?.response?.status === 413 && !err.response.data?.error?.message) err.response.data = { error: { message: TOO_LARGE_MESSAGE } };
    throw err;
  }
}

/** POST /api/documents/:id/versions/:versionId/restore - the current file becomes a version, the chosen one becomes current. */
export async function restoreDocumentVersion(id, versionId) {
  const { data } = await api.post(`/documents/${id}/versions/${versionId}/restore`);
  return data;
}

/** DELETE /api/documents/:id/versions/:versionId */
export async function deleteDocumentVersion(id, versionId) {
  await api.delete(`/documents/${id}/versions/${versionId}`);
}

/** GET /api/documents/:id/versions/:versionId/download - the bytes of a previous version (saved with downloadBytes). */
export async function fetchVersionBytes(id, versionId) {
  const response = await api.get(`/documents/${id}/versions/${versionId}/download`, { responseType: 'arraybuffer' });
  return { bytes: new Uint8Array(response.data), filename: filenameFromDisposition(response.headers['content-disposition']) };
}

/**
 * DELETE /api/documents/folders?path=...
 * Moves the folder, everything nested in it and every file inside to Trash as
 * one item; restoring it from Trash brings them all back together.
 * @param {string} path
 */
export async function deleteFolder(path) {
  await api.delete('/documents/folders', { params: { path } });
}

/**
 * Sets (a 'YYYY-MM-DD' day) or clears (null) a file's "Expires on" date. The date is stored READABLE by the
 * server (so a reminder can be emailed); the file's contents stay encrypted. Changing it re-arms the reminders.
 * @returns {Promise<object>} the updated document summary
 */
export async function setDocumentExpiry(id, day) {
  return updateDocument(id, { docExpiresAt: day || null });
}
