import { openDB } from 'idb';

/**
 * The phone's local IndexedDB mirror of vault documents - proof that a
 * device can hold and read its own offline copy independently of the PC's
 * live API. Pure storage only: no network calls, no pairing/sync logic,
 * no encryption/decryption. `encryptedBlob` is stored exactly as handed
 * to `saveDocumentLocally` (typically an ArrayBuffer) and returned
 * unchanged - decrypting it is a separate concern for later, via the
 * browser's Web Crypto API.
 */

const DB_NAME = 'warden-local';
const DB_VERSION = 1;
const STORE_NAME = 'documents';

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    },
  });
}

/**
 * Saves (or overwrites, if `doc.id` already exists) one document's local
 * copy. Same field shape as the server's Document model - filename,
 * folder, expiryDate, encryptedBlob, iv, authTag, checksum, syncStatus -
 * plus `cachedAt`, this mirror's own bookkeeping for when the local copy
 * was written, stamped here rather than trusted from the caller.
 *
 * @param {{
 *   id: string,
 *   filename: string,
 *   folder: string,
 *   expiryDate?: string | null,
 *   encryptedBlob: ArrayBuffer | Blob,
 *   iv: string,
 *   authTag: string,
 *   checksum: string,
 *   syncStatus: string,
 * }} doc
 */
export async function saveDocumentLocally(doc) {
  const db = await getDB();
  await db.put(STORE_NAME, { ...doc, cachedAt: new Date().toISOString() });
}

/**
 * @returns {Promise<Array<object>>} every document currently cached locally
 */
export async function getAllLocalDocuments() {
  const db = await getDB();
  return db.getAll(STORE_NAME);
}

/**
 * @param {string} id
 * @returns {Promise<object | undefined>}
 */
export async function getLocalDocument(id) {
  const db = await getDB();
  return db.get(STORE_NAME, id);
}

/**
 * @param {string} id
 */
export async function deleteLocalDocument(id) {
  const db = await getDB();
  await db.delete(STORE_NAME, id);
}
