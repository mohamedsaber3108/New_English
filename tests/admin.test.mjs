// Admin RBAC + operations integration tests (real server processes, real HTTP, real storage).
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freePort, stopServer} from './helpers.mjs';
import {createDb} from '../server/db/index.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN = 'adm' + Date.now() + Math.random().toString(36).slice(2, 6);
const PW = 'correct-horse-battery-staple';
const procs = [];
const dir = await mkdtemp(join(tmpdir(), 'usam-admin-'));
const baseEnv = extra => ({...process.env, NODE_ENV: 'test', RATE_LIMIT_PREFIX: RUN, AUTH_IP_LIMIT: '1000', AUDIT_HMAC_KEY: 'test-audit-key-0123456789', LEADS_FILE: join(dir, 'none.jsonl'), ...extra});

function runCli(script, args, env, input) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [script, ...args], {env, stdio: ['pipe', 'pipe', 'pipe']});
    let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d);
    if (input) p.stdin.end(input); else p.stdin.end();
    p.on('exit', code => resolve({code, out}));
  });
}
async function start(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {env: {...env, PORT: String(port)}, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  procs.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) { try { if ((await fetch(origin + '/api/health')).ok) return {origin, child}; } catch {} await sleep(100); }
  throw Error('server did not start');
}
const stop = s => stopServer(s.child); // graceful: the server closes its database before exiting
async function call(origin, path, {method = 'GET', body, cookie, headers = {}} = {}) {
  const r = await fetch(origin + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {}), ...headers}, body: body ? JSON.stringify(body) : undefined});
  let data = {}; try { data = await r.json(); } catch {}
  return {status: r.status, data, setCookie: r.headers.get('set-cookie') || ''};
}
const cookieOf = r => r.setCookie.split(';')[0];
async function adminLogin(origin, email, password = PW) { const r = await call(origin, '/api/admin/auth/login', {method: 'POST', body: {email, password}}); return {r, cookie: cookieOf(r)}; }

// With PostgreSQL, run against a dedicated throwaway database so this suite never shares state
// (audit chain, payment references) with other suites or earlier runs.
let pgAdmin = null, isolatedDb = null;
async function isolatePostgres() {
  if (!process.env.DATABASE_URL) return {};
  const {default: pg} = await import('pg');
  pgAdmin = new pg.Client({connectionString: process.env.DATABASE_URL});
  await pgAdmin.connect();
  isolatedDb = 'usam_admin_' + RUN.toLowerCase().replace(/[^a-z0-9]/g, '');
  await pgAdmin.query(`CREATE DATABASE ${isolatedDb}`);
  const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + isolatedDb;
  return {DATABASE_URL: u.toString()};
}

