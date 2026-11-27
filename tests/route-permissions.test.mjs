// Route-permission table test (E-3).
// 1. Every route registered by adminRouter() is discovered from the Express router itself (not from a hand list).
// 2. Each discovered route MUST have an entry in TABLE below; a route with no entry, or an entry with no route, fails the test.
// 3. Against a real server: no cookie -> 401; every role lacking the permission -> 403 with exactly DENIED_MESSAGE (exported by
//    server/admin.js); every role that has it -> not stopped by the gate (success or validation/not-found, dummy ids only).
// TABLE value: a permission name, 'session' (any signed-in admin, no permission), or 'public'.
// 'public' = login, mfa and logout: they run before a session exists (login/mfa) or must work without one (logout), so they are
// only checked for not crashing (login with an empty body must answer 400 or 401).
// Scope: only routes registered inside adminRouter() are discovered. Admin-like routes added in server/index.js or another
// router are NOT covered by this test.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {freePort, stopServer} from './helpers.mjs';
import {adminRouter, ROLES, PERMISSIONS, DENIED_MESSAGE as DENIED, can} from '../server/admin.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TABLE = {
  'POST /admin/auth/login': 'public',
  'POST /admin/auth/mfa': 'public',
  'POST /admin/auth/logout': 'public',
  'POST /admin/mfa/setup': 'session',
  'POST /admin/mfa/enable': 'session',
  'POST /admin/mfa/disable': 'session',
  'GET /admin/auth/me': 'session',
  'POST /admin/auth/password': 'session',
  'GET /admin/overview': 'dashboard.read',
  'GET /admin/ai-usage': 'dashboard.read',
  'GET /admin/users': 'users.read',
  'GET /admin/users/:id': 'users.read',
  'PATCH /admin/users/:id/status': 'users.write',
  'POST /admin/users/:id/revoke-sessions': 'users.write',
  'POST /admin/users/:id/verify-email': 'users.write',
  'POST /admin/users/:id/entitlements': 'orders.write',
  'DELETE /admin/users/:id/entitlements/English': 'orders.write',
  'GET /admin/orders': 'orders.read',
  'POST /admin/orders/:reference/activate': 'orders.write',
  'POST /admin/orders/:reference/refund': 'orders.write',
  'GET /admin/support': 'support.read',
  'PATCH /admin/support/:reference': 'support.write',
  'GET /admin/leads': 'leads.read',
  'PATCH /admin/leads/:reference': 'leads.write',
  'GET /admin/audit': 'audit.read',
  'GET /admin/audit/verify': 'audit.read',
  'GET /admin/roles': 'admins.read',
  'GET /admin/admins': 'admins.read',
  'POST /admin/admins': 'admins.write',
  'POST /admin/admins/:id/mfa/reset': 'admins.write',
  'PATCH /admin/admins/:id': 'admins.write',
};

// ---- 1. discover the routes the router really registers ----
const stub = {repo: {}, db: async () => ({}), throttle: (_q, _s, next) => next()};
const router = adminRouter(stub, {leadsFile: '/dev/null'});
const found = [];
for (const layer of router.stack) {
  if (!layer.route) continue;
  for (const m of Object.keys(layer.route.methods)) found.push(`${m.toUpperCase()} ${layer.route.path}`);
}
ok(found.length >= 25, `discovered ${found.length} routes from the router`);
const missing = found.filter(r => !(r in TABLE));
const stale = Object.keys(TABLE).filter(r => !found.includes(r));
ok(missing.length === 0, `every registered route has a table entry${missing.length ? ' - MISSING: ' + missing.join(', ') : ''}`);
ok(stale.length === 0, `no table entry without a route${stale.length ? ' - STALE: ' + stale.join(', ') : ''}`);

// ---- table sanity: all permissions and roles are exercised ----
const used = new Set(Object.values(TABLE));
ok(Object.keys(PERMISSIONS).every(p => used.has(p)), `all ${Object.keys(PERMISSIONS).length} permissions are used by at least one route`);
ok(Object.values(TABLE).every(v => v === 'public' || v === 'session' || v in PERMISSIONS), 'every table value is a known permission, session or public');

