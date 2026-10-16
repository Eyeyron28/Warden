import api from './api.js';
import { invalidateAll } from './dataCache.js';
import { quarantineCount } from './quarantineCount.js';

/**
 * GET /api/quarantine - the files held for review: name, size, dates, severity, and the reasons (a code and a plain sentence each).
 * @returns {Promise<{ count: number, items: Array<{ id: string, name: string, size: number, heldAt: string, severity: 'low'|'medium'|'high', reasons: Array<{ code: string, text: string }> }> }>}
 */
export async function listHeld() {
  const { data } = await api.get('/quarantine');
  quarantineCount.set(data.count);
  return data;
}

/** The word that has to be typed to release a file. */
export const RELEASE_WORD = 'RELEASE';

/** POST /api/documents/:id/quarantine/release - the file behaves like any other afterwards. */
export async function releaseHeld(id, confirm) {
  const { data } = await api.post(`/documents/${id}/quarantine/release`, { confirm });
  quarantineCount.bump(-1);
  invalidateAll();
  return data;
}
