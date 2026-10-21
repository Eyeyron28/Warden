import { subscribeToken } from './session.js';

export const JUST_ASKED_MS = 5000;

const entries = new Map();
const inflight = new Map();
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

export function invalidateAll() {
  generation += 1;
  entries.clear();
  inflight.clear();
}

subscribeToken(() => invalidateAll());

export const cacheSize = () => entries.size;
