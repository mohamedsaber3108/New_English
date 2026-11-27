// Service worker safety in a real browser (U-5): a learner signs in, signs out, goes offline, and opens private routes.
// Expected: the bilingual offline page is shown, no private content, and nothing private sits in the caches.
// Needs `npm run build:app` (the worker registers in production builds only) and Chrome/Edge (or CHROME_PATH).
import {spawn} from 'node:child_process';
import {mkdtemp, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright-core';
import {freePort, stopServer} from '../helpers.mjs';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = () => randomBytes(32).toString('hex'); // generated per run, never a literal (secret scan)
const PW = rnd(), RUN = 'sw' + Date.now();
const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
let exe = null; for (const p of CANDIDATES) { try { await access(p); exe = p; break; } catch {} }
if (!exe) { console.log('sw-offline.e2e: no Chrome/Edge found (set CHROME_PATH) — skipping. CI sets CHROME_PATH, so this test runs there.'); process.exit(0); }
try { await access('dist/index.html'); } catch { console.error('sw-offline.e2e: dist/ missing — run `npm run build:app` first.'); process.exit(1); }

const dir = await mkdtemp(join(tmpdir(), 'usam-sw-'));
const env = {...process.env, NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '', CUSTOMER_DB_FILE: join(dir, 'db.json'), LEADS_FILE: join(dir, 'l.jsonl'), RATE_LIMIT_PREFIX: RUN, AUTH_IP_LIMIT: '1000', AUDIT_HMAC_KEY: rnd()};
const PRECACHED = ['/offline.html', '/offline.js', '/manifest.webmanifest', '/brand/language-mark.svg'];
let server, browser;
try {
  const port = await freePort();
  server = spawn(process.execPath, ['server/index.js'], {env: {...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const o = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(o + '/api/health')).ok) break; } catch {} await sleep(100); }

  // register the learner through the API and hand the session cookie to the browser
  const NAME = 'Sally Swlearner', email = `sw-${RUN}@example.com`;
  const reg = await fetch(o + '/api/customer/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: NAME, email, phone: '01000000000', password: PW})});
  const [cname, ...cval] = (reg.headers.get('set-cookie') || '').split(';')[0].split('=');
  ok(reg.status < 300 && !!cname, 'learner registered through the API');

  browser = await chromium.launch({executablePath: exe, headless: true});
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}});
  await ctx.addInitScript(() => { try { localStorage.setItem('usam.language.consent', JSON.stringify({necessary: true, analytics: false})); } catch {} });
  await ctx.addCookies([{name: cname, value: cval.join('='), url: o}]);
  const page = await ctx.newPage();

  // signed in: the private account view shows the learner
  await page.goto(o + '/#account');
  await page.locator('.c-welcome').waitFor({timeout: 15000});
  ok((await page.locator('.c-welcome').innerText()).includes(email), 'signed in: the account page shows the learner');

  // the worker installs, precaches the offline page and takes control
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, {timeout: 15000});
  ok(true, 'the service worker controls the page');
  const cached = () => page.evaluate(async () => { const out = []; for (const k of await caches.keys()) { const c = await caches.open(k); for (const r of await c.keys()) out.push(new URL(r.url).pathname); } return out; });
  await page.waitForFunction(async () => !!(await caches.match('/offline.html')), null, {timeout: 15000});
  const before = await cached();
  ok(before.includes('/offline.html'), 'the offline page was cached at install');
  ok(!before.some(p => p === '/' || p.startsWith('/api') || p.startsWith('/admin') || p.startsWith('/account') || p.startsWith('/customer')), 'no page or private path is in the cache while signed in');

  // sign out through the UI
  await page.locator('.c-welcome').getByRole('button', {name: /خروج/}).click();
  await page.locator('.c-auth').waitFor({timeout: 15000});
  ok(true, 'signed out through the account page');
  let after = [];
  for (let i = 0; i < 50; i++) { after = await cached(); if (after.every(p => PRECACHED.includes(p))) break; await sleep(100); }
  ok(after.every(p => PRECACHED.includes(p)), `after sign-out only install-time files remain cached (${after.join(', ') || 'none'})`);
  ok(after.includes('/offline.html'), 'the offline page is still cached after sign-out');

  // offline: private routes show the bilingual offline page and nothing private
  await ctx.setOffline(true);
  for (const path of ['/account', '/admin', '/customer/orders']) {
    await page.goto(o + path, {waitUntil: 'domcontentloaded'});
    const text = await page.locator('body').innerText();
    ok(text.includes('لا يوجد اتصال') && text.includes('You are offline'), `offline ${path}: the Arabic and English offline page is shown`);
    ok(!text.includes(NAME) && !text.includes(email), `offline ${path}: no private content is shown`);
  }
  // the offline page has one retry button per language, each with its own lang
  ok(await page.locator('section[lang="ar"][dir="rtl"] button#retry-ar[lang="ar"]').count() === 1 && /[\u0600-\u06FF]/.test(await page.locator('#retry-ar').innerText()), 'offline page: Arabic retry button inside the Arabic section, lang="ar", Arabic label');
  ok(await page.locator('section[lang="en"][dir="ltr"] button#retry-en[lang="en"]').count() === 1 && /^[A-Za-z ]+$/.test((await page.locator('#retry-en').innerText()).trim()), 'offline page: English retry button inside the English section, lang="en", English label');
  ok(await page.locator('#still-ar').isHidden() && await page.locator('#still-en').isHidden(), 'offline page: the still-offline lines are hidden before retry');
  // retry while still offline: a "still offline" line appears in BOTH languages inside the role=status region
  for (const btn of ['#retry-ar', '#retry-en']) {
    await page.locator(btn).click();
    await page.locator('#still-ar').waitFor({state: 'visible', timeout: 10000});
    ok(await page.locator('#retry-status[role="status"][aria-live="polite"] #still-ar[lang="ar"]').isVisible() && await page.locator('#retry-status #still-en[lang="en"]').isVisible(), `offline page: clicking ${btn} while offline shows the still-offline line in Arabic and English in the role=status region`);
    ok(/ما زلت غير متصل/.test(await page.locator('#still-ar').innerText()) && /still offline/.test(await page.locator('#still-en').innerText()), `offline page: after ${btn} the Arabic line is Arabic and the English line is English`);
  }
  await ctx.setOffline(false);
  // back online: retry reloads the page and the offline page is gone
  await page.locator('#retry-en').click();
  await page.waitForFunction(() => !document.getElementById('retry-en'), null, {timeout: 15000});
  ok(true, 'back online: retry reloads the page (the offline page is replaced)');
} finally {
  if (browser) await browser.close();
  if (server) await stopServer(server);
}
if (failures) { console.error(`\nService worker e2e FAILED (${failures}).`); process.exit(1); }
console.log('\nService worker e2e passed.');
