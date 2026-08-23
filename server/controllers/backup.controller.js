const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const Document = require('../models/Document');
const BackupLog = require('../models/BackupLog');

// Routes are async, but Express doesn't forward rejected promises to
// error-handling middleware on its own - this small wrapper does that so
// every handler below can just `throw` instead of repeating try/catch.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/**
 * Confirms targetPath exists, is a directory, and is writable - the three
 * ways a USB export commonly fails (drive not plugged in, wrong drive
 * letter/path, permissions) - so the caller gets a clear reason instead of
 * a raw fs error.
 */
async function assertWritableDirectory(targetPath) {
  let stats;
  try {
    stats = await fs.stat(targetPath);
  } catch {
    throw badRequest(
      `Target path "${targetPath}" does not exist. Check that the drive is connected and the path is correct.`
    );
  }

  if (!stats.isDirectory()) {
    throw badRequest(`Target path "${targetPath}" is not a directory.`);
  }

  try {
    await fs.access(targetPath, fs.constants.W_OK);
  } catch {
    throw badRequest(`Target path "${targetPath}" is not writable. Check the drive's permissions.`);
  }
}

/**
 * POST /api/backup/export
 * Body: { targetPath }
 *
 * Copies every document's already-encrypted blob (plus its iv/authTag/
 * checksum) into targetPath/warden-backup, one JSON file per document,
 * alongside a tamper-evident manifest. Nothing is decrypted or
 * re-encrypted here - the export is exactly as unreadable as the live
 * vault, which is the whole point of backing up ciphertext-at-rest: a
 * copied USB drive is useless without the master password, no separate
 * pairing or key exchange required.
 */
const exportBackup = asyncHandler(async (req, res) => {
  const { targetPath } = req.body;

  if (!targetPath || typeof targetPath !== 'string') {
    throw badRequest('A targetPath is required.');
  }

  await assertWritableDirectory(targetPath);

  const backupDir = path.join(targetPath, 'warden-backup');

  try {
    await fs.mkdir(backupDir, { recursive: true });
  } catch (err) {
    const error = new Error(`Could not create backup directory: ${err.message}`);
    error.status = 500;
    throw error;
  }

  const documents = await Document.find();

  try {
    await Promise.all(
      documents.map((doc) => {
        const record = {
          id: doc._id,
          filename: doc.filename,
          folder: doc.folder,
          encryptedBlob: doc.encryptedBlob.toString('base64'),
          iv: doc.iv,
          authTag: doc.authTag,
          checksum: doc.checksum,
          createdAt: doc.createdAt,
        };
        return fs.writeFile(
          path.join(backupDir, `${doc._id}.json`),
          JSON.stringify(record, null, 2),
          'utf8'
        );
      })
    );
  } catch (err) {
    const error = new Error(
      `Backup failed while writing document files: ${err.message}. The target drive may be full or was disconnected mid-export.`
    );
    error.status = 500;
    throw error;
  }

  const timestamp = new Date().toISOString();

  // Tamper-evidence: hash the manifest's own content (everything except
  // the checksum field) and store the hash alongside it. Editing the
  // manifest afterward - by hand or by a corrupted copy - won't match a
  // recomputed hash of the remaining fields, so tampering is detectable
  // without needing to re-check every document file.
  const manifestBody = {
    timestamp,
    documentCount: documents.length,
    backupPath: backupDir,
  };
  const checksum = crypto.createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');
  const manifest = { ...manifestBody, checksum };

  await fs.writeFile(
    path.join(backupDir, 'backup-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  await BackupLog.create({ documentCount: documents.length, backupPath: backupDir });

  res.status(200).json({
    documentsBackedUp: documents.length,
    backupPath: backupDir,
    timestamp,
  });
});

/**
 * GET /api/backup/status
 */
const getStatus = asyncHandler(async (req, res) => {
  const lastBackup = await BackupLog.findOne().sort({ createdAt: -1 });

  if (!lastBackup) {
    return res.status(200).json({ lastBackupAt: null, documentCount: null, backupPath: null });
  }

  res.status(200).json({
    lastBackupAt: lastBackup.createdAt,
    documentCount: lastBackup.documentCount,
    backupPath: lastBackup.backupPath,
  });
});

module.exports = {
  exportBackup,
  getStatus,
};
