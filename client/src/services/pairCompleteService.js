import axios from 'axios';

/**
 * POST {apiBase}/api/pair/complete
 *
 * Deliberately NOT using the shared services/api.js axios instance: that
 * instance's baseURL ("/api") resolves relative to wherever THIS page
 * itself is hosted, via the Vite dev server's own proxy. The PC this
 * phone needs to reach is whatever LAN address was embedded in the QR it
 * just scanned - a different machine, with no Vite proxy of its own in
 * front of it - which has nothing to do with wherever this page happens
 * to be hosted. `apiBase` is passed in explicitly and used directly.
 *
 * @param {string} apiBase - e.g. "http://192.168.1.50:5000"
 * @param {{ pairingToken: string, masterPassword: string, phonePin: string, deviceName?: string }} params
 * @returns {Promise<{ deviceId: string, wrappedDEKPhonePin: string, wrappedDEKPhonePinIv: string, wrappedDEKPhonePinAuthTag: string, wrappedDEKPhonePinSalt: string }>}
 */
export async function completePairing(apiBase, params) {
  const { data } = await axios.post(`${apiBase}/api/pair/complete`, params);
  return data;
}
