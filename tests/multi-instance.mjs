// End-to-end multi-instance test: two server processes sharing one PostgreSQL database.
// A session created on instance 1 must be honoured on instance 2, and writes on either side must be
// visible to the other. Skips without DATABASE_URL.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freePort} from './helpers.mjs';

if (!process.env.DATABASE_URL) { console.log('multi-instance: DATABASE_URL not set — skipping.'); process.exit(0); }
let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const procs = [];
const dir = await mkdtemp(join(tmpdir(), 'usam-multi-'));
const prefix = 'multi' + Date.now();

async function start() {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {env: {...process.env, PORT: String(port), LEADS_FILE: join(dir, 'l.jsonl'), NODE_ENV: 'test', RATE_LIMIT_PREFIX: prefix}, stdio: ['ignore', 'ignore', 'pipe']});
  procs.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(origin + '/api/health')).ok) return origin; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw Error('server did not start');
}
const req = (origin, path, {method = 'GET', body, cookie} = {}) => fetch(origin + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined});

try {
  const one = await start(), two = await start();
  // warm both instances' caches first so a stale cache would be exposed
  await req(one, '/api/customer/catalog'); await req(two, '/api/customer/me');
  const email = `multi-${Date.now()}@example.com`;
  const reg = await req(one, '/api/customer/register', {method: 'POST', body: {name: 'Multi Learner', email, phone: '01000000000', password: 'correct-horse-battery'}});
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  ok(reg.status === 201 && cookie, 'registered on instance 1');
  const me2 = await req(two, '/api/customer/me', {cookie});
  ok(me2.status === 200 && (await me2.json()).user?.email === email, 'session from instance 1 is valid on instance 2');
  const edit = await req(two, '/api/customer/account', {method: 'PATCH', cookie, body: {name: 'Edited On Two', phone: '01011111111'}});
  ok(edit.ok, 'profile edited on instance 2');
  const me1 = await req(one, '/api/customer/me', {cookie});
  ok((await me1.json()).user?.name === 'Edited On Two', 'edit made on instance 2 is visible on instance 1');
  await req(one, '/api/customer/logout', {method: 'POST', cookie});
  ok((await req(two, '/api/customer/me', {cookie})).status === 401, 'logout on instance 1 invalidates the session on instance 2');
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nMulti-instance test FAILED (${failures}).`); process.exit(1); }
console.log('\nMulti-instance test passed.');
process.exit(0);
