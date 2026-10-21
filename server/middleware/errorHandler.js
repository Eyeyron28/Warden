const crypto = require('crypto');

const { scrubForLog } = require('../utils/logSafe');
const { logSecurity } = require('../utils/securityLog');
const { currentRequestId } = require('../utils/requestContext');

const notFound = (req, res, next) => {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.status = 404;
  next(error);
};

const PUBLIC_ERROR_CODES = new Set(['FOLDER_EXISTS', 'NAME_EXISTS', 'SESSION_INVALID', 'STORAGE_QUOTA', 'INVITE_CODE_INVALID', 'RESET_TICKET_INVALID', 'EMAIL_DOMAIN_NO_MAIL',
  'NOT_YET', 'EXPIRED', 'NO_REQUEST', 'NOT_AVAILABLE', 'EMERGENCY_READ_ONLY',
  'FILE_BLOCKED', 'USE_IMPORT', 'VERSION_REFUSED', 'QUARANTINED', 'RELEASE_CONFIRM',
  'UPLOAD_RATE_LIMITED', 'DOCUMENT_LIMIT']);

const GENERIC_SERVER_ERROR = 'Something went wrong on our side. Please try again.';

const errorHandler = (err, req, res, next) => {
  const status = err.status || (res.statusCode !== 200 ? res.statusCode : 500);

  const hidden = status >= 500 && !err.expose;
  const requestId = status >= 500 ? currentRequestId() || crypto.randomBytes(6).toString('hex') : undefined;
  if (status === 429) logSecurity('rate_limited', { bucket: err.bucket || 'other', count: err.count, subject: err.subject });
  if (hidden) {
    console.error(`[request ${requestId}] ${status} ${scrubForLog(err.name)}: ${scrubForLog(err.message)}${err.code ? ` (code ${scrubForLog(err.code)})` : ''}`);
  }

  const errorBody = {
    message: hidden ? GENERIC_SERVER_ERROR : err.message || 'Internal Server Error',
    status,
  };
  if (requestId) errorBody.requestId = requestId;
  if (!hidden && Array.isArray(err.errors)) {
    errorBody.errors = err.errors;
  }
  if (err.locked) {
    errorBody.locked = true;
    errorBody.lockedUntil = err.lockedUntil;
    errorBody.minutesRemaining = err.minutesRemaining;
  }
  if (err.emailVerificationRequired) {
    errorBody.emailVerificationRequired = true;
  }
  if (Number.isFinite(err.retryAfterSeconds)) {
    errorBody.retryAfterSeconds = err.retryAfterSeconds;
    if (status === 429) res.set('Retry-After', String(Math.max(1, Math.ceil(err.retryAfterSeconds))));
  }
  if (PUBLIC_ERROR_CODES.has(err.code)) {
    errorBody.code = err.code;
  }
  if (Array.isArray(err.reasons) && PUBLIC_ERROR_CODES.has(err.code)) errorBody.reasons = err.reasons;
  if (err.code === 'NOT_YET' && err.releaseAt) errorBody.releaseAt = err.releaseAt;

  res.status(status).json({
    success: false,
    error: errorBody,
  });
};

module.exports = { notFound, errorHandler, GENERIC_SERVER_ERROR, scrubForLog };
