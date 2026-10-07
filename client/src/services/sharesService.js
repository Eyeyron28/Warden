import api from './api.js';

/**
 * Owner-side share calls. None of these can ever return a share key or a link:
 * the server does not keep them. A link exists only in the response to the
 * create call, and then only in the owner's browser.
 */

/**
 * POST /api/documents/:id/share
 * Snapshot share of one file, valid for `durationHours` (at most 30 days).
 * `options`: { maxDownloads (1-100), recipientEmail (one address; the viewer
 * must enter an emailed code), passwordProtected (the share stays hidden until
 * setSharePassword() finishes it) }.
 * The returned `shareUrl` carries the share's key after the # and is the ONLY
 * time that key exists outside the link itself.
 * @returns {Promise<{ id: string, expiresAt: string, shareUrl: string, entryCount: number, totalBytes: number, maxDownloads: number|null, recipientEmail: string|null, passwordPending: boolean, usage: object }>}
 */
export async function createShare(documentId, durationHours, options = {}) {
  const { data } = await api.post(`/documents/${documentId}/share`, { durationHours, ...options });
  return data;
}

/** POST /api/shares - one link over many documents; same options as createShare. */
export async function createBulkShare(documentIds, durationHours, options = {}) {
  const { data } = await api.post('/shares', { documentIds, durationHours, ...options });
  return data;
}

/** GET /api/documents/:id/shares - active shares that include this document. */
export async function listShares(documentId) {
  const { data } = await api.get(`/documents/${documentId}/shares`);
  return data;
}

/**
 * GET /api/shares - the share manager's list.
 * @returns {Promise<{ shares: Array<{ id: string, name: string, fileNames: string[], fileCount: number, totalBytes: number, createdAt: string, expiresAt: string, maxExpiresAt: string, downloadCount: number, maxDownloads: number|null, passwordProtected: boolean, recipientEmail: string|null, emailRestricted: boolean }>, usage: object }>}
 */
export async function listAllShares() {
  const { data } = await api.get('/shares');
  return data;
}

/** GET /api/shares/usage - shared storage used and the limits. */
export async function fetchShareUsage() {
  const { data } = await api.get('/shares/usage');
  return data;
}

/**
 * PATCH /api/shares/:id - any of { durationHours, maxDownloads, recipientEmail }
 * (null clears a limit or the restriction). Nothing is re-uploaded.
 */
export async function updateShare(shareId, changes) {
  const { data } = await api.patch(`/shares/${shareId}`, changes);
  return data;
}

/**
 * PUT /api/shares/:id/password - sets or replaces the link password. `material`
 * is { salt, kdf, wrappedKey, verifier } made in the browser
 * (utils/sharePassword.js); the password and the plain key never get here.
 * For a share created with passwordProtected this also takes it live.
 */
export async function setSharePassword(shareId, material) {
  const { data } = await api.put(`/shares/${shareId}/password`, material);
  return data;
}

/** GET /api/shares/:id/protection - salt, cost and WRAPPED key, to unlock with the current password. */
export async function getShareProtection(shareId) {
  const { data } = await api.get(`/shares/${shareId}/protection`);
  return data;
}

/** GET /api/shares/:id/manifest - the encrypted manifest, to check a pasted key. */
export async function getOwnerManifest(shareId) {
  const { data } = await api.get(`/shares/${shareId}/manifest`);
  return data;
}

/** DELETE /api/shares/:id/password - back to a plain key-in-the-link share. */
export async function removeSharePassword(shareId) {
  const { data } = await api.delete(`/shares/${shareId}/password`);
  return data;
}

/** DELETE /api/shares/:id - stop sharing: the share and every encrypted copy are deleted. */
export async function revokeShareById(shareId) {
  const { data } = await api.delete(`/shares/${shareId}`);
  return data;
}

/** DELETE /api/shares - stop ALL sharing for this account. */
export async function stopAllShares() {
  const { data } = await api.delete('/shares');
  return data;
}
