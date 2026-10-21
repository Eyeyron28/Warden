import api from './api.js';
import { fetchCached } from './dataCache.js';
import { visitMemory } from './visitMemory.js';

export async function signupStart({ email, password, inviteCode }) {
  const { data } = await api.post('/auth/signup/start', { email, password, termsAccepted: true, ...(inviteCode ? { inviteCode } : {}) });
  return data;
}

export async function signupVerify({ email, password, code }) {
  const { data } = await api.post('/auth/signup/verify', { email, password, code });
  return data;
}

export async function signupResend(email) {
  const { data } = await api.post('/auth/signup/resend', { email });
  return data;
}

export async function verifyEmailToken(token) {
  const { data } = await api.post('/auth/verify-email', { token });
  return data;
}

export async function resendVerification(email) {
  const { data } = await api.post('/auth/resend-verification', { email });
  return data;
}

export async function getPublicConfig() {
  const { data } = await api.get('/auth/config');
  return data;
}

export async function loginVault(email, password) {
  const { data } = await api.post('/auth/unlock', { email, password });
  return data;
}

export async function verifyOtp(challengeToken, code, trustDevice = false) {
  const { data } = await api.post('/auth/verify-otp', { challengeToken, code, ...(trustDevice ? { trustDevice: true } : {}) });
  return data;
}

export async function resendOtp(challengeToken) {
  const { data } = await api.post('/auth/resend-otp', { challengeToken });
  return data;
}

export function getMe(options) {
  return fetchCached(
    'auth/me',
    async () => {
      const me = (await api.get('/auth/me')).data;
      if (me?.email) visitMemory.rememberAccount(me.email);
      return me;
    },
    options
  );
}

export async function requestPasswordReset(email) {
  const { data } = await api.post('/auth/password-reset/start', { email });
  return data;
}

export async function resendPasswordResetCode(challengeToken) {
  const { data } = await api.post('/auth/password-reset/resend', { challengeToken });
  return data;
}

export async function verifyPasswordResetCode(challengeToken, code) {
  const { data } = await api.post('/auth/password-reset/verify', { challengeToken, code });
  return data;
}

export async function resetPasswordWithRecoveryKey({ resetTicket, recoveryKey, newPassword }) {
  const { data } = await api.post('/auth/password-reset/with-recovery-key', { resetTicket, recoveryKey, newPassword });
  return data;
}

export async function resetPasswordStartOver({ resetTicket, confirmEmail, newPassword }) {
  const { data } = await api.post('/auth/password-reset/start-over', { resetTicket, confirmEmail, newPassword });
  return data;
}

export async function resetPasswordWithRecoveryKeyOnly({ email, recoveryKey, newPassword }) {
  const { data } = await api.post('/auth/password-reset/recovery-key-only', { email, recoveryKey, newPassword });
  return data;
}

export async function logoutVault() {
  const { data } = await api.post('/auth/logout');
  return data;
}
