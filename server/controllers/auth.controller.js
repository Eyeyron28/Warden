const crypto = require('crypto');

const User = require('../models/User');
const { generateSalt, hashPassword, verifyPassword, deriveEncryptionKey, unwrapKey } = require('../utils/crypto');
const { validatePassword } = require('../utils/passwordPolicy');
const { signupMode, requestAccessText } = require('../utils/inviteGate');
const { trustThisBrowser, isTrustedFor, labelFromUserAgent, parseUserAgent } = require('../utils/trustedDevice');
const { resolveDevice, deviceFromCookie } = require('../utils/deviceIdentity');
const { recordEvent, countryFrom, cityFrom } = require('../utils/audit');
const { templates } = require('../utils/emailTemplates');
const { createSession, destroySession, destroyAllSessionsForUser } = require('../utils/sessionStore');
const { getPublicAppUrl } = require('../utils/publicAppUrl');
const { sendEmail, normalizeRecipient } = require('../utils/email');
const { otpEnabled } = require('../utils/otpConfig');
const { PURPOSES, startChallenge, consumeChallenge, resendChallenge } = require('../utils/otpChallenge');
const { reserveLoginAttempt, clearLoginFailures, LOGIN_ATTEMPT_LIMIT } = require('../utils/loginLimiter');
const { logSecurity } = require('../utils/securityLog');
const { recordDuration, padLikeReal } = require('../utils/sendTiming');

const EMAIL_VERIFICATION_TOKEN_BYTES = 32;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const RESEND_GENERIC_MESSAGE = 'If this account exists and is not yet verified, a new link has been sent.';

function resolvePublicAppUrl() {
  return getPublicAppUrl();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const DUMMY_SALT = generateSalt();
const DUMMY_HASH = hashPassword('warden-timing-parity-dummy-password', DUMMY_SALT);

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function passwordPolicyError(errors) {
  const error = new Error('Password does not meet the security requirements.');
  error.status = 400;
  error.errors = errors;
  return error;
}

function lockoutError(lockedUntil) {
  const minutesRemaining = Math.max(1, Math.ceil((lockedUntil.getTime() - Date.now()) / 60000));
  const error = new Error(
    `Too many failed attempts. Try again in ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`
  );
  error.status = 403;
  error.locked = true;
  error.lockedUntil = lockedUntil.toISOString();
  error.minutesRemaining = minutesRemaining;
  return error;
}

function genericLoginError() {
  const error = new Error('Incorrect email or password.');
  error.status = 401;
  return error;
}

function unverifiedAccountError() {
  const error = new Error('Please verify your email before logging in. Check your inbox for the link.');
  error.status = 403;
  error.emailVerificationRequired = true;
  return error;
}

function invalidVerificationTokenError() {
  const error = new Error('This verification link is invalid or has expired.');
  error.status = 404;
  return error;
}

const verifyEmail = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') {
    throw badRequest('A verification token is required.');
  }

  const user = await User.findOne({ verificationTokenHash: hashToken(token) });
  if (!user || !user.verificationTokenExpiresAt || user.verificationTokenExpiresAt.getTime() <= Date.now()) {
    throw invalidVerificationTokenError();
  }

  user.emailVerified = true;
  user.verificationTokenHash = undefined;
  user.verificationTokenExpiresAt = undefined;
  await user.save();

  res.status(200).json({ message: 'Email verified. You can now log in.' });
});

const resendVerification = asyncHandler(async (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string' || !email.trim()) {
    throw badRequest('email is required.');
  }
  const normalizedEmail = normalizeRecipient(email);
  if (!normalizedEmail) {
    return res.status(200).json({ message: RESEND_GENERIC_MESSAGE });
  }

  const startedAt = Date.now();
  const user = await User.findOne({ email: normalizedEmail });
  if (user && !user.emailVerified) {
    const verificationToken = crypto.randomBytes(EMAIL_VERIFICATION_TOKEN_BYTES).toString('hex');
    user.verificationTokenHash = hashToken(verificationToken);
    user.verificationTokenExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    await user.save();

    const appUrl = resolvePublicAppUrl(req);
    const verifyUrl = appUrl ? `${appUrl}/verify-email?token=${verificationToken}` : null;
    await sendEmail({ to: normalizedEmail, ...templates.verifyEmailResend({ verifyUrl }) });
    recordDuration('resend-verification', Date.now() - startedAt);
  } else {
    await padLikeReal('resend-verification', startedAt);
  }

  res.status(200).json({
    message: RESEND_GENERIC_MESSAGE,
  });
});

const getPublicConfig = (req, res) => {
  const mode = signupMode();
  const body = { signupMode: mode };
  if (mode === 'invite') {
    const text = requestAccessText();
    if (text) body.requestAccessText = text;
  }
  res.status(200).json(body);
};

async function checkPasswordWithLockout(user, password) {
  const gate = await reserveLoginAttempt(user.email);
  if (!gate.granted) throw lockoutError(gate.lockedUntil);

  if (!verifyPassword(password, user.salt, user.passwordHash)) {
    throw gate.locked ? lockoutError(gate.lockedUntil) : genericLoginError();
  }
  await clearLoginFailures(user.email);
}

