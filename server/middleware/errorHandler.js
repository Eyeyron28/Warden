// Consistent JSON error format for all routes.
// Usage: pass errors to next(err), or let thrown errors in async handlers bubble up.
const notFound = (req, res, next) => {
  const error = new Error(`Route not found: ${req.originalUrl}`);
  error.status = 404;
  next(error);
};

const errorHandler = (err, req, res, next) => {
  const status = err.status || (res.statusCode !== 200 ? res.statusCode : 500);

  const errorBody = {
    message: err.message || 'Internal Server Error',
    status,
  };
  // Optional: a list of specific validation failures (e.g. password
  // policy violations), for callers that need more than one message.
  if (Array.isArray(err.errors)) {
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

  res.status(status).json({
    success: false,
    error: errorBody,
  });
};

module.exports = { notFound, errorHandler };
