// U-1 (language and direction per page) and U-3 (reduced motion): the pure parts, without a browser.
// The browser checks are in tests/e2e/lang-motion.e2e.mjs.
import {readFile, readdir} from 'node:fs/promises';
import {pageMeta, applyPageMeta, routeOf, ARABIC_PAGES, ADMIN_LANG, WORKSPACE_PAGES, EN_EXTRA_ROUTES} from '../client/src/pageMeta.js';
import {motionBehavior} from '../client/src/motion.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const hasArabic = s => /[\u0600-\u06FF]/.test(s);
const read = p => readFile(new URL('../client/' + p, import.meta.url), 'utf8');

// ---- language, direction, title per route ----
console.log('-- page meta');
for (const page of ['landing', 'pricing', 'account', 'contact', 'privacy']) {
  const m = pageMeta(page);
  ok(m.lang === 'ar' && m.dir === 'rtl' && hasArabic(m.title) && hasArabic(m.description), `${page}: Arabic page -> lang ar, dir rtl, Arabic title and description`);
}
for (const page of ['home', 'path', 'coach', 'practice', 'world', 'review', 'progress']) {
  const m = pageMeta(page);
  ok(m.lang === 'en' && m.dir === 'ltr' && !hasArabic(m.title) && !hasArabic(m.description) && /USAM Language/.test(m.title), `${page}: workspace page -> lang en, dir ltr, English title and description`);
}
ok(new Set(['home', 'path', 'coach', 'practice', 'world', 'review', 'progress'].map(p => pageMeta(p).title)).size === 7, 'each side-menu page has its own title');
{
  const titles = WORKSPACE_PAGES.map(p => pageMeta(p).title);
  ok(WORKSPACE_PAGES.length === 13 && new Set(titles).size === WORKSPACE_PAGES.length, `all ${WORKSPACE_PAGES.length} workspace routes (menu + pronunciation, writing, story, group, settings, engines) have a unique title`);
  ok(WORKSPACE_PAGES.every(p => pageMeta(p).lang === 'en' && pageMeta(p).dir === 'ltr' && !hasArabic(pageMeta(p).title) && !/^Learn English/.test(pageMeta(p).title)), 'no workspace route falls back to the generic title');
  const arabicTitles = [...ARABIC_PAGES.filter(p => !['forgot-password', 'reset-password', 'verify-email', 'payment-result'].includes(p)), 'admin'].map(p => pageMeta(p).title);
  ok(new Set([...titles, ...arabicTitles]).size === titles.length + arabicTitles.length, 'no Arabic page title equals another page title');
  // the table must agree with the breadcrumb names shown by main.jsx
  const bc = (await read('src/main.jsx')).match(/\(\{pronunciation:'([^']+)',writing:'([^']+)',story:'([^']+)',group:'([^']+)',settings:'([^']+)',engines:'([^']+)'\}\)\[page\]/);
  ok(bc && JSON.stringify(Object.values(EN_EXTRA_ROUTES)) === JSON.stringify(bc.slice(1)), 'the extra workspace titles match the breadcrumb names in main.jsx');
}
ok(pageMeta('landing').title !== pageMeta('pricing').title && pageMeta('pricing').title !== pageMeta('faq').title, 'each Arabic page has its own title');
ok(pageMeta('no-such-page').lang === 'en' && pageMeta(undefined).lang === 'ar' && pageMeta('').title === pageMeta('landing').title, 'an unknown route is the English workspace; an empty route is the landing page');
const admin = pageMeta('admin');
ok(ADMIN_LANG === 'ar' ? admin.lang === 'ar' && admin.dir === 'rtl' && hasArabic(admin.title) : admin.lang === 'en' && admin.dir === 'ltr' && !hasArabic(admin.title), `admin: page language follows ADMIN_LANG (${ADMIN_LANG}), and lang, dir and title agree`);
ok([...ARABIC_PAGES, 'admin', 'home', 'coach', 'zzz'].every(p => { const m = pageMeta(p); return (m.lang === 'ar') === (m.dir === 'rtl') && (m.lang === 'ar') === hasArabic(m.description); }), 'for every route lang, dir and description language agree (they cannot drift apart)');
ok(routeOf('#coach') === 'coach' && routeOf('#reset-password/abc123') === 'reset-password' && routeOf('#account?x=1') === 'account' && routeOf('') === 'landing' && routeOf('#') === 'landing', 'routeOf reads the route name from a location hash');

// ---- applyPageMeta moves lang, dir, title and description together ----
const fakeDoc = () => {
  const attrs = {}, metas = [];
  const doc = {title: '', head: {appendChild: m => metas.push(m)}, documentElement: {setAttribute: (k, v) => { attrs[k] = v; }},
    createElement: () => { const a = {}; return {setAttribute: (k, v) => { a[k] = v; }, a}; },
    querySelector: sel => (sel === 'meta[name="description"]' ? (metas[0] ? {setAttribute: (k, v) => { metas[0].a[k] = v; }} : null) : null)};
  return {doc, attrs, metas};
};
{
  const {doc, attrs, metas} = fakeDoc();
  applyPageMeta('pricing', doc);
  ok(attrs.lang === 'ar' && attrs.dir === 'rtl' && hasArabic(doc.title) && metas.length === 1 && hasArabic(metas[0].a.content), 'applyPageMeta(pricing) sets lang, dir, title and a description together (creating the meta tag if missing)');
  applyPageMeta('coach', doc);
  ok(attrs.lang === 'en' && attrs.dir === 'ltr' && /^Coach|AI coach/.test(doc.title) && metas.length === 1 && !hasArabic(metas[0].a.content), 'applyPageMeta(coach) switches all four to English and reuses the same meta tag');
}

