import axios from 'axios';

// Deliberately NOT the shared services/api.js instance: this is the public,
// signed-out side of a share. That instance attaches the session token and
// clears it on a 401, neither of which has any business here.
const publicApi = axios.create({ baseURL: '/api' });

/**
 * GET /api/shared/:shareId
 * Returns only ciphertext: the encrypted manifest (base64 of iv || ciphertext
 * || tag) and the id and size of each encrypted file. The key to open any of
 * it is in the link's #fragment and is never sent here.
 *
 * The backend returns the exact same generic 404 for every failure (never
 * existed, expired, revoked), so this rejects with whatever axios throws.
 *
 * @param {string} shareId
 * @returns {Promise<{ expiresAt: string, manifest: string, files: Array<{ id: string, size: number }> }>}
 */
export async function fetchSharedManifest(shareId) {
  const { data } = await publicApi.get(`/shared/${encodeURIComponent(shareId)}`);
  return data;
}

/**
 * GET /api/shared/:shareId/files/:fileId - one encrypted file as raw bytes
 * (iv || ciphertext || tag). Decryption happens in the browser.
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchSharedFile(shareId, fileId) {
  const { data } = await publicApi.get(
    `/shared/${encodeURIComponent(shareId)}/files/${encodeURIComponent(fileId)}`,
    { responseType: 'arraybuffer' }
  );
  return data;
}
