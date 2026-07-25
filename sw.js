// Offline-first service worker for the Poker Night Ledger PWA.
// Bump CACHE version whenever any cached asset changes to force an update.
const CACHE = 'poker-ledger-v9';

// Resolve against the SW location so it works under any GitHub Pages subpath.
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './src/engine.js',
  './manifest.webmanifest',
  './icons/icon.svg',
].map((p) => new URL(p, self.registration ? self.registration.scope : self.location).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new URL(u, self.location).toString())))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin GET, falling back to cache when offline.
// Cache-first kept serving stale app code after every deploy, which is far
// worse than a few ms of latency on a page this small.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          // Navigation fallback so the app still opens offline.
          if (req.mode === 'navigate') {
            return caches.match(new URL('./index.html', self.location).toString());
          }
          return Response.error();
        })
      )
  );
});
