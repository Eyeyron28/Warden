import api from './api.js';

/**
 * GET /api/devices
 * Owner-only. Metadata only - never the wrapped-DEK fields or deviceToken.
 * @returns {Promise<Array<{ id: string, deviceName: string|undefined, pairedAt: string, revoked: boolean }>>}
 */
export async function listDevices() {
  const { data } = await api.get('/devices');
  return data;
}

/**
 * POST /api/devices/:id/revoke
 * Idempotent - safe to call on an already-revoked device.
 */
export async function revokeDevice(deviceId) {
  const { data } = await api.post(`/devices/${deviceId}/revoke`);
  return data;
}
