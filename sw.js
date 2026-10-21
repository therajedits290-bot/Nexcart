const CACHE = 'nexcart-v69-live';
const ASSETS = [
  './',
  './tokri-standalone.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './privacy.html',
  './delete-account.html'
];

/* install: fetch each file on its own.
   v54 - this used to be cache.addAll(), which rejects the whole batch if a
   single file is missing, so one absent file left the app with no offline
   copy at all. Now a missing file is simply skipped. */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(
        ASSETS.map((u) => fetch(new Request(u, { cache: 'reload' }))
          .then((res) => { if (res && res.ok) return cache.put(u, res); })
          .catch(() => {}))
      ))
      .then(() => self.skipWaiting())
      .catch(() => {})
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

/* ---- push notifications (server.js v1.4.0 sends these) ---- */
self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; }
  catch (e) { try { d = { title: 'NEXCART', body: event.data.text() }; } catch (e2) {} }
  event.waitUntil(self.registration.showNotification(d.title || 'NEXCART', {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    image: d.image || undefined,
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { tab: d.tab || 'home' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const tab = (event.notification.data && event.notification.data.tab) || 'home';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.postMessage({ type: 'nc-open', tab }); return c.focus(); }
      }
      return self.clients.openWindow('./tokri-standalone.html#' + tab);
    })
  );
});
