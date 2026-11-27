// Repository tests on PGlite (always) and PostgreSQL (when DATABASE_URL is set; isolated database).
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDb, isUniqueViolation} from '../server/db/index.js';
import * as repo from '../server/db/repo.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
process.env.AUDIT_HMAC_KEY = 'repo-test-key-0123456789';

async function suite(label, db) {
  console.log(`-- ${label}`);
  const now = Date.now();
  const u = {id: 'u-1', email: 'Mona@Example.com', name: 'Mona', phone: '01000000000', password: 's:h', createdAt: new Date(now - 1000).toISOString(), profile: {xp: 5, reviews: [{word: 'gate'}]}};
  await repo.users.create(db, u);
  let got = await repo.users.byEmail(db, 'mona@example.com');
  ok(got?.id === 'u-1' && got.profile.reviews[0].word === 'gate' && got.preferences.marketing === false && got.status === 'active', `${label}: user round-trips (case-insensitive email, jsonb profile with arrays, default preferences)`);
  let e = null; try { await repo.users.create(db, {...u, id: 'u-2', email: 'MONA@example.com'}); } catch (x) { e = x; }
  ok(isUniqueViolation(e), `${label}: duplicate email -> unique violation`);
  await repo.entitlements.set(db, 'u-1', 'English', {plan: 'plus', expiresAt: now + 864e5, orderReference: 'USL-1', source: 'payment'});
  got = await repo.users.byId(db, 'u-1');
  ok(got.entitlements.English?.plan === 'plus' && got.entitlements.English.expiresAt === now + 864e5 && typeof got.entitlements.English.expiresAt === 'number', `${label}: entitlements load onto the user as {English: {plan, expiresAt(ms)}}`);
  ok(!(await repo.entitlements.removeIfOrder(db, 'u-1', 'English', 'USL-OTHER')) && (await repo.users.byId(db, 'u-1')).entitlements.English, `${label}: refund of a different order does not remove a newer entitlement`);
  await repo.users.update(db, 'u-1', {name: 'Mona R', status: 'suspended', emailVerified: true, preferences: {product: false, learning: true, marketing: true}});
  got = await repo.users.byId(db, 'u-1');
  ok(got.name === 'Mona R' && got.status === 'suspended' && got.emailVerified && got.preferences.product === false, `${label}: partial user update`);

  // sessions
  await repo.sessions.create(db, {id: 's1', hash: 'h1', userId: 'u-1', createdAt: now, lastSeen: now, device: 'test', expires: now + 1000});
  await repo.sessions.create(db, {id: 's2', hash: 'h2', userId: 'u-1', createdAt: now, lastSeen: now, device: 'test', expires: now - 1});
  ok((await repo.sessions.findValid(db, 'h1', now))?.userId === 'u-1' && !(await repo.sessions.findValid(db, 'h2', now)), `${label}: findValid returns live sessions only`);
  await repo.sessions.create(db, {id: 's3', hash: 'h3', userId: 'u-1', createdAt: now, lastSeen: now, device: 'test', expires: now + 1000});
  ok((await repo.sessions.removeForUser(db, 'u-1', 'h1')) === 2 && (await repo.sessions.findValid(db, 'h1', now)), `${label}: removeForUser keeps the excepted session`);

  // users list: search, filters, pagination
  for (let i = 0; i < 30; i++) await repo.users.create(db, {id: 'p' + i, email: `page${i}@example.com`, name: 'Pager ' + i, password: 'x', createdAt: new Date(now - i * 1000).toISOString()});
  const p1 = await repo.users.list(db, {needle: 'pager', pageSize: 10, page: 1}), p3 = await repo.users.list(db, {needle: 'pager', pageSize: 10, page: 3});
  ok(p1.total === 30 && p1.items.length === 10 && p1.pages === 3 && p1.items[0].id === 'p0' && p3.items[9].id === 'p29', `${label}: users.list searches and paginates newest-first`);
  ok((await repo.users.list(db, {needle: '100%_'})).total === 0, `${label}: search treats % and _ literally (no wildcard injection)`);
  ok((await repo.users.list(db, {status: 'suspended'})).total === 1 && (await repo.users.list(db, {subscription: 'active'})).items[0]?.id === 'u-1', `${label}: status and subscription filters`);
  ok((await repo.users.list(db, {pageSize: 5000})).pageSize === 100, `${label}: pageSize capped at 100`);

  // orders
  await repo.orders.create(db, {reference: 'USL-A', userId: 'u-1', language: 'English', plan: 'essential', term: 'monthly', amount: 300, status: 'pending_contact', createdAt: new Date().toISOString()});
  await repo.orders.update(db, 'USL-A', {status: 'paid', manualPaymentReference: 'BANK-1', expiresAt: now + 5, paidAt: new Date().toISOString()});
  const o = await repo.orders.byRef(db, 'USL-A');
  ok(o.status === 'paid' && o.amount === 300 && o.expiresAt === now + 5 && o.manualPaymentReference === 'BANK-1' && !('intentionId' in o), `${label}: order update/read (nulls omitted)`);
  ok(await repo.orders.manualRefUsed(db, 'BANK-1'), `${label}: manual payment reference lookup`);
  await repo.orders.create(db, {reference: 'USL-B', userId: 'u-1', language: 'English', plan: 'plus', term: 'yearly', amount: 4500, status: 'pending_contact', createdAt: new Date().toISOString()});
  e = null; try { await repo.orders.update(db, 'USL-B', {manualPaymentReference: 'BANK-1'}); } catch (x) { e = x; }
  ok(isUniqueViolation(e), `${label}: a manual payment reference can only be used once (unique index)`);
  const ol = await repo.orders.list(db, {needle: 'mona@', status: 'paid'});
  ok(ol.total === 1 && ol.items[0].customer?.email === 'Mona@Example.com', `${label}: orders.list joins the customer and filters`);

  // tokens: single use
  await repo.tokens.issue(db, {hash: 'th', userId: 'u-1', purpose: 'reset', expires: now + 60000, now});
  const [a, b] = await Promise.all([repo.tokens.consume(db, 'th', 'reset', now), repo.tokens.consume(db, 'th', 'reset', now)]);
  ok([a, b].filter(Boolean).length === 1, `${label}: a token is consumed exactly once even when redeemed concurrently`);
  ok(!(await repo.tokens.consume(db, 'th', 'verify', now)), `${label}: token purpose must match`);

  // tickets + leads
  await repo.tickets.create(db, {reference: 'SUP-1', userId: 'u-1', category: 'payment', subject: 'Pay', message: 'Please help me', status: 'open', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()});
  await repo.tickets.update(db, 'SUP-1', {status: 'resolved', resolution: 'Done', updatedBy: 'admin-1'});
  ok((await repo.tickets.listForUser(db, 'u-1'))[0].status === 'resolved' && (await repo.tickets.list(db, {status: 'resolved', category: 'payment'})).total === 1, `${label}: tickets update and filter`);
  await repo.leads.create(db, {reference: 'UL-1', name: 'Lead', email: 'l@example.com', phone: '0100000000', kind: 'question', language: 'English'});
  await repo.leads.create(db, {reference: 'UL-1', name: 'Dup', email: 'd@example.com', phone: '0', kind: 'question', language: 'English'});
  const lu = await repo.leads.update(db, 'UL-1', {status: 'contacted', note: 'called', adminId: 'admin-1'});
  const lu2 = await repo.leads.update(db, 'UL-1', {status: 'qualified', note: null, adminId: 'admin-1'});
  ok(lu.notes.length === 1 && lu.notes[0].text === 'called' && lu2.notes.length === 1 && lu2.status === 'qualified' && lu2.name === 'Lead', `${label}: lead notes append; import is idempotent by reference`);

  // audit chain in SQL
  for (let i = 0; i < 6; i++) await db.tx(t => repo.audit.append(t, {event: 'test_event', actor: {type: 'admin', id: 'a1'}, meta: {i, reason: 'x'}}));
  let v = await repo.audit.verify(db, 2); // tiny pages exercise the streaming path
  ok(v.ok && v.checked === 6 && v.keyedEntries === 6, `${label}: SQL audit chain verifies across pages (${v.checked} entries)`);
  await Promise.all(Array.from({length: 10}, (_, i) => db.tx(t => repo.audit.append(t, {event: 'parallel', meta: {i}}))));
  v = await repo.audit.verify(db);
  ok(v.ok && v.checked === 16, `${label}: 10 concurrent appends keep the chain intact (strictly serial via row lock)`);
  await db.query(`UPDATE audit_log SET meta = '{"i": 99, "reason": "x"}' WHERE seq = 3`);
  v = await repo.audit.verify(db);
  ok(!v.ok && v.brokenAt === 3, `${label}: editing a row directly in SQL is detected at that row (#${v.brokenAt})`);
  await db.query(`UPDATE audit_log SET meta = '{"i": 2, "reason": "x"}' WHERE seq = 3`);
  ok((await repo.audit.verify(db)).ok, `${label}: restoring the original content verifies again`);
  await db.query('DELETE FROM audit_log WHERE seq = (SELECT max(seq) FROM audit_log)');
  ok(!(await repo.audit.verify(db)).ok, `${label}: deleting the newest row is detected (head mismatch)`);
  const al = await repo.audit.list(db, {event: 'test_event', pageSize: 4});
  ok(al.total === 6 && al.items.length === 4 && al.items[0].seq > al.items[1].seq, `${label}: audit list filters by event, newest first`);

  // overview aggregates + meta
  const ov = await repo.overview(db, now);
  ok(ov.users === 31 && ov.suspended === 1 && ov.paidOrders === 1 && ov.revenuePaidEGP === 300 && ov.openTickets === 0, `${label}: overview aggregates`);
  await repo.meta.set(db, 'k', {imported: true}); await repo.meta.set(db, 'k', {imported: 2});
  ok((await repo.meta.get(db, 'k')).imported === 2, `${label}: meta upsert`);

  // cascade on account deletion
  await repo.users.remove(db, 'u-1');
  const left = (await db.query("SELECT (SELECT count(*) FROM orders WHERE user_id='u-1') + (SELECT count(*) FROM sessions WHERE user_id='u-1') + (SELECT count(*) FROM support_tickets WHERE user_id='u-1') + (SELECT count(*) FROM entitlements WHERE user_id='u-1') AS n")).rows[0].n;
  ok(Number(left) === 0, `${label}: deleting a user removes their orders, sessions, tickets and entitlements`);
}

