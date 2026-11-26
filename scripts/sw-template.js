/* Thanksgiving Command Center service worker — generated at build time. */
const VERSION = '__VERSION__';
const CACHE = `tcc-${VERSION}`;
const BASE = '__BASE__';
const URLS = __URLS__;

self.addEventListener('install', (event) => {
  // Cache every asset. Do NOT skipWaiting: a new version never takes over mid-cooking
  // unless the cook taps "Update" (which posts SKIP_WAITING).
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(URLS.map((u) => new Request(u, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tcc-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'VERSION') event.source?.postMessage({ type: 'VERSION', version: VERSION, cache: CACHE });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => (await cache.match(BASE, { ignoreVary: true })) || (await cache.match(BASE + 'index.html', { ignoreVary: true })) || fetch(req)),
    );
    return;
  }
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req, { ignoreSearch: true, ignoreVary: true });
      if (hit) return hit;
      return fetch(req);
    }),
  );
});
