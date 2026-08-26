import api from './api.js';

/**
 * POST /api/documents/:id/share
 * Owner-only. Creates a new share link, valid for `durationHours` hours.
 * @param {string} documentId
 * @param {number} durationHours
 * @returns {Promise<{ token: string, expiresAt: string, shareUrl: string }>}
 */
export async function createShare(documentId, durationHours) {
  const { data } = await api.post(`/documents/${documentId}/share`, { durationHours });
  return data;
}

/**
 * GET /api/documents/:id/shares
 * Owner-only. Active (non-revoked, non-expired) shares for this document,
 * newest first. Deliberately does NOT include the raw share token - same
 * one-time-secret hygiene as the recovery key never being shown again
 * after setup - so revoking one of these goes through `revokeShareById`,
 * not the token itself.
 * @param {string} documentId
 * @returns {Promise<Array<{ id: string, expiresAt: string, createdAt: string }>>}
 */
export async function listShares(documentId) {
  const { data } = await api.get(`/documents/${documentId}/shares`);
  return data;
}

/**
 * POST /api/shares/id/:shareId/revoke
 * Owner-only, addressed by the ShareToken's own id rather than its token.
 * Idempotent on the backend - safe to call even if it's already
 * revoked/expired.
 * @param {string} shareId
 */
export async function revokeShareById(shareId) {
  await api.post(`/shares/id/${shareId}/revoke`);
}
