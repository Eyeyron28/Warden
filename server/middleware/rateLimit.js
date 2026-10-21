const RateLimit = require('../models/RateLimit');
const { ipKey } = require('../utils/clientIp');

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

async function consumeBudget({ name, key, max, windowMs }) {
  const doc = await incrementWindow(name, key, windowMs);
  return doc.count <= max;
}

async function consumeBudgetCount({ name, key, max, windowMs }) {
  const doc = await incrementWindow(name, key, windowMs);
  return { allowed: doc.count <= max, count: doc.count };
}

async function reserveCapped({ name, key, max, windowMs }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const doc = await RateLimit.findOneAndUpdate(
        { bucket: name, key, count: { $lt: max } },
        { $inc: { count: 1 }, $setOnInsert: { windowExpiresAt: new Date(Date.now() + windowMs) } },
        { upsert: true, new: true }
      );
      return Boolean(doc);
    } catch (err) {
      if (err?.code !== 11000) throw err;
      // eslint-disable-next-line no-await-in-loop
      const row = await RateLimit.findOne({ bucket: name, key }).lean();
      if (row && row.count >= max) return false;
    }
  }
  return false;
}

async function isBudgetExhausted({ name, key, max }) {
  const doc = await RateLimit.findOne({ bucket: name, key });
  return Boolean(doc && doc.windowExpiresAt.getTime() > Date.now() && doc.count >= max);
}

async function budgetRetryAfterSeconds({ name, key, max }) {
  const doc = await RateLimit.findOne({ bucket: name, key });
  if (!doc || doc.count < max) return 0;
  const left = doc.windowExpiresAt.getTime() - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

function createRateLimiter({ name, max, windowMs = 60 * 1000, keyFn, code, message } = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('createRateLimiter requires a `name`.');
  }
  if (typeof max !== 'function' && (!Number.isFinite(max) || max <= 0)) {
    throw new Error('createRateLimiter requires a positive `max`.');
  }

  return async function rateLimit(req, res, next) {
    try {
      const key = (keyFn ? keyFn(req) : null) || (keyFn ? `no-key:${ipKey(req.ip)}` : ipKey(req.ip));

      const doc = await incrementWindow(name, key, windowMs);

      const limit = typeof max === 'function' ? max() : max;
      if (doc.count > limit) {
        const error = new Error(message || 'Too many requests. Please try again shortly.');
        error.status = 429;
        if (code) {
          error.code = code;
          error.retryAfterSeconds = Math.max(1, Math.ceil((doc.windowExpiresAt.getTime() - Date.now()) / 1000));
        }
        error.bucket = name;
        error.count = doc.count;
        error.subject = key;
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
module.exports.consumeBudgetCount = consumeBudgetCount;
module.exports.reserveCapped = reserveCapped;
module.exports.isBudgetExhausted = isBudgetExhausted;
module.exports.budgetRetryAfterSeconds = budgetRetryAfterSeconds;
