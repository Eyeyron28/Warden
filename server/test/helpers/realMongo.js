const mongoose = require('mongoose');

const DEFAULT_URI = 'mongodb://127.0.0.1:27099/?replicaSet=rs0&directConnection=true';

function isLocal(uri) {
  return /^mongodb:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//.test(uri);
}

function throwawayUri(name) {
  const base = process.env.WARDEN_TEST_MONGO || DEFAULT_URI;
  if (!isLocal(base)) return null;
  return base.replace(/^(mongodb:\/\/[^/]+)\/[^?]*/, `$1/warden_test_${name}`);
}

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
