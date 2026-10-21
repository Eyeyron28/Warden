import api from './api.js';

const KEEP_SESSION = { skipSessionClear: true };

export async function requestDeleteCode(password) {
  const { data } = await api.post('/account/delete-challenge', { password }, KEEP_SESSION);
  return data;
}

export async function resendDeleteCode(challengeToken) {
  const { data } = await api.post('/account/resend-delete-code', { challengeToken }, KEEP_SESSION);
  return data;
}

export async function deleteAccount({ challengeToken, code, emailConfirmation }) {
  const { data } = await api.delete('/account', {
    data: { challengeToken, code, emailConfirmation },
    ...KEEP_SESSION,
  });
  return data;
}

export async function listTrustedDevices() {
  const { data } = await api.get('/account/trusted-devices');
  return data;
}

export async function removeTrustedDevice(id) {
  await api.delete(`/account/trusted-devices/${encodeURIComponent(id)}`);
}

export async function removeAllTrustedDevices() {
  const { data } = await api.delete('/account/trusted-devices');
  return data;
}

export async function getVaultHealth() {
  const { data } = await api.get('/account/health', KEEP_SESSION);
  return data;
}

export async function getPreferences() {
  const { data } = await api.get('/account/preferences', KEEP_SESSION);
  return data;
}

export async function setExpiryReminders(expiryReminders) {
  const { data } = await api.patch('/account/preferences', { expiryReminders }, KEEP_SESSION);
  return data;
}
