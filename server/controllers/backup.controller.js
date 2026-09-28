const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const Document = require('../models/Document');
const User = require('../models/User');
const BackupLog = require('../models/BackupLog');
const { generateSalt, deriveEncryptionKey, wrapKey, unwrapKey, fingerprintDEK } = require('../utils/crypto');
const { createSession } = require('../utils/sessionStore');

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
// the User key material a restore now depends on.
const CURRENT_MANIFEST_VERSION = 2;

// Present only on a v2+ manifest, and only needed to rebuild the User
// record from scratch on a fresh install (see importBackup) - an
// existing-vault restore never touches these, it only compares
// dekFingerprint (checked separately, since it's needed by both branches).
const REQUIRED_MANIFEST_USER_FIELDS = [
  'passwordHash',
  'salt',
  'recoveryKeyHash',
  'wrappedDEKPassword',
  'wrappedDEKPasswordIv',
  'wrappedDEKPasswordAuthTag',
  'wrappedDEKRecovery',
  'wrappedDEKRecoveryIv',
  'wrappedDEKRecoveryAuthTag',
];

function oldManifestError() {
  const error = new Error(
    'This backup was made by an older version of Warden and does not include the key material a safe restore now needs. It cannot be restored automatically.'
  );
  error.status = 400;
  return error;
}

function vaultMismatchError() {
  const error = new Error(
    'This backup belongs to a different vault and cannot be imported here - doing so would leave documents this vault can never decrypt. Import aborted.'
  );
  error.status = 409;
  return error;
}

function wrongBackupPasswordError() {
  const error = new Error('Incorrect password for this backup.');
  error.status = 401;
  return error;
}

