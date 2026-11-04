// Admin two-factor authentication (TOTP) integration tests: real server, real HTTP, JSON storage.
import {spawn} from 'node:child_process';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freePort, stopServer} from './helpers.mjs';
import {createDb} from '../server/db/index.js';
import {totpAt} from '../server/totp.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN = 'mfa' + Date.now();
const PW = 'correct-horse-battery-staple';
const procs = [];
const dir = await mkdtemp(join(tmpdir(), 'usam-mfa-'));
const dbFile = join(dir, 'db.json');
const env = extra => ({...process.env, NODE_ENV: 'test', DATABASE_URL: '', CUSTOMER_DB_FILE: dbFile, LEADS_FILE: join(dir, 'l.jsonl'), RATE_LIMIT_PREFIX: RUN, AUTH_IP_LIMIT: '1000', AUTH_EMAIL_LIMIT: '1000', AUDIT_HMAC_KEY: 'mfa-audit-key-0123456789', ADMIN_MFA_KEY: 'mfa-seal-key-0123456789abcdef', ...extra});
const cli = (args, extra) => new Promise(r => { const p = spawn(process.execPath, ['scripts/create-admin.mjs', ...args], {env: {...env(extra), ADMIN_PASSWORD: PW}, stdio: 'ignore'}); p.on('exit', r); });
async function start(extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {env: {...env(extra), PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  procs.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + '/api/health')).ok) return {origin, child}; } catch {} await sleep(100); }
  throw Error('server did not start');
}
const stop = s => stopServer(s.child); // graceful: the server closes its database before exiting
let O;
async function call(path, {method = 'GET', body, cookie} = {}) {
  const r = await fetch(O + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined});
  let data = {}; try { data = await r.json(); } catch {}
  return {status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0]};
}
const login = (email, password = PW) => call('/api/admin/auth/login', {method: 'POST', body: {email, password}});
const next = secret => totpAt(secret, Date.now() + 30000); // next 30s step: valid in the drift window, never a replay

