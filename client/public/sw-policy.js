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

  // res: {status, type, headers: {get(name)}}; destination: the request's destination, when known.
  // Never store a response that is marked private. Note: browsers hide Set-Cookie from scripts, so the set-cookie check
  // below can never fire in a real worker; it is only defence in depth. The real guard is the path allow-list in
  // isCacheableRequest (only /assets/, /brand/ and three named files are ever stored).
  function isCacheableResponse(res, destination) {
    if (!res || res.status !== 200 || res.type !== 'basic') return false;
    if (res.headers.get('set-cookie')) return false;
    // A script/style/font/image request answered with an HTML page is the app shell or an error page, not an asset.
    if (STATIC_DESTINATIONS.includes(destination) && /text\/html/i.test(String(res.headers.get('content-type') || ''))) return false;
    const cc = String(res.headers.get('cache-control') || '').toLowerCase();
    if (/(^|[\s,])(no-store|private)([\s,=]|$)/.test(cc)) return false;
    if (String(res.headers.get('vary') || '').includes('*')) return false;
    return true;
  }

  const CACHE_PREFIX = 'usam-language-';
  const cacheName = version => CACHE_PREFIX + version;

  const PRECACHE = ['/offline.html', '/offline.js', '/manifest.webmanifest', '/brand/language-mark.svg'];
  // Sign-out clears everything EXCEPT these install-time files, so the offline page keeps working after sign-out.
  const isPrecachedPath = pathname => PRECACHE.includes(pathname);

  globalThis.SWPolicy = {isCacheableRequest, isCacheableResponse, isPrivatePath, isPrecachedPath, cacheName, CACHE_PREFIX, PRECACHE};
})();
