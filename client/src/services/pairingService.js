import api from './api.js';

/**
 * POST /api/pair/init
 * Owner-only. Starts a new 5-minute pairing window.
 * @returns {Promise<{ pairingToken: string, apiBase: string, expiresAt: string }>}
 */
export async function initPairing() {
  const { data } = await api.post('/pair/init');
  return data;
}

/**
 * GET /api/pair/status/:token
 * Owner-only - polled while the QR is on screen.
 * @param {string} token
 * @returns {Promise<{ used: boolean, expired: boolean }>}
 */
export async function getPairingStatus(token) {
  const { data } = await api.get(`/pair/status/${token}`);
  return data;
}
