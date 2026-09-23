import api from './api.js';

/**
 * GET /api/shared/:token
 * The public, unauthenticated endpoint - this call never sends (and the
 * backend never checks for) a session token. Used only by
 * pages/SharedDocumentPage.jsx, which lives entirely outside the vault's
 * auth flow.
 *
 * The backend intentionally returns the exact same generic 404 for every
 * failure mode (never existed, expired, revoked), so this rejects with
 * whatever axios throws and leaves interpreting that up to the caller.
 *
 * @param {string} token
 * @returns {Promise<{ expiresAt: string, entries: Array<{ id: string, filename: string, mimeType: string, size: number }> }>}
 */
export async function fetchSharedManifest(token) {
  const { data } = await api.get(`/shared/${token}`);
  return data;
}

/**
 * GET /api/shared/:token/files/:documentId - decrypts one file from the
 * link server-side and returns it as a blob.
 * @param {string} token
 * @param {string} documentId
 * @returns {Promise<{ blob: Blob, filename: string, contentType: string }>}
 */
export async function fetchSharedFile(token, documentId) {
  const response = await api.get(`/shared/${token}/files/${documentId}`, { responseType: 'blob' });

  const disposition = response.headers['content-disposition'] || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? decodeURIComponent(match[1]) : 'document';

  return {
    blob: response.data,
    filename,
    contentType: response.headers['content-type'] || 'application/octet-stream',
  };
}
