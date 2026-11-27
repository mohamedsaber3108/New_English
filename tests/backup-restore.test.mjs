// Backup + restore drill: real data through the running app -> scripts/backup.sh -> scripts/restore.sh into a NEW
// database -> row counts match -> the real server on the restored database still works (logins, progress, paid access,
// audit chain). Needs DATABASE_URL and ONE of:
//   PG_TOOLS_LOCAL=1       pg_dump / pg_restore / bash / sha256sum on this machine's PATH (CI: postgresql-client-16), or
//   PG_TOOLS_CONTAINER=<n> a Linux container with bash + pg_dump/pg_restore that reaches the same PostgreSQL as
//                          "localhost:5432", e.g. the postgres:16 container itself (docker exec). Used on Windows dev boxes.
// Skips when neither is set. With PG_TOOLS_LOCAL=1 missing tools are a FAILURE, never a skip.
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freePort, stopServer} from './helpers.mjs';

const run = promisify(execFile);
const LOCAL = process.env.PG_TOOLS_LOCAL === '1';
const C = process.env.PG_TOOLS_CONTAINER;
if (!process.env.DATABASE_URL || (!LOCAL && !C)) { console.log('backup-restore: DATABASE_URL and PG_TOOLS_LOCAL=1 (or PG_TOOLS_CONTAINER) required — skipping.'); process.exit(0); }
let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now(), secs = since => ((Date.now() - since) / 1000).toFixed(1);
const PW = 'correct-horse-battery-staple', RUN = 'br' + Date.now();
const hostUrl = new URL(process.env.DATABASE_URL);
// URL the tools use: in a container the database is "localhost:5432"; locally it is the same URL as the test uses.
const urlFor = (name, forTools) => { const u = new URL(hostUrl); u.pathname = '/' + name; if (forTools && !LOCAL) { u.hostname = 'localhost'; u.port = '5432'; } return u.toString(); };
const toolsUrl = name => urlFor(name, true);
const SCRIPT = n => LOCAL ? join(process.cwd(), 'scripts', n) : '/tmp/' + n;
const BK = LOCAL ? null : '/tmp/usam-bk'; // local mode: set below, inside the scratch dir
let bk = BK;
const sh = (cmd, env = {}) => (LOCAL
  ? run('bash', ['-c', cmd], {env: {...process.env, ...env}})
  : run('docker', ['exec', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), C, 'bash', '-c', cmd])
).then(r => ({code: 0, out: r.stdout + r.stderr}), e => ({code: e.code, out: (e.stdout || '') + (e.stderr || '')}));
const {default: pg} = await import('pg');
const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
const src = `usam_br_src_${Date.now()}`, dst = `usam_br_dst_${Date.now()}`;
const dir = await mkdtemp(join(tmpdir(), 'usam-br-'));
if (LOCAL) bk = join(dir, 'bk');
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
// Row count of every table in the public schema (names come from the catalog and are quoted).
async function rowCounts(name) {
  const c = new pg.Client({connectionString: urlFor(name)}); await c.connect();
  try {
    const tables = (await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1")).rows.map(r => r.table_name);
    const out = {};
    for (const t of tables) out[t] = Number((await c.query(`SELECT count(*) AS n FROM "${t.replace(/"/g, '""')}"`)).rows[0].n);
    return out;
  } finally { await c.end(); }
}
let proof = null;

try {
  if (LOCAL) {
    const v = await sh('pg_dump --version && pg_restore --version && sha256sum --version | head -n1');
    ok(v.code === 0, `local PostgreSQL tools found (${v.out.trim().split('\n').slice(0, 2).join('; ')})`);
    if (v.code !== 0) throw Error('PG_TOOLS_LOCAL=1 but pg_dump/pg_restore/sha256sum are not available');
  }
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
  const srcCounts = await rowCounts(src);

  // ---------- backup with the real script ----------
  if (LOCAL) await sh(`rm -rf "${bk}"`);
  else {
    for (const s of ['backup.sh', 'restore.sh']) await run('docker', ['cp', join('scripts', s), `${C}:/tmp/${s}`]);
    await sh(`sed -i "s/\\r$//" /tmp/backup.sh /tmp/restore.sh && chmod +x /tmp/backup.sh /tmp/restore.sh && rm -rf ${bk}`);
  }
  const tBackup = Date.now();
  const statusFile = join(dir, 'backup-status.json'); // A-7: backup.sh / restore.sh write the admin status file (needs node on PATH: local mode only)
  const b = await sh(`"${SCRIPT('backup.sh')}" "${bk}"`, {DATABASE_URL: toolsUrl(src), ...(LOCAL ? {BACKUP_STATUS_FILE: statusFile} : {})});
  const backupSecs = secs(tBackup);
  const file = b.out.trim().split('\n').pop();
  ok(b.code === 0 && /usam-\d{8}T\d{6}Z\.dump$/.test(file), `backup.sh wrote a validated archive (${file.split('/').pop()}, ${backupSecs}s)`);
  ok((await sh(`test -f "${file}.sha256" && test ! -e "${file}.partial" && stat -c %a "${bk}" "${file}"`)).out.trim().split('\n').join(',') === '700,600', 'checksum written, no partial file left, directory 700 and archive 600');
  if (LOCAL) {
    const st = JSON.parse(await readFile(statusFile, 'utf8'));
    const size = Number((await sh(`stat -c %s "${file}"`)).out.trim());
    const sum = (await sh(`cut -d' ' -f1 "${file}.sha256"`)).out.trim();
    ok(st.lastBackup?.result === 'ok' && st.lastBackup.file === file.split('/').pop() && st.lastBackup.sizeBytes === size && st.lastBackup.sha256 === sum && !!Date.parse(st.lastBackup.at), 'backup.sh wrote the status file (time, file name, size, sha256, result ok)');
  }
  ok((await sh(`"${SCRIPT('backup.sh')}" "${bk}"`, {DATABASE_URL: ''})).code !== 0, 'backup.sh refuses to run without DATABASE_URL');

  // ---------- restore safety checks ----------
  const noConfirm = await sh(`"${SCRIPT('restore.sh')}" "${file}"`, {TARGET_DATABASE_URL: toolsUrl(dst)});
  ok(noConfirm.code === 2 && /RESTORE_CONFIRM=yes/.test(noConfirm.out), 'restore.sh refuses without RESTORE_CONFIRM=yes');
  await sh(`cp "${file}" "${bk}/tampered.dump" && cp "${file}.sha256" "${bk}/tampered.dump.sha256" && sed -i "s/$(basename "${file}")/tampered.dump/" "${bk}/tampered.dump.sha256" && printf 'x' >> "${bk}/tampered.dump"`);
  const bad = await sh(`"${SCRIPT('restore.sh')}" "${bk}/tampered.dump"`, {TARGET_DATABASE_URL: toolsUrl(dst), RESTORE_CONFIRM: 'yes'});
  ok(bad.code === 3 && /Checksum mismatch/.test(bad.out), 'restore.sh refuses a corrupted archive (checksum mismatch)');

  // ---------- restore into a NEW database ----------
  const tRestore = Date.now();
  const r = await sh(`"${SCRIPT('restore.sh')}" "${file}" --record-test`, {TARGET_DATABASE_URL: toolsUrl(dst), RESTORE_CONFIRM: 'yes', ...(LOCAL ? {BACKUP_STATUS_FILE: statusFile} : {})});
  const restoreSecs = secs(tRestore);
  ok(r.code === 0 && /Restored/.test(r.out), `restore.sh restored the archive into a fresh database (${restoreSecs}s)`);

  if (LOCAL) {
    const st = JSON.parse(await readFile(statusFile, 'utf8'));
    ok(st.lastRestoreTest?.result === 'ok' && !!Date.parse(st.lastRestoreTest.at) && st.lastBackup?.result === 'ok', 'restore.sh --record-test recorded the drill result and kept the backup details');
  }

  // ---------- row counts: every table, before the app touches the restored database ----------
  const dstCounts = await rowCounts(dst);
  const tables = Object.keys(srcCounts), rows = Object.values(srcCounts).reduce((a, n) => a + n, 0);
  const diff = tables.filter(t => srcCounts[t] !== dstCounts[t]).map(t => `${t}: ${srcCounts[t]} vs ${dstCounts[t] ?? 'missing'}`);
  ok(tables.length >= 10 && rows > 0, `source has data to compare (${tables.length} tables, ${rows} rows)`);
  ok(diff.length === 0 && Object.keys(dstCounts).length === tables.length, `restored row counts match the source in every table${diff.length ? ' - DIFF: ' + diff.join('; ') : ''}`);

  // ---------- the real app on the restored database ----------
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
  proof = `restore drill proof: ${tables.length} tables / ${rows} rows backed up (${backupSecs}s) and restored (${restoreSecs}s) into a scratch database, row counts match, app booted and signed in, audit chain verified (${v.checked} entries), total ${secs(T0)}s`;
} catch (e) { console.error('  FAIL: unexpected error', e); failures++; }
finally {
  for (const p of procs) try { p.kill(); } catch {}
  await sleep(300);
  if (!LOCAL) await sh('rm -rf /tmp/usam-bk /tmp/backup.sh /tmp/restore.sh');
  for (const d of [src, dst]) await admin.query(`DROP DATABASE IF EXISTS ${d} WITH (FORCE)`).catch(() => {});
  await admin.end();
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nBackup/restore drill FAILED (${failures}).`); process.exit(1); }
console.log('\n' + (proof || 'restore drill proof: not produced'));
console.log('Backup/restore drill passed.');
process.exit(0);