// ---- wiring in the client ----
console.log('-- wiring');
const html = await read('index.html'), main = await read('src/main.jsx'), marketing = await read('src/Marketing.jsx');
ok(/<html lang="ar" dir="rtl">/.test(html) && /<title>[^<]*[\u0600-\u06FF][^<]*<\/title>/.test(html), 'index.html starts as the Arabic landing page (lang ar, dir rtl, Arabic title), the default route');
ok(/applyPageMeta\(page\)\},\[page\]\)/.test(main) && /applyPageMeta\(routeOf\(location\.hash\)\)/.test(main), 'main.jsx applies the page meta on every route change and once before the first render');
ok(!/document\.title\s*=/.test(marketing) && !/document\.documentElement\.lang/.test(main), 'there is one place that sets the title and the language (no second writer)');

// ---- reduced motion ----
console.log('-- reduced motion');
const cssFiles = (await readdir(new URL('../client/src/', import.meta.url))).filter(f => f.endsWith('.css'));
for (const f of ['styles.css', 'customer.css', 'admin.css']) {
  const css = (await read('src/' + f)).replace(/\s+/g, '');
  ok(/@media\(prefers-reduced-motion:reduce\)\{\*,\*(:|::)before,\*(:|::)after\{animation:none!important;transition:none!important;scroll-behavior:auto!important\}\}/.test(css), `${f}: reduced motion removes every animation and transition and smooth scrolling`);
}
let animations = 0, tooFast = [];
for (const f of cssFiles) {
  const css = await read('src/' + f);
  for (const m of css.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)(ms|s)\b[^;}]*/g)) {
    if (m[1] === 'none') continue;
    animations++;
    const ms = Number(m[2]) * (m[3] === 's' ? 1000 : 1);
    if (/infinite/.test(m[0]) && ms < 334) tooFast.push(`${f}: ${m[0]}`); // a loop shorter than a third of a second flashes more than 3 times a second
  }
}
ok(animations >= 3, `found ${animations} animation declarations to check`);
ok(tooFast.length === 0, `no repeating animation runs faster than 3 times a second${tooFast.length ? ': ' + tooFast.join('; ') : ''}`);
const jsxFiles = (await readdir(new URL('../client/src/', import.meta.url))).filter(f => /\.jsx?$/.test(f) && f !== 'motion.js');
const smooth = (await Promise.all(jsxFiles.map(async f => [f, await read('src/' + f)]))).filter(([, src]) => /behavior:\s*['"]smooth['"]/.test(src)).map(([f]) => f);
ok(jsxFiles.length >= 8 && smooth.length === 0, `no script in any of the ${jsxFiles.length} client files asks for smooth scrolling directly (they use motionBehavior())${smooth.length ? ': ' + smooth.join(', ') : ''}`);
// nothing is hidden at rest and revealed only by an animation: no opacity:0 / visibility:hidden outside @keyframes and print rules
const stripBlocks = (css, re) => { let out = css, m; while ((m = re.exec(out))) { let i = out.indexOf('{', m.index), depth = 0, j = i; for (; j < out.length; j++) { if (out[j] === '{') depth++; else if (out[j] === '}' && --depth === 0) break; } out = out.slice(0, m.index) + out.slice(j + 1); re.lastIndex = 0; } return out; };
const hiddenAtRest = [];
for (const f of cssFiles) {
  const css = stripBlocks(stripBlocks(await read('src/' + f), /@keyframes\s+[\w-]+\s*\{/), /@media\s*print\s*\{/).replace(/\s+/g, '');
  if (/opacity:0(?![.\d])/.test(css) || /visibility:hidden/.test(css)) hiddenAtRest.push(f);
}
ok(hiddenAtRest.length === 0, `no stylesheet hides content at rest (opacity 0 / visibility hidden) outside keyframes and print${hiddenAtRest.length ? ': ' + hiddenAtRest.join(', ') : ''}`);
const adminSrc = await read('src/Admin.jsx');
ok((adminSrc.match(/dir="ltr"/g) || []).length > 20 && (adminSrc.match(/dir="ltr"/g) || []).length === (adminSrc.match(/lang="en" dir="ltr"/g) || []).length, 'Admin.jsx: every English-only fragment with dir="ltr" also says lang="en"');
globalThis.matchMedia = q => ({matches: /reduce/.test(q)});
ok(motionBehavior() === 'auto', 'with reduced motion on, scripted scrolling is instant');
globalThis.matchMedia = () => ({matches: false});
ok(motionBehavior() === 'smooth', 'with reduced motion off, scripted scrolling is smooth');
delete globalThis.matchMedia;
ok(motionBehavior() === 'smooth', 'without matchMedia (Node, old browsers) it falls back to smooth');

if (failures) { console.error(`\nPage meta / motion tests FAILED (${failures}).`); process.exit(1); }
console.log('\nPage meta / motion tests passed.');
