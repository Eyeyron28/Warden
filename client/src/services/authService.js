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
