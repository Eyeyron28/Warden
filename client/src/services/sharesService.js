import api from './api.js';

/**
 * POST /api/documents/:id/share
 * Owner-only. Makes a snapshot share of one file, valid for `durationHours`
 * hours (at most 30 days). The returned `shareUrl` carries the share's key
 * after the # and is the ONLY time that key exists outside the link itself:
 * the server does not keep it.
 * @param {string} documentId
 * @param {number} durationHours
 * @returns {Promise<{ id: string, expiresAt: string, shareUrl: string, entryCount: number, totalBytes: number, usage: object }>}
 */
export async function createShare(documentId, durationHours) {
  const { data } = await api.post(`/documents/${documentId}/share`, { durationHours });
  return data;
}

/**
 * POST /api/shares
 * Owner-only. ONE link covering many documents (e.g. a folder's nested
 * contents plus loose files) - same snapshot, expiry and revoke semantics as
 * a single-file link, which is just the length-1 case.
 * @param {string[]} documentIds
 * @param {number} durationHours
 */
export async function createBulkShare(documentIds, durationHours) {
  const { data } = await api.post('/shares', { documentIds, durationHours });
  return data;
}

/**
 * GET /api/documents/:id/shares
 * Owner-only. Active shares that include this document, newest first. Never
 * includes a link or key - those exist only in the link itself - so the only
 * thing to do with a row is revoke it.
 * @param {string} documentId
 * @returns {Promise<Array<{ id: string, expiresAt: string, createdAt: string, entryCount: number }>>}
 */
export async function listShares(documentId) {
  const { data } = await api.get(`/documents/${documentId}/shares`);
  return data;
}

/**
 * GET /api/shares/usage
 * How much shared storage this account has used.
 * @returns {Promise<{ usedBytes: number, remainingBytes: number, limitBytes: number, perShareLimitBytes: number, activeShares: number, maxActiveShares: number, maxDurationHours: number }>}
 */
export async function fetchShareUsage() {
  const { data } = await api.get('/shares/usage');
  return data;
}

/**
 * DELETE /api/shares/:shareId
 * Owner-only. Deletes the share and every encrypted copy immediately.
 * @param {string} shareId
 */
export async function revokeShareById(shareId) {
  const { data } = await api.delete(`/shares/${shareId}`);
  return data;
}
