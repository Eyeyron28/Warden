import api from './api.js';

// A 401 here usually means "wrong code" or "wrong kit", not "your session ended": it must not sign anyone out
// (the api interceptor still ends a session when the server says the SESSION is the problem).
const KEEP_SESSION = { skipSessionClear: true };

// ---------------- the owner (signed in) ----------------

/** GET /api/emergency/status - configuration (no secrets), any open request, demo flag and wait options. */
export async function getEmergencyStatus() {
  const { data } = await api.get('/emergency/status', KEEP_SESSION);
  return data;
}

/** GET /api/emergency/folders - the folder tree with ids, for the "selected folders" picker. */
export async function listFolderChoices() {
  const { data } = await api.get('/emergency/folders', KEEP_SESSION);
  return data.folders;
}

/** POST /api/emergency/challenge - emails the owner a fresh code for ONE action ('setup' | 'regenerate' | 'revoke' | 'approve-now'). */
export async function startOwnerCode(action) {
  const { data } = await api.post('/emergency/challenge', { action }, KEEP_SESSION);
  return data;
}

export async function resendOwnerCode(challengeToken) {
  const { data } = await api.post('/emergency/challenge/resend', { challengeToken }, KEEP_SESSION);
  return data;
}

/** POST /api/emergency/setup. The response carries the kit ONCE: the caller keeps it in memory only. */
export async function setupEmergency(body, fresh) {
  const { data } = await api.post('/emergency/setup', { ...body, ...fresh }, KEEP_SESSION);
  return data;
}

export async function regenerateKit(fresh) {
  const { data } = await api.post('/emergency/regenerate-kit', fresh, KEEP_SESSION);
  return data;
}

export async function revokeEmergency(fresh) {
  const { data } = await api.post('/emergency/revoke', fresh, KEEP_SESSION);
  return data;
}

export async function denyRequest(requestId) {
  const { data } = await api.post(`/emergency/requests/${encodeURIComponent(requestId)}/deny`, {}, KEEP_SESSION);
  return data;
}

export async function approveNow(requestId, fresh) {
  const { data } = await api.post(`/emergency/requests/${encodeURIComponent(requestId)}/approve-now`, fresh, KEEP_SESSION);
  return data;
}

// ---------------- the contact (no account) ----------------

/** Always the same neutral answer. */
export async function requestCode({ ownerEmail, contactEmail }) {
  const { data } = await api.post('/emergency/public/request-code', { ownerEmail, contactEmail }, KEEP_SESSION);
  return data;
}

export async function requestAccess({ ownerEmail, contactEmail, code, kit }) {
  const { data } = await api.post('/emergency/public/request', { ownerEmail, contactEmail, code, kit }, KEEP_SESSION);
  return data;
}

export async function startEmergencySession({ ownerEmail, contactEmail, code, kit }) {
  const { data } = await api.post('/emergency/public/start-session', { ownerEmail, contactEmail, code, kit }, KEEP_SESSION);
  return data;
}

// ---------------- inside an emergency session ----------------

/** GET /api/emergency/session-info -> { readOnly, expiresAt, scopeSummary } (no owner name or email). */
export async function getSessionInfo() {
  const { data } = await api.get('/emergency/session-info', KEEP_SESSION);
  return data;
}

/** GET /api/documents/folders/children - the folders inside one folder of the scope ('' = the scope root). */
export async function listScopedChildren(path = '') {
  const { data } = await api.get('/documents/folders/children', { params: { path }, ...KEEP_SESSION });
  return data;
}
