const mongoose = require('mongoose');

// One Emergency Access setup per account. See utils/emergency/config.js for the security model.
//
// What is stored: the DEK wrapped under E (E = K1 XOR K2), the server's half K2, and a salted hash of the contact's
// half K1 (to check a presented kit in constant time). K1 itself is shown to the owner once and is never stored.
const emergencyAccessSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  contactEmail: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
  contactLabel: { type: String, default: '', maxlength: 60 },
  waitMinutes: { type: Number, required: true },
  // { mode: 'all' } or { mode: 'folders', folderIds: [Folder _id] }. Enforced by the server, not by cryptography.
  scope: {
    mode: { type: String, enum: ['all', 'folders'], required: true },
    folderIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  wrappedDek: { type: String, required: true }, // AES-256-GCM of the DEK under E
  wrappedDekIv: { type: String, required: true },
  wrappedDekAuthTag: { type: String, required: true },
  k2: { type: Buffer, required: true }, // the server's half, 32 bytes
  kitHash: { type: String, required: true }, // hex SHA-256(K1 || salt)
  kitSalt: { type: String, required: true }, // hex, per record
  kitVersion: { type: Number, default: 1 },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('EmergencyAccess', emergencyAccessSchema);