try {
  const owner = `owner-${RUN}@example.com`, viewer = `viewer-${RUN}@example.com`, third = `third-${RUN}@example.com`, fourth = `fourth-${RUN}@example.com`;
  await cli(['--email', owner, '--name', 'Owner', '--role', 'owner']);
  await cli(['--email', viewer, '--name', 'Viewer', '--role', 'viewer']);
  await cli(['--email', third, '--name', 'Third', '--role', 'support']);
  await cli(['--email', fourth, '--name', 'Fourth', '--role', 'support']);
  let S = await start();
  O = S.origin;

  // ---------- enrollment ----------
  const first = await login(owner);
  ok(first.status === 200 && first.data.mfaEnrollmentRequired === false && first.data.admin.mfaEnabled === false, 'password-only sign-in works before MFA is enabled');
  const ownerA = first.cookie;
  const other = (await login(owner)).cookie; // a second, older session for the same admin
  const setup = await call('/api/admin/mfa/setup', {method: 'POST', cookie: ownerA});
  const secret = setup.data.secret;
  ok(setup.status === 200 && /^[A-Z2-7]{32}$/.test(secret) && setup.data.otpauthUri.includes('secret=' + secret), 'setup returns a 160-bit base32 secret and an otpauth URI');
  ok((await call('/api/admin/mfa/enable', {method: 'POST', cookie: ownerA, body: {code: '000000'}})).status === 400, 'enable with a wrong code -> 400');
  const en = await call('/api/admin/mfa/enable', {method: 'POST', cookie: ownerA, body: {code: totpAt(secret)}});
  const codes = en.data.recoveryCodes || [];
  ok(en.status === 200 && codes.length === 8 && new Set(codes).size === 8 && codes.every(c => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(c)), 'enable with a correct code returns 8 unique recovery codes');
  ok((await call('/api/admin/auth/me', {cookie: other})).status === 401, 'enabling MFA ends the admin\'s other (password-only) sessions');
  ok((await call('/api/admin/auth/me', {cookie: ownerA})).data.admin?.mfaEnabled === true, 'the enrolling session stays signed in and reports mfaEnabled');
  ok((await call('/api/admin/mfa/setup', {method: 'POST', cookie: ownerA})).status === 409, 'setup again while enabled -> 409');

  // ---------- two-step sign-in ----------
  await call('/api/admin/auth/logout', {method: 'POST', cookie: ownerA});
  const step1 = await login(owner);
  ok(step1.status === 200 && step1.data.mfaRequired === true && !step1.data.admin, 'correct password alone returns mfaRequired, not a session');
  const challenge = step1.cookie;
  ok((await call('/api/admin/overview', {cookie: challenge})).status === 401, 'the challenge cookie grants no access to the console');
  const wrong = await call('/api/admin/auth/mfa', {method: 'POST', cookie: challenge, body: {code: '123456'}});
  ok(wrong.status === 401 && wrong.data.restart === false, 'wrong authenticator code -> 401 (challenge still usable)');
  const code1 = next(secret);
  const step2 = await call('/api/admin/auth/mfa', {method: 'POST', cookie: challenge, body: {code: code1}});
  ok(step2.status === 200 && step2.data.admin?.role === 'owner' && step2.cookie && step2.cookie !== challenge, 'correct code completes sign-in under a NEW session token');
  const ownerB = step2.cookie;
  ok((await call('/api/admin/overview', {cookie: ownerB})).status === 200, 'the full session can use the console');
  ok((await call('/api/admin/auth/mfa', {method: 'POST', cookie: challenge, body: {code: next(secret)}})).status === 401, 'a used challenge cannot be redeemed again');

  // ---------- replay + recovery codes ----------
  const ch2 = (await login(owner)).cookie;
  ok((await call('/api/admin/auth/mfa', {method: 'POST', cookie: ch2, body: {code: code1}})).status === 401, 'replaying an already-used authenticator code is rejected');
  const rec = await call('/api/admin/auth/mfa', {method: 'POST', cookie: ch2, body: {recoveryCode: codes[0].toUpperCase()}});
  ok(rec.status === 200 && rec.data.recoveryCodesLeft === 7, 'a recovery code signs in (case-insensitive) and reports 7 left');
  const ch3 = (await login(owner)).cookie;
  ok((await call('/api/admin/auth/mfa', {method: 'POST', cookie: ch3, body: {recoveryCode: codes[0]}})).status === 401, 'a recovery code works only once');

  // ---------- attempt limit ----------
  const ch4 = (await login(owner)).cookie;
  let last;
  for (let i = 0; i < 5; i++) last = await call('/api/admin/auth/mfa', {method: 'POST', cookie: ch4, body: {code: '00000' + i}});
  ok(last.status === 401 && last.data.restart === true, 'after 5 wrong codes the challenge is destroyed (restart required)');
  ok((await call('/api/admin/auth/mfa', {method: 'POST', cookie: ch4, body: {recoveryCode: codes[1]}})).status === 401, 'even a valid recovery code cannot use a destroyed challenge');

  // ---------- audit ----------
  const audit = await call('/api/admin/audit?pageSize=100', {cookie: ownerB});
  const ev = audit.data.items || [];
  ok(ev.some(e => e.event === 'admin_mfa_enabled'), 'audit records admin_mfa_enabled');
  ok(ev.some(e => e.event === 'admin_mfa_failed' && e.meta.exhausted === true), 'audit records failed codes and the exhausted challenge');
  ok(ev.some(e => e.event === 'admin_login' && e.meta.mfa === 'totp') && ev.some(e => e.event === 'admin_login' && e.meta.mfa === 'recovery'), 'audit records how each sign-in was completed (totp / recovery)');
  ok(!JSON.stringify(ev).includes(secret) && !JSON.stringify(ev).includes(codes[2]), 'audit never contains secrets or recovery codes');

  // ---------- disable (needs password + current code) ----------
  const tv = (await login(third)).cookie;
  const s3 = (await call('/api/admin/mfa/setup', {method: 'POST', cookie: tv})).data.secret;
  await call('/api/admin/mfa/enable', {method: 'POST', cookie: tv, body: {code: totpAt(s3)}});
  ok((await call('/api/admin/mfa/disable', {method: 'POST', cookie: tv, body: {password: 'wrong-password-000', code: next(s3)}})).status === 403, 'disable with a wrong password -> 403');
  ok((await call('/api/admin/mfa/disable', {method: 'POST', cookie: tv, body: {password: PW, code: '000000'}})).status === 400, 'disable with a wrong code -> 400');
  ok((await call('/api/admin/mfa/disable', {method: 'POST', cookie: tv, body: {password: PW, code: next(s3)}})).status === 200, 'disable with password + current code succeeds');
  ok((await login(third)).data.mfaRequired !== true, 'after disabling, sign-in is password-only again');

  // ---------- owner reset (lost device) ----------
  const fv = (await login(fourth)).cookie;
  const s4 = (await call('/api/admin/mfa/setup', {method: 'POST', cookie: fv})).data.secret;
  await call('/api/admin/mfa/enable', {method: 'POST', cookie: fv, body: {code: totpAt(s4)}});
  const fourthId = (await call('/api/admin/auth/me', {cookie: fv})).data.admin.id;
  const ownerId = (await call('/api/admin/auth/me', {cookie: ownerB})).data.admin.id;
  const vw = (await login(viewer)).cookie;
  ok((await call(`/api/admin/admins/${fourthId}/mfa/reset`, {method: 'POST', cookie: vw, body: {reason: 'lost phone ticket'}})).status === 403, 'a viewer cannot reset someone else\'s MFA');
  ok((await call(`/api/admin/admins/${fourthId}/mfa/reset`, {method: 'POST', cookie: ownerB, body: {}})).status === 400, 'MFA reset requires a reason');
  ok((await call(`/api/admin/admins/${ownerId}/mfa/reset`, {method: 'POST', cookie: ownerB, body: {reason: 'self reset attempt'}})).status === 409, 'an admin cannot reset their own MFA through the admin endpoint');
  const reset = await call(`/api/admin/admins/${fourthId}/mfa/reset`, {method: 'POST', cookie: ownerB, body: {reason: 'lost phone, identity verified by call'}});
  ok(reset.status === 200 && reset.data.admin.mfaEnabled === false, 'owner resets MFA for an admin who lost their device');
  ok((await call('/api/admin/auth/me', {cookie: fv})).status === 401, 'the reset admin\'s sessions are ended');
  ok((await call('/api/admin/admins', {cookie: ownerB})).data.items.find(a => a.id === fourthId)?.mfaEnabled === false, 'admin list shows MFA status');
  await stop(S);

  // ---------- ADMIN_REQUIRE_MFA=true ----------
  S = await start({ADMIN_REQUIRE_MFA: 'true'}); O = S.origin;
  const fx = await login(fourth); // fourth has no MFA after the reset
  ok(fx.status === 200 && fx.data.mfaEnrollmentRequired === true, 'required mode: an unenrolled admin signs in but is told to enroll');
  const blocked = await call('/api/admin/overview', {cookie: fx.cookie});
  ok(blocked.status === 403 && blocked.data.mfaEnrollmentRequired === true, 'required mode: console APIs are blocked until MFA is enabled');
  ok((await call('/api/admin/auth/me', {cookie: fx.cookie})).status === 200, 'required mode: session info stays available');
  const s5 = (await call('/api/admin/mfa/setup', {method: 'POST', cookie: fx.cookie})).data.secret;
  ok(!!s5 && (await call('/api/admin/mfa/enable', {method: 'POST', cookie: fx.cookie, body: {code: totpAt(s5)}})).status === 200, 'required mode: the admin can enroll');
  ok((await call('/api/admin/overview', {cookie: fx.cookie})).status === 200, 'required mode: after enrolling the console opens');
  await stop(S);

  // ---------- server without ADMIN_MFA_KEY ----------
  S = await start({ADMIN_MFA_KEY: ''}); O = S.origin;
  const nk = await login(viewer);
  ok((await call('/api/admin/mfa/setup', {method: 'POST', cookie: nk.cookie})).status === 503, 'without ADMIN_MFA_KEY, enrollment is refused (503) instead of storing secrets unprotected');
  await stop(S);
  // ---------- at-rest checks, read straight from the database after a clean shutdown ----------
  const raw = await createDb({databaseUrl: '', dataDir: dbFile.replace(/\.json$/, '') + '-pglite'});
  const rows = (await raw.query('SELECT email, mfa::text AS mfa FROM admins')).rows;
  await raw.close();
  const all = rows.map(r => r.mfa || '').join(' ');
  ok(!all.includes(secret) && JSON.parse(rows.find(r => r.email === owner).mfa).secret.startsWith('v1.'), 'the TOTP secret is stored encrypted (AES-GCM), never in plaintext');
  ok(!codes.some(c => all.includes(c) || all.includes(c.replace('-', ''))), 'recovery codes are stored hashed only');
} catch (e) {
  console.error('  FAIL: unexpected error', e); failures++;
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  await sleep(300);
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nAdmin MFA tests FAILED (${failures}).`); process.exit(1); }
console.log('\nAdmin MFA tests passed.');
process.exit(0);
