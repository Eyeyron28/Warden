const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const Document = require('../models/Document');
const { assertCanStore } = require('../utils/storage');
const { cleanStoredName } = require('../utils/fileNames');
const User = require('../models/User');
const BackupLog = require('../models/BackupLog');
const { serializeThumbnail, restoreThumbnail } = require('../utils/thumbnails');
const { generateSalt, deriveEncryptionKey, wrapKey, fingerprintDEK } = require('../utils/crypto');
const { ensureFolderPath, toDocumentFolder } = require('../utils/folders');

const MIN_USB_PASSPHRASE_LENGTH = 4; // same floor as the phone pairing PIN

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
 *
 * NOTE (multi-user): targetPath/sourcePath are paths on whatever machine
 * this Express process is running on - fine for local dev, but this
 * won't work once genuinely deployed to a serverless host with no
 * persistent/user-controllable filesystem. That redesign (stream the
 * backup to/from the browser instead of a server-local path) was
 * explicitly deferred; this prompt only adds the userId scoping below.
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
 * Confirms sourcePath exists, is a directory, and actually contains a
 * backup-manifest.json - i.e. it looks like a warden-backup folder rather
 * than an arbitrary directory. Returns the manifest's path for the caller
 * to read.
 */
async function assertBackupSource(sourcePath) {
  let stats;
  try {
    stats = await fs.stat(sourcePath);
  } catch {
    throw badRequest(
      `Source path "${sourcePath}" does not exist. Check that the drive is connected and the path is correct.`
    );
  }

  if (!stats.isDirectory()) {
    throw badRequest(`Source path "${sourcePath}" is not a directory.`);
  }

  const manifestPath = path.join(sourcePath, 'backup-manifest.json');

  try {
    await fs.access(manifestPath, fs.constants.R_OK);
  } catch {
    throw badRequest(
      `Source path "${sourcePath}" does not contain a backup-manifest.json - this doesn't look like a Warden backup folder.`
    );
  }

  return manifestPath;
}

const REQUIRED_BACKUP_RECORD_FIELDS = [
  'filename',
  'folder',
  'encryptedBlob',
  'iv',
  'authTag',
  'checksum',
  'mimeType',
  'createdAt',
];

/**
 * A per-document backup file is only trustworthy if it has every field the
 * restore path depends on. Anything less and the import is aborted rather
 * than silently skipped or partially applied - see importBackup.
 */
function isValidBackupRecord(record) {
  return (
    record &&
    typeof record === 'object' &&
    REQUIRED_BACKUP_RECORD_FIELDS.every(
      // encryptedBlob may legitimately be an empty string: a 0-byte file
      // encrypts to an empty ciphertext (its integrity proof is authTag).
      (field) =>
        typeof record[field] === 'string' && (field === 'encryptedBlob' || record[field].length > 0)
    )
  );
}

// manifestVersion introduced alongside the fields below - a manifest
// without it (or below it) predates the DEK-wrapping fix and doesn't carry
// the dekFingerprint a restore now depends on to confirm it belongs to
// this account.
const CURRENT_MANIFEST_VERSION = 2;

function oldManifestError() {
  const error = new Error(
    'This backup was made by an older version of Warden and does not include the key material a safe restore now needs. It cannot be restored automatically.'
  );
  error.status = 400;
  return error;
}

function accountMismatchError() {
  const error = new Error(
    'This backup belongs to a different account and cannot be imported here - doing so would leave documents this account can never decrypt. Import aborted.'
  );
  error.status = 409;
  return error;
}

/**
 * POST /api/backup/export
 * requireSession. Body: { targetPath, usbPassphrase }
 *
 * Copies every document's already-encrypted blob (plus its iv/authTag/
 * checksum) belonging to THIS account into targetPath/warden-backup, one
 * JSON file per document, alongside a tamper-evident manifest. Nothing is
 * decrypted or re-encrypted here - the export is exactly as unreadable as
 * the live account, which is the whole point of backing up ciphertext-
 * at-rest: a copied USB drive is useless without the master password, no
 * separate pairing or key exchange required.
 *
 * Also wraps a COPY of the account's DEK under a key derived from
 * `usbPassphrase` (same wrap-the-DEK pattern as the password/recovery-key
 * KEKs on User) and writes it into the manifest as wrappedDEKUsb* - this
 * is what POST /api/auth/recover-via-usb used to read before it was
 * temporarily disabled (see auth.controller.js) pending its own
 * multi-user redesign; the field is still written here so an existing
 * backup folder's shape doesn't change out from under that future work.
 */
