const crypto = require('crypto');
const mongoose = require('mongoose');

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
