// Service worker cache policy (U-5): decisions are pure functions in client/public/sw-policy.js, so no browser is needed.
// Also checks the static pieces: sw.js wiring, the bilingual offline page, and that logout code clears caches.
import {readFile} from 'node:fs/promises';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };

await import('../client/public/sw-policy.js');
const P = globalThis.SWPolicy;
const O = 'https://example.test';
const req = (path, o = {}) => ({method: 'GET', mode: 'no-cors', destination: 'script', url: O + path, ...o});
const res = (headers = {}, o = {}) => ({status: 200, type: 'basic', headers: {get: n => headers[n.toLowerCase()] ?? null}, ...o});

// ---- requests ----
ok(P.isCacheableRequest(req('/assets/index-abc.js'), O), 'built script under /assets is cacheable');
ok(P.isCacheableRequest(req('/assets/font.woff2', {destination: 'font'}), O), 'font under /assets is cacheable');
ok(P.isCacheableRequest(req('/brand/language-mark.svg', {destination: 'image'}), O), 'brand image is cacheable');
ok(P.isCacheableRequest(req('/manifest.webmanifest', {destination: 'manifest'}), O), 'manifest is cacheable');
ok(P.isCacheableRequest(req('/offline.html', {destination: ''}), O), 'offline page is cacheable');
ok(!P.isCacheableRequest(req('/', {mode: 'navigate', destination: 'document'}), O), 'page navigation is never cached');
ok(!P.isCacheableRequest(req('/admin', {mode: 'navigate', destination: 'document'}), O), '/admin navigation is never cached');
for (const p of ['/admin', '/admin/', '/admin/users', '/api/customer/me', '/api/admin/overview', '/customer/orders', '/account', '/account/settings']) {
  ok(!P.isCacheableRequest(req(p), O), `private path ${p} is never cached, even as a script request`);
  ok(P.isPrivatePath(p), `isPrivatePath(${p})`);
}
ok(!P.isCacheableRequest(req('/assets/../api/x'), O), 'normalised path traversal into /api is not cached');
ok(!P.isPrivatePath('/administrator'), '/administrator is not treated as /admin');
ok(!P.isCacheableRequest(req('/assets/a.js', {method: 'POST'}), O), 'non-GET is never cached');
ok(!P.isCacheableRequest(req('/assets/a.js', {url: 'https://other.test/assets/a.js'}), O), 'other origin is never cached');
ok(!P.isCacheableRequest(req('/random-data.json', {destination: ''}), O), 'unknown path is not cached (allow-list, not deny-list)');
ok(!P.isCacheableRequest({method: 'GET', mode: 'cors', destination: 'script', url: 'not a url'}, O), 'invalid URL is not cached');

// ---- responses ----
ok(P.isCacheableResponse(res()), 'plain 200 response is cacheable');
ok(P.isCacheableResponse(res({'cache-control': 'public, max-age=3600'})), 'public max-age response is cacheable');
ok(!P.isCacheableResponse(res({'set-cookie': 'a=b'})), 'response with Set-Cookie is not cached');
ok(!P.isCacheableResponse(res({'cache-control': 'no-store'})), 'Cache-Control: no-store is not cached');
ok(!P.isCacheableResponse(res({'cache-control': 'private, max-age=60'})), 'Cache-Control: private is not cached');
ok(!P.isCacheableResponse(res({'cache-control': 'No-Store'})), 'header check is case-insensitive');
ok(!P.isCacheableResponse(res({vary: '*'})), 'Vary: * is not cached');
ok(!P.isCacheableResponse(res({}, {status: 404})), '404 is not cached');
ok(!P.isCacheableResponse(res({}, {status: 206})), 'partial content is not cached');
ok(!P.isCacheableResponse(res({}, {type: 'opaque'})), 'opaque response is not cached');
ok(!P.isCacheableResponse(null), 'missing response is not cached');

// ---- versioning ----
ok(P.cacheName('abc') === 'usam-language-abc' && P.cacheName('abd') !== P.cacheName('abc'), 'cache name changes with the release id');
ok(P.PRECACHE.includes('/offline.html'), 'offline page is precached at install');
ok(!P.PRECACHE.includes('/'), 'the app shell page is not precached');

// ---- static wiring ----
const sw = await readFile(new URL('../client/public/sw.js', import.meta.url), 'utf8');
ok(sw.includes("'__BUILD_ID__'"), 'sw.js carries the build-id placeholder replaced at build time');
ok(/type === 'clear-caches'/.test(sw), 'sw.js handles the clear-caches message');
ok(/mode === 'navigate'/.test(sw) && sw.includes('/offline.html'), 'sw.js serves the offline page for failed navigations');
const off = await readFile(new URL('../client/public/offline.html', import.meta.url), 'utf8');
ok(/[\u0600-\u06FF]/.test(off) && /You are offline/.test(off), 'offline page has Arabic and English text');
ok(/lang="ar"[^>]*dir="rtl"/.test(off) && /lang="en"[^>]*dir="ltr"/.test(off), 'offline page sets language and direction per section');
ok(!/<script(?![^>]*\bsrc=)/.test(off), 'offline page has no inline script (CSP script-src self)');
for (const f of ['Admin.jsx', 'Customer.jsx']) {
  const src = await readFile(new URL('../client/src/' + f, import.meta.url), 'utf8');
  ok(/clearSwCaches\(\)/.test(src), `${f} clears service-worker caches on sign-out`);
}

if (failures) { console.error(`\nService worker policy tests FAILED (${failures}).`); process.exit(1); }
console.log('\nService worker policy tests passed.');
