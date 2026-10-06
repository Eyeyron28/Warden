const mongoose = require('mongoose');

// Cached at module scope so a serverless invocation that reuses this
// module's warm instance (Vercel does this often, just never reliably)
// reuses the existing connection instead of opening a new one per
// request - mongoose.connect() is itself idempotent/connection-pooled,
// but caching the PROMISE (not just calling connect() again) is what
// prevents a burst of concurrent cold requests from each kicking off
// their own separate connection attempt before the first one resolves.
let connectionPromise = null;

/**
 * Connects to MONGO_URI (required - there is no localhost fallback. A
 * missing value fails loudly at startup/first call rather than silently
 * falling back to a local Mongo instance that production was never meant
 * to have). serverSelectionTimeoutMS is short so a misconfigured/
 * unreachable Atlas cluster fails fast instead of hanging a serverless
 * invocation until ITS OWN timeout.
 */
function connectDB() {
  if (connectionPromise) return connectionPromise;

  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    throw new Error(
      'MONGO_URI is required and was not set. Refusing to start without a configured database.'
    );
  }

  connectionPromise = mongoose
    .connect(mongoUri, { serverSelectionTimeoutMS: 5000 })
    .then((conn) => {
      console.log('MongoDB connected.');
      return conn;
    })
    .catch((err) => {
      // Reset the cache on failure so the NEXT call retries a fresh
      // connection attempt instead of permanently caching a rejection.
      connectionPromise = null;
      console.error(`MongoDB connection error: ${err.message}`);
      throw err;
    });

  return connectionPromise;
}

module.exports = connectDB;
