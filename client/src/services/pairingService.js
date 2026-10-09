import api from './api.js';

/**
 * POST /api/pair/code - emails the owner a code for pairing a device.
 * @returns {Promise<object>} an emailed-code challenge (see OtpChallengePanel)
 */
export async function requestPairCode() {
  const { data } = await api.post('/pair/code');
  return data;
}

/** POST /api/pair/resend-code */
export async function resendPairCode(challengeToken) {
  const { data } = await api.post('/pair/resend-code', { challengeToken });
  return data;
}

/**
 * POST /api/pair/init - with the emailed code, starts a new 5-minute pairing window.
 * @returns {Promise<{ pairingToken: string, expiresAt: string, appUrl: string|null }>}
 *   `appUrl` is the server's validated public origin, or null (development: use the page's own origin)
 */
export async function initPairing(challengeToken, code) {
  const { data } = await api.post('/pair/init', { challengeToken, code });
  return data;
}

/**
 * GET /api/pair/status/:token - polled while the QR is on screen.
 * @returns {Promise<{ used: boolean, expired: boolean }>}
 */
export async function getPairingStatus(token) {
  const { data } = await api.get(`/pair/status/${token}`);
  return data;
}
