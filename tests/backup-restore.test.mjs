// Backup + restore drill: real data through the running app -> scripts/backup.sh -> scripts/restore.sh into a NEW
// database -> the real server on the restored database still works (logins, progress, paid access, audit chain).
// Needs DATABASE_URL and PG_TOOLS_CONTAINER (a Linux container with bash + pg_dump/pg_restore that can reach the same
// PostgreSQL as "localhost:5432", e.g. the postgres:16 container itself). Skips otherwise.
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freePort, stopServer} from './helpers.mjs';

const run = promisify(execFile);
const C = process.env.PG_TOOLS_CONTAINER;
if (!process.env.DATABASE_URL || !C) { console.log('backup-restore: DATABASE_URL and PG_TOOLS_CONTAINER required — skipping.'); process.exit(0); }
let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PW = 'correct-horse-battery-staple', RUN = 'br' + Date.now();
const hostUrl = new URL(process.env.DATABASE_URL);
const urlFor = (name, inContainer) => { const u = new URL(hostUrl); u.pathname = '/' + name; if (inContainer) { u.hostname = 'localhost'; u.port = '5432'; } return u.toString(); };
const sh = (cmd, env = {}) => run('docker', ['exec', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), C, 'bash', '-c', cmd]).then(r => ({code: 0, out: r.stdout + r.stderr}), e => ({code: e.code, out: (e.stdout || '') + (e.stderr || '')}));
const {default: pg} = await import('pg');
const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
const src = `usam_br_src_${Date.now()}`, dst = `usam_br_dst_${Date.now()}`;
const dir = await mkdtemp(join(tmpdir(), 'usam-br-'));
const procs = [];
const env = name => ({...process.env, NODE_ENV: 'test', DATABASE_URL: urlFor(name), REDIS_URL: '', RATE_LIMIT_PREFIX: RUN, AUTH_IP_LIMIT: '1000', AUDIT_HMAC_KEY: 'br-audit-key-0123456789', LEADS_FILE: join(dir, 'l.jsonl'), CUSTOMER_DB_FILE: join(dir, 'none.json')});
async function start(name) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {env: {...env(name), PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  procs.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(origin + '/api/health')).ok) return {origin, child}; } catch {} await sleep(100); }
  throw Error('server did not start');
}
const call = async (o, path, {method = 'GET', body, cookie} = {}) => { const r = await fetch(o + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined}); let data = {}; try { data = await r.json(); } catch {} return {status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0]}; };
const cli = (name, args) => new Promise(r => { const p = spawn(process.execPath, ['scripts/create-admin.mjs', ...args], {env: {...env(name), ADMIN_PASSWORD: PW}, stdio: 'ignore'}); p.on('exit', r); });

