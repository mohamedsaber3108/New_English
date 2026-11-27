// Legacy migration: data written by the OLD single-document store must arrive intact in the new tables.
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStorage} from './fixtures/legacy-storage.js'; // the OLD document store, used only to produce legacy-format data
import {appendAudit} from '../server/audit.js';
import {createDb} from '../server/db/index.js';
import {autoImport} from '../server/db/legacy-import.js';
import * as repo from '../server/db/repo.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
process.env.AUDIT_HMAC_KEY = 'legacy-test-key-0123456789';
const now = Date.now();

// Populate a legacy document exactly the way the previous code did (storage.mutate + appendAudit).
async function writeLegacy(storage) {
  await storage.mutate(db => {
    db.users.push(
      {id: 'u1', name: 'Old Learner', email: 'old@example.com', phone: '01000000000', password: 'salt:hash', createdAt: '2026-10-01T10:00:00.000Z', emailVerified: true, preferences: {product: true, learning: false, marketing: false}, entitlements: {English: {plan: 'plus', expiresAt: now + 30 * 864e5, orderReference: 'USL-OLD-1'}}, profile: {xp: 120, level: 'B1', reviews: [{word: 'gate', interval: 6, ease: 2.5, due: now}]}},
      {id: 'u2', name: 'Suspended', email: 'sus@example.com', phone: '01000000001', password: 'salt:hash', createdAt: '2026-10-02T10:00:00.000Z', status: 'suspended', entitlements: {}, profile: null});
    db.sessions.push({id: 's1', hash: 'a'.repeat(64), userId: 'u1', createdAt: now, lastSeen: now, device: 'Chrome', expires: now + 864e5}, {id: 'sx', hash: 'b'.repeat(64), userId: 'ghost', createdAt: now, lastSeen: now, expires: now + 864e5});
    db.orders.push({reference: 'USL-OLD-1', userId: 'u1', language: 'English', plan: 'plus', term: 'monthly', amount: 450, status: 'paid', createdAt: '2026-10-03T10:00:00.000Z', paidAt: '2026-10-03T11:00:00.000Z', expiresAt: now + 30 * 864e5, manualPaymentReference: 'BANK-OLD'});
    db.supportTickets.push({reference: 'SUP-OLD', userId: 'u1', category: 'payment', subject: 'Old ticket', message: 'Legacy support message', status: 'resolved', resolution: 'Fixed', createdAt: '2026-10-04T10:00:00.000Z', updatedAt: '2026-10-05T10:00:00.000Z'});
    db.leads.push({reference: 'UL-OLD', createdAt: '2026-10-06T10:00:00.000Z', name: 'Old Lead', email: 'lead@example.com', phone: '0100000000', kind: 'meeting', language: 'English', groupSize: 12, preferredDate: '2026-12-01', preferredTime: '10:00', message: 'Team', status: 'contacted', notes: [{at: '2026-10-07T10:00:00.000Z', adminId: 'a1', text: 'called'}]});
    db.admins.push({id: 'a1', email: 'owner@example.com', name: 'Owner', role: 'owner', status: 'active', password: 'salt:hash', createdAt: '2026-10-01T09:00:00.000Z', createdBy: 'cli', mfa: {enabled: true, secret: 'v1.x.y', lastStep: 5, recovery: [{hash: 'r1'}]}});
    db.auditLog.push({id: 'legacy-1', event: 'support_created', userId: 'u1', meta: {}, at: '2026-09-01T00:00:00.000Z'}); // pre-chain entry
    for (let i = 0; i < 5; i++) appendAudit(db, {event: 'old_event', actor: {type: 'admin', id: 'a1'}, meta: {i, reason: 'legacy chain'}});
  });
}

async function check(label, db) {
  const u = await repo.users.byEmail(db, 'old@example.com');
  ok(u?.id === 'u1' && u.entitlements.English?.plan === 'plus' && u.profile.reviews[0].word === 'gate' && u.preferences.learning === false && u.emailVerified, `${label}: learner, entitlement, profile and preferences imported`);
  ok((await repo.users.byId(db, 'u2'))?.status === 'suspended', `${label}: suspended status preserved`);
  ok((await repo.sessions.findValid(db, 'a'.repeat(64)))?.userId === 'u1', `${label}: existing learner sessions stay valid (nobody is logged out)`);
  ok(!(await repo.sessions.findValid(db, 'b'.repeat(64))), `${label}: orphan session for a missing user is skipped`);
  const o = await repo.orders.byRef(db, 'USL-OLD-1');
  ok(o?.status === 'paid' && o.amount === 450 && o.manualPaymentReference === 'BANK-OLD' && o.paidAt === '2026-10-03T11:00:00.000Z', `${label}: order with payment details imported`);
  ok((await repo.tickets.listForUser(db, 'u1'))[0]?.resolution === 'Fixed', `${label}: support ticket with resolution imported`);
  const l = await repo.leads.byRef(db, 'UL-OLD');
  ok(l?.status === 'contacted' && l.groupSize === 12 && l.notes[0].text === 'called', `${label}: lead with notes imported`);
  const a = await repo.admins.byEmail(db, 'owner@example.com');
  ok(a?.role === 'owner' && a.mfa?.enabled && a.mfa.lastStep === 5, `${label}: administrator with MFA state imported`);
  const v = await repo.audit.verify(db);
  ok(v.ok && v.checked === 5 && v.legacy === 1, `${label}: imported audit chain verifies (5 chained, 1 legacy entry kept)`);
  await db.tx(t => repo.audit.append(t, {event: 'after_import'}));
  ok((await repo.audit.verify(db)).ok, `${label}: new entries continue the imported chain`);
  const again = await autoImport(db, {jsonFile: null});
  ok(again.imported === false && /already/.test(again.reason), `${label}: import never runs twice`);
}

const dir = await mkdtemp(join(tmpdir(), 'usam-legacy-'));
try {
  // PGlite from the old JSON file
  const jsonFile = join(dir, 'customers.json');
  await writeLegacy(createStorage({dbFile: jsonFile, databaseUrl: ''}));
  const db = await createDb({databaseUrl: '', dataDir: join(dir, 'pglite')});
  const r = await autoImport(db, {jsonFile});
  ok(r.imported && r.counts.users === 2 && r.counts.orders === 1 && r.counts.skipped >= 1, `pglite: auto-import from ${'customers.json'} (${JSON.stringify(r.counts)})`);
  await check('pglite', db);
  await db.close();
  const empty = await createDb({databaseUrl: '', dataDir: 'memory://'});
  ok((await autoImport(empty, {jsonFile: join(dir, 'missing.json')})).imported === false, 'pglite: no legacy file -> nothing imported, no error');
  await empty.close();

  if (process.env.DATABASE_URL) {
    const {default: pg} = await import('pg');
    const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
    const name = 'usam_legacy_' + Date.now();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(process.env.DATABASE_URL); url.pathname = '/' + name;
    try {
      const old = createStorage({databaseUrl: url.toString()});
      await writeLegacy(old); await old.close();
      const pdb = await createDb({databaseUrl: url.toString()});
      const pr = await autoImport(pdb);
      ok(pr.imported && pr.source === 'app_state', 'postgres: auto-import from the old app_state row');
      await check('postgres', pdb);
      await pdb.close();
    } finally { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); }
  } else console.log('DATABASE_URL not set — skipping PostgreSQL import.');
} finally { await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); }
if (failures) { console.error(`\nLegacy import tests FAILED (${failures}).`); process.exit(1); }
console.log('\nLegacy import tests passed.');
process.exit(0);