// ---- 2. real server ----
const rnd = () => randomBytes(32).toString('hex'); // keys and passwords are generated per run, never literals (secret scan)
const PW = rnd(), RUN = 'rp' + Date.now();
const dir = await mkdtemp(join(tmpdir(), 'usam-rp-'));
const env = {...process.env, NODE_ENV: 'test', RATE_LIMIT_PREFIX: RUN, AUTH_IP_LIMIT: '100000', API_RATE_LIMIT_PER_MIN: '100000', AUDIT_HMAC_KEY: rnd(), ADMIN_MFA_KEY: rnd(), LEADS_FILE: join(dir, 'none.jsonl'), CUSTOMER_DB_FILE: join(dir, 'db.json')};
let child, isolatedDb = null, pgAdmin = null;
if (process.env.DATABASE_URL) {
  // dedicated throw-away database, as admin.test.mjs does
  const {default: pg} = await import('pg');
  pgAdmin = new pg.Client({connectionString: process.env.DATABASE_URL}); await pgAdmin.connect();
  isolatedDb = 'usam_rp_' + RUN.toLowerCase().replace(/[^a-z0-9]/g, '');
  await pgAdmin.query(`CREATE DATABASE ${isolatedDb}`);
  const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + isolatedDb; env.DATABASE_URL = u.toString();
}
const cli = (args, extra) => new Promise(r => { const p = spawn(process.execPath, args, {env: {...env, ...extra}, stdio: 'ignore'}); p.on('exit', r); });
const call = async (o, method, path, cookie, body) => {
  const r = await fetch(o + '/api' + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {})}, body: body ? JSON.stringify(body) : undefined});
  let data = {}; try { data = await r.json(); } catch {}
  return {status: r.status, data, cookie: (r.headers.get('set-cookie') || '').split(';')[0]};
};
try {
  const ownerEmail = `owner-${RUN}@example.com`;
  ok(await cli(['scripts/create-admin.mjs', '--email', ownerEmail, '--name', 'Owner', '--role', 'owner'], {ADMIN_PASSWORD: PW}) === 0, 'owner account created');
  const port = await freePort();
  child = spawn(process.execPath, ['server/index.js'], {env: {...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  const o = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(o + '/api/health')).ok) break; } catch {} await sleep(100); }
  const login = async email => (await call(o, 'POST', '/admin/auth/login', null, {email, password: PW})).cookie;
  const sessions = {owner: await login(ownerEmail)};
  for (const role of Object.keys(ROLES)) {
    if (role === 'owner') continue;
    const r = await call(o, 'POST', '/admin/admins', sessions.owner, {email: `${role}-${RUN}@example.com`, name: role + ' person', role, password: PW});
    ok(r.status === 201, `${role} account created`);
    sessions[role] = await login(`${role}-${RUN}@example.com`);
  }
  ok(Object.keys(ROLES).every(r => sessions[r]?.startsWith('usam_admin=')), `signed in with all ${Object.keys(ROLES).length} roles`);

  const urlOf = route => '/' + route.split(' ')[1].slice(1).replace(/:(\w+)/g, 'nonexistent-$1');
  const bodyFor = method => method === 'GET' ? undefined : {};
  let checks = 0;
  for (const [route, rule] of Object.entries(TABLE)) {
    const method = route.split(' ')[0], path = urlOf(route);
    if (rule === 'public') {
      const r = await call(o, method, path, null, bodyFor(method));
      ok(r.status !== 500, `${route}: public route answers without a server crash (got ${r.status})`);
      if (route === 'POST /admin/auth/login') ok(r.status === 400 || r.status === 401, `${route}: empty body -> 400 or 401 (got ${r.status})`);
      continue;
    }
    const anon = await call(o, method, path, null, bodyFor(method));
    ok(anon.status === 401, `${route}: no cookie -> 401 (got ${anon.status})`);
    for (const role of Object.keys(ROLES)) {
      const r = await call(o, method, path, sessions[role], bodyFor(method));
      const allowed = rule === 'session' || can(role, rule);
      checks++;
      if (allowed) {
        // Past the permission gate the handler may still answer 400/403/404 (e.g. wrong current password); only the gate's own
        // answers (401, or 403 with the role-denied message) and a crash (500) count as failures.
        if (r.status === 401 || r.status === 500 || r.data?.error === DENIED) ok(false, `${route}: ${role} has '${rule}' and must pass the permission check (got ${r.status})`);
      } else {
        const msg = r.data?.error;
        if (!(r.status === 403 && msg === DENIED)) ok(false, `${route}: ${role} lacks '${rule}' and must get 403 with a plain message (got ${r.status}, ${JSON.stringify(msg)})`);
      }
    }
  }
  const expectedChecks = Object.values(TABLE).filter(v => v !== 'public').length * Object.keys(ROLES).length;
  ok(checks === expectedChecks, `${checks} route x role checks ran (expected ${expectedChecks} = non-public routes x ${Object.keys(ROLES).length} roles; failures are listed above)`);
} finally {
  if (child) await stopServer(child);
  await rm(dir, {recursive: true, force: true});
  if (pgAdmin) { try { await pgAdmin.query(`DROP DATABASE IF EXISTS ${isolatedDb} WITH (FORCE)`); } catch {} await pgAdmin.end(); }
}
if (failures) { console.error(`\nRoute-permission tests FAILED (${failures}).`); process.exit(1); }
console.log('\nRoute-permission tests passed.');
