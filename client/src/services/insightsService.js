import api from './api.js';

/** GET /api/insights/overview - the numbers on the Overview page. */
export async function getOverview() {
  const { data } = await api.get('/insights/overview');
  return data;
}

/** GET /api/insights/stale - files not opened for 180+ days, oldest first. */
export async function getStaleFiles() {
  const { data } = await api.get('/insights/stale');
  return data;
}

/** GET /api/insights/frequent - the "Frequently used" row (at most 5, newest activity first). */
export async function getFrequentFiles() {
  const { data } = await api.get('/insights/frequent');
  return data.items;
}