/**
 * POST /api/backup/export
 * Body: { targetPath, usbPassphrase }
 *
 * Copies every document's already-encrypted blob (plus its iv/authTag/
 * checksum) into targetPath/warden-backup, one JSON file per document,
 * alongside a tamper-evident manifest. Nothing is decrypted or
 * re-encrypted here - the export is exactly as unreadable as the live
 * vault, which is the whole point of backing up ciphertext-at-rest: a
 * copied USB drive is useless without the master password, no separate
 * pairing or key exchange required.
 *
 * Also wraps a COPY of the vault's DEK under a key derived from
 * `usbPassphrase` (same wrap-the-DEK pattern as the password/recovery-key/
 * phone-PIN KEKs on User and PairedDevice) and writes it into the
 * manifest as wrappedDEKUsb* - this is what lets POST
 * /api/auth/recover-via-usb reset the master password later using only
 * this backup folder and the passphrase, without the DEK ever touching
 * disk unencrypted. The manifest's existing tamper-evidence checksum
 * (below) covers these new fields automatically, since it hashes
 * whatever manifestBody ends up containing.
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

  const user = await User.findOne();
  if (!user) {
    const error = new Error('The vault has not been set up yet.');
    error.status = 404;
    throw error;
  }
  // Same lazy backfill as unlock/recover (auth.controller.js) - a vault
  // that predates dekFingerprint won't have one yet, and req.session.
  // encryptionKey (available here - this route is behind requireSession)
  // is the real, live DEK to backfill it from.
  if (!user.dekFingerprint) {
    user.dekFingerprint = fingerprintDEK(req.session.encryptionKey);
    await user.save();
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
          mimeType: doc.mimeType,
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

  // A COPY of the vault's DEK, wrapped under a key derived from
  // usbPassphrase - never the raw DEK. req.session.encryptionKey is the
  // live DEK, available here because this route is behind requireSession
  // (routes/backup.routes.js), same as every other place in this app
  // that reads it.
  const usbSalt = generateSalt();
  const usbKek = deriveEncryptionKey(usbPassphrase, usbSalt);
  const wrappedUsb = wrapKey(req.session.encryptionKey, usbKek);

  // Tamper-evidence: hash the manifest's own content (everything except
  // the checksum field) and store the hash alongside it. Editing the
  // manifest afterward - by hand or by a corrupted copy - won't match a
  // recomputed hash of the remaining fields, so tampering (including of
  // the wrapped DEK fields below) is detectable without needing to
  // re-check every document file.
  const manifestBody = {
    manifestVersion: CURRENT_MANIFEST_VERSION,
    timestamp,
    documentCount: documents.length,
    backupPath: backupDir,
    // Every wrapped-DEK-related field currently on User, so a restore -
    // onto a fresh install, or checked against an existing vault - has
    // everything it needs (see importBackup). Without these, restoring
    // onto a fresh install could only ever generate a brand-new random
    // DEK, and every restored document would fail its authTag check
    // forever: it was encrypted under the OLD DEK, which would no longer
    // exist anywhere.
    passwordHash: user.passwordHash,
    salt: user.salt,
    recoveryKeyHash: user.recoveryKeyHash,
    wrappedDEKPassword: user.wrappedDEKPassword,
    wrappedDEKPasswordIv: user.wrappedDEKPasswordIv,
    wrappedDEKPasswordAuthTag: user.wrappedDEKPasswordAuthTag,
    wrappedDEKRecovery: user.wrappedDEKRecovery,
    wrappedDEKRecoveryIv: user.wrappedDEKRecoveryIv,
    wrappedDEKRecoveryAuthTag: user.wrappedDEKRecoveryAuthTag,
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

  await BackupLog.create({ documentCount: documents.length, backupPath: backupDir });

  res.status(200).json({
    documentsBackedUp: documents.length,
    backupPath: backupDir,
    timestamp,
  });
});

/**
 * POST /api/backup/import
 * Body: { sourcePath, password? }
 *
 * Restores documents from a warden-backup folder (produced by
 * POST /api/backup/export) into a vault. Nothing is decrypted during
 * import - the restored rows carry whatever ciphertext, iv, and authTag
 * the backup had.
 *
 * Two very different situations reach this handler, distinguished purely
 * by whether a User document already exists (see routes/backup.routes.js
 * for how a fresh install even reaches this route without a session at
 * all):
 *
 * - Fresh install (no User yet): there's no DEK anywhere yet either, so
 *   restoring documents encrypted under the ORIGINAL vault's DEK requires
 *   rebuilding that vault's key material from the manifest first - see
 *   CURRENT_MANIFEST_VERSION and REQUIRED_MANIFEST_USER_FIELDS. `password`
 *   is required here, and is verified by actually unwrapping the
 *   manifest's wrappedDEKPassword with it BEFORE anything is written -
 *   same verify-before-write discipline as every other recovery flow in
 *   this app (POST /api/auth/recover-via-usb and friends).
 * - Existing vault: the current live DEK (req.session.encryptionKey) is
 *   already known and is never replaced or re-derived. The manifest's
 *   dekFingerprint is compared against this vault's - a mismatch means
 *   this backup is from a DIFFERENT vault, and the import is refused
 *   outright rather than mixing in documents this vault could never
 *   decrypt (the bug this fix closes).
 */
