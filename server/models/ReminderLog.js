const mongoose = require('mongoose');

const reminderLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  fileId: { type: mongoose.Schema.Types.ObjectId, required: true },
  threshold: { type: Number, required: true, enum: [60, 30, 7, 0] },
  sent: { type: Boolean, default: true },
  at: { type: Date, default: Date.now },
});

reminderLogSchema.index({ userId: 1, fileId: 1, threshold: 1 }, { unique: true });

module.exports = mongoose.model('ReminderLog', reminderLogSchema);
