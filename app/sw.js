// Offline cache. App files and the data (content-hashed names) are cached on
// first use; the page and data/manifest.json are always checked online first
// so a new build is picked up.
const CACHE = 'wt-__BUILD__';
const NETWORK_FIRST = /(\/|index\.html|manifest\.json|app\.js|style\.css|sw\.js)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  // Wikimedia thumbnails and summaries are left to the browser's own cache
  // (cross-origin images can't be cached here without a large storage cost).
  if (!sameOrigin) return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (NETWORK_FIRST.test(url.pathname)) {
      try {
        const res = await fetch(e.request);
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        return (await cache.match(e.request)) || Response.error();
      }
    }
    const hit = await cache.match(e.request);
    if (hit) return hit;
    const res = await fetch(e.request);
    if (res.ok) cache.put(e.request, res.clone());
    return res;
  })());
});
