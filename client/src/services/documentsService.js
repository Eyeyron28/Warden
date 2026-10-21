import api from './api.js';
import { fetchCached, peek } from './dataCache.js';
import { setFolderStyles } from './folderStyles.js';
import { quarantineCount } from './quarantineCount.js';
import { generateThumbnail } from '../utils/thumbnail.js';
import { newUploadKey } from '../utils/uuid.js';
import { filenameFromDisposition, sanitizeDownloadName } from '../utils/fileNames.js';

export function listDocuments(options) {
  return fetchCached('documents', async () => (await api.get('/documents')).data, options);
}

export const peekDocuments = () => peek('documents');

export function listExpiringDocuments(options) {
  return fetchCached('documents/expiring', async () => (await api.get('/documents/expiring')).data, options);
}

export const peekExpiringDocuments = () => peek('documents/expiring');

export function listFolders(options) {
  return fetchCached('documents/folders', async () => (await api.get('/documents/folders')).data, options);
}

export const peekFolders = () => peek('documents/folders');

export async function createFolder(name, style = {}) {
  const { data } = await api.post('/documents/folders', { name, ...pickStyle(style) });
  return data;
}

export async function renameFolder(path, name, style = {}) {
  const { data } = await api.patch('/documents/folders', { path, ...(name === undefined ? {} : { name }), ...pickStyle(style) });
  return data;
}

function pickStyle(style) {
  const out = {};
  if (style && 'color' in style) out.color = style.color || null;
  if (style && 'icon' in style) out.icon = style.icon || null;
  return out;
}

export async function setFolderStyle(path, style) {
  return renameFolder(path, undefined, style);
}

export async function moveItems(items, destination) {
  const { data } = await api.post('/documents/move', { items, destination });
  return data;
}

export async function updateDocument(id, updates) {
  const { data } = await api.patch(`/documents/${id}`, updates);
  return data;
}

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const TOO_LARGE_MESSAGE = 'File exceeds the 4MB size limit.';

const XHR_ONLY = typeof XMLHttpRequest === 'undefined' ? {} : { adapter: 'xhr' };

export const THUMBNAIL_READY = 'warden:thumbnail-ready';

const MAX_QUEUED_PREVIEWS = 3;
let previewQueue = Promise.resolve();
let queuedPreviews = 0;

function drawPreviewLater(file, id) {
  if (queuedPreviews >= MAX_QUEUED_PREVIEWS) return;
  queuedPreviews += 1;
  previewQueue = previewQueue
    .then(async () => {
      const thumb = await generateThumbnail(file);
      if (!thumb) return;
      await putThumbnail(id, thumb);
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(THUMBNAIL_READY, { detail: { id } }));
    })
    .catch(() => {
    })
    .finally(() => {
      queuedPreviews -= 1;
    });
}

export async function uploadDocument({ file, folder, expiryDate, signal, preview = true, uploadKey }, onProgress) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(TOO_LARGE_MESSAGE), { response: { status: 413, data: { error: { message: TOO_LARGE_MESSAGE } } } });
  }
  const formData = new FormData();
  formData.append('uploadKey', uploadKey || newUploadKey());
  if (folder) formData.append('folder', folder);
  if (expiryDate) formData.append('expiryDate', expiryDate);
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
    if (err?.response?.status === 413 && !err.response.data?.error?.message) {
      err.response.data = { error: { message: TOO_LARGE_MESSAGE } };
    }
    throw err;
  }
}

export function renamedNotice(result) {
  if (!result?.nameChanged) return '';
  return `A file with this name already exists. Saved as "${result.filename ?? result.name}".`;
}

export async function putThumbnail(id, thumb) {
  const formData = new FormData();
  formData.append('thumb', thumb, 'thumb');
  const { data } = await api.put(`/documents/${id}/thumbnail`, formData);
  return data;
}

export async function markThumbnailFailed(id, reason, kind) {
  const { data } = await api.post(`/documents/${id}/thumbnail-failed`, { reason, kind });
  return data;
}

export async function retryFailedThumbnails() {
  const { data } = await api.post('/documents/thumbnails/retry');
  return data;
}

export async function fetchDocumentBlob(id) {
  const response = await api.get(`/documents/${id}/view`, { responseType: 'blob' });

  const filename = filenameFromDisposition(response.headers['content-disposition']);

  return {
    blob: response.data,
    filename,
    contentType: response.headers['content-type'],
  };
}

export async function fetchDocumentBytes(id, { signal, purpose } = {}) {
  const response = await api.get(`/documents/${id}/view`, {
    responseType: 'arraybuffer',
    signal,
    ...(purpose ? { params: { for: purpose } } : {}),
  });
  const filename = filenameFromDisposition(response.headers['content-disposition']);
  return { bytes: new Uint8Array(response.data), filename };
}

export async function recordDownload(id) {
  try {
    await api.post(`/documents/${id}/downloaded`);
  } catch {
  }
}

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

export async function listPhotos() {
  const { data } = await api.get('/documents/photos');
  return data;
}

export async function getStorage() {
  const { data } = await api.get('/documents/storage');
  return data;
}

export function listFolderChildren(path = '', options) {
  return fetchCached(
    `documents/folders/children:${path}`,
    async () => {
      const { data } = await api.get('/documents/folders/children', { params: { path } });
      if (path === '' && data?.styles) setFolderStyles(data.styles);
      if (path === '') quarantineCount.set(data?.heldCount);
      return data;
    },
    options
  );
}

export const peekFolderChildren = (path = '') => peek(`documents/folders/children:${path}`);

export async function deleteDocument(id) {
  await api.delete(`/documents/${id}`);
}

export const BATCH_SIZE = 50;
const chunk = (list, size = BATCH_SIZE) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

export async function starDocuments(ids, starred) {
  let updated = 0;
  for (const batch of chunk(ids)) {
    // eslint-disable-next-line no-await-in-loop
    const { data } = await api.post('/documents/star', { ids: batch, starred });
    updated += data.updatedCount;
  }
  return updated;
}

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

export function listRecent(options) {
  return fetchCached('documents/recent', async () => (await api.get('/documents/recent')).data, options);
}

export function getDocumentDetails(id, options) {
  return fetchCached(`documents/details:${id}`, async () => (await api.get(`/documents/${id}/details`)).data, { maxAgeMs: 30000, ...options });
}
export const peekDocumentDetails = (id) => peek(`documents/details:${id}`);

export const MAX_NOTE_CHARS = 2000;

export async function setDocumentNote(id, note) {
  const { data } = await api.put(`/documents/${id}/note`, { note: note && note.trim() ? note : null });
  return data;
}

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

export async function restoreDocumentVersion(id, versionId) {
  const { data } = await api.post(`/documents/${id}/versions/${versionId}/restore`);
  return data;
}

export async function deleteDocumentVersion(id, versionId) {
  await api.delete(`/documents/${id}/versions/${versionId}`);
}

export async function fetchVersionBytes(id, versionId) {
  const response = await api.get(`/documents/${id}/versions/${versionId}/download`, { responseType: 'arraybuffer' });
  return { bytes: new Uint8Array(response.data), filename: filenameFromDisposition(response.headers['content-disposition']) };
}

export async function deleteFolder(path) {
  await api.delete('/documents/folders', { params: { path } });
}

export async function setDocumentExpiry(id, day) {
  return updateDocument(id, { docExpiresAt: day || null });
}
