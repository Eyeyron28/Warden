import axios from 'axios';

import { assertSameOrigin } from '../utils/apiOrigin.js';

/**
 * POST {apiBase}/api/pair/complete
 *
 * Deliberately NOT using the shared services/api.js axios instance (it attaches
 * a session token this page does not have). `apiBase` must be this page's own
 * origin (assertSameOrigin): the request carries the master password, so it can
 * never go anywhere else.
 *
 * The PIN is NOT sent. The server answers with the device token and the vault
 * key once; the phone wraps the key under its own PIN locally.
 *
 * @param {string} apiBase - this page's origin
 * @param {{ pairingToken: string, masterPassword: string, deviceName?: string }} params
 * @returns {Promise<{ deviceId: string, deviceToken: string, dek: string }>} `dek` is base64
 */
export async function completePairing(apiBase, params) {
  assertSameOrigin(apiBase);
  const { data } = await axios.post(`${apiBase}/api/pair/complete`, params, { timeout: 60_000 });
  return data;
}
