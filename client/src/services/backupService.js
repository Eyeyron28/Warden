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
 * @returns {Promise<{ documentsImported: number, documentsSkipped: number, timestamp: string, note: string }>}
 */
export async function importBackup(sourcePath) {
  const { data } = await api.post('/backup/import', { sourcePath });
  return data;
}
