// Minimal app-shell cache: precache the shell entry on install, then a
// cache-first/network-fallback strategy for everything else so
// already-visited static files (JS/CSS/images) survive a flaky
// connection. No background sync, no update-prompt UI, no runtime
// versioning beyond bumping CACHE_NAME - that's deliberately out of
// scope until the real sync feature needs it.
const CACHE_NAME = 'warden-shell-v1';

// Hashed build output (JS/CSS under /assets/*) isn't known ahead of
// time, so it isn't precached here - it's added to the cache the first
// time it's actually fetched, via the fetch handler below. Only the
// handful of paths guaranteed to exist verbatim (this app's shell and
// its own static /public files) are precached up front.
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET, same-origin requests are cacheable here. Everything under
  // /api/* is the vault's live, encrypted, session-gated data - it must
  // never be served from cache, so it's left to the network entirely.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }
  if (new URL(request.url).pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request).then((response) => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, responseClone));
        }
        return response;
      });
    })
  );
});
