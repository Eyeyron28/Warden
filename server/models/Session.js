const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema({
  sessionIdHash: {
    type: String,
    required: true,
    unique: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  wrappedDEK: {
    type: String,
    required: true,
  },
  wrappedDEKIv: {
    type: String,
    required: true,
  },
  wrappedDEKAuthTag: {
    type: String,
    required: true,
  },
  deviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Device', default: null, index: true },
  emergency: { type: Boolean, default: false, index: true },
  accessId: { type: mongoose.Schema.Types.ObjectId, default: null },
  requestId: { type: mongoose.Schema.Types.ObjectId, default: null },
  scopePaths: { type: [String], default: undefined },
  scopeMode: { type: String, enum: ['all', 'folders', null], default: null },
  absoluteExpiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  expiresAt: {
    type: Date,
    required: true,
  },
});

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('Session', sessionSchema);
