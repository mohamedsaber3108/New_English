// Money data hardening (E-6): migration 003 up/down/refusal, DB constraints, and the Paymob webhook against a real
// database (PGlite always; PostgreSQL too when DATABASE_URL is set). No provider is called: events are signed locally
// with a made-up HMAC secret generated for this run.
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes, createHmac} from 'node:crypto';
import express from 'express';
import {createDb, isUniqueViolation} from '../server/db/index.js';
import * as repo from '../server/db/repo.js';
import {freePort} from './helpers.mjs';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const rnd = () => randomBytes(32).toString('hex'); // generated per run, never a literal (secret scan)
const RUN = 'md' + Date.now() + Math.random().toString(36).slice(2, 6);
const DOWN = await readFile(new URL('../server/db/migrations-down/003_money_hardening.down.sql', import.meta.url), 'utf8');
const noRetry = {recursive: true, force: true, maxRetries: 5, retryDelay: 200};

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const exists = async (db, sql) => (await db.query(sql)).rows.length > 0;
const hasIndex = (db, n) => exists(db, `SELECT 1 FROM pg_indexes WHERE indexname = '${n}'`);
const hasTable = (db, n) => exists(db, `SELECT 1 FROM information_schema.tables WHERE table_name = '${n}'`);
const hasColumn = (db, t, c) => exists(db, `SELECT 1 FROM information_schema.columns WHERE table_name = '${t}' AND column_name = '${c}'`);
async function seedOrder(db, n, extra = {}) {
  const uid = `u-${RUN}-${n}`, ref = `ORD-${RUN}-${n}`;
  await db.tx(async q => {
    await repo.users.create(q, {id: uid, email: `${uid}@example.com`, name: 'Money Tester', password: 'x', emailVerified: true});
    await repo.orders.create(q, {reference: ref, userId: uid, language: 'English', plan: 'essential', term: 'monthly', amount: 300, status: 'pending_payment', createdAt: new Date().toISOString()});
    if (Object.keys(extra).length) await repo.orders.update(q, ref, extra);
  });
  return {uid, ref};
}

// ------------------------------------------------------------------ migration 003: up, constraints, down, refusal
async function migrationSuite(label, open) {
  console.log(`-- migration 003 (${label})`);
  let db = await open();
  ok(db.applied.includes('003_money_hardening.sql'), `${label}: 003 is applied on first open`);
  ok(await hasIndex(db, 'orders_transaction_key') && await hasTable(db, 'payment_events') && await hasColumn(db, 'orders', 'currency'), `${label}: unique index, payment_events and orders.currency exist`);
  const a = await seedOrder(db, 'a'), b = await seedOrder(db, 'b'), c = await seedOrder(db, 'c');
  ok((await one(db, 'SELECT currency FROM orders WHERE reference = $1', [a.ref])).currency === 'EGP', `${label}: orders.currency defaults to EGP`);
  await db.tx(q => repo.orders.update(q, a.ref, {transactionId: 'T-1'}));
  let err = null; try { await db.tx(q => repo.orders.update(q, b.ref, {transactionId: 'T-1'})); } catch (e) { err = e; }
  ok(isUniqueViolation(err), `${label}: the database rejects a second order with the same provider transaction id (23505)`);
  ok((await one(db, 'SELECT count(*)::int AS n FROM orders WHERE transaction_id IS NULL')).n === 2, `${label}: orders without a transaction id may repeat (NULL is allowed many times)`);
  const ev = {provider: 'paymob', eventId: 'E-1', rawBody: '{}', signatureVerified: true};
  const c1 = await db.tx(q => repo.paymentEvents.claim(q, ev));
  await db.tx(q => repo.paymentEvents.setOutcome(q, c1.id, 'applied', null));
  const c2 = await db.tx(q => repo.paymentEvents.claim(q, ev));
  ok(c1.replay === false && c2.replay === true && c2.id === c1.id && (await one(db, "SELECT count(*)::int AS n FROM payment_events WHERE event_id = 'E-1'")).n === 1, `${label}: an applied provider event id is stored once and a second claim is a replay`);
  await db.tx(q => repo.paymentEvents.setOutcome(q, c1.id, 'unmatched', null));
  ok((await db.tx(q => repo.paymentEvents.claim(q, ev))).replay === false, `${label}: an event whose outcome is not 'applied' is claimed again (re-processed), not dropped`);
  err = null; try { await db.query("UPDATE payment_events SET outcome = 'bogus' WHERE event_id = 'E-1'"); } catch (e) { err = e; }
  ok(!!err, `${label}: outcome only accepts applied, rejected, unmatched or ignored`);

  // down script: removes the objects and the migration record; the runner never executes it by itself
  await db.tx(q => q.exec(DOWN));
  ok(!await hasIndex(db, 'orders_transaction_key') && !await hasTable(db, 'payment_events') && !await hasColumn(db, 'orders', 'currency'), `${label}: the down script removes index, table and column`);
  ok(!await exists(db, "SELECT 1 FROM schema_migrations WHERE name = '003_money_hardening.sql'"), `${label}: the down script clears the migration record`);
  ok((await one(db, 'SELECT count(*)::int AS n FROM orders')).n === 3, `${label}: no order rows are lost by the down script`);

  // duplicates present while 003 is not applied: the migration refuses with a clear message and changes nothing
  await db.tx(async q => { await q.query("UPDATE orders SET transaction_id = 'DUP' WHERE reference IN ($1, $2)", [b.ref, c.ref]); });
  await db.close();
  let refused = null; try { db = await open(); } catch (e) { refused = e; }
  ok(refused && /migration 003 refused: duplicate orders\.transaction_id/.test(refused.message), `${label}: with duplicate transaction ids the migration refuses with a clear message`);
  // The refused migration rolled back; the "up, down, up" step after the caller fixes the duplicates proves nothing was left half-done.
}

