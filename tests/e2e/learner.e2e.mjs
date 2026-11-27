// Learner journey in a real browser against the real built frontend + server (embedded PGlite).
// register -> onboarding + placement -> writing practice -> progress is saved on the SERVER (survives a new browser
// profile) -> subscription gate -> manual payment activation -> receipt -> data export -> account deletion.
// Every UI step is cross-checked through the HTTP API. Requires `npm run build:app` and Chrome/Edge (or CHROME_PATH).
import {spawn} from 'node:child_process';
import {mkdtemp, rm, access, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {freePort, stopServer} from '../helpers.mjs';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PW = 'correct-horse-battery-staple', RUN = 'le' + Date.now();
const CANDIDATES = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
let exe = null; for (const p of CANDIDATES) { try { await access(p); exe = p; break; } catch {} }
if (!exe) { console.log('learner.e2e: no Chrome/Edge found (set CHROME_PATH) — skipping.'); process.exit(0); }
try { await access('dist/index.html'); } catch { console.error('learner.e2e: dist/ missing — run `npm run build:app` first.'); process.exit(1); }

const dir = await mkdtemp(join(tmpdir(), 'usam-le-'));
const env = {...process.env, NODE_ENV: 'test', DATABASE_URL: '', REDIS_URL: '', CUSTOMER_DB_FILE: join(dir, 'db.json'), LEADS_FILE: join(dir, 'l.jsonl'), RATE_LIMIT_PREFIX: RUN, AUTH_IP_LIMIT: '1000', AUDIT_HMAC_KEY: 'le-audit-key-0123456789', ACCESS_ENFORCEMENT: 'enforced'};
const cli = (args, extra) => new Promise(r => { const p = spawn(process.execPath, args, {env: {...env, ...extra}, stdio: 'ignore'}); p.on('exit', r); });
let server, browser;
try {
  const ownerEmail = `owner-${RUN}@example.com`, email = `learner-${RUN}@example.com`;
  await cli(['scripts/create-admin.mjs', '--email', ownerEmail, '--name', 'Owner', '--role', 'owner'], {ADMIN_PASSWORD: PW});
  const port = await freePort();
  server = spawn(process.execPath, ['server/index.js'], {env: {...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const o = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(o + '/api/health')).ok) break; } catch {} await sleep(100); }
  const api = async (path, {method = 'GET', body, cookie} = {}) => { const r = await fetch(o + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined}); let d = {}; try { d = await r.json(); } catch {} return {status: r.status, data: d, cookie: (r.headers.get('set-cookie') || '').split(';')[0]}; };

  browser = await chromium.launch({executablePath: exe, headless: true});
  const ctx = await browser.newContext({viewport: {width: 1366, height: 900}, acceptDownloads: true});
  await ctx.addInitScript(() => { try { localStorage.setItem('usam.language.consent', JSON.stringify({necessary: true, analytics: false})); } catch {} });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/40[1-4]|Failed to load resource/.test(m.text())) errors.push(m.text()); });

  // ---- register through the account page ----
  await page.goto(o + '/#account');
  await page.getByRole('button', {name: 'حساب جديد'}).click();
  const form = page.locator('.c-auth form');
  await form.locator('input[autocomplete=name]').fill('Layla Learner');
  await form.locator('input[type=tel]').fill('01000000000');
  await form.locator('input[type=email]').fill(email);
  await form.locator('input[type=password]').fill(PW);
  await form.locator('button[type=submit]').click();
  await page.locator('.c-welcome').waitFor({timeout: 15000});
  ok(true, 'registration through the account page signs the learner in');

  // ---- enforced deployment: no subscription -> the learning space asks for a plan ----
  await page.goto(o + '/#home');
  await page.getByText('ابدأ اشتراك الإنجليزية').waitFor({timeout: 10000});
  ok(true, 'without a subscription, the learning space shows the subscription gate (not the paid content)');

  // ---- buy a plan (no payment provider configured -> recorded for manual confirmation) ----
  await page.goto(o + '/#account');
  await page.locator('.c-plans .m-action').first().click();
  await page.locator('.c-message').filter({hasText: 'USL-'}).waitFor({timeout: 10000});
  const orderRef = (await page.locator('.c-message').innerText()).match(/USL-[A-F0-9-]{12}/)?.[0];
  ok(!!orderRef, `ordering a plan creates an order (${orderRef}) awaiting payment confirmation`);

  // ---- staff confirm the payment (admin API, same rules as the console) ----
  const admin = await api('/api/admin/auth/login', {method: 'POST', body: {email: ownerEmail, password: PW}});
  const act = await api(`/api/admin/orders/${orderRef}/activate`, {method: 'POST', cookie: admin.cookie, body: {paymentReference: 'BANK-' + RUN, reason: 'transfer reconciled in e2e'}});
  ok(act.status === 200, 'staff activate the reconciled payment');

  // ---- receipt (previously an alert box) ----
  await page.reload();
  await page.getByRole('button', {name: 'عرض الإيصال'}).click();
  await page.locator('#c-receipt').waitFor({timeout: 10000});
  ok(/مدفوع/.test(await page.locator('#c-receipt').innerText()) && (await page.locator('#c-receipt').innerText()).includes(orderRef), 'the receipt renders as a printable card with the order reference and status');

  // ---- onboarding + placement inside the learning space ----
  await page.goto(o + '/#home');
  const onboarding = page.locator('.onboarding');
  await onboarding.waitFor({timeout: 10000});
  await onboarding.locator('input').first().fill('Layla');
  await onboarding.getByRole('button', {name: /Find my starting point/}).click();
  for (let i = 0; i < 6; i++) {
    await onboarding.locator('.answer-options button').first().waitFor({timeout: 10000});
    await onboarding.locator('.answer-options button').first().click();
    await onboarding.getByRole('button', {name: /Next question|See my path/}).click();
  }
  await onboarding.getByRole('button', {name: /Enter my learning space/}).click();
  await page.locator('.dashboard').waitFor({timeout: 10000});
  ok(true, 'onboarding and the 6-question placement complete in the browser');
  const cookie = (await ctx.cookies()).filter(c => c.name === 'usam_session').map(c => `${c.name}=${c.value}`)[0];
  const assess = await api('/api/customer/learning/assessments', {cookie});
  ok(assess.data.assessments?.length === 1, 'API confirms: the placement result was stored on the server');

  // ---- writing practice -> recorded server-side ----
  await page.goto(o + '/#writing');
  await page.locator('textarea[aria-label="Your writing"]').fill('Yesterday I go to the airport and I is very happy because my flight was on time');
  await page.getByRole('button', {name: /Review my writing/}).click();
  await page.locator('.writing-feedback').waitFor({timeout: 10000});
  ok(/past/i.test(await page.locator('.writing-feedback').innerText()), 'writing feedback flags the past-tense issue');
  let me = {};
  for (let i = 0; i < 20; i++) { me = (await api('/api/customer/me', {cookie})).data.profile || {}; if (me.xp >= 25) break; await sleep(250); }
  ok(me.xp === 25 && me.sessions?.[0]?.id === 'writing' && me.evidence?.Writing === 1, 'API confirms: the writing session was recorded on the server (+25 XP, Writing evidence)');

  // ---- progress follows the account to a NEW browser profile (no localStorage) ----
  const ctx2 = await browser.newContext({viewport: {width: 1366, height: 900}});
  await ctx2.addInitScript(() => { try { localStorage.setItem('usam.language.consent', JSON.stringify({necessary: true, analytics: false})); } catch {} });
  const p2 = await ctx2.newPage();
  await p2.goto(o + '/#account');
  const f2 = p2.locator('.c-auth form');
  await f2.locator('input[type=email]').fill(email);
  await f2.locator('input[type=password]').fill(PW);
  await f2.locator('button[type=submit]').click();
  await p2.locator('.c-welcome').waitFor({timeout: 10000});
  await p2.goto(o + '/#progress');
  await p2.locator('.progress-overview').waitFor({timeout: 10000});
  const ptext = await p2.locator('.progress-overview').innerText();
  ok(/25/.test(ptext) && !(await p2.locator('.onboarding').count()), 'on a fresh browser profile the progress page shows the server-side XP and onboarding is not repeated');
  await ctx2.close();

  // ---- data export from Settings ----
  await page.goto(o + '/#settings');
  const [download] = await Promise.all([page.waitForEvent('download', {timeout: 15000}), page.getByRole('button', {name: /Export JSON/}).click()]);
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  ok(exported.format === 'usam-language-export/1' && exported.activities.length === 1 && exported.orders.length === 1 && exported.assessments.length === 1 && !JSON.stringify(exported).includes('"password"'), 'Settings > Export downloads the full server-side data export (no password)');

  // ---- account deletion (previously a browser prompt) ----
  await page.goto(o + '/#account');
  await page.getByRole('button', {name: /حذف حسابي/}).click();
  await page.locator('.c-delete input[type=password]').fill(PW);
  await page.getByRole('button', {name: /تأكيد حذف الحساب/}).click();
  await page.getByText('تم حذف الحساب').waitFor({timeout: 10000});
  ok((await api('/api/customer/login', {method: 'POST', body: {email, password: PW}})).status === 401, 'account deletion through the inline form removes the account (login now fails)');

  // ---- mobile layout ----
  const m = await browser.newContext({viewport: {width: 390, height: 844}});
  const mp = await m.newPage();
  for (const r of ['landing', 'pricing', 'account', 'payment-result']) {
    await mp.goto(o + '/#' + r); await sleep(400);
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    ok(overflow <= 1, `no horizontal overflow on a 390px phone: #${r} (${overflow}px)`);
  }
  await m.close();
  ok(errors.length === 0, `no browser errors (${errors.length})${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
} catch (e) { console.error('  FAIL: unexpected error', e.message.split('\n')[0], '|', (e.stack || '').split('\n').find(l => l.includes('.e2e.mjs')) || ''); failures++; }
finally {
  try { await browser?.close(); } catch {}
  if (server) await stopServer(server);
  await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}
if (failures) { console.error(`\nLearner E2E FAILED (${failures}).`); process.exit(1); }
console.log('\nLearner E2E passed.');
process.exit(0);
