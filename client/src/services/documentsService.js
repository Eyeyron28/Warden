import api from './api.js';
import { generateThumbnail } from '../utils/thumbnail.js';
import { filenameFromDisposition, sanitizeDownloadName } from '../utils/fileNames.js';

/**
 * GET /api/documents
 * @returns {Promise<Array<{ id: string, filename: string, folder: string, expiryDate: string|null, daysUntilExpiry: number|null, expiryStatus: 'expired'|'expiring_soon'|'ok', syncStatus: string, createdAt: string }>>}
 */
export async function listDocuments() {
  const { data } = await api.get('/documents');
  return data;
}

/**
 * GET /api/documents/expiring - same shape as listDocuments, filtered to
 * expired/expiring_soon documents and sorted soonest-first. Not wired into
 * any view yet; this is what a future reminders widget would call.
 */
export async function listExpiringDocuments() {
  const { data } = await api.get('/documents/expiring');
  return data;
}

/**
 * GET /api/documents/folders - distinct folder names currently in use,
 * plus "root", sorted with "root" first. Used to populate the folder
 * filter and the edit form's folder combobox suggestions.
 * @returns {Promise<Array<string>>}
 */
export async function listFolders() {
  const { data } = await api.get('/documents/folders');
  return data;
}

/**
 * POST /api/documents/folders
 * Creates an empty folder (Drive-style "New folder") so it shows up in
 * the folder tabs/filters before any document has been filed into it.
 * @param {string} name
 * @returns {Promise<{ name: string }>}
 */
export async function createFolder(name) {
  const { data } = await api.post('/documents/folders', { name });
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
export async function renameFolder(path, name) {
  const { data } = await api.patch('/documents/folders', { path, name });
  return data;
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

export async function uploadDocument({ file, folder, expiryDate }, onProgress) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(TOO_LARGE_MESSAGE), { response: { status: 413, data: { error: { message: TOO_LARGE_MESSAGE } } } });
  }
  const formData = new FormData();
  formData.append('file', file);
  // Drawn here, in the browser, from the plaintext file; the server
  // encrypts it. Optional by design: generateThumbnail never throws, and
  // null (non-image/PDF, corrupt file, too large to fit) just means this
  // document gets a type icon instead.
  const thumb = await generateThumbnail(file);
  if (thumb) formData.append('thumb', thumb, 'thumb');
  if (folder) formData.append('folder', folder);
  if (expiryDate) formData.append('expiryDate', expiryDate);

  try {
    const { data } = await api.post('/documents', formData, {
      onUploadProgress: (event) => {
        if (onProgress && event.total) {
          onProgress(Math.round((event.loaded / event.total) * 100));
        }
      },
    });
    return data;
  } catch (err) {
    // The platform's own "payload too large" has no JSON body to read a message from.
    if (err?.response?.status === 413 && !err.response.data?.error?.message) {
      err.response.data = { error: { message: TOO_LARGE_MESSAGE } };
    }
    throw err;
  }
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
export async function listFolderChildren(path = '') {
  const { data } = await api.get('/documents/folders/children', { params: { path } });
  return data;
}

/**
 * DELETE /api/documents/:id - moves the file to Trash (kept encrypted for 30
 * days, its share links stop at once).
 */
export async function deleteDocument(id) {
  await api.delete(`/documents/${id}`);
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