process.env.AUDIT_MAX_ENTRIES = '';
const dir = await mkdtemp(join(tmpdir(), 'usam-repo-'));
try {
  const db = await createDb({databaseUrl: '', dataDir: join(dir, 'pg')});
  try { await suite('pglite', db); } finally { await db.close(); }
  // Trimming with an anchor keeps the tail verifiable.
  process.env.AUDIT_MAX_ENTRIES = '5';
  const t = await createDb({databaseUrl: '', dataDir: 'memory://'});
  for (let i = 0; i < 12; i++) await t.tx(x => repo.audit.append(x, {event: 'trim', meta: {i}}));
  const v = await repo.audit.verify(t);
  ok(v.ok && v.checked === 5 && Number((await t.query('SELECT anchor_seq FROM audit_chain')).rows[0].anchor_seq) === 7, 'pglite: AUDIT_MAX_ENTRIES trims old rows and the anchored tail still verifies');
  await t.close();
  process.env.AUDIT_MAX_ENTRIES = '';
  if (process.env.DATABASE_URL) {
    const {default: pg} = await import('pg');
    const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
    const name = 'usam_repo_' + Date.now();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL); url.pathname = '/' + name;
    try { const pdb = await createDb({databaseUrl: url.toString()}); try { await suite('postgres', pdb); } finally { await pdb.close(); } }
    finally { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); }
  } else console.log('DATABASE_URL not set — skipping PostgreSQL suite.');
} finally { await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); }
if (failures) { console.error(`\nRepo tests FAILED (${failures}).`); process.exit(1); }
console.log('\nRepo tests passed.');
process.exit(0);
