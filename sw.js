// SHTL Mtwara Workshop — Offline App Shell Cache
// Purpose: let the app OPEN even with zero internet (e.g. laptop restarted
// mid-outage, tab closed and reopened). Once the page is running, Firebase's
// own offline persistence (enablePersistence, already configured in the app)
// takes over for queuing/syncing actual data.
//
// Strategy:
//  - index.html (the app itself): NETWORK-FIRST, falls back to cache when
//    offline. This preserves the app's existing auto-update-on-new-version
//    behavior when online — it should always try to get the freshest copy
//    first, and only use the offline copy when there's truly no connection.
//  - External libraries (Firebase SDK, xlsx, qrcode, icon font): CACHE-FIRST,
//    since these rarely change and loading them instantly from cache is both
//    faster and more reliable than waiting on a flaky connection.

const SHELL_CACHE = 'shtl-shell-v1';
const LIB_CACHE = 'shtl-libs-v1';

const SHELL_URLS = ['./', './index.html'];

const LIB_URLS = [
  'https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/dist/tabler-icons.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.13.0/firebase-database-compat.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil((async () => {
    try {
      const shellCache = await caches.open(SHELL_CACHE);
      await shellCache.addAll(SHELL_URLS);
    } catch (e) {
      console.warn('SW: shell cache failed', e);
    }
    // Cache each library individually — if one CDN resource fails (CORS,
    // temporary outage, etc.) it must not block the others or the shell.
    const libCache = await caches.open(LIB_CACHE);
    await Promise.allSettled(
      LIB_URLS.map((url) =>
        fetch(url, { mode: 'cors' })
          .then((res) => { if (res && res.ok) return libCache.put(url, res); })
          .catch((e) => console.warn('SW: lib cache failed for', url, e))
      )
    );
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== SHELL_CACHE && k !== LIB_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept POST/PUT etc.

  const url = req.url;
  const isLib = LIB_URLS.includes(url);
  const isNavigation = req.mode === 'navigate' || (req.destination === 'document');

  if (isLib) {
    // Cache-first for known static libraries
    event.respondWith((async () => {
      const cache = await caches.open(LIB_CACHE);
      const cached = await cache.match(url);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(url, res.clone());
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  if (isNavigation) {
    // Network-first for the app page itself, so online users always get the
    // latest deployed version; offline users get the last cached copy.
    event.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put('./index.html', res.clone());
        return res;
      } catch (e) {
        const cached = await cache.match('./index.html') || await cache.match('./');
        return cached || Response.error();
      }
    })());
  }
  // All other requests (Firebase realtime WebSocket traffic, etc.) pass
  // through untouched — this handler doesn't apply to them anyway.
});