try {
  await admin.query(`CREATE DATABASE ${src}`); await admin.query(`CREATE DATABASE ${dst}`);
  // ---------- real data through the app ----------
  const ownerEmail = `owner-${RUN}@example.com`, learnerEmail = `learner-${RUN}@example.com`;
  ok(await cli(src, ['--email', ownerEmail, '--name', 'Owner', '--role', 'owner']) === 0, 'owner created in the source database');
  let S = await start(src);
  const reg = await call(S.origin, '/api/customer/register', {method: 'POST', body: {name: 'Rania Restore', email: learnerEmail, phone: '01000000000', password: PW}});
  await call(S.origin, '/api/customer/profile', {method: 'PUT', cookie: reg.cookie, body: {profile: {goal: 'Career & interviews', level: 'B1'}}});
  const order = (await call(S.origin, '/api/customer/orders', {method: 'POST', cookie: reg.cookie, body: {plan: 'plus', term: 'yearly', language: 'English'}})).data.reference;
  const ow = await call(S.origin, '/api/admin/auth/login', {method: 'POST', body: {email: ownerEmail, password: PW}});
  const act = await call(S.origin, `/api/admin/orders/${order}/activate`, {method: 'POST', cookie: ow.cookie, body: {paymentReference: 'BANK-' + RUN, reason: 'reconciled before backup'}});
  // Real practice through the learning API (progress is server-computed; the browser cannot set XP).
  const practice = await call(S.origin, '/api/customer/learning/activities', {method: 'POST', cookie: reg.cookie, body: {clientId: 'drill-' + RUN, ref: 'airport', title: 'The airport', words: ['backup', 'gate']}});
  ok(act.status === 200 && practice.status === 201, 'source: learner registered, order paid via admin, practice recorded');
  const srcAudit = (await call(S.origin, '/api/admin/audit/verify', {cookie: ow.cookie})).data;
  await stopServer(S.child);

  // ---------- backup inside a Linux container with the real scripts ----------
  for (const s of ['backup.sh', 'restore.sh']) await run('docker', ['cp', join('scripts', s), `${C}:/tmp/${s}`]);
  await sh('sed -i "s/\\r$//" /tmp/backup.sh /tmp/restore.sh && chmod +x /tmp/backup.sh /tmp/restore.sh && rm -rf /tmp/usam-bk');
  const b = await sh('/tmp/backup.sh /tmp/usam-bk', {DATABASE_URL: urlFor(src, true)});
  const file = b.out.trim().split('\n').pop();
  ok(b.code === 0 && /usam-\d{8}T\d{6}Z\.dump$/.test(file), `backup.sh wrote a validated archive (${file})`);
  ok((await sh(`test -f ${file}.sha256 && test ! -e ${file}.partial && stat -c %a /tmp/usam-bk ${file}`)).out.trim().split('\n').join(',') === '700,600', 'checksum written, no partial file left, directory 700 and archive 600');
  ok((await sh('/tmp/backup.sh /tmp/usam-bk', {})).code !== 0, 'backup.sh refuses to run without DATABASE_URL');

  // ---------- restore safety checks ----------
  const noConfirm = await sh(`/tmp/restore.sh ${file}`, {TARGET_DATABASE_URL: urlFor(dst, true)});
  ok(noConfirm.code === 2 && /RESTORE_CONFIRM=yes/.test(noConfirm.out), 'restore.sh refuses without RESTORE_CONFIRM=yes');
  await sh(`cp ${file} /tmp/usam-bk/tampered.dump && cp ${file}.sha256 /tmp/usam-bk/tampered.dump.sha256 && sed -i "s/$(basename ${file})/tampered.dump/" /tmp/usam-bk/tampered.dump.sha256 && printf 'x' >> /tmp/usam-bk/tampered.dump`);
  const bad = await sh('/tmp/restore.sh /tmp/usam-bk/tampered.dump', {TARGET_DATABASE_URL: urlFor(dst, true), RESTORE_CONFIRM: 'yes'});
  ok(bad.code === 3 && /Checksum mismatch/.test(bad.out), 'restore.sh refuses a corrupted archive (checksum mismatch)');

  // ---------- restore into a NEW database and run the real app on it ----------
  const r = await sh(`/tmp/restore.sh ${file}`, {TARGET_DATABASE_URL: urlFor(dst, true), RESTORE_CONFIRM: 'yes'});
  ok(r.code === 0 && /Restored/.test(r.out), 'restore.sh restored the archive into a fresh database');
  S = await start(dst);
  const li = await call(S.origin, '/api/customer/login', {method: 'POST', body: {email: learnerEmail, password: PW}});
  ok(li.status === 200, 'restored: the learner signs in with their original password');
  const me = await call(S.origin, '/api/customer/me', {cookie: li.cookie});
  ok(me.data.profile?.xp === 25 && me.data.profile.sessions?.[0]?.id === 'airport' && me.data.profile.reviews?.some(r => r.word === 'backup') && me.data.profile.goal === 'Career & interviews', 'restored: learning history, XP, review cards and settings are intact');
  ok((await call(S.origin, '/api/feedback', {method: 'POST', cookie: li.cookie, body: {text: 'Restored access works.'}})).status === 200, 'restored: the paid entitlement still unlocks content');
  ok((await call(S.origin, '/api/customer/me', {cookie: reg.cookie})).status === 200, 'restored: sessions issued before the backup are still valid');
  const ow2 = await call(S.origin, '/api/admin/auth/login', {method: 'POST', body: {email: ownerEmail, password: PW}});
  ok(ow2.status === 200, 'restored: the administrator signs in');
  const v = (await call(S.origin, '/api/admin/audit/verify', {cookie: ow2.cookie})).data;
  ok(v.ok === true && v.checked >= srcAudit.checked, `restored: audit chain verifies (${v.checked} entries)`);
  const orders = (await call(S.origin, `/api/admin/orders?q=${order}`, {cookie: ow2.cookie})).data;
  ok(orders.items?.[0]?.status === 'paid' && orders.items[0].manualPaymentReference === 'BANK-' + RUN, 'restored: the paid order with its payment reference is intact');
  await stopServer(S.child);
} catch (e) { console.error('  FAIL: unexpected error', e); failures++; }
finally {
  for (const p of procs) try { p.kill(); } catch {}
  await sleep(300);
  await sh('rm -rf /tmp/usam-bk /tmp/backup.sh /tmp/restore.sh');
  for (const d of [src, dst]) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
  await admin.end();
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nBackup/restore drill FAILED (${failures}).`); process.exit(1); }
console.log('\nBackup/restore drill passed.');
process.exit(0);
