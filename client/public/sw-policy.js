// Cache decisions for the service worker (sw.js). Pure functions, no browser APIs, so Node can test them
// (tests/sw-policy.test.mjs). Loaded by the worker with importScripts and exposed as globalThis.SWPolicy.
// Rule: only public static files are ever cached. Pages (navigations), /api, /admin and customer/account paths never are.
(() => {
  const PRIVATE_PREFIXES = ['/api', '/admin', '/customer', '/account'];
  const STATIC_PREFIXES = ['/assets/', '/brand/'];
  const STATIC_FILES = ['/manifest.webmanifest', '/offline.html', '/offline.js'];
  const STATIC_DESTINATIONS = ['script', 'style', 'font', 'image', 'manifest'];

  const isPrivatePath = path => PRIVATE_PREFIXES.some(p => path === p || path.startsWith(p + '/'));

  // req: {method, mode, destination, url}; origin: the worker's own origin.
  // Returns true when this request may be answered from / stored in the cache.
  function isCacheableRequest(req, origin) {
    if (req.method !== 'GET') return false;
    if (req.mode === 'navigate' || req.destination === 'document') return false; // pages always come from the network
    let u; try { u = new URL(req.url); } catch { return false; }
    if (u.origin !== origin) return false;
    if (isPrivatePath(u.pathname)) return false;
    if (STATIC_FILES.includes(u.pathname)) return true;
    return STATIC_PREFIXES.some(p => u.pathname.startsWith(p)) && STATIC_DESTINATIONS.includes(req.destination);
  }

  // res: {status, type, headers: {get(name)}}. Never store a response that sets a cookie or is marked private.
  function isCacheableResponse(res) {
    if (!res || res.status !== 200 || res.type !== 'basic') return false;
    if (res.headers.get('set-cookie')) return false;
    const cc = String(res.headers.get('cache-control') || '').toLowerCase();
    if (/(^|[\s,])(no-store|private)([\s,=]|$)/.test(cc)) return false;
    if (String(res.headers.get('vary') || '').includes('*')) return false;
    return true;
  }

  const CACHE_PREFIX = 'usam-language-';
  const cacheName = version => CACHE_PREFIX + version;

  globalThis.SWPolicy = {isCacheableRequest, isCacheableResponse, isPrivatePath, cacheName, CACHE_PREFIX, PRECACHE: ['/offline.html', '/offline.js', '/manifest.webmanifest', '/brand/language-mark.svg']};
})();
