const mongoose = require('mongoose');

const Document = require('../models/Document');
const { recordEvent } = require('../utils/audit');
const { describeReasons, severityOf, SCANNER_VERSION } = require('../utils/fileScanner');
const { logSecurity } = require('../utils/securityLog');
const { codesOf } = require('../utils/quarantine');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

const RELEASE_WORD = 'RELEASE';

const HELD_PROJECTION = { filename: 1, folder: 1, createdAt: 1, scan: 1, quarantine: 1, size: { $binarySize: '$encryptedBlob' } };

const listHeld = asyncHandler(async (req, res) => {
  const rows = await Document.aggregate([
    { $match: { userId: req.userId, 'quarantine.state': 'held', deletedAt: null } },
    { $sort: { 'quarantine.heldAt': -1 } },
    { $project: HELD_PROJECTION },
  ]);
  const items = rows.map((doc) => ({
    id: doc._id,
    name: doc.filename,
    folder: doc.folder,
    size: doc.size ?? 0,
    createdAt: doc.createdAt,
    heldAt: doc.quarantine?.heldAt ?? doc.createdAt,
    severity: severityOf(doc.scan?.reasons),
    reasons: describeReasons(doc.scan?.reasons),
    scannerVersion: doc.scan?.scannerVersion ?? SCANNER_VERSION,
  }));
  res.status(200).json({ count: items.length, items });
});

const releaseHeld = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) throw fail(404, 'Document not found.');
  const typed = req.body && typeof req.body.confirm === 'string' ? req.body.confirm.trim() : '';
  if (typed !== RELEASE_WORD) throw fail(400, `Type ${RELEASE_WORD} to release this file.`, 'RELEASE_CONFIRM');

  const now = new Date();
  const document = await Document.findOneAndUpdate(
    { _id: id, userId: req.userId, deletedAt: null, 'quarantine.state': 'held' },
    { $set: { 'quarantine.state': 'released', 'quarantine.releasedAt': now } },
    { new: false, projection: { scan: 1 } }
  );
  if (!document) {
    throw fail(404, 'Held file not found.');
  }
  const codes = codesOf(document.scan?.reasons);
  logSecurity('file_released', { bucket: codes });
  await recordEvent(req, 'file_released', { targetId: document._id, detail: codes });
  res.status(200).json({ id: document._id, released: true });
});

module.exports = { listHeld, releaseHeld, RELEASE_WORD };
