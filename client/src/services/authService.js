import api from './api.js';

/**
 * GET /api/auth/status
 * @returns {Promise<{ initialized: boolean }>}
 */
export async function getAuthStatus() {
  const { data } = await api.get('/auth/status');
  return data;
}

/**
 * POST /api/auth/setup - first-run only.
 * @param {string} password
 * @returns {Promise<{ sessionToken: string, recoveryKey: string }>}
 */
export async function setupVault(password) {
  const { data } = await api.post('/auth/setup', { password });
  return data;
}

/**
 * POST /api/auth/unlock
 * @param {string} password
 * @returns {Promise<{ sessionToken: string }>}
 */
export async function unlockVault(password) {
  const { data } = await api.post('/auth/unlock', { password });
  return data;
}

/**
 * POST /api/auth/recover - the "forgot password" flow.
 * @param {string} recoveryKey
 * @param {string} newPassword
 * @returns {Promise<{ sessionToken: string }>}
 */
export async function recoverVault(recoveryKey, newPassword) {
  const { data } = await api.post('/auth/recover', { recoveryKey, newPassword });
  return data;
}

/**
 * POST /api/auth/recover-via-usb - the USB backup "forgot your password"
 * flow. `wrappedDEK`/`wrappedDEKIv`/`wrappedDEKAuthTag`/`wrappedDEKSalt`
 * come straight from the selected backup folder's backup-manifest.json,
 * read client-side (see components/UsbRecoveryModal.jsx) - this call
 * never touches the filesystem itself.
 * @param {{ wrappedDEK: string, wrappedDEKIv: string, wrappedDEKAuthTag: string, wrappedDEKSalt: string, usbPassphrase: string, newPassword: string }} params
 * @returns {Promise<{ sessionToken: string }>}
 */
export async function recoverViaUsb(params) {
  const { data } = await api.post('/auth/recover-via-usb', params);
  return data;
}

/**
 * POST /api/auth/recover-via-phone/init - starts a new 5-minute
 * paired-phone recovery window from the locked-out PC. `recoverUrl` is
 * null if the server couldn't determine its own LAN IP - the frontend
 * should fall back to showing `recoveryToken` as a manually-typed code.
 * @returns {Promise<{ recoveryToken: string, recoverUrl: string|null, expiresAt: string }>}
 */
export async function initPhoneRecovery() {
  const { data } = await api.post('/auth/recover-via-phone/init');
  return data;
}

/**
 * GET /api/auth/recover-via-phone/status/:token - polled by the PC while
 * its recovery code is on screen, waiting for the paired phone to respond.
 * @param {string} token
 * @returns {Promise<{ fulfilled: boolean, expired: boolean }>}
 */
export async function getPhoneRecoveryStatus(token) {
  const { data } = await api.get(`/auth/recover-via-phone/status/${token}`);
  return data;
}

/**
 * POST /api/auth/recover-via-phone/complete - called once the phone has
 * fulfilled the request, to actually set the new master password.
 * @param {string} recoveryToken
 * @param {string} newPassword
 * @returns {Promise<{ sessionToken: string }>}
 */
export async function completePhoneRecovery(recoveryToken, newPassword) {
  const { data } = await api.post('/auth/recover-via-phone/complete', { recoveryToken, newPassword });
  return data;
}

/**
 * POST /api/auth/logout
 * Explicitly ends the session server-side, so "Lock vault" actually kills
 * the old token instead of leaving it valid until its 30-min expiry.
 * @returns {Promise<{ success: boolean }>}
 */
export async function logoutVault() {
  const { data } = await api.post('/auth/logout');
  return data;
}
