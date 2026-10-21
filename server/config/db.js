const mongoose = require('mongoose');

let connectionPromise = null;

mongoose.set('autoIndex', false);

const CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 30000,
  maxPoolSize: 5,
  minPoolSize: 0,
  maxIdleTimeMS: 30000,
};

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
      connectionPromise = null;
      console.error(`MongoDB connection error: ${err.message}`);
      throw err;
    });

  return connectionPromise;
}

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
