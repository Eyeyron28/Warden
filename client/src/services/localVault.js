import { openDB } from 'idb';

/**
 * The phone's local IndexedDB layer - proof that a device can hold and
 * read its own offline data independently of the PC's live API. Pure
 * storage only: no network calls, no pairing/sync logic beyond saving
 * what a caller hands in, no encryption/decryption. Binary fields
 * (encryptedBlob, and the wrapped-DEK fields below) are stored exactly
 * as given and returned unchanged - decrypting/unwrapping them is a
 * separate concern for later, via the browser's Web Crypto API.
 *
 * Two object stores in one database:
 *   - "documents": the offline mirror of vault documents.
 *   - "deviceAuth": this phone's own pairing credentials (the DEK,
 *     wrapped under this phone's PIN) from POST /api/pair/complete -
 *     what a later local-unlock-with-PIN pass reads from, so the phone
 *     never has to send the master password again after pairing once.
 */

const DB_NAME = 'warden-local';
const DB_VERSION = 3;
const DOCUMENTS_STORE = 'documents';
const DEVICE_AUTH_STORE = 'deviceAuth';
const FOLDERS_STORE = 'folders';

function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(DOCUMENTS_STORE)) {
        db.createObjectStore(DOCUMENTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DEVICE_AUTH_STORE)) {
        db.createObjectStore(DEVICE_AUTH_STORE, { keyPath: 'deviceId' });
      }
      // Folder paths the phone knows about beyond what its documents imply
      // (i.e. empty folders): { name, syncStatus: 'synced' | 'pending' }.
      if (!db.objectStoreNames.contains(FOLDERS_STORE)) {
        db.createObjectStore(FOLDERS_STORE, { keyPath: 'name' });
      }
    },
  });
}

/** @returns {Promise<Array<{ name: string, syncStatus: string }>>} */
export async function getAllLocalFolders() {
  const db = await getDB();
  return db.getAll(FOLDERS_STORE);
}

/** @param {{ name: string, syncStatus: string }} folder */
export async function saveLocalFolder(folder) {
  const db = await getDB();
  await db.put(FOLDERS_STORE, folder);
}

/** @param {string} name */
export async function deleteLocalFolder(name) {
  const db = await getDB();
  await db.delete(FOLDERS_STORE, name);
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
  await db.put(DOCUMENTS_STORE, { ...doc, cachedAt: new Date().toISOString() });
}

/**
 * @returns {Promise<Array<object>>} every document currently cached locally
 */
export async function getAllLocalDocuments() {
  const db = await getDB();
  return db.getAll(DOCUMENTS_STORE);
}

/**
 * @param {string} id
 * @returns {Promise<object | undefined>}
 */
export async function getLocalDocument(id) {
  const db = await getDB();
  return db.get(DOCUMENTS_STORE, id);
}

/**
 * @param {string} id
 */
export async function deleteLocalDocument(id) {
  const db = await getDB();
  await db.delete(DOCUMENTS_STORE, id);
}

/**
 * Replaces a local-only document's record with its canonical server copy
 * after a successful sync push - IndexedDB's keyPath is fixed per record,
 * so "renaming" the id means deleting the old entry and inserting a new
 * one, done here as a single transaction so a mid-write failure can't
 * leave both the orphaned local-only copy and the new one behind.
 *
 * @param {string} localId - the old, locally-generated id to remove
 * @param {object} canonicalDoc - the full record to store under its new (real) id
 */
export async function remapLocalDocumentId(localId, canonicalDoc) {
  const db = await getDB();
  const tx = db.transaction(DOCUMENTS_STORE, 'readwrite');
  await tx.store.delete(localId);
  await tx.store.put({ ...canonicalDoc, cachedAt: new Date().toISOString() });
  await tx.done;
}

/**
 * Saves this phone's pairing credentials, exactly as returned by
 * POST /api/pair/complete, plus the apiBase it paired against (needed
 * later to know which PC to talk to) and `pairedAt` bookkeeping.
 *
 * @param {{
 *   deviceId: string,
 *   deviceToken: string,
 *   wrappedDEKPhonePin: string,
 *   wrappedDEKPhonePinIv: string,
 *   wrappedDEKPhonePinAuthTag: string,
 *   wrappedDEKPhonePinSalt: string,
 *   apiBase: string,
 * }} deviceAuth
 */
export async function saveDeviceAuthLocally(deviceAuth) {
  const db = await getDB();
  await db.put(DEVICE_AUTH_STORE, { ...deviceAuth, pairedAt: new Date().toISOString() });
}

/**
 * @returns {Promise<Array<object>>} every device-pairing record stored locally
 */
export async function getAllDeviceAuth() {
  const db = await getDB();
  return db.getAll(DEVICE_AUTH_STORE);
}

/**
 * @param {string} deviceId
 * @returns {Promise<object | undefined>}
 */
export async function getDeviceAuth(deviceId) {
  const db = await getDB();
  return db.get(DEVICE_AUTH_STORE, deviceId);
}

/**
 * @param {string} deviceId
 */
export async function deleteDeviceAuth(deviceId) {
  const db = await getDB();
  await db.delete(DEVICE_AUTH_STORE, deviceId);
}
