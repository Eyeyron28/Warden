const crypto = require('crypto');
const mongoose = require('mongoose');

/**
 * Builds the indexes the models declare - ONCE per set of indexes, not on every cold start.
 *
 * Mongoose's own automatic index build (autoIndex) sends a createIndex for every index of every model each time a server
 * instance starts: about fifty commands on every serverless cold start, sharing the small connection pool with the first
 * real requests. Instead, config/db.js turns autoIndex off and this migration does the same work when - and only when -
 * the declared indexes changed: a marker named after a hash of every model's index definitions says "these exact indexes
 * were built". An ordinary start therefore costs one read. Adding or changing an index in a model changes the hash, so the
 * next start builds it (createIndexes is idempotent, so two instances starting together is harmless), then writes the marker.
 *
 * Unique and TTL indexes (an email, a share id, a code's expiry) are part of what is built here, exactly as before.
 */

function indexSignature(models) {
  const parts = models
    .map((model) => [model.collection.name, ...model.schema.indexes().map(([fields, options]) => JSON.stringify([fields, options]))].join('|'))
    .sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

async function migrateIndexes() {
  const models = Object.values(mongoose.models);
  const id = `indexes-${indexSignature(models)}`;
  const migrations = mongoose.connection.db.collection('migrations');
  if (await migrations.findOne({ _id: id })) return { built: false, id };
  // eslint-disable-next-line no-restricted-syntax
  await Promise.all(models.map((model) => model.createIndexes()));
  await migrations.updateOne({ _id: id }, { $setOnInsert: { at: new Date() } }, { upsert: true });
  return { built: true, id };
}

module.exports = { migrateIndexes, indexSignature };
