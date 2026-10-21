import api from './api.js';
import { fetchCached, peek } from './dataCache.js';

export function getOverview() {
  return fetchCached('insights/overview', async () => (await api.get('/insights/overview')).data);
}

export const peekOverview = () => peek('insights/overview');

export async function getStaleFiles() {
  const { data } = await api.get('/insights/stale');
  return data;
}

export function getFrequentFiles(options) {
  return fetchCached('insights/frequent', async () => (await api.get('/insights/frequent')).data.items, options);
}

export const peekFrequentFiles = () => peek('insights/frequent');
