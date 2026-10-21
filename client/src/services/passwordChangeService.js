import api from './api.js';

const KEEP_SESSION = { skipSessionClear: true };

export async function startPasswordChange({ currentPassword, newPassword }) {
  const { data } = await api.post('/account/password/start', { currentPassword, newPassword }, KEEP_SESSION);
  return data;
}

export async function resendPasswordChangeCode(challengeToken) {
  const { data } = await api.post('/account/password/resend', { challengeToken }, KEEP_SESSION);
  return data;
}

export async function confirmPasswordChange({ challengeToken, code, newPassword }) {
  const { data } = await api.post('/account/password/confirm', { challengeToken, code, newPassword }, KEEP_SESSION);
  return data;
}
