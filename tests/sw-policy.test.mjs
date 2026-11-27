// Service worker cache policy (U-5): decisions are pure functions in client/public/sw-policy.js, so no browser is needed.
// Also checks the static pieces: sw.js wiring, the bilingual offline page, and that logout code clears caches.
import {readFile, readdir} from 'node:fs/promises';

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

// HTML answered to an asset request is the app shell or an error page, not an asset
for (const d of ['script', 'style', 'font', 'image']) ok(!P.isCacheableResponse(res({'content-type': 'text/html; charset=utf-8'}), d), `text/html answer to a ${d} request is not cached`);
ok(P.isCacheableResponse(res({'content-type': 'text/javascript'}), 'script'), 'a real script response is cacheable');
ok(P.isCacheableResponse(res({'content-type': 'text/html'}), ''), 'the content-type rule applies to asset destinations only (offline.html has none)');

// ---- sign-out keeps the install-time files ----
for (const p of P.PRECACHE) ok(P.isPrecachedPath(p), `${p} survives sign-out`);
ok(!P.isPrecachedPath('/assets/index-abc.js') && !P.isPrecachedPath('/'), 'everything else is removed on sign-out');

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
ok((off.match(/<script/g) || []).length === 1 && /<script src="\/offline\.js"><\/script>/.test(off), 'offline.js is the only script on the offline page');
// two retry buttons, each inside its own language section and carrying its own lang
const arSection = off.match(/<section lang="ar" dir="rtl">[\s\S]*?<\/section>/)?.[0] || '', enSection = off.match(/<section lang="en" dir="ltr">[\s\S]*?<\/section>/)?.[0] || '';
ok(/<button[^>]*id="retry-ar"[^>]*lang="ar"[^>]*>[\u0600-\u06FF ]+<\/button>/.test(arSection), 'the Arabic section has its own Arabic retry button with lang="ar"');
ok(/<button[^>]*id="retry-en"[^>]*lang="en"[^>]*>[A-Za-z ]+<\/button>/.test(enSection), 'the English section has its own English retry button with lang="en"');
ok(!/id="retry"/.test(off) && (off.match(/<button/g) || []).length === 2, 'the old single bilingual button is gone (exactly two buttons)');
const status = off.match(/<div id="retry-status"[^>]*>[\s\S]*?<\/div>/)?.[0] || '';
ok(/role="status"/.test(status) && /aria-live="polite"/.test(status), 'the still-offline lines sit in a role="status" container with aria-live polite');
ok(/<p id="still-ar" lang="ar" dir="rtl" hidden>[\u0600-\u06FF ،.]+<\/p>/.test(status) && /<p id="still-en" lang="en" dir="ltr" hidden>[A-Za-z ,.]+<\/p>/.test(status), 'the still-offline line exists in Arabic (lang="ar") and English (lang="en"), hidden until needed');
const offJs = await readFile(new URL('../client/public/offline.js', import.meta.url), 'utf8');
ok(/getElementById\('retry-ar'\)|'retry-ar'/.test(offJs) && /'retry-en'/.test(offJs) && /location\.reload\(\)/.test(offJs) && /still-ar/.test(offJs) && /still-en/.test(offJs), 'offline.js wires both buttons, reloads when back online, and shows both still-offline lines otherwise');
ok(/isPrecachedPath\(new URL\(r\.url\)\.pathname\)/.test(sw), 'sw.js keeps the precached files when clearing');
const bundle = await readdir(new URL('../client/src/', import.meta.url));
// Every file with a sign-out path must call clearSwCaches() once per path. Sign-out paths: admin logout, admin
// session lost (onAuthLost), learner logout, learner account deletion.
const TRIGGER = /auth\/logout|customerApi\('logout'|customerApi\('account','DELETE'|const onAuthLost =/g;
const EXPECT = {'Admin.jsx': 2, 'Customer.jsx': 2};
for (const f of bundle.filter(n => /\.jsx?$/.test(n) && n !== 'swCache.js')) {
  const src = await readFile(new URL('../client/src/' + f, import.meta.url), 'utf8');
  const triggers = (src.match(TRIGGER) || []).length, calls = (src.match(/clearSwCaches\(\)/g) || []).length;
  ok(triggers === (EXPECT[f] ?? 0), `${f}: ${triggers} sign-out path(s) found (expected ${EXPECT[f] ?? 0})`);
  ok(calls === triggers, `${f}: clearSwCaches() called ${calls} time(s) for ${triggers} sign-out path(s)`);
}
ok(/const onAuthLost = useCallback\(\(\) => \{ clearSwCaches\(\)/.test(await readFile(new URL('../client/src/Admin.jsx', import.meta.url), 'utf8')), 'Admin onAuthLost clears caches');

// ---- build output (dist/ is built by `pretest` when missing) ----
const dist = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8').catch(() => null);
ok(dist !== null, 'dist/sw.js exists after the build');
if (dist !== null) {
  ok(!dist.includes('__BUILD_ID__'), 'dist/sw.js has no __BUILD_ID__ placeholder left');
  ok(/const RELEASE = '[A-Za-z0-9._-]+';/.test(dist), 'dist/sw.js carries a concrete release id');
}

if (failures) { console.error(`\nService worker policy tests FAILED (${failures}).`); process.exit(1); }
console.log('\nService worker policy tests passed.');
