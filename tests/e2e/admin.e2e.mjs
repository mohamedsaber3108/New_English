// Browser end-to-end test of the operations console: real built frontend + real server + real browser.
// Requires a server-mode build (`npm run build:app`) and Chrome/Edge (or CHROME_PATH).
// Every UI action is cross-checked through the HTTP API so the test proves the UI changed real server state.
import {spawn} from 'node:child_process';
import {mkdtemp, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {freePort} from '../helpers.mjs';
import {totpAt} from '../../server/totp.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN = 'e2e' + Date.now();
const PW = 'correct-horse-battery-staple';
const CHROME = process.env.CHROME_PATH || ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];

async function findBrowser() {
  for (const p of [].concat(CHROME)) { try { await access(p); return p; } catch {} }
  return null;
}
const exe = await findBrowser();
if (!exe) { console.log('admin.e2e: no Chrome/Edge found (set CHROME_PATH) — skipping browser test.'); process.exit(0); }
try { await access('dist/index.html'); } catch { console.error('admin.e2e: dist/ missing — run `npm run build:app` first.'); process.exit(1); }

const dir = await mkdtemp(join(tmpdir(), 'usam-e2e-'));
const env = {...process.env, NODE_ENV: 'test', DATABASE_URL: '', CUSTOMER_DB_FILE: join(dir, 'db.json'), LEADS_FILE: join(dir, 'l.jsonl'), RATE_LIMIT_PREFIX: RUN, AUTH_IP_LIMIT: '1000', AUDIT_HMAC_KEY: 'e2e-audit-key-0123456789', ADMIN_MFA_KEY: 'e2e-mfa-key-0123456789abcdef', VITE_STATIC_PREVIEW: ''};
const run = (args, extra = {}) => new Promise(res => { const p = spawn(process.execPath, args, {env: {...env, ...extra}, stdio: ['ignore', 'pipe', 'pipe']}); let o = ''; p.stdout.on('data', d => o += d); p.stderr.on('data', d => o += d); p.on('exit', c => res({c, o})); });

