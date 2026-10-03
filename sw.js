/* ============================================================
   NEXCART — Service Worker  (v17)
   ------------------------------------------------------------
   What changed and why:
   v1 precached the app shell under a fixed cache name and let the
   phone's HTTP cache answer repeat visits, so an updated
   tokri-standalone.html could keep showing the OLD design on an
   installed app.
   v2 fixes that:
     - CACHE name bumped to v17, so every already-installed app
       installs this worker, which deletes the old cache.
     - HTML/navigation requests now use cache:'reload', which
       bypasses the HTTP cache and always reads the real file.
       Future updates therefore appear by themselves.
     - Only successful responses are cached.
   Nothing else about the app changes.
   ============================================================ */

const CACHE = 'nexcart-v17';
const ASSETS = [
  './',
  './tokri-standalone.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

/* install: fetch fresh copies (cache:'reload' bypasses the HTTP cache) */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))
        .catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

/* activate: drop every older cache, then take over open pages */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never touch third-party requests

  const isAsset = /\.(png|jpg|jpeg|webp|svg|woff2?|ttf)$/i.test(url.pathname);

  /* images + fonts: cache first, for speed */
  if (isAsset) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => hit))
    );
    return;
  }

  /* pages + JSON: ALWAYS read the real file, fall back to cache offline */
  event.respondWith(
    fetch(req, { cache: 'reload' })
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./tokri-standalone.html')))
  );
});
