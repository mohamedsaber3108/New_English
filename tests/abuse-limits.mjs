// HTTP-level abuse-protection tests: login brute-force throttle and lead anti-spam.
// With REDIS_URL set, also proves the limit is SHARED by two independent server instances.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freePort} from './helpers.mjs';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
// One namespace per test run: isolates this file from other runs, while the two multi-instance
// servers below deliberately share it (that sharing is what the test proves).
const RUN_PREFIX = 'abuse' + Date.now() + Math.random().toString(36).slice(2, 8);

async function start(dir, port, extra = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {env: {...process.env, PORT: String(port), CUSTOMER_DB_FILE: join(dir, port + '.json'), LEADS_FILE: join(dir, 'l.jsonl'), NODE_ENV: 'test', RATE_LIMIT_PREFIX: RUN_PREFIX, ...extra}, stdio: ['ignore', 'ignore', 'pipe']});
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(origin + '/api/health')).ok) return {child, origin}; } catch {} await new Promise(r => setTimeout(r, 100)); }
  child.kill(); throw Error('server did not start on ' + port);
}
const post = (origin, path, body, ip) => fetch(origin + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

const dir = await mkdtemp(join(tmpdir(), 'usam-abuse-'));
const procs = [];
try {
  // --- Single instance: login throttle (10 / 15min / IP) ---
  const a = await start(dir, await freePort(), {REDIS_URL: ''});
  procs.push(a.child);
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push((await post(a.origin, '/api/customer/login', {email: `nobody${i}@example.com`, password: 'wrong-password-xx'})).status);
  ok(codes.slice(0, 10).every(c => c === 401), 'first 10 bad logins return 401');
  ok(codes.slice(10).every(c => c === 429), 'attempts 11-12 are throttled with 429');

  // --- Lead anti-spam: 5 saved leads / hour / IP ---
  const lead = i => ({name: 'Lead Person', email: `lead${i}@example.com`, phone: '01000000000', kind: 'question', language: 'English', message: 'hello'});
  const lc = [];
  for (let i = 0; i < 6; i++) lc.push((await post(a.origin, '/api/leads', lead(i))).status);
  ok(lc.slice(0, 5).every(c => c === 201), 'first 5 valid leads are accepted (201)');
  ok(lc[5] === 429, '6th lead in the hour is rejected (429)');
  // invalid leads do NOT consume the quota (original semantics preserved) — verified on a fresh instance
  a.child.kill();

  const b = await start(dir, await freePort(), {REDIS_URL: ''});
  procs.push(b.child);
  for (let i = 0; i < 7; i++) await post(b.origin, '/api/leads', {name: 'x'});
  ok((await post(b.origin, '/api/leads', lead(99))).status === 201, 'invalid lead submissions do not consume the lead quota');
  b.child.kill();

  // --- Two instances sharing Redis: limit must be global, not per-instance ---
  if (process.env.REDIS_URL) {
    const tag = Date.now();
    const i1 = await start(dir, await freePort(), {AUTH_IP_LIMIT: '1000'});
    const i2 = await start(dir, await freePort(), {AUTH_IP_LIMIT: '1000'});
    procs.push(i1.child, i2.child);
    const email = `target-${tag}@example.com`;
    // per-email limit is 20; alternate instances. AUTH_IP_LIMIT is raised so only the email limit applies.
    const st = [];
    for (let i = 0; i < 22; i++) st.push((await post(i % 2 ? i2.origin : i1.origin, '/api/customer/login', {email, password: 'wrong-password-xx'})).status);
    ok(st.slice(0, 20).every(c => c === 401), '20 attempts against one email across 2 instances -> 401');
    ok(st.slice(20).every(c => c === 429), 'attempt 21+ throttled even though split across instances (shared Redis limit)');
  } else console.log('REDIS_URL not set — skipping multi-instance shared-limit test.');
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nAbuse-limit tests FAILED (${failures}).`); process.exit(1); }
console.log('\nAbuse-limit tests passed.');
process.exit(0);
