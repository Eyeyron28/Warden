import axios from 'axios';

/**
 * Phone-side call for "Help recover PC vault" (PhoneVault.jsx).
 * Deliberately NOT using the shared services/api.js axios instance - same
 * reasoning as syncService.js/pairCompleteService.js: the PC this phone
 * talks to is whatever apiBase it paired against (this phone's own
 * IndexedDB deviceAuth record), which has nothing to do with wherever
 * this frontend itself happens to be hosted. Auth is a deviceToken bearer
 * (see server/middleware/requireDeviceAuth.js), not the session token
 * services/api.js attaches - this phone has no PC session, it's helping
 * recover one.
 */

/**
 * POST {apiBase}/api/auth/recover-via-phone/submit
 * @param {string} apiBase
 * @param {string} deviceToken
 * @param {{ recoveryToken: string, wrappedDEK: string, wrappedDEKIv: string, wrappedDEKAuthTag: string, wrappedDEKSalt: string }} params
 * @returns {Promise<{ success: boolean }>}
 */
export async function submitPhoneRecovery(apiBase, deviceToken, params) {
  const { data } = await axios.post(`${apiBase}/api/auth/recover-via-phone/submit`, params, {
    headers: { Authorization: `Bearer ${deviceToken}` },
  });
  return data;
}