// ------------------------------------------------------------------ run on PGlite (+ PostgreSQL)
const dir = await mkdtemp(join(tmpdir(), 'usam-money-'));
let pgAdmin = null, pgDb = null;
try {
  // PGlite
  {
    const dataDir = join(dir, 'pglite');
    const open = () => createDb({databaseUrl: '', dataDir});
    await migrationSuite('pglite', open);
    // fix the duplicates the refusal test left behind, re-open, and check 003 applies cleanly again
    const {PGlite} = await import('@electric-sql/pglite');
    const raw = new PGlite(dataDir); await raw.waitReady;
    await raw.query("UPDATE orders SET transaction_id = NULL");
    await raw.close();
    const again = await open();
    ok(again.applied.includes('003_money_hardening.sql') && await hasIndex(again, 'orders_transaction_key'), 'pglite: after the duplicates are fixed, 003 applies again (up, down, up)');
    await again.close();
  }
  // PostgreSQL
  if (process.env.DATABASE_URL) {
    const {default: pg} = await import('pg');
    pgAdmin = new pg.Client({connectionString: process.env.DATABASE_URL}); await pgAdmin.connect();
    pgDb = 'usam_money_' + RUN;
    await pgAdmin.query(`CREATE DATABASE ${pgDb}`);
    const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + pgDb;
    const url = u.toString();
    const open = () => createDb({databaseUrl: url});
    await migrationSuite('postgres', open);
    const fix = new pg.Client({connectionString: url}); await fix.connect(); await fix.query('UPDATE orders SET transaction_id = NULL'); await fix.end();
    const again = await open();
    ok(again.applied.includes('003_money_hardening.sql') && await hasIndex(again, 'orders_transaction_key'), 'postgres: after the duplicates are fixed, 003 applies again (up, down, up)');
    await again.close();
    process.env.DATABASE_URL = url; // the webhook suite below runs on this scratch database
    await pgAdmin.query(`DROP DATABASE ${pgDb} WITH (FORCE)`).catch(() => {}); // recreate empty for the webhook suite
    await pgAdmin.query(`CREATE DATABASE ${pgDb}`);
  }

  // ---------------------------------------------------------------- webhook, in-process (real router, real database)
  console.log('-- paymob webhook');
  const HMAC_SECRET = rnd();
  Object.assign(process.env, {NODE_ENV: 'test', CUSTOMER_DB_FILE: join(dir, 'c.json'), PAYMOB_HMAC_SECRET: HMAC_SECRET, PAYMOB_INTEGRATION_IDS: '123', AUDIT_HMAC_KEY: rnd(), REDIS_URL: '', RATE_LIMIT_PREFIX: RUN});
  const {customerRouter} = await import('../server/customer.js');
  const customer = customerRouter();
  const app = express();
  app.use(express.json({limit: '96kb', verify: (req, _res, buf) => { if (req.url.startsWith('/api/paymob/webhook')) req.rawBody = buf.toString('utf8'); }}));
  app.use('/api', customer.router);
  const port = await freePort();
  const server = await new Promise(r => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  const origin = `http://127.0.0.1:${port}`;
  const db = await customer.db();
  try {
    const sign = o => createHmac('sha512', HMAC_SECRET).update([o.amount_cents, o.created_at, o.currency, o.error_occured, o.has_parent_transaction, o.id, o.integration_id, o.is_3d_secure, o.is_auth, o.is_capture, o.is_refunded, o.is_standalone_payment, o.is_voided, o.order?.id, o.owner, o.pending, o.source_data?.pan, o.source_data?.sub_type, o.source_data?.type, o.success].map(x => String(x ?? '')).join('')).digest('hex');
    const event = (ref, paymobOrder, over = {}) => ({id: 9001, amount_cents: 30000, created_at: '2026-11-27T00:00:00', currency: 'EGP', error_occured: false, has_parent_transaction: false, integration_id: 123, is_3d_secure: true, is_auth: false, is_capture: false, is_refunded: false, is_standalone_payment: true, is_voided: false, order: {id: paymobOrder, merchant_order_id: ref}, owner: 1, pending: false, source_data: {pan: '2346', sub_type: 'MasterCard', type: 'card'}, success: true, ...over});
    const post = (obj, hmac = sign(obj)) => fetch(`${origin}/api/paymob/webhook?hmac=${hmac}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({type: 'TRANSACTION', obj})});
    const events = async id => Number((await one(db, 'SELECT count(*) AS n FROM payment_events WHERE provider = $1 AND event_id = $2', ['paymob', id])).n);

    const outcomeOf = async id => (await one(db, 'SELECT outcome FROM payment_events WHERE provider = $1 AND event_id = $2', ['paymob', id]))?.outcome;
    const grantedDays = async (uid, since) => { const e = (await repo.users.byId(db, uid)).entitlements.English; return e ? (e.expiresAt - since) / 86400000 : null; };

    // ---- concurrent identical webhooks: one payment, one event ----
    const o1 = await seedOrder(db, 'w1', {paymobOrderId: '555'});
    const ok1 = event(o1.ref, 555);
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([post(ok1), post(ok1)]);
    ok(r1.status === 200 && r2.status === 200, `two concurrent identical signed webhooks both answer 200 (${r1.status}, ${r2.status})`);
    const paid = await repo.orders.byRef(db, o1.ref);
    const days = await grantedDays(o1.uid, t0);
    ok(paid.status === 'paid' && paid.transactionId === '9001' && paid.currency === 'EGP', 'the order is paid once, with its transaction id and currency');
    ok(days > 27 && days < 32, `exactly one entitlement period was granted (${days.toFixed(1)} days, not two)`);
    ok(await events('9001:success') === 1 && await outcomeOf('9001:success') === 'applied', "one payment_events row for the two concurrent deliveries, outcome 'applied'");
    const row = await one(db, 'SELECT * FROM payment_events WHERE event_id = $1', ['9001:success']);
    ok(row.signature_verified === true && row.order_ref === o1.ref && row.provider === 'paymob' && JSON.parse(row.raw_body).obj.id === 9001, 'the stored event carries provider, order reference, verified flag and the raw body');
    const expiry1 = (await repo.users.byId(db, o1.uid)).entitlements.English.expiresAt;
    ok((await post(ok1)).status === 200 && await events('9001:success') === 1 && (await repo.users.byId(db, o1.uid)).entitlements.English.expiresAt === expiry1, 'a later replay of an applied event is a no-op (one event, same expiry)');
    ok((await post(ok1, 'f'.repeat(128))).status === 403 && await events('9001:success') === 1, 'a bad signature is rejected (403) and stores nothing');

    // ---- refund / void reusing the ORIGINAL transaction id must still refund (review finding 1) ----
    ok((await post(event(o1.ref, 555, {is_refunded: true}))).status === 200 && (await repo.orders.byRef(db, o1.ref)).status === 'refunded' && !(await repo.users.byId(db, o1.uid)).entitlements.English && await outcomeOf('9001:refunded') === 'applied', 'a refund that reuses the ORIGINAL transaction id refunds the order and removes the entitlement');
    const o1v = await seedOrder(db, 'w1v', {paymobOrderId: '5551'});
    await post(event(o1v.ref, 5551, {id: 9010}));
    ok((await post(event(o1v.ref, 5551, {id: 9010, is_voided: true}))).status === 200 && (await repo.orders.byRef(db, o1v.ref)).status === 'refunded' && await outcomeOf('9010:voided') === 'applied', 'a void that reuses the original transaction id also refunds');

    // ---- refunded order is never paid by a later success (finding 4) ----
    ok((await post(event(o1.ref, 555, {id: 9020}))).status === 200 && (await repo.orders.byRef(db, o1.ref)).status === 'refunded' && !(await repo.users.byId(db, o1.uid)).entitlements.English && await outcomeOf('9020:success') === 'ignored', "a success event for a refunded order pays nothing and is recorded as 'ignored'");

    // ---- failed, then success with the SAME transaction id: pays once ----
    const o4 = await seedOrder(db, 'w4', {paymobOrderId: '558'});
    const t4 = Date.now();
    ok((await post(event(o4.ref, 558, {id: 9200, success: false}))).status === 200 && (await repo.orders.byRef(db, o4.ref)).status === 'failed', 'a failed attempt marks the order failed');
    ok((await post(event(o4.ref, 558, {id: 9200}))).status === 200 && (await repo.orders.byRef(db, o4.ref)).status === 'paid' && await outcomeOf('9200:success') === 'applied', 'a success with the same transaction id after a failure still pays');
    ok((await post(event(o4.ref, 558, {id: 9200}))).status === 200 && (await grantedDays(o4.uid, t4)) < 32, 'delivering that success again does not extend the subscription');
    ok((await post(event(o4.ref, 558, {id: 9201, success: false}))).status === 200 && (await repo.orders.byRef(db, o4.ref)).status === 'paid' && await outcomeOf('9201:failed') === 'ignored', "a late failure never downgrades a paid order (outcome 'ignored')");

    // ---- rejected events are re-processed, not dropped (finding 2) ----
    const o2 = await seedOrder(db, 'w2', {paymobOrderId: '556'});
    const bad = event(o2.ref, 556, {id: 9002, amount_cents: 100});
    ok((await post(bad)).status === 400 && await outcomeOf('9002:success') === 'rejected' && (await repo.orders.byRef(db, o2.ref)).status !== 'paid', "a signed event with the wrong amount is stored with outcome 'rejected', answered 400, and does not pay");
    ok((await post(bad)).status === 400 && await events('9002:success') === 1, 'its retry is processed again (400 again) and still one row');

    // ---- unmatched events become processable once the order has its provider id (finding 2) ----
    const o5 = await seedOrder(db, 'w5');
    const early = event(o5.ref, 999, {id: 9100});
    ok((await post(early)).status === 200 && await outcomeOf('9100:success') === 'unmatched' && (await repo.orders.byRef(db, o5.ref)).status !== 'paid', "an event for an order that has no provider id yet is stored as 'unmatched' (200, nothing paid)");
    await db.tx(q => repo.orders.update(q, o5.ref, {paymobOrderId: '999'}));
    ok((await post(early)).status === 200 && (await repo.orders.byRef(db, o5.ref)).status === 'paid' && await outcomeOf('9100:success') === 'applied' && await events('9100:success') === 1, "the retry of that event pays the order once the provider id is known; the same row becomes 'applied'");
    ok((await post(event('NO-SUCH-ORDER', 777, {id: 9101}))).status === 200 && await outcomeOf('9101:success') === 'unmatched', 'a verified event for an unknown order is stored as unmatched with no order reference');

    // ---- the same transaction id on a different order ----
    const o3 = await seedOrder(db, 'w3', {paymobOrderId: '557'});
    ok((await post(event(o3.ref, 557, {id: 9001}))).status === 200 && (await repo.orders.byRef(db, o3.ref)).status !== 'paid', 'a success event id already applied to another order is a replay: 200 and nothing is paid');
    let dup = null; try { await db.tx(q => repo.orders.update(q, o3.ref, {transactionId: '9001'})); } catch (e) { dup = e; }
    ok(isUniqueViolation(dup), 'the database itself rejects the duplicate transaction id on another order');
    // a NEW event id (failed state) with transaction id 9001 for order o3 really hits orders_transaction_key
    const o8 = await seedOrder(db, 'w8', {paymobOrderId: '560'});
    ok((await post(event(o8.ref, 560, {id: 9001, success: false}))).status === 200, 'a new event whose transaction id belongs to another order answers 200, not 500');
    const anomaly = await one(db, 'SELECT outcome, order_ref FROM payment_events WHERE event_id = $1', ['9001:failed']);
    ok(anomaly?.outcome === 'rejected' && anomaly.order_ref === o8.ref && (await repo.orders.byRef(db, o8.ref)).status === 'pending_payment', "that anomaly is recorded with outcome 'rejected' (outside the rolled-back transaction) and the order is left untouched");

    // ---- account deletion removes the learner's payment events (finding 3) ----
    const pw = rnd(), mail = `del-${RUN}@example.com`;
    const regRes = await fetch(`${origin}/api/customer/register`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Delete Me', email: mail, phone: '01000000000', password: pw})});
    const regBody = await regRes.json();
    const cookie = (regRes.headers.get('set-cookie') || '').split(';')[0];
    ok(regRes.status < 300 && !!regBody.user?.id, 'a learner registers (for the account deletion check)');
    const od = {uid: regBody.user.id, ref: `ORD-${RUN}-del`};
    await db.tx(async q => { await repo.orders.create(q, {reference: od.ref, userId: od.uid, language: 'English', plan: 'essential', term: 'monthly', amount: 300, status: 'pending_payment', createdAt: new Date().toISOString()}); await repo.orders.update(q, od.ref, {paymobOrderId: '561'}); });
    await post(event(od.ref, 561, {id: 9400}));
    const keepBefore = Number((await one(db, 'SELECT count(*) AS n FROM payment_events WHERE order_ref IS DISTINCT FROM $1', [od.ref])).n);
    ok(await events('9400:success') === 1, 'the learner has a stored payment event');
    const del = await fetch(`${origin}/api/customer/account`, {method: 'DELETE', headers: {'Content-Type': 'application/json', Cookie: cookie}, body: JSON.stringify({password: pw})});
    ok(del.status === 200 && await events('9400:success') === 0, "deleting the account deletes that learner's payment events (and their billing data)");
    ok(Number((await one(db, 'SELECT count(*) AS n FROM payment_events')).n) === keepBefore, "other learners' payment events are untouched");
  } finally {
    await new Promise(r => server.close(r));
    await customer.storageClose();
  }
} catch (e) { console.error('  FAIL: unexpected error', e); failures++; }
finally {
  if (pgAdmin) { await pgAdmin.query(`DROP DATABASE IF EXISTS ${pgDb} WITH (FORCE)`).catch(() => {}); await pgAdmin.end(); }
  await rm(dir, noRetry);
}
if (failures) { console.error(`\nMoney data tests FAILED (${failures}).`); process.exit(1); }
console.log('\nMoney data tests passed.');
process.exit(0);
