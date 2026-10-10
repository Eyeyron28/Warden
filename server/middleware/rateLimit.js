const RateLimit = require('../models/RateLimit');
const { ipKey } = require('../utils/clientIp');

/**
 * Mongo-backed rate limiter, replacing the old in-memory-Map version - an
 * in-memory counter is invisible to every other serverless instance
 * Vercel spins up, so it stopped meaningfully limiting anything the
 * moment this app stopped being one single long-lived process.
 *
 * One RateLimit document per (name, key) rolling window (models/
 * RateLimit.js). `name` is this limiter's own identity (so two different
 * routes rate-limiting the same IP don't share a counter); `key` is
 * whatever this limiter counts by - by default the caller's IP, or
 * whatever `keyFn` returns (e.g. the email in the request body, for the
 * signup/forgot-password limiters that also count per-email).
 *
 * The increment is a single atomic findOneAndUpdate using a pipeline
 * update (MongoDB 4.2+, supported on Atlas M0): if the stored window has
 * already expired (or no document exists yet), it resets to count 1 with
 * a fresh window; otherwise it increments in place. Doing the "did the
 * window expire" check and the write in one atomic operation (rather than
 * read-then-write) is what keeps this race-safe when two requests for the
 * same key land on two different serverless instances at nearly the same
 * moment.
 */
async function incrementWindow(bucket, key, windowMs) {
  const now = new Date();
  return RateLimit.findOneAndUpdate(
    { bucket, key },
    [
      {
        $set: {
          count: {
            $cond: [{ $lte: ['$windowExpiresAt', now] }, 1, { $add: ['$count', 1] }],
          },
          windowExpiresAt: {
            $cond: [{ $lte: ['$windowExpiresAt', now] }, new Date(now.getTime() + windowMs), '$windowExpiresAt'],
          },
        },
      },
    ],
    { upsert: true, new: true }
  );
}

/**
 * Spends one unit of a named budget (e.g. "5 OTP emails per hour for this
 * account") outside of any request middleware. Same atomic window as the
 * limiter. Returns true if the unit was available, false if the budget is
 * already used up.
 */
async function consumeBudget({ name, key, max, windowMs }) {
  const doc = await incrementWindow(name, key, windowMs);
  return doc.count <= max;
}

/**
 * Whether a budget is already used up, WITHOUT spending anything: true when the
 * current window holds `max` or more. Lets a caller block further attempts
 * (even correct ones) once a number of failures has been counted with
 * consumeBudget.
 */
async function isBudgetExhausted({ name, key, max }) {
  const doc = await RateLimit.findOne({ bucket: name, key });
  return Boolean(doc && doc.windowExpiresAt.getTime() > Date.now() && doc.count >= max);
}

/**
 * Seconds until a used-up budget frees up again, or 0 when it still has room.
 * Spends nothing. Lets a caller refuse (and say when to come back) before doing
 * any other work.
 */
async function budgetRetryAfterSeconds({ name, key, max }) {
  const doc = await RateLimit.findOne({ bucket: name, key });
  if (!doc || doc.count < max) return 0;
  const left = doc.windowExpiresAt.getTime() - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function createRateLimiter({ name, max, windowMs = 60 * 1000, keyFn } = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('createRateLimiter requires a `name`.');
  }
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('createRateLimiter requires a positive `max`.');
  }

  return async function rateLimit(req, res, next) {
    try {
      // The address is always reduced through ONE helper (utils/clientIp.js: IPv6 by its /64). A limiter that cannot
      // determine its own key (e.g. no email in a malformed body) falls back to the address; it is never skipped, so
      // leaving the field out cannot be a way around a limit.
      const key = (keyFn ? keyFn(req) : null) || (keyFn ? `no-key:${ipKey(req.ip)}` : ipKey(req.ip));

      const doc = await incrementWindow(name, key, windowMs);

      if (doc.count > max) {
        const error = new Error('Too many requests. Please try again shortly.');
        error.status = 429;
        return next(error);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = createRateLimiter;
module.exports.consumeBudget = consumeBudget;
module.exports.isBudgetExhausted = isBudgetExhausted;
module.exports.budgetRetryAfterSeconds = budgetRetryAfterSeconds;
