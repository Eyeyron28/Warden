import axios from 'axios';

/**
 * Phone-side sync calls. Deliberately NOT using the shared services/api.js
 * axios instance (same reasoning as pairCompleteService.js): the PC this
 * phone syncs with is whatever apiBase it paired against, stored in its
 * own IndexedDB deviceAuth record, which has nothing to do with wherever
 * this frontend itself happens to be hosted. Auth is a deviceToken bearer
 * (see server/middleware/requireDeviceAuth.js), not the session token
 * services/api.js attaches.
 */

/**
 * POST {apiBase}/api/sync/pull
 * @param {string} apiBase
 * @param {string} deviceToken
 * @param {string[]} knownDocumentIds - ids this phone already has locally
 * @returns {Promise<{
 *   documents: Array<object>,
 *   index: Array<{ id: string, filename: string, folder: string, expiryDate: string|null }>,
 *   folders: string[],
 * }>} `documents`: full data for documents new to the phone. `index`:
 *   metadata for EVERY document currently on the PC - anything the phone
 *   holds that's missing from it was deleted PC-side. `folders`: every
 *   folder path on the PC (excluding "root").
 */
export async function pullDocuments(apiBase, deviceToken, knownDocumentIds) {
  const { data } = await axios.post(
    `${apiBase}/api/sync/pull`,
    { knownDocumentIds },
    { headers: { Authorization: `Bearer ${deviceToken}` } }
  );
  return data;
}

/**
 * DELETE {apiBase}/api/documents/:id - the same endpoint the PC uses,
 * authorized here by deviceToken instead of a session token.
 */
export async function deleteDocumentOnPC(apiBase, deviceToken, id) {
  await axios.delete(`${apiBase}/api/documents/${id}`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
}

/**
 * DELETE {apiBase}/api/documents/folders?path= - removes the PC's empty-
 * folder markers under `path` (documents themselves are deleted separately).
 */
export async function deleteFolderOnPC(apiBase, deviceToken, path) {
  await axios.delete(`${apiBase}/api/documents/folders`, {
    params: { path },
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
}

/**
 * POST {apiBase}/api/sync/push
 * @param {string} apiBase
 * @param {string} deviceToken
 * @param {Array<object>} newDocuments - already encrypted by the phone
 * @param {string[]} [newFolders] - empty folder paths created on the phone
 * @returns {Promise<{ idMap: Array<{ localId: string|null, id: string }> }>}
 */
export async function pushDocuments(apiBase, deviceToken, newDocuments, newFolders = []) {
  const { data } = await axios.post(
    `${apiBase}/api/sync/push`,
    { newDocuments, newFolders },
    { headers: { Authorization: `Bearer ${deviceToken}` } }
  );
  return data;
}
