// Accessibility check with axe-core on the 8 main pages (E-1b), in a real browser against the built app.
// Fails on any violation with impact "critical". "serious" and "moderate" are only counted and printed as a baseline
// (`a11y baseline: <page> critical=0 serious=N moderate=N minor=N`) so later work can show them going down.
// Each page is checked in its own language: the marketing pages and the admin sign-in are Arabic (rtl), the coach is English (ltr);
// no page exists in both languages today. Rule set: WCAG 2.0/2.1/2.2 A and AA tags of axe-core.
// Needs `npm run build:app`, Chrome/Edge (or CHROME_PATH) and the dev dependency axe-core; skips with a message without a browser.
import {spawn} from 'node:child_process';
import {mkdtemp, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright-core';
import {freePort, stopServer} from '../helpers.mjs';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = () => randomBytes(32).toString('hex'); // generated per run, never a literal (secret scan)
const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
let exe = null; for (const p of CANDIDATES) { try { await access(p); exe = p; break; } catch {} }
if (!exe) { console.log('a11y.e2e: no Chrome/Edge found (set CHROME_PATH) — skipping. CI sets CHROME_PATH, so this test runs there.'); process.exit(0); }
try { await access('dist/index.html'); } catch { console.error('a11y.e2e: dist/ missing — run `npm run build:app` first.'); process.exit(1); }
let axePath;
try { axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js'); } catch { console.error('a11y.e2e: axe-core is not installed — run `npm ci`.'); process.exit(1); }

// route -> what the page is called in the report and the language it must be in
const PAGES = [
  ['landing', 'landing', 'ar'], ['pricing', 'pricing', 'ar'], ['method', 'method', 'ar'], ['groups', 'groups', 'ar'],
  ['contact', 'contact', 'ar'], ['account', 'account', 'ar'], ['coach', 'coach', 'en'], ['admin', 'admin-signin', 'ar'],
];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const dir = await mkdtemp(join(tmpdir(), 'usam-ax-'));
const env = {...process.env, NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '', CUSTOMER_DB_FILE: join(dir, 'db.json'), LEADS_FILE: join(dir, 'l.jsonl'), RATE_LIMIT_PREFIX: 'ax' + Date.now(), AUDIT_HMAC_KEY: rnd(), ACCESS_ENFORCEMENT: 'open'};
let server, browser;
try {
  const port = await freePort();
  server = spawn(process.execPath, ['server/index.js'], {env: {...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const o = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(o + '/api/health')).ok) break; } catch {} await sleep(100); }
  browser = await chromium.launch({executablePath: exe, headless: true});
  // bypassCSP: the app's CSP (script-src 'self') would block the injected axe script; the CSP itself is tested elsewhere.
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}, bypassCSP: true, reducedMotion: 'reduce'});
  await ctx.addInitScript(() => { try { localStorage.setItem('usam.language.consent', JSON.stringify({necessary: true, analytics: false})); } catch {} });
  const page = await ctx.newPage();
  let total = {critical: 0, serious: 0, moderate: 0, minor: 0};
  for (const [route, name, lang] of PAGES) {
    await page.goto(o + '/#' + route);
    await page.waitForFunction(() => document.querySelector('#root h1, #root h2'), null, {timeout: 20000});
    await sleep(900); // let the page finish rendering (lazy admin chunk, fonts)
    ok(await page.evaluate(() => document.documentElement.lang) === lang, `${name}: page language is ${lang}`);
    if (!await page.evaluate(() => typeof window.axe === 'object')) await page.addScriptTag({path: axePath});
    const found = await page.evaluate(tags => window.axe.run(document, {runOnly: {type: 'tag', values: tags}, resultTypes: ['violations']}).then(r => r.violations.map(v => ({id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, first: (v.nodes[0]?.target || []).join(' ').slice(0, 120)}))), TAGS);
    const count = impact => found.filter(v => v.impact === impact).length;
    const c = {critical: count('critical'), serious: count('serious'), moderate: count('moderate'), minor: count('minor')};
    for (const k of Object.keys(total)) total[k] += c[k];
    console.log(`a11y baseline: ${name} critical=${c.critical} serious=${c.serious} moderate=${c.moderate}${c.minor ? ' minor=' + c.minor : ''}`);
    for (const v of found.filter(x => x.impact === 'serious' || x.impact === 'critical')) console.log(`    ${v.impact}: ${v.id} (${v.nodes} element${v.nodes === 1 ? '' : 's'}) - ${v.help}; first: ${v.first}`);
    ok(c.critical === 0, `${name}: no critical accessibility violation${c.critical ? ' - ' + found.filter(v => v.impact === 'critical').map(v => v.id).join(', ') : ''}`);
  }
  console.log(`a11y baseline: TOTAL critical=${total.critical} serious=${total.serious} moderate=${total.moderate} minor=${total.minor} on ${PAGES.length} pages`);
} catch (e) { console.error('  FAIL: unexpected error', e); failures++; }
finally {
  if (browser) await browser.close();
  if (server) await stopServer(server);
  await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}
if (failures) { console.error(`\nAccessibility e2e FAILED (${failures}).`); process.exit(1); }
console.log('\nAccessibility e2e passed.');
