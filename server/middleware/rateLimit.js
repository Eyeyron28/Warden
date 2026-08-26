// Minimal in-memory, per-IP rate limiter. Deliberately simple: a fixed
// rolling window counter, no external dependency, no cross-process/
// distributed awareness - fine for a single-process local vault server.
// Built specifically for GET /api/shared/:token, the one route in the
// app reachable with zero credentials, so it's the most exposed to
// scripted brute-force token guessing.
function createRateLimiter({ max, windowMs = 60 * 1000 } = {}) {
  if (!Number.isFinite(max) || max <= 0) {
    throw new Error('createRateLimiter requires a positive `max`.');
  }

  /** @type {Map<string, { count: number, windowStart: number }>} */
  const hits = new Map();

  // Periodic sweep so IPs that stop hitting this route don't linger in
  // memory forever. unref() keeps this timer from holding the process
  // open on its own, same pattern as sessionStore's cleanup timer.
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) {
      if (now - entry.windowStart > windowMs) hits.delete(ip);
    }
  }, windowMs);
  cleanupTimer.unref();

  return function rateLimit(req, res, next) {
    const ip = req.ip;
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || now - entry.windowStart > windowMs) {
      hits.set(ip, { count: 1, windowStart: now });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const error = new Error('Too many requests. Please try again shortly.');
      error.status = 429;
      return next(error);
    }

    next();
  };
}

module.exports = createRateLimiter;
