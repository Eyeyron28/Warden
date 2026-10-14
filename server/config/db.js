const mongoose = require('mongoose');

// Cached at module scope so a serverless invocation that reuses this
// module's warm instance (Vercel does this often, just never reliably)
// reuses the existing connection instead of opening a new one per
// request - mongoose.connect() is itself idempotent/connection-pooled,
// but caching the PROMISE (not just calling connect() again) is what
// prevents a burst of concurrent cold requests from each kicking off
// their own separate connection attempt before the first one resolves.
let connectionPromise = null;

// Indexes are built by utils/migrateIndexes.js, once per set of declared indexes - not by Mongoose on every cold start.
// Set before any model is compiled (this file is required first, by server.js).
mongoose.set('autoIndex', false);

// A small pool per function instance: Atlas M0 allows 500 connections in
// total, and Vercel may run many instances side by side, so each one keeps
// only a handful (and none idle for long). maxIdleTimeMS lets a quiet warm
// instance hand its sockets back. socketTimeoutMS ends a stuck query well
// inside the function's own time limit.
const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 30000,
  maxPoolSize: 5,
  minPoolSize: 0,
  maxIdleTimeMS: 30000,
};

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
    .connect(mongoUri, CONNECT_OPTIONS)
    .then(async (conn) => {
      console.log('MongoDB connected.');
      // Required lazily - utils/migrateFolders pulls in models, which
      // shouldn't load before mongoose is configured here.
      // Each of these is a marker check that is a no-op once done, and they do not depend on each other, so they ask
      // together (one round trip to the database instead of four in a row on every cold start). A failed migration
      // must not take the whole API down; it is retried on the next connection since its marker isn't written.
      const steps = [
        ['Index build', () => require('../utils/migrateIndexes').migrateIndexes()], // eslint-disable-line global-require
        ['Folder migration', () => require('../utils/migrateFolders')()], // eslint-disable-line global-require
        ['Phone-vault removal migration', () => require('../utils/migrateRemovePhone')()], // eslint-disable-line global-require
        ['Expiry-date migration', () => require('../utils/migrateExpiry')()], // eslint-disable-line global-require
      ];
      const results = await Promise.allSettled(steps.map(([, run]) => run()));
      results.forEach((result, index) => {
        if (result.status === 'rejected') console.error(`${steps[index][0]} failed: ${result.reason?.message}`);
      });
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

/**
 * Whether the database answers a ping right now (used by /api/health). Never
 * throws and never reveals why it failed.
 */
async function isDatabaseReachable() {
  try {
    await connectDB();
    await mongoose.connection.db.admin().ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = connectDB;
module.exports.isDatabaseReachable = isDatabaseReachable;
