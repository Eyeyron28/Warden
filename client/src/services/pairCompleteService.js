import axios from 'axios';

/**
 * POST {apiBase}/api/pair/complete
 *
 * Deliberately NOT using the shared services/api.js axios instance: that
 * instance has a fixed baseURL from VITE_API_BASE_URL, set once when
 * this frontend was built/started. The PC this phone needs to reach is
 * whatever LAN address was embedded in the QR it just scanned - which
 * has nothing to do with wherever this page itself happens to be
 * hosted, and can differ from the frontend's own build-time API base
 * entirely. `apiBase` is passed in explicitly and used directly.
 *
 * @param {string} apiBase - e.g. "http://192.168.1.50:5000"
 * @param {{ pairingToken: string, masterPassword: string, phonePin: string, deviceName?: string }} params
 * @returns {Promise<{ deviceId: string, wrappedDEKPhonePin: string, wrappedDEKPhonePinIv: string, wrappedDEKPhonePinAuthTag: string, wrappedDEKPhonePinSalt: string }>}
 */
export async function completePairing(apiBase, params) {
  const { data } = await axios.post(`${apiBase}/api/pair/complete`, params);
  return data;
}
