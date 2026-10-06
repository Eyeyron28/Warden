import axios from 'axios';

import { assertSameOrigin } from '../utils/apiOrigin.js';

/**
 * Phone-side sync calls. Deliberately NOT using the shared services/api.js
 * axios instance: these carry a deviceToken bearer (see server/middleware/
 * requireDeviceAuth.js), not the session token services/api.js attaches.
 *
 * `apiBase` is passed in explicitly but must be this page's own origin -
 * every function asserts it (utils/apiOrigin.js), so the device token can
 * only ever go to the server this page was loaded from, never to an
 * address taken from a link or from storage. */

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
  assertSameOrigin(apiBase);
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
  assertSameOrigin(apiBase);
  await axios.delete(`${apiBase}/api/documents/${id}`, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
}

/**
 * DELETE {apiBase}/api/documents/folders?path= - removes the PC's empty-
 * folder markers under `path` (documents themselves are deleted separately).
 */
export async function deleteFolderOnPC(apiBase, deviceToken, path) {
  assertSameOrigin(apiBase);
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
  assertSameOrigin(apiBase);
  const { data } = await axios.post(
    `${apiBase}/api/sync/push`,
    { newDocuments, newFolders },
    { headers: { Authorization: `Bearer ${deviceToken}` } }
  );
  return data;
}
