const crypto = require('crypto');

const { consumeBudget, budgetRetryAfterSeconds } = require('../middleware/rateLimit');
const { ipKey } = require('./clientIp');

/**
 * The sign-up invite code, enforced on the server (the form is only a courtesy).
 *
 * Only SIGNUP_MODE=open opens sign-up. Anything else - "invite", unset, a typo
 * such as "closed" - requires the code, so a misspelt setting can never leave
 * the door open. In open mode a submitted code is ignored.
 *
 * The gate runs before anything else about the request is looked at: before the
 * email is validated or looked up, before a password is hashed, before an account
 * is created or any mail is sent. So a bad code does no work, sends nothing, and
 * the answer says nothing about any email address.
 */

const MAX_INVITE_CODE_LENGTH = 256;
const MAX_REQUEST_ACCESS_LENGTH = 200;
const MESSAGE = 'The invite code is missing or incorrect.';

// Failures only. 5 per 15 minutes and 20 per hour, per IP. While either is used
// up, even the right code is refused until the window ends.
const FAILURE_BUDGETS = [
  { name: 'invite-fail-15m', max: 5, windowMs: 15 * 60 * 1000 },
  { name: 'invite-fail-1h', max: 20, windowMs: 60 * 60 * 1000 },
];

function signupMode() {
  return (process.env.SIGNUP_MODE || '').trim().toLowerCase() === 'open' ? 'open' : 'invite';
}

/** REQUEST_ACCESS_TEXT as plain text: control and bidi characters removed, whitespace collapsed, length-limited. */
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

// SHA-256 of both sides first, so the buffers are always 32 bytes and the
// comparison never depends on the length of what was typed.
function codesMatch(given, expected) {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Throws unless sign-up is open or req.body.inviteCode is the configured code. */
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
  // A comparison always runs (against an empty string when nothing usable was
  // sent), so a missing code costs the same as a wrong one.
  const matches = codesMatch(usable ? given.trim() : '', expected);

  if (usable && expected !== '' && matches) return;

  for (const budget of FAILURE_BUDGETS) {
    // eslint-disable-next-line no-await-in-loop
    await consumeBudget({ name: budget.name, key, max: budget.max, windowMs: budget.windowMs });
  }
  throw inviteError();
}

/** Route middleware form of the same check (see routes/auth.routes.js). */
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
