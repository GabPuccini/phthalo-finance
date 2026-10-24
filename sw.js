/**
 * sw.js
 *
 * Offline support for Phthalo Finance.
 *
 * Every file the app needs, the page included, is served from one cache
 * named after CACHE_VERSION. The page and its code therefore always come
 * from the same release, so a half updated app, new page with old scripts,
 * cannot happen. The first version of this worker served the page from the
 * network and the scripts from the cache, which allowed exactly that.
 *
 * A new release is a new sw.js. The browser notices, this worker installs
 * the new files into a fresh cache and waits, and the page offers "A new
 * version is ready". Tapping it activates the new cache and deletes the old
 * one. CACHE_VERSION is stamped from a hash of the files by
 * tools/stamp-sw.mjs, and a test fails if the files change without it, so a
 * release cannot go out under an old version and be served stale forever.
 *
 * Every path here is relative, because the app is served from a project
 * subfolder on GitHub Pages, not from the domain root.
 */

const CACHE_VERSION = '54997e566625';
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
  './src/icons.js',
  './src/storage.js',
  './src/plan.js',
  './src/prices.js',
  './src/seed.js',
  './tests/cases.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // Fetched fresh, past any HTTP cache, so a release never inherits an old file.
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
    await Promise.all(names
      .filter((name) => name.startsWith('phthalo-finance-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
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

  // Price lookups go to other sites. They are never cached, never served
  // from the cache, and allowed to fail; the app copes.
  if (url.origin !== self.location.origin) return;

  // Opening the app, at the folder or at index.html, gets the cached page.
  const isShell = request.mode === 'navigate'
    && (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html'));

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(isShell ? './index.html' : request, { ignoreSearch: isShell });
    if (cached) return cached;
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok && !isShell) cache.put(request, fresh.clone());
      return fresh;
    } catch {
      if (request.mode === 'navigate') {
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
          + '<body style="font-family:system-ui;background:#0F1013;color:#F4F5F7;padding:24px">'
          + '<h1>Offline</h1><p>Phthalo is not saved for offline use on this device yet. '
          + 'Open it once while connected and it will work offline from then on.</p>',
          { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      }
      return new Response('', { status: 504, statusText: 'Offline and not cached' });
    }
  })());
});
