// Reproducible load test for the learner hot paths, per storage backend and data size.
//
//   node tests/load/run.mjs [--sizes 1000,10000,50000] [--backends json,pg] [--duration 10000] [--connections 50]
//
// For each (backend, size): seeds storage directly (realistic learner records + one session each), starts the real
// server (rate limits raised so they do not throttle the test), and runs:
//   health   GET  /api/health              (baseline: no storage access)
//   read     GET  /api/customer/me         (authenticated read: runs on every learner page load)
//   write    PUT  /api/customer/profile    (progress autosave)
//   mixed    90% read / 10% write
// PostgreSQL runs need DATABASE_URL (a server where the test may CREATE/DROP throwaway databases).
// Results: tests/load/results/<timestamp>.json and a markdown table on stdout.
// IMPORTANT: generator, app server and database share one machine here, so absolute numbers are a lower bound for
// a dedicated deployment; the comparison between sizes/backends is the point.
import {spawn} from 'node:child_process';
import {mkdtemp, rm, mkdir, writeFile, stat} from 'node:fs/promises';
import {tmpdir, cpus, totalmem, platform, release} from 'node:os';
import {join} from 'node:path';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {freePort} from '../helpers.mjs';
import {runLoad} from './loadgen.mjs';
import {createDb} from '../../server/db/index.js';
import {passwordHash} from '../../server/passwords.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const SIZES = arg('sizes', '1000,10000,50000').split(',').map(Number);
const BACKENDS = arg('backends', process.env.DATABASE_URL ? 'pglite,pg' : 'pglite').split(',');
const DURATION = Number(arg('duration', 10000)), CONNECTIONS = Number(arg('connections', 50));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = v => createHash('sha256').update(v).digest('hex');

function learner(i, pw, now) {
  const words = ['airport', 'boarding pass', 'luggage', 'gate', 'delayed', 'reservation', 'deadline', 'project', 'customer', 'order', 'platform', 'timetable', 'experience', 'challenge', 'result', 'scope', 'brief', 'available', 'booking', 'room'];
  return {
    id: randomUUID(), name: `Load Learner ${i}`, email: `load${i}@example.com`, phone: '01000000000', password: pw, createdAt: new Date(now - i * 60000).toISOString(),
    emailVerified: i % 3 !== 0, preferences: {product: true, learning: true, marketing: false},
    entitlements: i % 4 === 0 ? {English: {plan: 'essential', expiresAt: now + 30 * 864e5, orderReference: 'USL-LOAD' + i}} : {},
    profile: {name: `Load Learner ${i}`, goal: 'Travel & everyday life', minutes: 20, assessmentDone: true, level: 'A2', xp: i % 500, streak: i % 9, lastActive: new Date(now).toDateString(),
      skills: {Speaking: 46, Listening: 55, Reading: 61, Writing: 40, Grammar: 48, Vocabulary: 52, Pronunciation: 43, Fluency: 42}, evidence: {Writing: 2, Reading: 1},
      sessions: Array.from({length: 10}, (_, k) => ({id: 'airport', title: 'The airport', date: new Date(now - k * 864e5).toISOString(), words: ['gate', 'luggage'], summary: 'You stayed in the conversation.'})),
      completed: ['airport', 'story'], reviews: words.map((w, k) => ({word: w, reps: k % 4, interval: k % 7, ease: 2.5, due: now + k * 36e5, lapses: 0}))},
  };
}

