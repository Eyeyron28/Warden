import api from './api.js';

/**
 * GET /api/trash
 * @returns {Promise<{ retentionDays: number, items: Array<{
 *   kind: 'file' | 'folder', id: string, name: string, originalLocation: string,
 *   itemCount: number, size: number, sniffedType: string | null, hasThumb: boolean,
 *   deletedAt: string, purgeAt: string, daysLeft: number }> }>}
 */
export async function listTrash() {
  const { data } = await api.get('/trash');
  return data;
}

/**
 * POST /api/trash/restore - back to the original folder, or to the top level
 * with a `message` when that folder is gone or the name is taken. A 409
 * (NAME_EXISTS / FOLDER_EXISTS) means the top level has that name too.
 * @returns {Promise<{ restoredTo: string, message: string | null }>}
 */
export async function restoreTrashItem(kind, id) {
  const { data } = await api.post('/trash/restore', { kind, id });
  return data;
}

/** DELETE /api/trash/:kind/:id - permanently, including the encrypted data. */
export async function deleteTrashItem(kind, id) {
  await api.delete(`/trash/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
}

/** DELETE /api/trash - permanently deletes everything in Trash. */
export async function emptyTrash() {
  const { data } = await api.delete('/trash');
  return data;
}