async function issueLoginSession(req, res, user, dek, { trust = false } = {}) {
  const { device, isNew, hadOtherDevices } = await resolveDevice(req, res, user._id);
  const sessionToken = await createSession(user._id, dek, { deviceId: device._id });

  if (trust) {
    await trustThisBrowser(req, res, user._id, { deviceId: device._id });
    await recordEvent(req, 'trusted_added', { userId: user._id, deviceId: device._id });
    sendEmail({
      to: user.email,
      ...templates.trustedBrowser({ browser: labelFromUserAgent(req.headers['user-agent']), when: new Date() }),
    }).catch(() => false);
  }

  await recordEvent(req, 'login', { userId: user._id, deviceId: device._id });

  if (isNew && hadOtherDevices) {
    const { browser, os } = parseUserAgent(req.headers['user-agent']);
    sendEmail({
      to: user.email,
      ...templates.newDevice({ browser, os, country: countryFrom(req), city: cityFrom(req), when: new Date() }),
    }).catch(() => false);
  }
  return sessionToken;
}

async function respondWithLoginChallenge(req, res, user, dek) {
  if (otpEnabled()) {
    const challenge = await startChallenge({ user, secret: dek, purpose: PURPOSES.login });
    await recordEvent(req, 'otp_sent', { userId: user._id, deviceId: (await deviceFromCookie(req, user._id))?._id || null });
    res.status(200).json(challenge);
    return;
  }
  res.status(200).json({ sessionToken: await issueLoginSession(req, res, user, dek) });
}

const unlock = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string') {
    throw badRequest('email and password are required.');
  }
  const normalizedEmail = email.trim().toLowerCase();

  const gate = await reserveLoginAttempt(normalizedEmail);
  const noteLockout = () => {
    if (gate.locked && gate.granted) logSecurity('lockout', { bucket: 'login', count: LOGIN_ATTEMPT_LIMIT, subject: normalizedEmail });
  };
  const user = await User.findOne({ email: normalizedEmail });
  const failedLogin = async () =>
    recordEvent(req, 'login_failed', { userId: user._id, deviceId: (await deviceFromCookie(req, user._id))?._id || null });

  if (!gate.granted) {
    if (user) await failedLogin();
    throw lockoutError(gate.lockedUntil);
  }

  if (!user) {
    verifyPassword(password, DUMMY_SALT, DUMMY_HASH);
    noteLockout();
    throw gate.locked ? lockoutError(gate.lockedUntil) : genericLoginError();
  }

  if (!verifyPassword(password, user.salt, user.passwordHash)) {
    await failedLogin();
    noteLockout();
    throw gate.locked ? lockoutError(gate.lockedUntil) : genericLoginError();
  }
  await clearLoginFailures(normalizedEmail);

  if (!user.emailVerified) {
    throw unverifiedAccountError();
  }

  const passwordKek = deriveEncryptionKey(password, user.salt);
  const dek = unwrapKey(
    user.wrappedDEKPassword,
    passwordKek,
    user.wrappedDEKPasswordIv,
    user.wrappedDEKPasswordAuthTag
  );

  if (otpEnabled() && (await isTrustedFor(req, user._id, res))) {
    res.status(200).json({ sessionToken: await issueLoginSession(req, res, user, dek) });
    return;
  }

  await respondWithLoginChallenge(req, res, user, dek);
});

const verifyOtp = asyncHandler(async (req, res) => {
  const { challengeToken, code } = req.body;
  const { claimed, secret: dek } = await consumeChallenge({
    challengeToken,
    code,
    purpose: PURPOSES.login,
  });

  const user = await User.findById(claimed.userId);
  if (!user || !user.emailVerified) {
    const error = new Error('That code is incorrect or has expired.');
    error.status = 401;
    throw error;
  }

  const sessionToken = await issueLoginSession(req, res, user, dek, { trust: req.body.trustDevice === true });
  res.status(200).json({ sessionToken });
});

const resendOtp = asyncHandler(async (req, res) => {
  res.status(200).json(
    await resendChallenge({
      challengeToken: req.body.challengeToken,
      purpose: PURPOSES.login,
      findUser: (id) => User.findById(id),
    })
  );
});

const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);
  if (!user) {
    const error = new Error('Account not found.');
    error.status = 404;
    throw error;
  }
  if (req.emergency) {
    return res.status(200).json({
      emergency: true,
      readOnly: true,
      scopeMode: req.emergency.scopeMode,
      endsAt: req.emergency.absoluteExpiresAt,
    });
  }
  res.status(200).json({ email: user.email, emailVerified: user.emailVerified });
});

const logout = asyncHandler(async (req, res) => {
  await recordEvent(req, 'logout');
  await destroySession(req.session.token);
  res.status(200).json({ success: true });
});

module.exports = {
  issueLoginSession,
  verifyEmail,
  resendVerification,
  getPublicConfig,
  unlock,
  getMe,
  verifyOtp,
  resendOtp,
  logout,
  checkPasswordWithLockout,
};
