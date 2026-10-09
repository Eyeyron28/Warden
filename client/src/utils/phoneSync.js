/**
 * The phone's sync, as one function with its network and storage injected
 * (pages/PhoneVault.jsx wires the real ones), so every rule here is testable.
 *
 * Shaped for a serverless host with a 4.5 MB body limit:
 *   1. page through the metadata of every document (small responses);
 *   2. work out what changed - new, edited, trashed, gone;
 *   3. download each missing document's ciphertext on its own request;
 *   4. push what was added offline, one document per request.
 * Nothing holds state between requests, so an interrupted sync resumes by just
 * running again: whatever was already saved is not fetched twice. A phone that
 * has been away for days does exactly the same, only with more to do.
 */

export const PAGE_SIZE = 100;
export const MAX_PUSH_BYTES = 4 * 1024 * 1024;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STOPPING = ['cancelled', 'offline', 'revoked', 'outdated'];

/**
 * What went wrong with a request, in the terms the phone acts on.
 * @returns {{ kind: 'cancelled' | 'offline' | 'revoked' | 'outdated' | 'quota' | 'too-large' | 'missing' | 'busy' | 'server' | 'other', retryable: boolean, message: string }}
 */
export function classifyError(error) {
  if (error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || error?.name === 'AbortError') {
    return { kind: 'cancelled', retryable: false, message: 'Cancelled.' };
  }
  const status = error?.response?.status;
  if (!status) return { kind: 'offline', retryable: true, message: 'The server could not be reached.' };
  const serverMessage = error.response?.data?.error?.message;
  const code = error.response?.data?.error?.code;
  if (status === 401) {
    return {
      kind: 'revoked',
      retryable: false,
      message:
        'This phone is no longer paired with the account (it may have been removed on the Devices page). Pair it again to sync.',
    };
  }
  if (status === 410) {
    return { kind: 'outdated', retryable: false, message: serverMessage || 'This version of Warden is out of date. Reload the app and try again.' };
  }
  if (status === 413) {
    return code === 'STORAGE_QUOTA'
      ? { kind: 'quota', retryable: false, message: 'Your storage is full.' }
      : { kind: 'too-large', retryable: false, message: 'Larger than the 4 MB a file can be.' };
  }
  if (status === 404) return { kind: 'missing', retryable: false, message: serverMessage || 'Not found.' };
  if (status === 429) return { kind: 'busy', retryable: true, message: 'The server is busy. Try again in a moment.' };
  if (status >= 500) return { kind: 'server', retryable: true, message: 'The server had a problem.' };
  return { kind: 'other', retryable: false, message: serverMessage || 'The request was refused.' };
}

/** Runs `fn`, retrying a network failure, 429 or 5xx a couple of times with a growing pause. */
export async function withRetry(fn, { tries = 3, baseDelayMs = 700, sleep = defaultSleep, signal } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ERR_CANCELED' });
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (error) {
      if (!classifyError(error).retryable || attempt >= tries) throw error;
      // eslint-disable-next-line no-await-in-loop
      await sleep(baseDelayMs * attempt * attempt);
    }
  }
}

const sameValue = (a, b) => (a ?? null) === (b ?? null);

/**
 * @param {{
 *   api: {
 *     listDocumentPage: (args: { cursor?: string, limit: number }) => Promise<{ items: object[], nextCursor: string|null }>,
 *     listFolders: () => Promise<string[]>,
 *     fetchContent: (id: string) => Promise<ArrayBuffer>,
 *     pushDocument: (doc: object) => Promise<{ id: string }>,
 *     pushFolder: (name: string) => Promise<void>,
 *   },
 *   store: {
 *     getDocs: () => Promise<object[]>, putDoc: (doc: object) => Promise<void>, deleteDoc: (id: string) => Promise<void>,
 *     remapDoc: (localId: string, doc: object) => Promise<void>,
 *     getFolders: () => Promise<object[]>, putFolder: (record: object) => Promise<void>, deleteFolder: (name: string) => Promise<void>,
 *   },
 *   onProgress?: (event: { phase: string, done: number, total: number, current?: string }) => void,
 *   signal?: AbortSignal,
 *   sleep?: (ms: number) => Promise<void>,
 * }} deps
 * @returns {Promise<{
 *   status: 'done' | 'partial' | 'offline' | 'revoked' | 'outdated' | 'cancelled',
 *   message: string,
 *   pulled: number, updated: number, removed: number, pushed: number,
 *   failures: Array<{ name: string, reason: string }>,
 * }>}
 */