const exportBackup = asyncHandler(async (req, res) => {
  const { targetPath, usbPassphrase } = req.body;

  if (!targetPath || typeof targetPath !== 'string') {
    throw badRequest('A targetPath is required.');
  }
  if (
    !usbPassphrase ||
    typeof usbPassphrase !== 'string' ||
    usbPassphrase.length < MIN_USB_PASSPHRASE_LENGTH
  ) {
    throw badRequest(`A USB recovery passphrase of at least ${MIN_USB_PASSPHRASE_LENGTH} characters is required.`);
  }

  const user = await User.findById(req.userId);
  if (!user) {
    const error = new Error('Account not found.');
    error.status = 404;
    throw error;
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

  const documents = await Document.find({ userId: req.userId, deletedAt: null });

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
          mimeType: doc.mimeType,
          createdAt: doc.createdAt,
          // Optional, still-encrypted preview, so a restore keeps it. Not in
          // REQUIRED_BACKUP_RECORD_FIELDS: older backups without one stay valid.
          ...serializeThumbnail(doc),
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

  // A COPY of the account's DEK, wrapped under a key derived from
  // usbPassphrase - never the raw DEK. req.dek is the live DEK, available
  // here because this route is behind requireSession (routes/
  // backup.routes.js), same as every other place in this app that reads it.
  const usbSalt = generateSalt();
  const usbKek = deriveEncryptionKey(usbPassphrase, usbSalt);
  const wrappedUsb = wrapKey(req.dek, usbKek);

  // Tamper-evidence: hash the manifest's own content (everything except
  // the checksum field) and store the hash alongside it. Editing the
  // manifest afterward - by hand or by a corrupted copy - won't match a
  // recomputed hash of the remaining fields, so tampering is detectable
  // without needing to re-check every document file.
  const manifestBody = {
    manifestVersion: CURRENT_MANIFEST_VERSION,
    timestamp,
    documentCount: documents.length,
    backupPath: backupDir,
    dekFingerprint: user.dekFingerprint,
    wrappedDEKUsb: wrappedUsb.wrappedKey,
    wrappedDEKUsbIv: wrappedUsb.iv,
    wrappedDEKUsbAuthTag: wrappedUsb.authTag,
    wrappedDEKUsbSalt: usbSalt,
  };
  const checksum = crypto.createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');
  const manifest = { ...manifestBody, checksum };

  await fs.writeFile(
    path.join(backupDir, 'backup-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  await BackupLog.create({ userId: req.userId, documentCount: documents.length, backupPath: backupDir });

  res.status(200).json({
    documentsBackedUp: documents.length,
    backupPath: backupDir,
    timestamp,
  });
});

/**
 * POST /api/backup/import
 * requireSession. Body: { sourcePath }
 *
 * Restores documents from a warden-backup folder (produced by
 * POST /api/backup/export) into the CURRENTLY LOGGED-IN account. Nothing
 * is decrypted during import - the restored rows carry whatever
 * ciphertext, iv, and authTag the backup had.
 *
 * The old single-vault version of this route had a second, unauthenticated
 * "fresh install" branch (no User existed yet, so a password in the
 * request body proved ownership instead of a session). That branch is
 * retired here: in a multi-user account there is no longer a meaningful
 * "the one vault doesn't exist yet" state to detect - there are simply
 * other people's accounts, which must never be reachable without a
 * session. Restoring a backup now always means "add these documents to
 * MY already-logged-in account," checked the same way an existing-vault
 * restore always was: req.dek is the real, live DEK for this session (no
 * unwrap/password needed), and the manifest's dekFingerprint is compared
 * against it - a mismatch means this backup is from a DIFFERENT account,
 * refused outright rather than mixing in documents this account could
 * never decrypt.
 */
const importBackup = asyncHandler(async (req, res) => {
  const { sourcePath } = req.body;

  if (!sourcePath || typeof sourcePath !== 'string') {
    throw badRequest('A sourcePath is required.');
  }

  const user = await User.findById(req.userId);
  if (!user) {
    const error = new Error('Account not found.');
    error.status = 404;
    throw error;
  }

  const manifestPath = await assertBackupSource(sourcePath);

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw badRequest(`Could not read backup-manifest.json: ${err.message}`);
  }

  // Recompute the manifest's own tamper-evidence hash (see exportBackup)
  // and reject the whole import before touching anything if it doesn't
  // match - a corrupted or edited manifest means the document files next
  // to it can't be trusted either.
  const { checksum: storedChecksum, ...manifestBody } = manifest;
  const recomputedChecksum = crypto.createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');

  if (!storedChecksum || recomputedChecksum !== storedChecksum) {
    throw badRequest('This backup appears corrupted or tampered with (manifest checksum mismatch). Import aborted.');
  }

  if (manifest.manifestVersion !== CURRENT_MANIFEST_VERSION) {
    throw oldManifestError();
  }
  if (typeof manifest.dekFingerprint !== 'string' || !manifest.dekFingerprint) {
    throw oldManifestError();
  }

  const currentFingerprint = user.dekFingerprint || fingerprintDEK(req.dek);
  if (!user.dekFingerprint) {
    user.dekFingerprint = currentFingerprint;
    await user.save();
  }
  if (manifest.dekFingerprint !== currentFingerprint) {
    throw accountMismatchError();
  }

  const entries = await fs.readdir(sourcePath);
  const documentFileNames = entries.filter((name) => name.endsWith('.json') && name !== 'backup-manifest.json');

  const backupRecords = [];
  for (const fileName of documentFileNames) {
    let record;
    try {
      record = JSON.parse(await fs.readFile(path.join(sourcePath, fileName), 'utf8'));
    } catch (err) {
      throw badRequest(`Could not read backup file "${fileName}": ${err.message}. Import aborted.`);
    }

    if (!isValidBackupRecord(record)) {
      throw badRequest(`Backup file "${fileName}" is missing required fields. Import aborted.`);
    }

    backupRecords.push(record);
  }

  const existingDocuments = await Document.find({ userId: req.userId, deletedAt: null }, 'checksum');
  const existingChecksums = new Set(existingDocuments.map((doc) => doc.checksum));

  let documentsImported = 0;
  let documentsSkipped = 0;

  for (const record of backupRecords) {
    if (existingChecksums.has(record.checksum)) {
      documentsSkipped += 1;
      continue;
    }

    await assertCanStore(req.userId, Math.floor((record.encryptedBlob.length * 3) / 4));
    await Document.create({
      userId: req.userId,
      filename: cleanStoredName(record.filename),
      folder: toDocumentFolder(await ensureFolderPath(req.userId, record.folder)),
      encryptedBlob: Buffer.from(record.encryptedBlob, 'base64'),
      iv: record.iv,
      authTag: record.authTag,
      checksum: record.checksum,
      mimeType: record.mimeType,
      createdAt: record.createdAt,
      originDevice: 'restored',
      syncStatus: 'synced',
      ...restoreThumbnail(record),
    });

    // Prevents re-importing the same document twice within one import run
    // if the backup folder happens to contain a duplicate file.
    existingChecksums.add(record.checksum);
    documentsImported += 1;
  }

  res.status(200).json({
    documentsImported,
    documentsSkipped,
    timestamp: new Date().toISOString(),
    note: 'This backup was verified to belong to this account, so every restored document decrypts normally.',
  });
});

/**
 * GET /api/backup/status
 * requireSession.
 */
const getStatus = asyncHandler(async (req, res) => {
  const lastBackup = await BackupLog.findOne({ userId: req.userId }).sort({ createdAt: -1 });

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
  importBackup,
  getStatus,
};
