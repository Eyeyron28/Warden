// A LOCAL, THROWAWAY MongoDB for the few tests that need real atomic updates (the in-memory fakes cannot race).
//
// The address is explicit: WARDEN_TEST_MONGO, or a local replica set on 127.0.0.1:27099. Each test file gets its own
// database name and drops it when it finishes. It refuses any address that is not local, so a test can never touch
// Atlas or another real database, and it never reads an .env file. When no local MongoDB answers, the tests that use
// it are SKIPPED (with the reason), not failed.
const mongoose = require('mongoose');

const DEFAULT_URI = 'mongodb://127.0.0.1:27099/?replicaSet=rs0&directConnection=true';

function isLocal(uri) {
  return /^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(uri);
}

/** The explicit address of this test file's throwaway database, or null when WARDEN_TEST_MONGO is not a local one. */
function throwawayUri(name) {
  const base = process.env.WARDEN_TEST_MONGO || DEFAULT_URI;
  if (!isLocal(base)) return null;
  return base.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, `$1/warden_test_${name}`);
}

/** Connects to a throwaway database named for this test file. Resolves { ok, reason }. */
async function connectThrowaway(name) {
  const uri = throwawayUri(name);
  if (!uri) return { ok: false, reason: 'WARDEN_TEST_MONGO must point at a local MongoDB' };
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 2500 });
    await mongoose.connection.dropDatabase();
    return { ok: true, reason: '' };
  } catch (err) {
    return { ok: false, reason: `no local MongoDB answered (${String(err.message).slice(0, 60)})` };
  }
}

async function disconnectThrowaway() {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}

module.exports = { connectThrowaway, disconnectThrowaway, throwawayUri, mongoose };
