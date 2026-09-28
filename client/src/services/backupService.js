import api from './api.js';

/**
 * GET /api/backup/status
 * @returns {Promise<{ lastBackupAt: string|null, documentCount: number|null, backupPath: string|null }>}
 */
export async function getBackupStatus() {
  const { data } = await api.get('/backup/status');
  return data;
}

/**
 * POST /api/backup/export
 * @param {string} targetPath
 * @param {string} usbPassphrase - sets/refreshes this backup's USB
 *   recovery passphrase (see POST /api/auth/recover-via-usb)
 * @returns {Promise<{ documentsBackedUp: number, backupPath: string, timestamp: string }>}
 */
export async function exportBackup(targetPath, usbPassphrase) {
  const { data } = await api.post('/backup/export', { targetPath, usbPassphrase });
  return data;
}

/**
 * POST /api/backup/import
 * @param {string} sourcePath
 * @param {string} [password] - only required when restoring onto a fresh
 *   install (no vault set up yet) - see backup.controller.js importBackup.
 *   Omitted entirely for a restore into an already-unlocked vault, which
 *   verifies the backup a different way (dekFingerprint, not a password).
 * @returns {Promise<{
 *   documentsImported: number,
 *   documentsSkipped: number,
 *   timestamp: string,
 *   note: string,
 *   sessionToken?: string,
 * }>} `sessionToken` is present only for a fresh-install restore - there
 *   was no session to have beforehand, so the caller needs one to enter
 *   the vault, same as setupVault/recoverVault.
 */
export async function importBackup(sourcePath, password) {
  const { data } = await api.post('/backup/import', { sourcePath, password });
  return data;
}
