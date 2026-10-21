import api from './api.js';
import { fetchCached, peek } from './dataCache.js';

export async function createShare(documentId, durationHours, options = {}) {
  const { data } = await api.post(`/documents/${documentId}/share`, { durationHours, ...options });
  return data;
}

export async function createBulkShare(documentIds, durationHours, options = {}) {
  const { data } = await api.post('/shares', { documentIds, durationHours, ...options });
  return data;
}

export async function listShares(documentId) {
  const { data } = await api.get(`/documents/${documentId}/shares`);
  return data;
}

export function listAllShares() {
  return fetchCached('shares', async () => (await api.get('/shares')).data);
}

export const peekShares = () => peek('shares');

export async function fetchShareUsage() {
  const { data } = await api.get('/shares/usage');
  return data;
}

export async function updateShare(shareId, changes) {
  const { data } = await api.patch(`/shares/${shareId}`, changes);
  return data;
}

export async function setSharePassword(shareId, material) {
  const { data } = await api.put(`/shares/${shareId}/password`, material);
  return data;
}

export async function getShareProtection(shareId) {
  const { data } = await api.get(`/shares/${shareId}/protection`);
  return data;
}

export async function getOwnerManifest(shareId) {
  const { data } = await api.get(`/shares/${shareId}/manifest`);
  return data;
}

export async function removeSharePassword(shareId) {
  const { data } = await api.delete(`/shares/${shareId}/password`);
  return data;
}

export async function revokeShareById(shareId) {
  const { data } = await api.delete(`/shares/${shareId}`);
  return data;
}

export async function stopAllShares() {
  const { data } = await api.delete('/shares');
  return data;
}
