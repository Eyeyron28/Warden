import api from './api.js';
import { subscribeToken } from './session.js';

const MAX_CONCURRENT = 4;

const urls = new Map();
const inflight = new Map();
const queue = [];
let active = 0;
let generation = 0;

function pump() {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const id = queue.shift();
    const entry = inflight.get(id);
    if (!entry) continue;
    if (entry.wanted <= 0) {
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
      result = undefined;
    } else {
      result = URL.createObjectURL(response.data);
      urls.set(id, result);
    }
  } catch (err) {
    if (startedIn === generation) {
      if (err?.response?.status === 404) urls.set(id, null);
      result = null;
    }
  }
  inflight.delete(id);
  entry.resolve(result);
}

export function getCachedThumbnail(id) {
  return urls.get(id);
}

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

export function invalidateThumbnail(id) {
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

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

subscribeToken((token) => {
  if (!token) clearThumbnails();
});

export function cachedThumbnailCount() {
  let count = 0;
  urls.forEach((url) => {
    if (url) count += 1;
  });
  return count;
}