async function seed(db, n) {
  const now = Date.now(), pw = await passwordHash('load-test-password-1234'), tokens = [];
  const users = [], sessions = [];
  for (let i = 0; i < n; i++) {
    const u = learner(i, pw, now); users.push(u);
    const t = randomBytes(32).toString('hex'); tokens.push(t);
    sessions.push({id: randomUUID(), hash: sha(t), userId: u.id, createdAt: now, lastSeen: now, device: 'load', expires: now + 30 * 864e5});
  }
  // Batched inserts (2,000 rows per statement) into the relational tables; entitlements as their own rows.
  const B = 2000;
  for (let i = 0; i < users.length; i += B) {
    const chunk = users.slice(i, i + B);
    await db.query(`INSERT INTO users (id, email, name, phone, password, status, email_verified, preferences, profile, created_at)
      SELECT id, email, name, phone, password, 'active', email_verified, preferences, profile, created_at::timestamptz
      FROM jsonb_to_recordset($1::jsonb) AS x(id text, email text, name text, phone text, password text, email_verified boolean, preferences jsonb, profile jsonb, created_at text)`,
      [JSON.stringify(chunk.map(u => ({id: u.id, email: u.email, name: u.name, phone: u.phone, password: u.password, email_verified: u.emailVerified, preferences: u.preferences, profile: u.profile, created_at: u.createdAt})))]);
    const ents = chunk.filter(u => u.entitlements.English).map(u => ({user_id: u.id, plan: u.entitlements.English.plan, expires_at: u.entitlements.English.expiresAt, order_reference: u.entitlements.English.orderReference}));
    if (ents.length) await db.query(`INSERT INTO entitlements (user_id, language, plan, expires_at, order_reference) SELECT user_id, 'English', plan, expires_at, order_reference FROM jsonb_to_recordset($1::jsonb) AS x(user_id text, plan text, expires_at bigint, order_reference text)`, [JSON.stringify(ents)]);
  }
  for (let i = 0; i < sessions.length; i += B) {
    await db.query(`INSERT INTO sessions (id, hash, user_id, created_at, last_seen, device, expires) SELECT id, hash, user_id, created_at, last_seen, device, expires
      FROM jsonb_to_recordset($1::jsonb) AS x(id text, hash text, user_id text, created_at bigint, last_seen bigint, device text, expires bigint)`,
      [JSON.stringify(sessions.slice(i, i + B).map(s => ({id: s.id, hash: s.hash, user_id: s.userId, created_at: s.createdAt, last_seen: s.lastSeen, device: s.device, expires: s.expires})))]);
  }
  // Logical data size, for comparison with Baseline 1 (where every write re-serialized all of it).
  const bytes = Buffer.byteLength(JSON.stringify(users)) + Buffer.byteLength(JSON.stringify(sessions));
  return {tokens, bytes};
}

async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['--max-old-space-size=4096', 'server/index.js'], {env: {...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe']});
  let err = ''; child.stderr.on('data', d => { err += d; });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i++) { try { if ((await fetch(origin + '/api/health')).ok) return {child, origin}; } catch {} await sleep(100); }
  child.kill(); throw Error('server did not start: ' + err.slice(-500));
}

const profileBody = n => ({profile: {name: 'Load', goal: 'Travel & everyday life', minutes: 20, assessmentDone: true, level: 'A2', xp: n, streak: 1, skills: {Speaking: 47}}});

const results = [];
const env0 = {...process.env, NODE_ENV: 'production', API_RATE_LIMIT_PER_MIN: '100000000', AUTH_IP_LIMIT: '100000000', REDIS_URL: process.env.REDIS_URL || '', RATE_LIMIT_PREFIX: 'load' + Date.now(), SITE_ORIGIN: ''};
let pgAdmin = null;
if (BACKENDS.includes('pg')) {
  if (!process.env.DATABASE_URL) { console.error('pg backend requested but DATABASE_URL is not set'); process.exit(2); }
  const {default: pg} = await import('pg');
  pgAdmin = new pg.Client({connectionString: process.env.DATABASE_URL}); await pgAdmin.connect();
}

