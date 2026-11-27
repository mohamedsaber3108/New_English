// Language, direction and title per page (U-1) and reduced motion (U-3) in a real browser against the built app.
// Needs `npm run build:app` and Chrome/Edge (or CHROME_PATH); skips with a message when no browser is found.
import {spawn} from 'node:child_process';
import {mkdtemp, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright-core';
import {freePort, stopServer} from '../helpers.mjs';
import {pageMeta} from '../../client/src/pageMeta.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = () => randomBytes(32).toString('hex'); // generated per run, never a literal (secret scan)
const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
let exe = null; for (const p of CANDIDATES) { try { await access(p); exe = p; break; } catch {} }
if (!exe) { console.log('lang-motion.e2e: no Chrome/Edge found (set CHROME_PATH) — skipping. CI sets CHROME_PATH, so this test runs there.'); process.exit(0); }
try { await access('dist/index.html'); } catch { console.error('lang-motion.e2e: dist/ missing — run `npm run build:app` first.'); process.exit(1); }

const dir = await mkdtemp(join(tmpdir(), 'usam-lm-'));
const RUN = 'lm' + Date.now();
const env = {...process.env, NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '', CUSTOMER_DB_FILE: join(dir, 'db.json'), LEADS_FILE: join(dir, 'l.jsonl'), RATE_LIMIT_PREFIX: RUN, AUDIT_HMAC_KEY: rnd(), ACCESS_ENFORCEMENT: 'open'};
let server, browser;
try {
  const port = await freePort();
  server = spawn(process.execPath, ['server/index.js'], {env: {...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const o = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(o + '/api/health')).ok) break; } catch {} await sleep(100); }
  browser = await chromium.launch({executablePath: exe, headless: true});
  const newPage = async opts => {
    const ctx = await browser.newContext({viewport: {width: 1280, height: 800}, ...opts});
    await ctx.addInitScript(() => { try { localStorage.setItem('usam.language.consent', JSON.stringify({necessary: true, analytics: false})); } catch {} });
    return ctx.newPage();
  };
  const state = page => page.evaluate(() => ({lang: document.documentElement.lang, dir: document.documentElement.dir, title: document.title, description: document.querySelector('meta[name="description"]')?.content || ''}));
  const go = async (page, route) => { await page.evaluate(r => { location.hash = r; }, route); await page.waitForFunction(t => document.title === t, pageMeta(route).title, {timeout: 10000}); };

  // ---- U-1: lang, dir, title and description follow the page, and move together on a route change ----
  const page = await newPage();
  await page.goto(o + '/#pricing');
  await page.waitForFunction(t => document.title === t, pageMeta('pricing').title, {timeout: 15000});
  let s = await state(page);
  ok(s.lang === 'ar' && s.dir === 'rtl' && s.title === pageMeta('pricing').title && s.description === pageMeta('pricing').description, `Arabic page /#pricing: lang=ar dir=rtl, Arabic title and description (${s.title})`);
  await go(page, 'account');
  s = await state(page);
  ok(s.lang === 'ar' && s.dir === 'rtl' && s.title === pageMeta('account').title, `Arabic page /#account: lang=ar dir=rtl, its own title (${s.title})`);
  await go(page, 'coach');
  s = await state(page);
  ok(s.lang === 'en' && s.dir === 'ltr' && s.title === pageMeta('coach').title && s.description === pageMeta('coach').description && !/[\u0600-\u06FF]/.test(s.title + s.description), `workspace /#coach: lang=en dir=ltr, English title and description (${s.title})`);
  await go(page, 'pricing');
  s = await state(page);
  ok(s.lang === 'ar' && s.dir === 'rtl' && /[\u0600-\u06FF]/.test(s.title + s.description), 'switching back to an Arabic page moves lang, dir, title and description together');
  const admin = pageMeta('admin');
  await go(page, 'admin');
  s = await state(page);
  ok(s.lang === admin.lang && s.dir === admin.dir && s.title === admin.title, `admin page: lang=${admin.lang} dir=${admin.dir} as set by pageMeta (its screens are written in that language)`);
  const direct = await newPage();
  await direct.goto(o + '/#coach');
  await direct.waitForFunction(t => document.title === t, pageMeta('coach').title, {timeout: 15000});
  s = await state(direct);
  ok(s.lang === 'en' && s.dir === 'ltr', 'opening the workspace directly is English left-to-right (no Arabic flash left in place)');

  // ---- U-3: with reduced motion emulated, nothing is animating on the main pages ----
  const calm = await newPage({reducedMotion: 'reduce'});
  ok(await calm.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'reduced motion is emulated in this browser context');
  for (const route of ['landing', 'pricing', 'account', 'coach', 'home', 'progress', 'admin', 'world', 'pronunciation']) {
    await calm.goto(o + '/#' + route);
    await calm.waitForFunction(t => document.title === t, pageMeta(route).title, {timeout: 15000});
    await sleep(700); // longer than the 350 ms page fade-in
    const running = await calm.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').map(a => a.animationName || a.transitionProperty || 'unknown'));
    ok(running.length === 0, `reduced motion: no running animation or transition on /#${route}${running.length ? ' (' + running.join(', ') + ')' : ''}`);
    if (route === 'landing') {
      // content must be visible without any animation: the main heading is fully opaque and shown
      const h1 = await calm.evaluate(() => { const e = document.querySelector('h1'); if (!e) return null; const c = getComputedStyle(e); return {opacity: c.opacity, visibility: c.visibility, display: c.display, text: e.textContent.trim().length}; });
      ok(h1 && h1.opacity === '1' && h1.visibility === 'visible' && h1.display !== 'none' && h1.text > 0, `reduced motion: the landing h1 is visible (opacity ${h1?.opacity}, visibility ${h1?.visibility})`);
    }
  }
  // the workspace routes that are not in the side menu have their own title too
  for (const route of ['pronunciation', 'writing', 'story', 'group', 'settings', 'engines']) {
    await calm.goto(o + '/#' + route);
    await calm.waitForFunction(t => document.title === t, pageMeta(route).title, {timeout: 15000});
    ok(true, `/#${route} has its own title (${pageMeta(route).title})`);
  }
} catch (e) { console.error('  FAIL: unexpected error', e); failures++; }
finally {
  if (browser) await browser.close();
  if (server) await stopServer(server);
  await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}
if (failures) { console.error(`\nLanguage/motion e2e FAILED (${failures}).`); process.exit(1); }
console.log('\nLanguage/motion e2e passed.');