try {
  // ======================= main flow (whichever storage backend is configured) =======================
  const dbFile = join(dir, 'main.json');
  const env = baseEnv({CUSTOMER_DB_FILE: dbFile, ...(await isolatePostgres())});
  const PAY1 = 'BANK-' + RUN.slice(-8).toUpperCase() + '-1', PAY2 = 'BANK-' + RUN.slice(-8).toUpperCase() + '-2';
  const ownerEmail = `owner-${RUN}@example.com`;
  const cli = await runCli('scripts/create-admin.mjs', ['--email', ownerEmail, '--name', 'Owner Person', '--role', 'owner'], {...env, ADMIN_PASSWORD: PW});
  ok(cli.code === 0, 'CLI bootstraps the first owner account');
  const cliWeak = await runCli('scripts/create-admin.mjs', ['--email', `weak-${RUN}@example.com`, '--name', 'Weak', '--role', 'owner'], {...env, ADMIN_PASSWORD: 'short'});
  ok(cliWeak.code !== 0, 'CLI rejects a weak password');
  const cliStdin = await runCli('scripts/create-admin.mjs', ['--email', `stdin-${RUN}@example.com`, '--name', 'Stdin Admin', '--role', 'viewer', '--password-stdin'], env, PW + '\n');
  ok(cliStdin.code === 0, 'CLI accepts the password on stdin');

  const S = await start(env);
  const O = S.origin;

  // --- unauthenticated / legacy ---
  ok((await call(O, '/api/admin/users')).status === 401, 'unauthenticated admin API -> 401');
  ok((await call(O, '/api/admin/overview', {headers: {Authorization: 'Bearer ' + 'a'.repeat(40)}})).status === 401, 'shared bearer token is rejected by default (legacy disabled)');

  // --- login ---
  const bad = await adminLogin(O, ownerEmail, 'wrong-password-123');
  const unknown = await adminLogin(O, `nobody-${RUN}@example.com`);
  ok(bad.r.status === 401 && unknown.r.status === 401 && bad.r.data.error === unknown.r.data.error, 'wrong password and unknown email give the same 401 (no account enumeration)');
  const owner = await adminLogin(O, ownerEmail);
  ok(owner.r.status === 200 && owner.cookie.startsWith('usam_admin='), 'owner signs in and receives an admin session cookie');
  ok(/HttpOnly/i.test(owner.r.setCookie) && /SameSite=Strict/i.test(owner.r.setCookie) && /Path=\/api\/admin/i.test(owner.r.setCookie), 'admin cookie is HttpOnly, SameSite=Strict, scoped to /api/admin');
  const me = await call(O, '/api/admin/auth/me', {cookie: owner.cookie});
  ok(me.data.admin?.role === 'owner' && me.data.permissions.includes('admins.write'), '/auth/me returns role and permissions');
  ok(!('password' in (me.data.admin || {})), 'admin password hash is never returned');

  // --- staff accounts ---
  const mk = async (role) => (await call(O, '/api/admin/admins', {method: 'POST', cookie: owner.cookie, body: {email: `${role}-${RUN}@example.com`, name: role + ' person', role, password: PW}}));
  const created = {};
  for (const role of ['admin', 'finance', 'support', 'viewer']) created[role] = await mk(role);
  ok(Object.values(created).every(r => r.status === 201), 'owner creates admin, finance, support and viewer accounts');
  ok((await mk('support')).status === 409, 'duplicate administrator email -> 409');
  ok((await call(O, '/api/admin/admins', {method: 'POST', cookie: owner.cookie, body: {email: `x-${RUN}@example.com`, name: 'X', role: 'viewer', password: 'short'}})).status === 400, 'weak admin password -> 400');
  ok((await call(O, '/api/admin/admins', {method: 'POST', cookie: owner.cookie, body: {email: `y-${RUN}@example.com`, name: 'Y', role: 'superuser', password: PW}})).status === 400, 'unknown role -> 400');
  const s = {};
  for (const role of ['admin', 'finance', 'support', 'viewer']) s[role] = (await adminLogin(O, `${role}-${RUN}@example.com`)).cookie;

  // --- learner side setup ---
  const learnerEmail = `learner-${RUN}@example.com`;
  const reg = await call(O, '/api/customer/register', {method: 'POST', body: {name: 'Lina Learner', email: learnerEmail, phone: '01000000000', password: PW}});
  let learner = cookieOf(reg);
  const learnerId = reg.data.user.id;
  ok((await call(O, '/api/admin/overview', {cookie: learner})).status === 401, 'a learner session cannot use the admin API');
  ok((await call(O, '/api/customer/me', {cookie: owner.cookie})).status === 401, 'an admin session is not a learner session');
  const order1 = (await call(O, '/api/customer/orders', {method: 'POST', cookie: learner, body: {plan: 'essential', term: 'monthly', language: 'English'}})).data.reference;
  const order2 = (await call(O, '/api/customer/orders', {method: 'POST', cookie: learner, body: {plan: 'plus', term: 'monthly', language: 'English'}})).data.reference;
  const ticket = (await call(O, '/api/customer/support', {method: 'POST', cookie: learner, body: {category: 'payment', subject: 'Payment question', message: 'I paid by bank transfer, please activate.'}})).data.reference;
  const leadEmail = `lead-${RUN}@example.com`;
  await call(O, '/api/leads', {method: 'POST', body: {name: 'Lead Person', email: leadEmail, phone: '01000000000', kind: 'question', language: 'English', message: 'Group pricing?'}});
  ok((await call(O, '/api/feedback', {method: 'POST', cookie: learner, body: {text: 'I like learning English.'}})).status === 402, 'learner without subscription is blocked from paid content (402)');

  // --- users: search, pagination, detail ---
  const list = await call(O, `/api/admin/users?q=${encodeURIComponent(learnerEmail)}`, {cookie: s.viewer});
  ok(list.status === 200 && list.data.total === 1 && list.data.items[0].email === learnerEmail, 'viewer searches users by email');
  const paged = await call(O, '/api/admin/users?pageSize=1&page=1', {cookie: owner.cookie});
  ok(paged.data.items.length === 1 && paged.data.pageSize === 1 && paged.data.pages === paged.data.total, 'user list paginates (pageSize=1)');
  ok((await call(O, '/api/admin/users?pageSize=5000', {cookie: owner.cookie})).data.pageSize === 100, 'pageSize is capped at 100');
  const detail = await call(O, `/api/admin/users/${learnerId}`, {cookie: s.support});
  ok(detail.status === 200 && detail.data.orders.length === 2 && detail.data.tickets.length === 1, 'user detail shows the learner\'s orders and tickets');
  ok((await call(O, '/api/admin/users/does-not-exist', {cookie: owner.cookie})).status === 404, 'unknown user -> 404');

  // --- permission boundaries ---
  ok((await call(O, `/api/admin/users/${learnerId}/status`, {method: 'PATCH', cookie: s.viewer, body: {status: 'suspended', reason: 'testing permissions'}})).status === 403, 'viewer cannot suspend a user (403)');
  ok((await call(O, `/api/admin/orders/${order1}/activate`, {method: 'POST', cookie: s.support, body: {paymentReference: PAY1, reason: 'should be denied'}})).status === 403, 'support cannot activate payments (403)');
  ok((await call(O, '/api/admin/audit', {cookie: s.support})).status === 403, 'support cannot read the audit log (403)');
  ok((await call(O, '/api/admin/admins', {cookie: s.viewer})).status === 403, 'viewer cannot list administrators (403)');
  ok((await call(O, '/api/admin/admins', {method: 'POST', cookie: s.admin, body: {email: `o2-${RUN}@example.com`, name: 'O2', role: 'owner', password: PW}})).status === 403, 'admin role cannot create administrators / owners (403)');
  ok((await call(O, `/api/admin/support/${ticket}`, {method: 'PATCH', cookie: s.finance, body: {status: 'resolved'}})).status === 403, 'finance cannot update support tickets (403)');

  // --- orders: manual activation, duplicate payment reference, refund ---
  ok((await call(O, `/api/admin/orders/${order1}/activate`, {method: 'POST', cookie: s.finance, body: {paymentReference: PAY1}})).status === 400, 'activation without a reason -> 400');
  const act = await call(O, `/api/admin/orders/${order1}/activate`, {method: 'POST', cookie: s.finance, body: {paymentReference: PAY1, reason: 'bank transfer reconciled'}});
  ok(act.status === 200 && act.data.order.status === 'paid', 'finance activates a reconciled manual payment');
  ok((await call(O, '/api/feedback', {method: 'POST', cookie: learner, body: {text: 'I like learning English.'}})).status === 200, 'learner can now use paid content (entitlement enforced server-side)');
  ok((await call(O, `/api/admin/orders/${order2}/activate`, {method: 'POST', cookie: s.finance, body: {paymentReference: PAY1, reason: 'reuse attempt'}})).status === 409, 'reusing a payment reference -> 409');
  ok((await call(O, `/api/admin/orders/${order1}/activate`, {method: 'POST', cookie: s.finance, body: {paymentReference: PAY2, reason: 'double activation'}})).status === 409, 'activating an already-paid order -> 409');
  const orders = await call(O, `/api/admin/orders?status=paid&q=${encodeURIComponent(learnerEmail)}`, {cookie: s.viewer});
  ok(orders.data.total === 1 && orders.data.items[0].reference === order1, 'orders filter by status and customer email');
  const ref = await call(O, `/api/admin/orders/${order1}/refund`, {method: 'POST', cookie: s.finance, body: {reason: 'customer requested refund'}});
  ok(ref.status === 200 && ref.data.order.status === 'refunded' && ref.data.entitlementRevoked === true, 'refund recorded and the paid entitlement revoked');
  ok(/does not move funds/i.test(ref.data.notice || ''), 'refund response states that money is not moved by this action');
  ok((await call(O, '/api/feedback', {method: 'POST', cookie: learner, body: {text: 'Hello again.'}})).status === 402, 'after refund the learner is blocked again (402)');

  // --- manual entitlement grant / revoke ---
  const grant = await call(O, `/api/admin/users/${learnerId}/entitlements`, {method: 'POST', cookie: s.finance, body: {plan: 'plus', days: 30, reason: 'goodwill extension'}});
  ok(grant.status === 200 && grant.data.user.subscription?.active && grant.data.user.subscription.plan === 'plus', 'finance grants a 30-day Plus entitlement');
  ok((await call(O, '/api/feedback', {method: 'POST', cookie: learner, body: {text: 'Granted access works.'}})).status === 200, 'granted entitlement unlocks paid content');
  ok((await call(O, `/api/admin/users/${learnerId}/entitlements`, {method: 'POST', cookie: s.finance, body: {plan: 'gold', days: 30, reason: 'invalid plan'}})).status === 400, 'invalid plan -> 400');
  const revoke = await call(O, `/api/admin/users/${learnerId}/entitlements/English`, {method: 'DELETE', cookie: s.finance, body: {reason: 'grant ended early'}});
  ok(revoke.status === 200 && revoke.data.revoked === true, 'finance revokes the entitlement');
  ok((await call(O, '/api/feedback', {method: 'POST', cookie: learner, body: {text: 'Revoked.'}})).status === 402, 'revoked entitlement blocks paid content again');

  // --- suspension ---
  const sus = await call(O, `/api/admin/users/${learnerId}/status`, {method: 'PATCH', cookie: s.admin, body: {status: 'suspended', reason: 'abuse report review'}});
  ok(sus.status === 200 && sus.data.user.status === 'suspended', 'admin suspends a learner');
  ok((await call(O, '/api/customer/me', {cookie: learner})).status === 401, 'suspension ends the learner\'s existing sessions');
  ok((await call(O, '/api/customer/login', {method: 'POST', body: {email: learnerEmail, password: PW}})).status === 403, 'suspended learner cannot sign in (403)');
  ok((await call(O, `/api/admin/users?status=suspended&q=${encodeURIComponent(learnerEmail)}`, {cookie: s.viewer})).data.total === 1, 'users filter by status=suspended');
  await call(O, `/api/admin/users/${learnerId}/status`, {method: 'PATCH', cookie: s.admin, body: {status: 'active', reason: 'review complete'}});
  const relog = await call(O, '/api/customer/login', {method: 'POST', body: {email: learnerEmail, password: PW}});
  ok(relog.status === 200, 'reactivated learner can sign in again');
  learner = cookieOf(relog);

  // --- support tickets ---
  ok((await call(O, `/api/admin/support/${ticket}`, {method: 'PATCH', cookie: s.support, body: {status: 'bogus'}})).status === 400, 'invalid ticket status -> 400');
  const tk = await call(O, `/api/admin/support/${ticket}`, {method: 'PATCH', cookie: s.support, body: {status: 'resolved', resolution: 'Activated after reconciliation.'}});
  ok(tk.status === 200 && tk.data.ticket.status === 'resolved', 'support resolves a ticket');
  const mine = await call(O, '/api/customer/support', {cookie: learner});
  ok(mine.data.tickets?.find(t => t.reference === ticket)?.status === 'resolved', 'the learner sees the updated ticket status');
  ok((await call(O, '/api/admin/support?status=resolved&category=payment', {cookie: s.support})).data.items.some(t => t.reference === ticket), 'support list filters by status and category');

  // --- leads ---
  const leads = await call(O, `/api/admin/leads?q=${encodeURIComponent(leadEmail)}`, {cookie: s.support});
  ok(leads.status === 200 && leads.data.total === 1 && leads.data.items[0].status === 'new', 'new website lead is stored and searchable');
  const leadRef = leads.data.items[0].reference;
  const lu = await call(O, `/api/admin/leads/${leadRef}`, {method: 'PATCH', cookie: s.support, body: {status: 'contacted', note: 'Called, sending group quote.'}});
  ok(lu.status === 200 && lu.data.lead.status === 'contacted' && lu.data.lead.notes?.length === 1, 'support updates lead status with a note');
  ok((await call(O, `/api/admin/leads/${leadRef}`, {method: 'PATCH', cookie: s.support, body: {status: 'won'}})).status === 400, 'invalid lead status -> 400');
  ok((await call(O, `/api/admin/leads/${leadRef}`, {method: 'PATCH', cookie: s.viewer, body: {status: 'closed'}})).status === 403, 'viewer cannot update leads (403)');

  // --- administrator management ---
  const meOwner = me.data.admin.id;
  ok((await call(O, `/api/admin/admins/${meOwner}`, {method: 'PATCH', cookie: owner.cookie, body: {role: 'viewer'}})).status === 409, 'an administrator cannot change their own role');
  const supportId = created.support.data.admin.id;
  const dis = await call(O, `/api/admin/admins/${supportId}`, {method: 'PATCH', cookie: owner.cookie, body: {status: 'disabled'}});
  ok(dis.status === 200 && dis.data.admin.status === 'disabled', 'owner disables the support administrator');
  ok((await call(O, '/api/admin/support', {cookie: s.support})).status === 401, 'a disabled administrator\'s session stops working immediately');
  ok((await adminLogin(O, `support-${RUN}@example.com`)).r.status === 401, 'a disabled administrator cannot sign in');
  const roles = await call(O, '/api/admin/roles', {cookie: s.admin});
  ok(roles.status === 200 && roles.data.roles.owner && roles.data.permissions['orders.write'], 'role matrix is available to admins.read');

  // --- audit trail ---
  const audit = await call(O, '/api/admin/audit?pageSize=100', {cookie: owner.cookie});
  const events = audit.data.items.map(e => e.event);
  for (const ev of ['admin_login', 'admin_login_failed', 'admin_created', 'admin_permission_denied', 'order_manually_activated', 'order_refund_recorded', 'entitlement_granted', 'entitlement_revoked', 'user_status_changed', 'support_updated', 'lead_updated', 'admin_updated'])
    ok(events.includes(ev), `audit log records ${ev}`);
  const actEntry = audit.data.items.find(e => e.event === 'order_manually_activated');
  ok(actEntry?.actorLabel === `finance-${RUN}@example.com` && actEntry.meta.reason === 'bank transfer reconciled', 'audit entry names the acting administrator and the reason');
  ok(!JSON.stringify(audit.data.items).includes(learnerEmail), 'audit entries do not contain the learner\'s email (pseudonymous ids only)');
  const filtered = await call(O, '/api/admin/audit?event=order_refund_recorded', {cookie: s.finance});
  ok(filtered.status === 200 && filtered.data.items.every(e => e.event === 'order_refund_recorded') && filtered.data.items.length >= 1, 'audit log filters by event (finance has audit.read)');
  const v = await call(O, '/api/admin/audit/verify', {cookie: owner.cookie});
  ok(v.status === 200 && v.data.ok === true && v.data.keyed === true && v.data.checked > 10, `audit chain verifies (${v.data.checked} keyed entries)`);

  // --- CSRF / logout ---
  ok((await call(O, '/api/admin/auth/logout', {method: 'POST', cookie: owner.cookie, headers: {Origin: 'https://evil.example'}})).status === 403, 'cross-origin admin POST is rejected (403)');
  await call(O, '/api/admin/auth/logout', {method: 'POST', cookie: owner.cookie});
  ok((await call(O, '/api/admin/overview', {cookie: owner.cookie})).status === 401, 'logout invalidates the admin session');
  await stop(S);

  // ======================= embedded PGlite: tamper evidence, idle timeout, legacy migration mode =======================
  const tFile = join(dir, 'tamper.json');
  const tEnv = baseEnv({CUSTOMER_DB_FILE: tFile, DATABASE_URL: '', ADMIN_IDLE_MS: '1500', ADMIN_LEGACY_TOKEN: 'true', ADMIN_ACCESS_TOKEN: 'L'.repeat(40)});
  const tOwner = `towner-${RUN}@example.com`;
  await runCli('scripts/create-admin.mjs', ['--email', tOwner, '--name', 'Tamper Owner', '--role', 'owner'], {...tEnv, ADMIN_PASSWORD: PW});
  let T = await start(tEnv);
  let to = await adminLogin(T.origin, tOwner);
  await call(T.origin, '/api/admin/admins', {method: 'POST', cookie: to.cookie, body: {email: `tv-${RUN}@example.com`, name: 'TV', role: 'viewer', password: PW}});
  ok((await call(T.origin, '/api/admin/audit/verify', {cookie: to.cookie})).data.ok === true, 'fresh chain verifies before tampering');
  const legacy = await call(T.origin, '/api/admin/overview', {headers: {Authorization: 'Bearer ' + 'L'.repeat(40)}});
  ok(legacy.status === 200, 'ADMIN_LEGACY_TOKEN=true: legacy token can still read (migration mode)');
  ok((await call(T.origin, '/api/admin/admins', {method: 'POST', headers: {Authorization: 'Bearer ' + 'L'.repeat(40)}, body: {email: 'z@example.com', name: 'Z', role: 'viewer', password: PW}})).status === 403, 'legacy token is read-only (403 on writes)');
  await sleep(2200);
  ok((await call(T.origin, '/api/admin/auth/me', {cookie: to.cookie})).status === 401, 'admin session expires after the idle timeout');
  await stop(T);
  // Tamper with a recorded audit entry directly in the database (an attacker with storage access, no signing key).
  const raw = await createDb({databaseUrl: '', dataDir: tFile.replace(/\.json$/, '') + '-pglite'});
  const target = (await raw.query("SELECT seq FROM audit_log WHERE event = 'admin_created' AND actor->>'type' = 'admin' ORDER BY seq LIMIT 1")).rows[0];
  await raw.query(`UPDATE audit_log SET meta = jsonb_set(meta, '{role}', '"owner"') WHERE seq = $1`, [target.seq]);
  await raw.close();
  T = await start(tEnv);
  to = await adminLogin(T.origin, tOwner);
  const tv = await call(T.origin, '/api/admin/audit/verify', {cookie: to.cookie});
  ok(tv.data.ok === false && tv.data.brokenAt === target.seq, `tampering is detected at entry #${target.seq} (${tv.data.reason})`);
  ok(legacy.status === 200 && (await call(T.origin, '/api/admin/audit?event=admin_legacy_token_used', {cookie: to.cookie})).data.total >= 1, 'every legacy-token use is audited');
  await stop(T);
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  await sleep(300);
  if (pgAdmin) { try { await pgAdmin.query(`DROP DATABASE IF EXISTS ${isolatedDb} WITH (FORCE)`); } catch (e) { console.error('could not drop', isolatedDb, e.message); } await pgAdmin.end(); }
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nAdmin tests FAILED (${failures}).`); process.exit(1); }
console.log('\nAdmin tests passed.');
process.exit(0);