for (const backend of BACKENDS) for (const size of SIZES) {
  const dir = await mkdtemp(join(tmpdir(), 'usam-load-'));
  let env = {...env0, CUSTOMER_DB_FILE: join(dir, 'db.json'), PGLITE_DATA_DIR: join(dir, 'pglite'), LEADS_FILE: join(dir, 'l.jsonl'), DATABASE_URL: ''};
  let dbName = null;
  if (backend === 'pg') {
    dbName = `usam_load_${size}_${Date.now()}`;
    await pgAdmin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + dbName; env.DATABASE_URL = u.toString();
  }
  // Pass DATABASE_URL through as-is: '' must mean "JSON file", never fall back to the shell's DATABASE_URL.
  const storage = await createDb({databaseUrl: env.DATABASE_URL, dataDir: env.PGLITE_DATA_DIR}); // runs migrations
  const t = Date.now();
  let tokens, docBytes;
  try { ({tokens, bytes: docBytes} = await seed(storage, size)); } // serialized size of the whole application document
  catch (e) {
    console.error(`\n[${backend} ${size}] SEED FAILED: ${e.message}`);
    results.push({backend, size, scenario: 'seed', error: 'storage rejected the data set: ' + e.message.slice(0, 160)});
    await storage.close().catch(() => {});
    if (dbName) await pgAdmin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await rm(dir, {recursive: true, force: true});
    continue;
  }
  await storage.close();
  console.error(`\n[${backend} ${size}] seeded in ${((Date.now() - t) / 1000).toFixed(1)}s${docBytes ? `, document ${(docBytes / 1e6).toFixed(1)} MB` : ''}`);
  let server;
  try {
    const st = Date.now();
    server = await startServer(env);
    const startupMs = Date.now() - st;
    const cookie = w => ({Cookie: 'usam_session=' + tokens[(w * 7919 + Math.floor(Math.random() * tokens.length)) % tokens.length]});
    const scenarios = {
      health: (w) => ({path: '/api/health'}),
      read: (w) => ({path: '/api/customer/me', headers: cookie(w)}),
      write: (w, n) => ({method: 'PUT', path: '/api/customer/profile', headers: cookie(w), body: profileBody(n)}),
      mixed: (w, n) => n % 10 === 0 ? {method: 'PUT', path: '/api/customer/profile', headers: cookie(w), body: profileBody(n)} : {path: '/api/customer/me', headers: cookie(w)},
    };
    for (const [name, makeRequest] of Object.entries(scenarios)) {
      const conns = name === 'write' ? Math.min(20, CONNECTIONS) : CONNECTIONS;
      const r = await runLoad({origin: server.origin, connections: conns, durationMs: DURATION, makeRequest});
      // A measurement only counts if the requests actually succeeded (fast 401s/503s are not throughput).
      const valid = r.non2xx === 0 && r.errors === 0;
      const row = {backend, size, scenario: name, startupMs, docMB: docBytes ? +(docBytes / 1e6).toFixed(1) : null, valid, ...r};
      results.push(row);
      console.error(`  ${name.padEnd(6)} ${String(r.rps).padStart(6)} req/s  p50 ${r.p50}ms  p99 ${r.p99}ms  errors ${r.errors} non2xx ${r.non2xx}${valid ? '' : '  <-- INVALID: ' + JSON.stringify(r.codes)}`);
    }
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    results.push({backend, size, scenario: 'startup', error: e.message});
  } finally {
    server?.child.kill(); await sleep(500);
    if (dbName) await pgAdmin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
    await rm(dir, {recursive: true, force: true});
  }
}
if (pgAdmin) await pgAdmin.end();

const machine = {cpu: cpus()[0]?.model, cores: cpus().length, ramGB: +(totalmem() / 2 ** 30).toFixed(1), os: `${platform()} ${release()}`, node: process.version, note: 'generator, app server and database on the same machine; PostgreSQL 16 and Redis 7 in local Docker containers'};
await mkdir('tests/load/results', {recursive: true});
const file = `tests/load/results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(file, JSON.stringify({machine, durationMs: DURATION, connections: CONNECTIONS, results}, null, 2));
console.log(`\nMachine: ${machine.cpu} · ${machine.cores} logical cores · ${machine.ramGB} GB · ${machine.os} · Node ${machine.node}`);
console.log(`Each scenario: ${DURATION / 1000}s after 1s warm-up, ${CONNECTIONS} connections (write: ${Math.min(20, CONNECTIONS)}).\n`);
console.log('| Backend | Learners | Doc MB | Startup ms | Scenario | req/s | p50 ms | p90 ms | p99 ms | max ms | errors | non-2xx | valid |');
console.log('|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|');
for (const r of results) console.log(r.error ? `| ${r.backend} | ${r.size} | | | FAILED | ${r.error} | | | | | | | no |` : `| ${r.backend} | ${r.size} | ${r.docMB ?? '—'} | ${r.startupMs} | ${r.scenario} | ${r.rps} | ${r.p50} | ${r.p90} | ${r.p99} | ${r.max} | ${r.errors} | ${r.non2xx} | ${r.valid ? 'yes' : '**INVALID**'} |`);
console.log(`\nRaw results: ${file}`);
process.exit(0);
