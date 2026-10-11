/* ============================================================
   NEXCART — Service Worker  (v24)
   ------------------------------------------------------------
   What changed and why:
   v1 precached the app shell under a fixed cache name and let the
   phone's HTTP cache answer repeat visits, so an updated
   tokri-standalone.html could keep showing the OLD design on an
   installed app.
   v2 fixes that:
     - CACHE name bumped to v24, so every already-installed app
       installs this worker, which deletes the old cache.
     - HTML/navigation requests now use cache:'reload', which
       bypasses the HTTP cache and always reads the real file.
       Future updates therefore appear by themselves.
     - Only successful responses are cached.
   Nothing else about the app changes.
   v30 (2026-10-06) - pink rose-gold storefront re-skin. CACHE is
   bumped again so an installed app drops the v29 cache and picks up
   the new design instead of serving the old one.
   v31 (2026-10-06) - category-tile ring switched from gold to pink
   (owner's pick). CACHE bumped again.
   v32 (2026-10-06) - Categories / Cart / Orders / Profile tabs themed
   to match Home. CACHE bumped again.
   v33 (2026-10-06) - splash screen rebuilt, and manifest.json
   background_color changed for the installed-app launch screen.
   CACHE bumped again.
   v34 (2026-10-06) - splash + launch screen moved to DEEP WINE
   (#6E0526), the owner's pick from four rendered options. CACHE
   bumped again.
   v35 (2026-10-06) - back to a WHITE launch/splash field, with the
   icon rounded (icon-192/512 now have transparent corners). CACHE
   bumped again.
   v36 (2026-10-07) - the v32 Categories-page theming was deployed but
   too faint to see; this pass makes it clearly visible. CACHE bumped
   again.
   v37 (2026-10-07) - the template "have this reviewed" notices removed
   and the Privacy Policy / Return & Refund Policy / Terms rewritten in
   full, plus an in-app "Delete my account" route. CACHE bumped again.
   v38 (2026-10-07) - support email set to the owner's real address in
   LEGAL and on both public legal pages. CACHE bumped again.
   v39 (2026-10-07) - standalone Admin app (admin.html + its own
   manifest and icon) and a Cloud-sync section in admin Settings.
   CACHE bumped again.
   v40 (2026-10-07) - admin dashboard now reports whether the shop is
   backed up to the server, and warns when it exists only on the phone.
   CACHE bumped again.
   v41 (2026-10-07) - the separate Admin app is withdrawn at the owner's
   request; admin is reached only by the hidden footer trigger, whose
   long-press is now 10s. Its files are dropped from the precache list.
   CACHE bumped again.
   v42 (2026-10-08) - manifest.json gains an explicit id and scope (needed
   for a reliable full-screen TWA), and the unused Google demo-account
   chooser is deleted. CACHE bumped again.
   v46 (2026-10-11) - customers are now recorded on the server, so the
   owner's Customers page lists every tester. CACHE bumped again.
   v51 (2026-10-11) - splash + login brought into the theme. Both were already
   indigo, but the app mark they show was still the old pink artwork (two inlined
   PNGs: NEX_LOGO and --nex-mark). Both are recoloured to the indigo brand ramp,
   white glyph and transparency preserved. Also: launcher icons (icon-192.png,
   icon-512.png, apple-touch-icon) live in the repo, not in this file - see
   README-UPLOAD.txt. CACHE bumped.
   v50 (2026-10-11) - INDIGO BAZAAR theme: the owner picked option B from three
   rendered directions. Deep indigo (#3B2BD9) + marigold (#FF8A1E), Poppins
   headings embedded for offline use, chunkier cards, marigold savings badges,
   indigo CTAs, a 3-cell trust strip on the cart, and the older rose/gold
   marketing shell recoloured to the same palette. CACHE bumped.
   v49 (2026-10-11) - a product can carry up to four photos: the importer reads
   image, image 2, image 3 and image 4, and the product page shows the extra
   ones as tap-to-swap thumbnails. CACHE bumped again.
   v48 (2026-10-11) - a category page lists its own products only; the
   shop-wide search made a Shirts tile include t-shirts and showed men's
   items under a women's tile. CACHE bumped again.
   v47 (2026-10-11) - a new version now takes over on a single reopen
   (the page reloads itself once when the new worker activates), and a
   customer row can be removed from the list. CACHE bumped again.
   ============================================================ */

const CACHE = 'nexcart-v51';
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
