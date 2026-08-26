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
 * whatever axios throws and leaves interpreting that up to the caller -
 * there is nothing more specific to extract even if we tried.
 *
 * @param {string} token
 * @returns {Promise<{ blob: Blob, filename: string, contentType: string }>}
 */
export async function fetchSharedDocument(token) {
  const response = await api.get(`/shared/${token}`, { responseType: 'blob' });

  const disposition = response.headers['content-disposition'] || '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const filename = match ? decodeURIComponent(match[1]) : 'document';

  return {
    blob: response.data,
    filename,
    contentType: response.headers['content-type'] || 'application/octet-stream',
  };
}
