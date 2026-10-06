import axios from 'axios';

import { assertSameOrigin } from '../utils/apiOrigin.js';

/**
 * POST {apiBase}/api/pair/complete
 *
 * Deliberately NOT using the shared services/api.js axios instance: that
 * instance's baseURL ("/api") resolves relative to wherever THIS page
 * itself is hosted, via the Vite dev server's own proxy. The PC this
 * phone needs to reach is whatever LAN address was embedded in the QR it
 * just scanned - a different machine, with no Vite proxy of its own in
 * front of it - which has nothing to do with wherever this page happens
 * to be hosted. `apiBase` is passed in explicitly, but it must be this
 * page's own origin (assertSameOrigin): this request carries the master
 * password, so it can never go anywhere else.
 *
 * @param {string} apiBase - this page's origin, e.g. "https://192.168.1.50:5173"
 * @param {{ pairingToken: string, masterPassword: string, phonePin: string, deviceName?: string }} params
 * @returns {Promise<{ deviceId: string, wrappedDEKPhonePin: string, wrappedDEKPhonePinIv: string, wrappedDEKPhonePinAuthTag: string, wrappedDEKPhonePinSalt: string }>}
 */
export async function completePairing(apiBase, params) {
  assertSameOrigin(apiBase);
  const { data } = await axios.post(`${apiBase}/api/pair/complete`, params);
  return data;
}