const importBackup = asyncHandler(async (req, res) => {
  const { sourcePath, password } = req.body;

  if (!sourcePath || typeof sourcePath !== 'string') {
    throw badRequest('A sourcePath is required.');
  }
  if (password !== undefined && typeof password !== 'string') {
    throw badRequest('password must be a string.');
  }

  const manifestPath = await assertBackupSource(sourcePath);

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  } catch (err) {
    throw badRequest(`Could not read backup-manifest.json: ${err.message}`);
  }

  // Recompute the manifest's own tamper-evidence hash (see exportBackup)
  // and reject the whole import before touching the vault if it doesn't
  // match - a corrupted or edited manifest means the document files next
  // to it can't be trusted either.
  const { checksum: storedChecksum, ...manifestBody } = manifest;
  const recomputedChecksum = crypto.createHash('sha256').update(JSON.stringify(manifestBody)).digest('hex');

  if (!storedChecksum || recomputedChecksum !== storedChecksum) {
    throw badRequest('This backup appears corrupted or tampered with (manifest checksum mismatch). Import aborted.');
  }

  // Old-format manifest (predates this fix): refuse outright rather than
  // attempt a restore with no key material to rebuild a fresh install's
  // vault from, or no dekFingerprint to check an existing vault against.
  if (manifest.manifestVersion !== CURRENT_MANIFEST_VERSION) {
    throw oldManifestError();
  }
  // Guaranteed present on any manifest that legitimately carries this
  // version (exportBackup always writes it, backfilling first if
  // needed) - a v2-tagged manifest missing it is malformed the same way
  // an old one is.
  if (typeof manifest.dekFingerprint !== 'string' || !manifest.dekFingerprint) {
    throw oldManifestError();
  }

  const existingUser = await User.findOne();
  let dek;

  if (existingUser) {
    // Existing vault: never touch its key material, only compare
    // fingerprints. req.session.encryptionKey IS the current vault's
    // real, live DEK (present - this branch is only reached once
    // requireSession has already run), so no unwrap or password is
    // needed here at all - only whether this backup's DEK is the SAME
    // DEK, not a foreign one from a different Warden installation.
    dek = req.session.encryptionKey;
    const currentFingerprint = existingUser.dekFingerprint || fingerprintDEK(dek);
    if (!existingUser.dekFingerprint) {
      existingUser.dekFingerprint = currentFingerprint;
      await existingUser.save();
    }
    if (manifest.dekFingerprint !== currentFingerprint) {
      throw vaultMismatchError();
    }
  } else {
    // Fresh install: no User yet, so no session was possible - this is
    // the one state in which routes/backup.routes.js lets this route
    // through without requireSession at all.
    if (!password) {
      throw badRequest('This backup\'s master password is required to restore it onto a fresh install.');
    }
    if (!REQUIRED_MANIFEST_USER_FIELDS.every((field) => typeof manifest[field] === 'string' && manifest[field])) {
      throw oldManifestError();
    }

    try {
      const passwordKek = deriveEncryptionKey(password, manifest.salt);
      dek = unwrapKey(
        manifest.wrappedDEKPassword,
        passwordKek,
        manifest.wrappedDEKPasswordIv,
        manifest.wrappedDEKPasswordAuthTag
      );
    } catch {
      throw wrongBackupPasswordError();
    }

    // Only now, after the password has actually proved correct, is
    // anything written - same verify-before-write discipline as every
    // other recovery flow in this app.
    await User.create({
      passwordHash: manifest.passwordHash,
      salt: manifest.salt,
      recoveryKeyHash: manifest.recoveryKeyHash,
      wrappedDEKPassword: manifest.wrappedDEKPassword,
      wrappedDEKPasswordIv: manifest.wrappedDEKPasswordIv,
      wrappedDEKPasswordAuthTag: manifest.wrappedDEKPasswordAuthTag,
      wrappedDEKRecovery: manifest.wrappedDEKRecovery,
      wrappedDEKRecoveryIv: manifest.wrappedDEKRecoveryIv,
      wrappedDEKRecoveryAuthTag: manifest.wrappedDEKRecoveryAuthTag,
      dekFingerprint: manifest.dekFingerprint,
    });
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

  const existingDocuments = await Document.find({}, 'checksum');
  const existingChecksums = new Set(existingDocuments.map((doc) => doc.checksum));

  let documentsImported = 0;
  let documentsSkipped = 0;

  for (const record of backupRecords) {
    if (existingChecksums.has(record.checksum)) {
      documentsSkipped += 1;
      continue;
    }

    await Document.create({
      filename: record.filename,
      folder: record.folder,
      encryptedBlob: Buffer.from(record.encryptedBlob, 'base64'),
      iv: record.iv,
      authTag: record.authTag,
      checksum: record.checksum,
      mimeType: record.mimeType,
      createdAt: record.createdAt,
      originDevice: 'restored',
      syncStatus: 'synced',
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
    note: existingUser
      ? 'This backup was verified to belong to this vault, so every restored document decrypts normally.'
      : "This backup's key material was restored along with your documents - everything decrypts normally with the password you just entered.",
    // Only present on a fresh-install restore: there was no session to
    // have beforehand, so the caller needs one to actually enter the
    // vault, same as POST /api/auth/setup and every recovery endpoint.
    ...(existingUser ? {} : { sessionToken: createSession(dek) }),
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
  importBackup,
  getStatus,
};
