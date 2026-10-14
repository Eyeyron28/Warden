import api from './api.js';
import { fetchCached, peek } from './dataCache.js';

/** GET /api/insights/overview - the numbers on the Overview page. */
export function getOverview() {
  return fetchCached('insights/overview', async () => (await api.get('/insights/overview')).data);
}

export const peekOverview = () => peek('insights/overview');

/** GET /api/insights/stale - files not opened for 180+ days, oldest first. */
export async function getStaleFiles() {
  const { data } = await api.get('/insights/stale');
  return data;
}

/** GET /api/insights/frequent - the "Frequently used" row (at most 5, newest activity first). */
export function getFrequentFiles(options) {
  return fetchCached('insights/frequent', async () => (await api.get('/insights/frequent')).data.items, options);
}

export const peekFrequentFiles = () => peek('insights/frequent');
