import api from './api.js';

/**
 * GET /api/devices
 * @returns {Promise<Array<{ id: string, deviceName: string|undefined, browserLabel: string|undefined, pairedAt: string, lastSeenAt: string|null, revoked: boolean, revokedAt: string|null }>>}
 */
export async function listDevices() {
  const { data } = await api.get('/devices');
  return data;
}

/**
 * POST /api/devices/:id/revoke - 404 for an unknown or foreign id; fine to repeat on your own.
 */
export async function revokeDevice(deviceId) {
  const { data } = await api.post(`/devices/${deviceId}/revoke`);
  return data;
}
