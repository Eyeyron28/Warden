import api from './api.js';
import { subscribeToken } from './session.js';

/**
 * In-memory cache of DECRYPTED preview thumbnails, as object URLs, keyed by
 * document id. Nothing here ever touches disk, localStorage or IndexedDB.
 *
 * The server hands each thumbnail back decrypted for the signed-in session
 * (GET /api/documents/:id/thumbnail, same as /view does for the file).
 * Fetches are queued with at most MAX_CONCURRENT in flight, and a fetch
 * nobody is waiting for any more (its card scrolled away or unmounted) is
 * skipped.
 *
 * Every way a session ends - "Lock vault", logout, an expired session's 401
 * - goes through session.js clearToken(), so one subscription below
 * revokes every URL, empties the cache and invalidates in-flight work.
 */

const MAX_CONCURRENT = 4;

const urls = new Map(); // id -> object URL, or null for "no usable thumbnail"
const inflight = new Map(); // id -> { promise, wanted }
const queue = []; // ids waiting for a free slot
let active = 0;
let generation = 0; // bumped on clear so late responses are discarded

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift();
    const entry = inflight.get(id);
    if (!entry) continue;
    if (entry.wanted <= 0) {
      // Nobody is waiting any more: don't spend a request on it.
      inflight.delete(id);
      entry.resolve(undefined);
      continue;
    }
    active += 1;
    run(id, entry).finally(() => {
      active -= 1;
      pump();
    });
  }
}

async function run(id, entry) {
  const startedIn = generation;
  let result;
  try {
    const response = await api.get(`/documents/${id}/thumbnail`, { responseType: 'blob' });
    if (startedIn !== generation) {
      result = undefined; // session ended while fetching: drop it
    } else {
      result = URL.createObjectURL(response.data);
      urls.set(id, result);
    }
  } catch (err) {
    if (startedIn === generation) {
      // 404 = genuinely no usable thumbnail (remember it); anything else may
      // be transient, so leave it uncached and let a later request retry.
      if (err?.response?.status === 404) urls.set(id, null);
      result = null;
    }
  }
  inflight.delete(id);
  entry.resolve(result);
}

export function getCachedThumbnail(id) {
  return urls.get(id); // string | null | undefined (undefined = not fetched yet)
}

/**
 * Asks for a document's thumbnail. Resolves to an object URL, or null when
 * there isn't one. Call releaseThumbnail(id) if the requester goes away
 * before it resolves.
 */
export function requestThumbnail(id) {
  if (urls.has(id)) return Promise.resolve(urls.get(id));

  const existing = inflight.get(id);
  if (existing) {
    existing.wanted += 1;
    return existing.promise;
  }

  const entry = { wanted: 1 };
  entry.promise = new Promise((resolve) => {
    entry.resolve = resolve;
  });
  inflight.set(id, entry);
  queue.push(id);
  pump();
  return entry.promise;
}

export function releaseThumbnail(id) {
  const entry = inflight.get(id);
  if (entry) entry.wanted -= 1;
}

/** Forget one document's thumbnail (e.g. after a new one was uploaded for it). */
export function invalidateThumbnail(id) {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

/** Revokes every object URL and drops every reference. */
export function clearThumbnails() {
  generation += 1;
  urls.forEach((url) => {
    if (url) URL.revokeObjectURL(url);
  });
  urls.clear();
  queue.length = 0;
  inflight.forEach((entry) => entry.resolve(undefined));
  inflight.clear();
  active = 0;
}

// Lock vault, logout and session expiry all end with clearToken().
subscribeToken((token) => {
  if (!token) clearThumbnails();
});

/** Test/diagnostic hook: how many object URLs are currently held. */
export function cachedThumbnailCount() {
  let count = 0;
  urls.forEach((url) => {
    if (url) count += 1;
  });
  return count;
}
