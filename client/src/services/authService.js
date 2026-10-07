import api from './api.js';

/**
 * POST /api/auth/signup
 * Response is intentionally identical whether or not `email` already has
 * an account, down to a `recoveryKey` field that's either the real,
 * one-time key (new account) or a decoy of the same shape (existing
 * account) - see the server's own comment on this for why. The caller
 * cannot and should not try to tell which case it got.
 * @param {string} email
 * @param {string} password
 * @param {string} [inviteCode]
 * @returns {Promise<{ message: string, recoveryKey: string }>}
 */
export async function signupVault(email, password, inviteCode) {
  const { data } = await api.post('/auth/signup', { email, password, inviteCode });
  return data;
}

/**
 * POST /api/auth/verify-email
 * @param {string} token
 * @returns {Promise<{ message: string }>}
 */
export async function verifyEmailToken(token) {
  const { data } = await api.post('/auth/verify-email', { token });
  return data;
}

/**
 * POST /api/auth/resend-verification - always the same generic response.
 * Rejects with HTTP 429 if a link was already sent to this email in the
 * last 60 seconds.
 * @param {string} email
 * @returns {Promise<{ message: string }>}
 */
export async function resendVerification(email) {
  const { data } = await api.post('/auth/resend-verification', { email });
  return data;
}

/**
 * GET /api/auth/config - public settings the signup screen needs.
 * @returns {Promise<{ signupMode: 'open' | 'invite' }>}
 */
export async function getPublicConfig() {
  const { data } = await api.get('/auth/config');
  return data;
}

/**
 * POST /api/auth/unlock - step 1 of login: email + password.
 *
 * With the emailed code on (always, in production) the answer is NOT a
 * session: it is a challenge for step 2, `{ otpRequired: true,
 * challengeToken, codeLength, expiresAt, resendAvailableAt, resendsLeft }`,
 * and a 6-digit code has been emailed to the account. (Only a development
 * server with OTP_ENABLED=false answers `{ sessionToken }` directly.)
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{ sessionToken: string } | { otpRequired: true, challengeToken: string, codeLength: number, expiresAt: string, resendAvailableAt: string, resendsLeft: number }>}
 */
export async function loginVault(email, password) {
  const { data } = await api.post('/auth/unlock', { email, password });
  return data;
}

/**
 * POST /api/auth/verify-otp - step 2 of login: the emailed code. The
 * challengeToken must be held in memory only. Every failure (wrong, expired,
 * too many tries, already used) is the same 401.
 * @param {string} challengeToken
 * @param {string} code six digits
 * @returns {Promise<{ sessionToken: string }>}
 */
export async function verifyOtp(challengeToken, code) {
  const { data } = await api.post('/auth/verify-otp', { challengeToken, code });
  return data;
}

/**
 * POST /api/auth/resend-otp - a new code for the same login; the previous
 * one stops working. 429 carries `retryAfterSeconds` inside the cooldown.
 * @param {string} challengeToken
 * @returns {Promise<{ otpRequired: true, challengeToken: string, codeLength: number, expiresAt: string, resendAvailableAt: string, resendsLeft: number }>}
 */
export async function resendOtp(challengeToken) {
  const { data } = await api.post('/auth/resend-otp', { challengeToken });
  return data;
}

/**
 * GET /api/auth/me - who, if anyone, the current bearer token belongs to.
 * @returns {Promise<{ email: string, emailVerified: boolean }>}
 */
export async function getMe() {
  const { data } = await api.get('/auth/me');
  return data;
}

/**
 * POST /api/auth/forgot-password - always the same generic response.
 * @param {string} email
 * @returns {Promise<{ message: string }>}
 */
export async function forgotPassword(email) {
  const { data } = await api.post('/auth/forgot-password', { email });
  return data;
}

/**
 * POST /api/auth/reset-password
 * @param {{ token: string, newPassword: string, recoveryKey?: string, confirmWipe?: boolean }} params
 * @returns {Promise<{ message: string, recoveryKey?: string, documentsWiped?: boolean }>}
 *   `recoveryKey` is present only on the no-recovery-key (wipe) path - a
 *   brand-new one, since the old one no longer unwraps anything meaningful.
 */
export async function resetPassword({ token, newPassword, recoveryKey, confirmWipe }) {
  const { data } = await api.post('/auth/reset-password', {
    token,
    newPassword,
    recoveryKey,
    confirmWipe,
  });
  return data;
}

/**
 * POST /api/auth/recover-via-phone/init - starts a new 5-minute
 * paired-phone recovery window. Requires the account's email now (there's
 * no single implicit vault to fall back to). `recoverUrl` is null if the
 * server couldn't determine its own LAN IP - the frontend should fall
 * back to showing `recoveryToken` as a manually-typed code.
 * @param {string} email
 * @returns {Promise<{ recoveryToken: string, recoverUrl: string|null, expiresAt: string }>}
 */
export async function initPhoneRecovery(email) {
  const { data } = await api.post('/auth/recover-via-phone/init', { email });
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
 * Explicitly ends the session server-side, so "Log out" actually kills
 * the old token instead of leaving it valid until its 30-min expiry.
 * @returns {Promise<{ success: boolean }>}
 */
export async function logoutVault() {
  const { data } = await api.post('/auth/logout');
  return data;
}
