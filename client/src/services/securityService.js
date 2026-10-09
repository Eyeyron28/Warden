import api from './api.js';

/** GET /api/security/devices - the browsers that have signed in to this account. */
export async function listDevices() {
  const { data } = await api.get('/security/devices');
  return data.devices;
}

/** POST /api/security/devices/:id/sign-out - ends that device's sessions and removes its trust. */
export async function signOutDevice(id) {
  const { data } = await api.post(`/security/devices/${id}/sign-out`);
  return data;
}

/** POST /api/security/devices/:id/forget-trusted - that browser asks for an emailed code next time. */
export async function forgetTrustedDevice(id) {
  const { data } = await api.post(`/security/devices/${id}/forget-trusted`);
  return data;
}

/** POST /api/security/devices/sign-out-others - every session but this one; optionally their trust too. */
export async function signOutOtherDevices({ forgetTrusted = false } = {}) {
  const { data } = await api.post('/security/devices/sign-out-others', { forgetTrusted });
  return data;
}

/**
 * GET /api/security/activity - newest first, 50 a page; `before` is the `nextBefore` of the previous page.
 * @param {{ device?: string, group?: 'vault'|'sharing'|'account', flagged?: boolean, from?: string, to?: string, before?: number }} [filters]
 */
export async function getActivity(filters = {}) {
  const params = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    params[key] = value === true ? '1' : value;
  }
  const { data } = await api.get('/security/activity', { params });
  return data;
}

/** POST /api/security/verify-log - checks the activity log's hash chain. */
export async function verifyActivityLog() {
  const { data } = await api.post('/security/verify-log');
  return data;
}

/** POST /api/security/client-event - the page reports an export or import it just did (those happen in the browser). */
export async function reportClientEvent(type) {
  try {
    await api.post('/security/client-event', { type });
  } catch {
    // The log is best effort; the export or import itself already happened.
  }
}
