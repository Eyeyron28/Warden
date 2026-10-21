import api from './api.js';
import { invalidateAll } from './dataCache.js';
import { quarantineCount } from './quarantineCount.js';

export async function listHeld() {
  const { data } = await api.get('/quarantine');
  quarantineCount.set(data.count);
  return data;
}

export const RELEASE_WORD = 'RELEASE';

export async function releaseHeld(id, confirm) {
  const { data } = await api.post(`/documents/${id}/quarantine/release`, { confirm });
  quarantineCount.bump(-1);
  invalidateAll();
  return data;
}
