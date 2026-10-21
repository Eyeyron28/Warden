import api from './api.js';
import { fetchCached, peek } from './dataCache.js';

export function listTrash() {
  return fetchCached('trash', async () => (await api.get('/trash')).data);
}

export const peekTrash = () => peek('trash');

export async function restoreTrashItem(kind, id) {
  const { data } = await api.post('/trash/restore', { kind, id });
  return data;
}

export async function deleteTrashItem(kind, id) {
  await api.delete(`/trash/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
}

export async function emptyTrash() {
  const { data } = await api.delete('/trash');
  return data;
}
