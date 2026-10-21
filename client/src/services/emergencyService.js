import api from './api.js';
import { fetchCached, peek } from './dataCache.js';

const KEEP_SESSION = { skipSessionClear: true };

export function getEmergencyStatus({ maxAgeMs = 0 } = {}) {
  return fetchCached('emergency/status', async () => (await api.get('/emergency/status', KEEP_SESSION)).data, { maxAgeMs });
}

export const peekEmergencyStatus = () => peek('emergency/status');

export async function listFolderChoices() {
  const { data } = await api.get('/emergency/folders', KEEP_SESSION);
  return data.folders;
}

export async function startOwnerCode(action) {
  const { data } = await api.post('/emergency/challenge', { action }, KEEP_SESSION);
  return data;
}

export async function resendOwnerCode(challengeToken) {
  const { data } = await api.post('/emergency/challenge/resend', { challengeToken }, KEEP_SESSION);
  return data;
}

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

export async function getSessionInfo() {
  const { data } = await api.get('/emergency/session-info', KEEP_SESSION);
  return data;
}

export async function listScopedChildren(path = '') {
  const { data } = await api.get('/documents/folders/children', { params: { path }, ...KEEP_SESSION });
  return data;
}
