// App-shell cache with one rule above all others: the page itself is never
// served stale. A cache-first index.html is how an old login page used to
// outlive a deployment, so navigations go to the network first and the cached
// copy is only an offline fallback.
//
//   page navigations     network first, cached shell only when offline
//   /assets/* (hashed)   cache first: the file name changes with the content
//   other static files   network first, cached copy when offline
//   /api/*               never touched (live, session-gated, encrypted data)
//
// A new worker takes over at once (skipWaiting + clients.claim) and deletes
// every older cache; open tabs are told to offer a reload (see main.jsx).
//
// BUILD_ID is replaced at build time (vite.config.js) with a hash of the built
// index.html, so every deployment changes this file's bytes: that is what makes
// the browser install the new worker, drop the old cache and show the reload bar.
const BUILD_ID = '__BUILD_ID__';
const CACHE_NAME = `warden-shell-${BUILD_ID}`;
const SHELL = '/index.html';
const PRECACHE = [SHELL, '/manifest.json', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)));
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

const remember = (request, response) => {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
};

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // The shell is the same document for every route; keep the newest.
          if (response.ok) remember(SHELL, response.clone());
          return response;
        })
        .catch(() => caches.match(SHELL))
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => remember(request, response)))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => remember(request, response))
      .catch(() => caches.match(request))
  );
});
