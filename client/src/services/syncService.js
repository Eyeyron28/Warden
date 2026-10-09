import axios from 'axios';

import { assertSameOrigin } from '../utils/apiOrigin.js';

/**
 * Phone-side sync calls. Deliberately NOT using the shared services/api.js
 * axios instance: these carry a device token bearer (server/middleware/
 * requireDeviceAuth.js), not the session token services/api.js attaches.
 *
 * `apiBase` must be this page's own origin - every function asserts it
 * (utils/apiOrigin.js), so the device token only ever goes to the server this
 * page was loaded from.
 *
 * Shaped for a host that caps request and response bodies at 4.5 MB: metadata
 * in pages, ciphertext one document at a time as raw bytes (see
 * server/controllers/sync.controller.js).
 */

const REQUEST_TIMEOUT_MS = 60_000;

const auth = (deviceToken) => ({ Authorization: `Bearer ${deviceToken}` });

/** GET /api/sync/documents - one page of metadata for every document, trashed ones flagged. */
export async function listDocumentPage(apiBase, deviceToken, { cursor, limit = 100, signal } = {}) {
  assertSameOrigin(apiBase);
  const { data } = await axios.get(`${apiBase}/api/sync/documents`, {
    params: { ...(cursor ? { cursor } : {}), limit },
    headers: auth(deviceToken),
    timeout: REQUEST_TIMEOUT_MS,
    signal,
  });
  return data;
}

/** GET /api/sync/folders */
export async function listServerFolders(apiBase, deviceToken, { signal } = {}) {
  assertSameOrigin(apiBase);
  const { data } = await axios.get(`${apiBase}/api/sync/folders`, { headers: auth(deviceToken), timeout: REQUEST_TIMEOUT_MS, signal });
  return data.folders;
}

/** GET /api/sync/documents/:id/content - the ciphertext as an ArrayBuffer. */
export async function fetchDocumentContent(apiBase, deviceToken, id, { signal } = {}) {
  assertSameOrigin(apiBase);
  const { data } = await axios.get(`${apiBase}/api/sync/documents/${encodeURIComponent(id)}/content`, {
    headers: auth(deviceToken),
    responseType: 'arraybuffer',
    timeout: REQUEST_TIMEOUT_MS * 2,
    signal,
  });
  return data;
}

/**
 * POST /api/sync/documents - one already-encrypted document, as multipart.
 * `clientId` makes a repeat after a lost response harmless.
 */
export async function pushDocument(apiBase, deviceToken, doc, { signal } = {}) {
  assertSameOrigin(apiBase);
  const form = new FormData();
  form.append('clientId', doc.clientId);
  form.append('filename', doc.filename);
  form.append('folder', doc.folder && doc.folder !== 'root' ? doc.folder : '');
  form.append('iv', doc.iv);
  form.append('authTag', doc.authTag);
  form.append('checksum', doc.checksum);
  if (doc.mimeType) form.append('mimeType', doc.mimeType);
  if (doc.expiryDate) form.append('expiryDate', doc.expiryDate);
  // The file part goes last so the small fields are parsed before the bytes.
  form.append('file', new Blob([doc.encryptedBlob], { type: 'application/octet-stream' }), 'ciphertext');
  const { data } = await axios.post(`${apiBase}/api/sync/documents`, form, {
    headers: auth(deviceToken),
    timeout: REQUEST_TIMEOUT_MS * 2,
    signal,
  });
  return data;
}

/** POST /api/sync/folders - an empty folder created on the phone. */
export async function pushFolder(apiBase, deviceToken, name, { signal } = {}) {
  assertSameOrigin(apiBase);
  await axios.post(`${apiBase}/api/sync/folders`, { name }, { headers: auth(deviceToken), timeout: REQUEST_TIMEOUT_MS, signal });
}

/**
 * DELETE {apiBase}/api/documents/:id - the same endpoint the PC uses (it moves
 * the file to Trash), authorized here by the device token.
 */
export async function deleteDocumentOnPC(apiBase, deviceToken, id) {
  assertSameOrigin(apiBase);
  await axios.delete(`${apiBase}/api/documents/${id}`, { headers: auth(deviceToken), timeout: REQUEST_TIMEOUT_MS });
}

/** DELETE {apiBase}/api/documents/folders?path= - removes the PC's empty-folder markers under `path`. */
export async function deleteFolderOnPC(apiBase, deviceToken, path) {
  assertSameOrigin(apiBase);
  await axios.delete(`${apiBase}/api/documents/folders`, { params: { path }, headers: auth(deviceToken), timeout: REQUEST_TIMEOUT_MS });
}