let server, browser;
try {
  const ownerEmail = `owner-${RUN}@example.com`, viewerEmail = `viewer-${RUN}@example.com`;
  ok((await run(['scripts/create-admin.mjs', '--email', ownerEmail, '--name', 'Omar Owner', '--role', 'owner'], {ADMIN_PASSWORD: PW})).c === 0, 'bootstrap owner via CLI');
  ok((await run(['scripts/create-admin.mjs', '--email', viewerEmail, '--name', 'Vera Viewer', '--role', 'viewer'], {ADMIN_PASSWORD: PW})).c === 0, 'bootstrap viewer via CLI');
  const port = await freePort();
  server = spawn(process.execPath, ['server/index.js'], {env: {...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe']});
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(origin + '/api/health')).ok) break; } catch {} await sleep(100); }
  const api = async (path, {method = 'GET', body, cookie} = {}) => { const r = await fetch(origin + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined}); let d = {}; try { d = await r.json(); } catch {} return {status: r.status, data: d, cookie: (r.headers.get('set-cookie') || '').split(';')[0]}; };

  // Seed one learner with a manual-payment order, through the public API.
  const learnerEmail = `learner-${RUN}@example.com`;
  const reg = await api('/api/customer/register', {method: 'POST', body: {name: 'Laila Learner', email: learnerEmail, phone: '01000000000', password: PW}});
  const learner = reg.cookie;
  const order = (await api('/api/customer/orders', {method: 'POST', cookie: learner, body: {plan: 'essential', term: 'monthly', language: 'English'}})).data.reference;
  ok(!!order, 'seeded learner order ' + order);

  browser = await chromium.launch({executablePath: exe, headless: true});
  const ctx = await browser.newContext({viewport: {width: 1366, height: 900}, locale: 'ar-EG'});
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error' && !/401|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('dialog', d => d.accept());

  // ---- sign in through the UI ----
  await page.goto(origin + '/#admin');
  await page.locator('form.ad-login input[type=email]').fill(ownerEmail);
  await page.locator('form.ad-login input[type=password]').fill('wrong-password-000');
  await page.locator('form.ad-login button[type=submit]').click();
  ok(await page.getByText('البريد أو كلمة المرور غير صحيحة.').isVisible({timeout: 8000}).catch(() => false) || await page.getByText('البريد أو كلمة المرور غير صحيحة.').waitFor({timeout: 8000}).then(() => true, () => false), 'wrong password shows an error in the UI');
  await page.locator('form.ad-login input[type=password]').fill(PW);
  await page.locator('form.ad-login button[type=submit]').click();
  await page.getByRole('heading', {name: 'لوحة التشغيل'}).waitFor({timeout: 10000});
  ok(true, 'owner signs in through the login form');
  await page.locator('.ad-metric').first().waitFor({timeout: 10000});
  ok(await page.locator('.ad-metric').count() >= 8, 'overview shows operational metrics');
  ok(await page.getByText('بانتظار بيانات الاعتماد').first().isVisible(), 'overview reports unconfigured providers as awaiting credentials');
  const tabs = await page.locator('.ad-tabs button').allInnerTexts();
  ok(tabs.length === 7, `owner sees all 7 sections (${tabs.length})`);

  // ---- orders: activate the manual payment ----
  await page.getByRole('button', {name: /الطلبات والاشتراكات/}).click();
  await page.locator('.ad-search input').fill(learnerEmail);
  const orderRow = page.locator('.ad-table tbody tr', {hasText: order});
  await orderRow.waitFor({timeout: 10000});
  await orderRow.click();
  await page.getByRole('button', {name: 'تفعيل بعد التحقق من الدفع'}).click();
  const form = page.locator('form.ad-reason');
  await form.locator('input').first().fill('BANK-' + RUN);
  await form.locator('textarea').fill('Transfer matched in bank statement');
  await form.getByRole('button', {name: 'تأكيد'}).click();
  await page.getByText('تم تفعيل الطلب والاشتراك.').waitFor({timeout: 10000});
  ok(true, 'activation succeeds from the Orders screen');
  ok((await api('/api/feedback', {method: 'POST', cookie: learner, body: {text: 'Now I have access.'}})).status === 200, 'API confirms: the learner now has paid access');

  // ---- users: search, open detail, suspend ----
  await page.getByRole('button', {name: /المتعلمون/}).click();
  await page.locator('.ad-search input').fill(learnerEmail);
  const userRow = page.locator('.ad-table tbody tr', {hasText: learnerEmail});
  await userRow.waitFor({timeout: 10000});
  ok(await page.locator('.ad-table tbody tr').count() === 1, 'search narrows the user list to one learner');
  await userRow.click();
  await page.locator('.ad-detail h2', {hasText: 'Laila Learner'}).waitFor({timeout: 10000});
  ok(await page.locator('.ad-detail').getByText(order).isVisible(), 'user detail lists the learner\'s order');
  await page.getByRole('button', {name: 'إيقاف الحساب'}).click();
  await page.locator('form.ad-reason textarea').fill('Chargeback dispute under review');
  await page.locator('form.ad-reason').getByRole('button', {name: 'تأكيد'}).click();
  await page.getByText('تم إيقاف الحساب وإنهاء جلساته.').waitFor({timeout: 10000});
  ok(true, 'suspension succeeds from the Users screen');
  ok((await api('/api/customer/me', {cookie: learner})).status === 401, 'API confirms: the learner\'s session was ended');
  ok(await page.getByRole('button', {name: 'إعادة تفعيل الحساب'}).isVisible(), 'detail panel now offers reactivation');

  // ---- audit: verify the chain from the UI ----
  await page.getByRole('button', {name: /سجل التدقيق/}).click();
  await page.locator('.ad-table tbody tr', {hasText: 'order_manually_activated'}).first().waitFor({timeout: 10000});
  ok(await page.locator('.ad-table tbody tr', {hasText: 'user_status_changed'}).first().isVisible(), 'audit screen lists the suspension');
  await page.getByRole('button', {name: 'تحقق من السجل'}).click();
  await page.locator('.ad-verify-result.good').waitFor({timeout: 10000});
  ok(/سليم/.test(await page.locator('.ad-verify-result').innerText()), 'audit chain verifies from the UI');

  // ---- mobile layout ----
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: /المتعلمون/}).click();
  await page.locator('.ad-table').first().waitFor({timeout: 10000});
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  ok(overflow <= 1, `no horizontal page overflow on a 390px phone (overflow ${overflow}px; tables scroll inside their container)`);
  await page.setViewportSize({width: 1366, height: 900});

  // ---- MFA enrollment through the security panel ----
  await page.getByRole('button', {name: /الأمان/}).click();
  await page.getByRole('button', {name: 'ابدأ الإعداد'}).click();
  await page.locator('.ad-secret').waitFor({timeout: 10000});
  const shownSecret = (await page.locator('.ad-secret').innerText()).replace(/\s+/g, '');
  ok(/^[A-Z2-7]{32}$/.test(shownSecret), 'security panel shows the setup key for the authenticator app');
  await page.locator('.ad-mfa input.ad-code').fill(totpAt(shownSecret));
  await page.getByRole('button', {name: 'تفعيل'}).click();
  await page.locator('.ad-codes li').first().waitFor({timeout: 10000});
  ok(await page.locator('.ad-codes li').count() === 8, 'enabling shows 8 one-time recovery codes');
  await page.getByRole('button', {name: 'حفظتها، متابعة'}).click();
  await page.locator('.ad-mfa .ad-badge.good').first().waitFor({timeout: 10000});
  ok(true, 'security panel now reports two-factor authentication as enabled');

  // ---- sign out ----
  await page.getByRole('button', {name: /خروج/}).click();
  await page.locator('form.ad-login').waitFor({timeout: 10000});
  ok(true, 'sign-out returns to the login form');
  await page.reload();
  await page.locator('form.ad-login').waitFor({timeout: 10000});
  ok(true, 'after reload the session is gone (cookie invalidated server-side)');

  // ---- two-step sign-in through the UI ----
  await page.locator('form.ad-login input[type=email]').fill(ownerEmail);
  await page.locator('form.ad-login input[type=password]').fill(PW);
  await page.locator('form.ad-login button[type=submit]').click();
  await page.getByRole('heading', {name: 'التحقق بخطوتين'}).waitFor({timeout: 10000});
  ok(true, 'after the password, the UI asks for the authenticator code');
  await page.locator('form.ad-login input.ad-code').fill('000000');
  await page.locator('form.ad-login button[type=submit]').click();
  await page.getByText('الرمز غير صحيح.').waitFor({timeout: 10000});
  ok(true, 'a wrong code shows an error and keeps the code step');
  await page.locator('form.ad-login input.ad-code').fill(totpAt(shownSecret, Date.now() + 30000));
  await page.locator('form.ad-login button[type=submit]').click();
  await page.getByRole('heading', {name: 'لوحة التشغيل'}).waitFor({timeout: 10000});
  ok(true, 'the correct code opens the console');
  await page.getByRole('button', {name: /خروج/}).click();
  await page.locator('form.ad-login').waitFor({timeout: 10000});

  // ---- viewer: read-only UI ----
  await page.locator('form.ad-login input[type=email]').fill(viewerEmail);
  await page.locator('form.ad-login input[type=password]').fill(PW);
  await page.locator('form.ad-login button[type=submit]').click();
  await page.getByRole('heading', {name: 'لوحة التشغيل'}).waitFor({timeout: 10000});
  const vtabs = await page.locator('.ad-tabs button').allInnerTexts();
  ok(!vtabs.some(t => /المشرفون|سجل التدقيق/.test(t)), 'viewer does not see administrator or audit sections');
  await page.getByRole('button', {name: /المتعلمون/}).click();
  await page.locator('.ad-search input').fill(learnerEmail);
  await page.locator('.ad-table tbody tr', {hasText: learnerEmail}).click();
  await page.locator('.ad-detail h2', {hasText: 'Laila Learner'}).waitFor({timeout: 10000});
  ok(await page.locator('.ad-detail .ad-actions').count() === 0, 'viewer gets no action buttons on the user detail');

  ok(consoleErrors.length === 0, `no browser console errors (${consoleErrors.length})${consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''}`);
} catch (e) {
  console.error('  FAIL: unexpected error', e.message);
  failures++;
} finally {
  try { await browser?.close(); } catch {}
  try { server?.kill(); } catch {}
  await sleep(300);
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nAdmin E2E FAILED (${failures}).`); process.exit(1); }
console.log('\nAdmin E2E passed.');
process.exit(0);
