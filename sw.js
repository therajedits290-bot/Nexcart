const CACHE = 'nexcart-v92-live';      // app files + small assets
const IMG   = 'nexcart-img-v1';         // product / banner pictures seen so far (kept across versions)
const ASSETS = [
  './',
  './index.html',
  './tokri-standalone.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './privacy.html',
  './delete-account.html'
];
const IMG_MAX = 400;
const NAV_TIMEOUT = 4000;   // slow / no network: fall back to the saved copy after 4 s

/* install: fetch each file on its own, so one missing file never blocks the rest */
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

/* activate: drop old app caches (pictures cache is kept), take over open pages */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== IMG).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function trim(cache) {
  return cache.keys().then((keys) => {
    if (keys.length > IMG_MAX) return Promise.all(keys.slice(0, keys.length - IMG_MAX).map((k) => cache.delete(k)));
  });
}

/* pictures from anywhere (own site or the shop server): show the saved copy at once, refresh it quietly */
function pictureStrategy(req) {
  return caches.open(IMG).then((cache) =>
    cache.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && (res.ok || res.type === 'opaque')) { cache.put(req, res.clone()).then(() => trim(cache)).catch(() => {}); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
}

/* pages / scripts / json: the network is always asked first (so updates arrive at once),
   but when there is no network - or it is too slow - the saved copy opens instantly */
function pageStrategy(req) {
  const fromCache = () => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./tokri-standalone.html'));
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) fromCache().then((r) => { if (r && !done) { done = true; resolve(r); } }); }, NAV_TIMEOUT);
    fetch(req, { cache: 'reload' }).then((res) => {
      clearTimeout(timer);
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      if (!done) fromCache().then((r) => { done = true; resolve(r || Response.error()); });
    });
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;                 // video streaming: leave to the browser
  const url = new URL(req.url);
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url.pathname)) return;
  if (/version\.json$/.test(url.pathname)) return;
  if (/\/api\//.test(url.pathname) || /\/(media-stats)/.test(url.pathname)) return;   // live data is never cached here

  const isPicture = req.destination === 'image' || /\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.test(url.pathname) || /\/media\//.test(url.pathname);

  if (url.origin !== self.location.origin) {
    if (isPicture) event.respondWith(pictureStrategy(req));
    return;                                             // everything else from other sites: untouched
  }
  if (isPicture || /\.(woff2?|ttf)$/i.test(url.pathname)) {
    event.respondWith(pictureStrategy(req));
    return;
  }
  event.respondWith(pageStrategy(req));
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
    vibrate: [120, 60, 120],
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
