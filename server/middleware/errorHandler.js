const crypto = require('crypto');

const { scrubForLog } = require('../utils/logSafe');

// Consistent JSON error format for all routes.
// Usage: pass errors to next(err), or let thrown errors in async handlers bubble up.
const notFound = (req, res, next) => {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.status = 404;
  next(error);
};

// SESSION_INVALID: the bearer token itself is missing, expired or unknown (as
// opposed to some other 401, such as a wrong password or code on a signed-in
// route), so the client knows to end its session.
const PUBLIC_ERROR_CODES = new Set(['FOLDER_EXISTS', 'NAME_EXISTS', 'SESSION_INVALID', 'STORAGE_QUOTA', 'INVITE_CODE_INVALID', 'RESET_TICKET_INVALID',
  // Emergency Access: answers the screens act on (the first three are only ever given to someone who has already passed
  // the kit and code checks).
  'NOT_YET', 'EXPIRED', 'NO_REQUEST', 'NOT_AVAILABLE', 'EMERGENCY_READ_ONLY']);

// What a caller is told for any server-side failure. The real error stays in the server log, next to the request id.
const GENERIC_SERVER_ERROR = 'Something went wrong on our side. Please try again.';

const errorHandler = (err, req, res, next) => {
  const status = err.status || (res.statusCode !== 200 ? res.statusCode : 500);

  // Anything >= 500 is answered with ONE fixed message and a request id, so a driver error (a duplicate-key message
  // naming a collection and a value, a stack, a path) can never reach the caller. The only exception is an error the
  // app itself raised with `expose` set, whose text was written for the user (e.g. "We couldn't send the code email").
  const hidden = status >= 500 && !err.expose;
  const requestId = status >= 500 ? crypto.randomBytes(6).toString('hex') : undefined;
  if (hidden) {
    console.error(`[request ${requestId}] ${status} ${scrubForLog(err.name)}: ${scrubForLog(err.message)}${err.code ? ` (code ${scrubForLog(err.code)})` : ''}`);
  }

  const errorBody = {
    message: hidden ? GENERIC_SERVER_ERROR : err.message || 'Internal Server Error',
    status,
  };
  if (requestId) errorBody.requestId = requestId;
  // Optional: a list of specific validation failures (e.g. password
  // policy violations), for callers that need more than one message.
  if (!hidden && Array.isArray(err.errors)) {
    errorBody.errors = err.errors;
  }
  // Optional: vault lockout state (see POST /api/auth/unlock), so the
  // frontend can show a countdown instead of a generic error.
  if (err.locked) {
    errorBody.locked = true;
    errorBody.lockedUntil = err.lockedUntil;
    errorBody.minutesRemaining = err.minutesRemaining;
  }
  // Optional: an unverified-account login rejection (POST /api/auth/
  // unlock, only ever set AFTER the password has already been verified
  // correct - see unverifiedAccountError in auth.controller.js), so the
  // frontend can show a "check your email" message instead of a generic
  // "incorrect email or password."
  if (err.emailVerificationRequired) {
    errorBody.emailVerificationRequired = true;
  }
  // Optional: how long until a rate-limited action (e.g. resending a login
  // code) is allowed again, so the client can show a countdown.
  if (Number.isFinite(err.retryAfterSeconds)) {
    errorBody.retryAfterSeconds = err.retryAfterSeconds;
  }
  // Optional: a stable, machine-readable code for errors the client
  // branches on (e.g. FOLDER_EXISTS from folder create/rename/move).
  // Allowlisted rather than forwarding err.code wholesale - Node and the
  // Mongo driver put their own codes there (ENOENT, 11000) that shouldn't
  // leak to the client.
  if (PUBLIC_ERROR_CODES.has(err.code)) {
    errorBody.code = err.code;
  }
  // "Not yet" tells an authenticated contact when the waiting period ends.
  if (err.code === 'NOT_YET' && err.releaseAt) errorBody.releaseAt = err.releaseAt;

  res.status(status).json({
    success: false,
    error: errorBody,
  });
};

module.exports = { notFound, errorHandler, GENERIC_SERVER_ERROR, scrubForLog };
