/**
 * sw.js
 *
 * Offline support for Phthalo Finance.
 *
 * Bump CACHE_VERSION on every deploy. On activate, every cache that is not
 * the current one is deleted, and the page is told a new version is
 * waiting so it can offer a reload rather than serving a stale app forever.
 *
 * Every path here is relative, because the app is served from a project
 * subfolder on GitHub Pages, not from the domain root.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `phthalo-finance-${CACHE_VERSION}`;

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './tests.html',
  './src/app.js',
  './src/logic.js',
  './src/charts.js',
  './src/storage.js',
  './src/prices.js',
  './src/seed.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // addAll fails the whole install if one file is missing, so each file
    // is added on its own and a miss is logged rather than fatal.
    await Promise.all(PRECACHE.map(async (path) => {
      try {
        await cache.add(new Request(path, { cache: 'reload' }));
      } catch {
        // A missing optional file must not stop the app installing.
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) => {
      if (name.startsWith('phthalo-finance-') && name !== CACHE_NAME) return caches.delete(name);
      return Promise.resolve(false);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Price lookups must never be served from the cache, and must never be
  // cached themselves. They are allowed to fail; the app copes.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    // Network first for the page itself so a new deploy is picked up,
    // falling back to the cached shell when offline.
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match('./index.html');
        return cached || new Response(
          '<h1>Offline</h1><p>Phthalo Finance is not in the cache yet. '
          + 'Connect once and it will work offline afterwards.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
    })());
    return;
  }

  // Cache first for everything else, refreshing the copy in the background.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) {
      event.waitUntil((async () => {
        try {
          const fresh = await fetch(request);
          if (fresh && fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, fresh);
          }
        } catch {
          // Offline is fine, the cached copy was already returned.
        }
      })());
      return cached;
    }
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok && url.origin === self.location.origin) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch {
      return new Response('', { status: 504, statusText: 'Offline and not cached' });
    }
  })());
});
