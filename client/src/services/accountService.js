import api from './api.js';

// A 401 on these calls usually means "wrong password" or "wrong code", not
// "your session ended" - so it must not log the person out (see api.js).
const KEEP_SESSION = { skipSessionClear: true };

/**
 * POST /api/account/delete-challenge - step 1 of deleting the account: the
 * master password is checked again, then a 6-digit DELETION code is emailed.
 * That code cannot log anyone in, and a login code cannot delete anything.
 * Nothing is deleted by this call.
 * @param {string} password
 * @returns {Promise<{ otpRequired: true, challengeToken: string, codeLength: number, expiresAt: string, resendAvailableAt: string, resendsLeft: number }>}
 */
export async function requestDeleteCode(password) {
  const { data } = await api.post('/account/delete-challenge', { password }, KEEP_SESSION);
  return data;
}

/**
 * POST /api/account/resend-delete-code - a new deletion code for the same
 * challenge; the previous one stops working.
 * @param {string} challengeToken
 */
export async function resendDeleteCode(challengeToken) {
  const { data } = await api.post('/account/resend-delete-code', { challengeToken }, KEEP_SESSION);
  return data;
}

/**
 * DELETE /api/account - permanently deletes the account and everything it
 * owns. Needs the session, the emailed deletion code, and the account's email
 * typed exactly. This cannot be undone.
 * @param {{ challengeToken: string, code: string, emailConfirmation: string }} body
 * @returns {Promise<{ success: boolean }>}
 */
export async function deleteAccount({ challengeToken, code, emailConfirmation }) {
  const { data } = await api.delete('/account', {
    data: { challengeToken, code, emailConfirmation },
    ...KEEP_SESSION,
  });
  return data;
}
