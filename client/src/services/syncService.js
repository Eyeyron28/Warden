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
 * @returns {Promise<Array<object>>} full data for documents new to the phone
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
 * POST {apiBase}/api/sync/push
 * @param {string} apiBase
 * @param {string} deviceToken
 * @param {Array<object>} newDocuments - already encrypted by the phone
 * @returns {Promise<{ idMap: Array<{ localId: string|null, id: string }> }>}
 */
export async function pushDocuments(apiBase, deviceToken, newDocuments) {
  const { data } = await axios.post(
    `${apiBase}/api/sync/push`,
    { newDocuments },
    { headers: { Authorization: `Bearer ${deviceToken}` } }
  );
  return data;
}
