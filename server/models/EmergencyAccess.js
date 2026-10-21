const mongoose = require('mongoose');

const emergencyAccessSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  contactEmail: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  contactLabel: { type: String, default: '', maxlength: 60 },
  waitMinutes: { type: Number, required: true },
  scope: {
    mode: { type: String, enum: ['all', 'folders'], required: true },
    folderIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  wrappedDek: { type: String, required: true },
  wrappedDekIv: { type: String, required: true },
  wrappedDekAuthTag: { type: String, required: true },
  k2: { type: Buffer, required: true },
  kitHash: { type: String, required: true },
  kitSalt: { type: String, required: true },
  kitVersion: { type: Number, default: 1 },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('EmergencyAccess', emergencyAccessSchema);
