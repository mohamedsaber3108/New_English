// Service worker. Caches public static files only; decisions live in sw-policy.js (unit-tested).
// RELEASE: replaced at build time (vite.config.js) with $RELEASE_ID, or a build timestamp when RELEASE_ID is not set,
// so every release gets its own cache and the activate step deletes the older ones. In `npm run dev` it stays as is.
importScripts('/sw-policy.js');
const RELEASE = '__BUILD_ID__';
const {isCacheableRequest, isCacheableResponse, isPrecachedPath, cacheName, PRECACHE} = self.SWPolicy;
const CACHE = cacheName(RELEASE);

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// The page posts {type: 'clear-caches'} on sign-out (client/src/swCache.js). Everything is deleted except the install-time
// files (offline page etc.), so the offline page still works right after sign-out.
async function clearCaches() {
  for (const k of await caches.keys()) {
    if (k !== CACHE) { await caches.delete(k); continue; }
    const c = await caches.open(k);
    for (const r of await c.keys()) if (!isPrecachedPath(new URL(r.url).pathname)) await c.delete(r);
  }
}
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'clear-caches') e.waitUntil(clearCaches());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.mode === 'navigate') {
    // Pages are never cached. Offline, show the static bilingual page instead of a stale or private view.
    if (req.method === 'GET') e.respondWith(fetch(req).catch(() => caches.match('/offline.html').then(r => r || Response.error())));
    return;
  }
  if (!isCacheableRequest({method: req.method, mode: req.mode, destination: req.destination, url: req.url}, self.location.origin)) return;
  e.respondWith(fetch(req).then(res => {
    if (isCacheableResponse(res, req.destination)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(r => r || Response.error())));
});
