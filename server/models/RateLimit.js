const mongoose = require('mongoose');

// Mongo-backed replacement for the old in-memory rate limiter (middleware/
// rateLimit.js) - an in-memory counter Map is invisible to every other
// serverless instance Vercel spins up, so it stopped meaningfully limiting
// anything the moment this app moved off a single long-lived process.
//
// One document per (bucket, key) rolling window - `bucket` is the limiter's
// own name (e.g. "login", "signup"), `key` is whatever that limiter counts
// by (an IP, or "ip:email" for the limiters that count both - see
// middleware/rateLimit.js). `count` resets implicitly: once `windowExpiresAt`
// passes, the next hit's $setOnInsert-style upsert starts a fresh window
// rather than incrementing a stale one (see rateLimit.js for the exact
// upsert). The TTL index then reaps the old window document on its own.
const rateLimitSchema = new mongoose.Schema({
  bucket: {
    type: String,
    required: true,
  },
  key: {
    type: String,
    required: true,
  },
  count: {
    type: Number,
    required: true,
    default: 0,
  },
  windowExpiresAt: {
    type: Date,
    required: true,
  },
});

rateLimitSchema.index({ bucket: 1, key: 1 }, { unique: true });
rateLimitSchema.index({ windowExpiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('RateLimit', rateLimitSchema);
