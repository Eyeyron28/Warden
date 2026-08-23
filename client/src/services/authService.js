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
 * POST /api/auth/logout
 * Explicitly ends the session server-side, so "Lock vault" actually kills
 * the old token instead of leaving it valid until its 30-min expiry.
 * @returns {Promise<{ success: boolean }>}
 */
export async function logoutVault() {
  const { data } = await api.post('/auth/logout');
  return data;
}
