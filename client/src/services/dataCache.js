import { subscribeToken } from './session.js';

/**
 * A small in-memory cache for the signed-in app's lists, so going back to a page shows its data at once and the page
 * then refreshes it in the background (stale-while-revalidate).
 *
 *   fetchCached(key, load)   always asks the server (several callers of the same key share ONE request), and remembers
 *                            the answer. With `maxAgeMs` an answer younger than that is returned without a request.
 *   peek(key)                what is remembered, synchronously, or undefined: a page uses it as its first state.
 *   invalidateAll()          forgets everything. Called after EVERY write (see services/api.js), so a page never starts
 *                            from data a write has just made wrong, and by a generation counter an answer that was
 *                            still in flight when the write happened is thrown away instead of stored.
 *
 * What it holds: JSON answers of list endpoints, in this tab's memory only. Never document bytes, thumbnails, keys or
 * tokens, never written to any storage, and emptied whenever the session token changes (sign-in, sign-out, expiry).
 */

// A page that opens right after the first-screen prefetch (or after another page that just asked) reuses an answer this
// young instead of asking again; anything older is refreshed in the background as usual.
export const JUST_ASKED_MS = 5000;

const entries = new Map(); // key -> { value, at }
const inflight = new Map(); // key -> Promise
let generation = 0;

export function peek(key) {
  return entries.get(key)?.value;
}

export function fetchCached(key, load, { maxAgeMs = 0 } = {}) {
  const hit = entries.get(key);
  if (hit && maxAgeMs > 0 && Date.now() - hit.at < maxAgeMs) return Promise.resolve(hit.value);
  const running = inflight.get(key);
  if (running) return running;

  const startedIn = generation;
  const promise = Promise.resolve()
    .then(load)
    .then((value) => {
      if (startedIn === generation) entries.set(key, { value, at: Date.now() });
      return value;
    })
    .finally(() => {
      if (inflight.get(key) === promise) inflight.delete(key);
    });
  inflight.set(key, promise);
  return promise;
}

/** Forgets everything remembered and everything in flight (a write happened, or the session changed). */
export function invalidateAll() {
  generation += 1;
  entries.clear();
  inflight.clear();
}

// A different session (or none) must never see the previous one's lists.
subscribeToken(() => invalidateAll());

/** For tests. */
export const cacheSize = () => entries.size;
