const crypto = require('crypto');

const { consumeBudget, budgetRetryAfterSeconds } = require('../middleware/rateLimit');
const { ipKey } = require('./clientIp');

const MAX_INVITE_CODE_LENGTH = 256;
const MAX_REQUEST_ACCESS_LENGTH = 200;
const MESSAGE = 'The invite code is missing or incorrect.';

const FAILURE_BUDGETS = [
  { name: 'invite-fail-15m', max: 5, windowMs: 15 * 60 * 1000 },
  { name: 'invite-fail-1h', max: 20, windowMs: 60 * 60 * 1000 },
];

function signupMode() {
  return (process.env.SIGNUP_MODE || '').trim().toLowerCase() === 'open' ? 'open' : 'invite';
}

function requestAccessText() {
  const raw = (process.env.REQUEST_ACCESS_TEXT || '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ');
  return [...raw.replace(/\s+/g, ' ').trim()].slice(0, MAX_REQUEST_ACCESS_LENGTH).join('');
}

function inviteError() {
  const error = new Error(MESSAGE);
  error.status = 403;
  error.code = 'INVITE_CODE_INVALID';
  return error;
}

function tooManyError(retryAfterSeconds) {
  const error = new Error('Too many requests. Please try again shortly.');
  error.status = 429;
  if (retryAfterSeconds > 0) error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

function codesMatch(given, expected) {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function assertInviteCode(req) {
  if (signupMode() === 'open') return;

  const key = ipKey(req.ip);

  let wait = 0;
  for (const budget of FAILURE_BUDGETS) {
    // eslint-disable-next-line no-await-in-loop
    wait = Math.max(wait, await budgetRetryAfterSeconds({ name: budget.name, key, max: budget.max }));
  }
  if (wait > 0) throw tooManyError(wait);

  const given = req.body?.inviteCode;
  const expected = process.env.INVITE_CODE || '';
  const usable = typeof given === 'string' && given.length <= MAX_INVITE_CODE_LENGTH && given.trim() !== '';
  const matches = codesMatch(usable ? given.trim() : '', expected);

  if (usable && expected !== '' && matches) return;

  for (const budget of FAILURE_BUDGETS) {
    // eslint-disable-next-line no-await-in-loop
    await consumeBudget({ name: budget.name, key, max: budget.max, windowMs: budget.windowMs });
  }
  throw inviteError();
}

function inviteGate(req, res, next) {
  assertInviteCode(req).then(
    () => {
      req.inviteChecked = true;
      next();
    },
    next
  );
}

module.exports = {
  assertInviteCode,
  inviteGate,
  signupMode,
  requestAccessText,
  MAX_INVITE_CODE_LENGTH,
  MAX_REQUEST_ACCESS_LENGTH,
  FAILURE_BUDGETS,
};
