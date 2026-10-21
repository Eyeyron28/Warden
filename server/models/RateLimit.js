const mongoose = require('mongoose');

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
