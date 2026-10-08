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
 * @param {boolean} [trustDevice] remember this browser for 30 days
 * @returns {Promise<{ sessionToken: string }>}
 */
export async function verifyOtp(challengeToken, code, trustDevice = false) {
  // `trustDevice: true` asks the server to remember this browser (an HttpOnly
  // cookie it sets) so the next login here skips the code. Never the password.
  const { data } = await api.post('/auth/verify-otp', { challengeToken, code, ...(trustDevice ? { trustDevice: true } : {}) });
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

// ---- Forgot password: emailed code -> single-use ticket -> recovery key or start over ----
// Tickets, codes, recovery keys and passwords only ever pass through here in memory.

/**
 * POST /api/auth/password-reset/start - the same answer for every address. It
 * carries a code challenge (a decoy for an address with no account).
 * @param {string} email
 * @returns {Promise<{ message: string, challengeToken: string, codeLength: number, expiresAt: string, resendAvailableAt: string, resendsLeft: number }>}
 */
export async function requestPasswordReset(email) {
  const { data } = await api.post('/auth/password-reset/start', { email });
  return data;
}

/** POST /api/auth/password-reset/resend - a new code for the same challenge. */
export async function resendPasswordResetCode(challengeToken) {
  const { data } = await api.post('/auth/password-reset/resend', { challengeToken });
  return data;
}

/**
 * POST /api/auth/password-reset/verify - a correct code buys a single-use ticket
 * (never a session).
 * @returns {Promise<{ resetTicket: string, expiresAt: string }>}
 */
export async function verifyPasswordResetCode(challengeToken, code) {
  const { data } = await api.post('/auth/password-reset/verify', { challengeToken, code });
  return data;
}

/** POST /api/auth/password-reset/with-recovery-key - keeps the vault. */
export async function resetPasswordWithRecoveryKey({ resetTicket, recoveryKey, newPassword }) {
  const { data } = await api.post('/auth/password-reset/with-recovery-key', { resetTicket, recoveryKey, newPassword });
  return data;
}

/**
 * POST /api/auth/password-reset/start-over - erases the vault and starts a new one.
 * @returns {Promise<{ recoveryKey: string, documentsWiped: true }>} the NEW recovery key, shown once
 */
export async function resetPasswordStartOver({ resetTicket, confirmEmail, newPassword }) {
  const { data } = await api.post('/auth/password-reset/start-over', { resetTicket, confirmEmail, newPassword });
  return data;
}

/** POST /api/auth/password-reset/recovery-key-only - "Try another way": no email code, vault kept. */
export async function resetPasswordWithRecoveryKeyOnly({ email, recoveryKey, newPassword }) {
  const { data } = await api.post('/auth/password-reset/recovery-key-only', { email, recoveryKey, newPassword });
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
 * @returns {Promise<{ otpRequired: true, challengeToken: string, codeLength: number, expiresAt: string, resendAvailableAt: string, resendsLeft: number } | { sessionToken: string }>}
 *   A 6-digit code is emailed first, exactly like a password login; the session only
 *   comes from POST /api/auth/verify-otp (a plain `{ sessionToken }` is only ever
 *   answered by a development server with OTP_ENABLED=false).
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