export async function runSync({ api, store, onProgress = () => {}, signal, sleep = defaultSleep }) {
  const result = { status: 'done', message: '', pulled: 0, updated: 0, removed: 0, pushed: 0, failures: [] };
  const retry = (fn) => withRetry(fn, { sleep, signal });
  const stopIfCancelled = () => {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'ERR_CANCELED' });
  };

  try {
    // ---- 1. metadata, page by page ----
    const remote = new Map();
    let cursor;
    do {
      stopIfCancelled();
      // eslint-disable-next-line no-await-in-loop
      const page = await retry(() => api.listDocumentPage({ cursor, limit: PAGE_SIZE }));
      for (const item of page.items) remote.set(item.id, item);
      cursor = page.nextCursor || undefined;
      onProgress({ phase: 'listing', done: remote.size, total: remote.size });
    } while (cursor);
    const serverFolders = await retry(() => api.listFolders());

    // ---- 2. what changed ----
    const local = await store.getDocs();
    const localById = new Map(local.map((doc) => [String(doc.id), doc]));
    const pendingByLocalId = new Map(local.filter((doc) => doc.syncStatus === 'pending').map((doc) => [String(doc.id), doc]));
    const toFetch = [];

    for (const item of remote.values()) {
      const here = localById.get(item.id);
      if (item.deletedAt) {
        // In Trash on the account: gone from the phone. (Restored later, it shows up as new below.)
        if (here && here.syncStatus === 'synced') {
          // eslint-disable-next-line no-await-in-loop
          await store.deleteDoc(here.id);
          result.removed += 1;
        }
      } else if (!here) {
        // An upload from this phone whose answer was lost is already here, under its local id.
        const mine = item.clientId ? pendingByLocalId.get(item.clientId) : null;
        if (mine) {
          // eslint-disable-next-line no-await-in-loop
          await store.remapDoc(mine.id, { ...mine, id: item.id, syncStatus: 'synced' });
          pendingByLocalId.delete(item.clientId);
        } else {
          toFetch.push(item);
        }
      } else if (here.syncStatus === 'synced') {
        if (here.iv !== item.iv || here.checksum !== item.checksum) {
          toFetch.push(item);
        } else if (
          !sameValue(here.filename, item.filename) ||
          !sameValue(here.folder, item.folder) ||
          !sameValue(here.expiryDate, item.expiryDate) ||
          !sameValue(here.mimeType, item.mimeType)
        ) {
          // eslint-disable-next-line no-await-in-loop
          await store.putDoc({ ...here, filename: item.filename, folder: item.folder, expiryDate: item.expiryDate, mimeType: item.mimeType });
          result.updated += 1;
        }
      }
    }
    // A synced document missing from a COMPLETE listing was removed for good. Documents added on this
    // phone and not yet pushed are never pruned.
    for (const here of local) {
      if (here.syncStatus === 'synced' && !remote.has(String(here.id))) {
        // eslint-disable-next-line no-await-in-loop
        await store.deleteDoc(here.id);
        result.removed += 1;
      }
    }

    // ---- 3. download what is missing, one document per request ----
    for (let index = 0; index < toFetch.length; index += 1) {
      stopIfCancelled();
      const item = toFetch[index];
      onProgress({ phase: 'downloading', done: index, total: toFetch.length, current: item.filename });
      try {
        // eslint-disable-next-line no-await-in-loop
        const bytes = await retry(async () => {
          const buffer = await api.fetchContent(item.id);
          if (item.size && buffer.byteLength !== item.size) {
            throw Object.assign(new Error('Incomplete download'), { response: { status: 503 } });
          }
          return buffer;
        });
        // eslint-disable-next-line no-await-in-loop
        await store.putDoc({
          id: item.id,
          filename: item.filename,
          folder: item.folder,
          expiryDate: item.expiryDate,
          encryptedBlob: bytes,
          iv: item.iv,
          authTag: item.authTag,
          checksum: item.checksum,
          mimeType: item.mimeType,
          syncStatus: 'synced',
        });
        result.pulled += 1;
      } catch (error) {
        const info = classifyError(error);
        if (STOPPING.includes(info.kind)) throw error;
        // Trashed or removed since the listing: nothing to fetch. Anything else is reported and the rest carries on.
        if (info.kind !== 'missing') result.failures.push({ name: item.filename, reason: info.message });
      }
    }
    onProgress({ phase: 'downloading', done: toFetch.length, total: toFetch.length });

    // ---- folders: mirror the account's, keep the phone's own pending ones ----
    const folderRecords = await store.getFolders();
    const serverFolderSet = new Set(serverFolders);
    for (const record of folderRecords) {
      if (record.syncStatus === 'synced' && !serverFolderSet.has(record.name)) {
        // eslint-disable-next-line no-await-in-loop
        await store.deleteFolder(record.name);
      }
    }
    const knownFolders = new Set(folderRecords.map((record) => record.name));
    for (const name of serverFolders) {
      if (!knownFolders.has(name)) {
        // eslint-disable-next-line no-await-in-loop
        await store.putFolder({ name, syncStatus: 'synced' });
      }
    }

    // ---- 4. push what was added on the phone, one document per request ----
    const pending = (await store.getDocs()).filter((doc) => doc.syncStatus === 'pending');
    let quotaHit = false;
    for (let index = 0; index < pending.length; index += 1) {
      stopIfCancelled();
      const doc = pending[index];
      onProgress({ phase: 'pushing', done: index, total: pending.length, current: doc.filename });
      if (quotaHit) {
        result.failures.push({ name: doc.filename, reason: 'Your storage is full, so this was not uploaded.' });
        continue;
      }
      if (doc.encryptedBlob.byteLength > MAX_PUSH_BYTES) {
        result.failures.push({ name: doc.filename, reason: 'Larger than the 4 MB a file can be, so it stays on this phone only.' });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        const saved = await retry(() => api.pushDocument({ ...doc, clientId: String(doc.id) }));
        // eslint-disable-next-line no-await-in-loop
        await store.remapDoc(doc.id, { ...doc, id: saved.id, syncStatus: 'synced' });
        result.pushed += 1;
      } catch (error) {
        const info = classifyError(error);
        if (STOPPING.includes(info.kind)) throw error;
        if (info.kind === 'quota') quotaHit = true;
        result.failures.push({ name: doc.filename, reason: info.kind === 'quota' ? 'Your storage is full, so this was not uploaded.' : info.message });
      }
    }
    for (const record of (await store.getFolders()).filter((r) => r.syncStatus === 'pending')) {
      stopIfCancelled();
      try {
        // eslint-disable-next-line no-await-in-loop
        await retry(() => api.pushFolder(record.name));
        // eslint-disable-next-line no-await-in-loop
        await store.putFolder({ name: record.name, syncStatus: 'synced' });
      } catch (error) {
        const info = classifyError(error);
        if (STOPPING.includes(info.kind)) throw error;
        result.failures.push({ name: `${record.name}/`, reason: info.message });
      }
    }
    onProgress({ phase: 'pushing', done: pending.length, total: pending.length });

    if (result.failures.length > 0) result.status = 'partial';
    return result;
  } catch (error) {
    const info = classifyError(error);
    if (STOPPING.includes(info.kind)) return { ...result, status: info.kind, message: info.message };
    return { ...result, status: 'partial', message: info.message, failures: [...result.failures, { name: 'Sync', reason: info.message }] };
  }
}
