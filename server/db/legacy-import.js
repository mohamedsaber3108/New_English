// One-time import of the previous single-document store into the relational tables.
//   - PostgreSQL: the old `app_state` row (if that table exists in the same database)
//   - PGlite:     the old JSON file at CUSTOMER_DB_FILE (if it exists)
// Runs inside ONE transaction; marks meta.legacy_imported so it never runs twice. Records already present are
// skipped (ON CONFLICT / existence checks), so a partially populated database is safe.
// Audit entries keep their original seq/hash/prevHash/kid so the imported chain still verifies.
import {readFile} from 'node:fs/promises';
import * as repo from './repo.js';

export async function readLegacyDocument(db, {jsonFile} = {}) {
  if (db.backend === 'postgres') {
    const t = (await db.query("SELECT to_regclass('public.app_state') AS t")).rows[0].t;
    if (!t) return null;
    return (await db.query('SELECT document FROM app_state WHERE id = 1')).rows[0]?.document || null;
  }
  if (!jsonFile) return null;
  try { return JSON.parse(await readFile(jsonFile, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const has = async (q, sql, v) => (await q.query(sql, v)).rows.length > 0;

export async function importDocument(db, doc, {source = 'legacy'} = {}) {
  if (!doc) return {imported: false, reason: 'no legacy document'};
  return db.tx(async q => {
    const done = await repo.meta.get(q, 'legacy_imported');
    if (done) return {imported: false, reason: 'already imported', at: done.at};
    const n = {users: 0, entitlements: 0, sessions: 0, orders: 0, tickets: 0, tokens: 0, leads: 0, admins: 0, adminSessions: 0, audit: 0, analytics: 0, skipped: 0};
    const userIds = new Set();
    for (const u of doc.users || []) {
      if (!u?.id || !u.email) { n.skipped++; continue; }
      if (await has(q, 'SELECT 1 FROM users WHERE id = $1 OR lower(email) = lower($2)', [u.id, u.email])) { n.skipped++; continue; }
      await repo.users.create(q, {...u, status: u.status === 'suspended' ? 'suspended' : 'active'});
      userIds.add(u.id); n.users++;
      for (const [language, e] of Object.entries(u.entitlements || {})) {
        if (!e?.plan || !Number.isFinite(Number(e.expiresAt))) continue;
        await repo.entitlements.set(q, u.id, language, {...e, expiresAt: Number(e.expiresAt)}); n.entitlements++;
      }
    }
    const known = async id => userIds.has(id) || await has(q, 'SELECT 1 FROM users WHERE id = $1', [id]);
    for (const s of doc.sessions || []) {
      if (!s?.hash || !(await known(s.userId)) || await has(q, 'SELECT 1 FROM sessions WHERE hash = $1', [s.hash])) { n.skipped++; continue; }
      await repo.sessions.create(q, {id: s.id || 'legacy-' + s.hash.slice(0, 16), hash: s.hash, userId: s.userId, createdAt: s.createdAt || Date.now(), lastSeen: s.lastSeen || s.createdAt || Date.now(), device: s.device || 'Browser', expires: s.expires}); n.sessions++;
    }
    for (const o of doc.orders || []) {
      if (!o?.reference || await has(q, 'SELECT 1 FROM orders WHERE reference = $1', [o.reference])) { n.skipped++; continue; }
      await repo.orders.create(q, {...o, userId: (await known(o.userId)) ? o.userId : null});
      const {reference, userId, language, plan, term, amount, status, createdAt, ...rest} = o;
      const patch = Object.fromEntries(Object.entries(rest).filter(([k, v]) => v != null && ['paidAt', 'expiresAt', 'paymobOrderId', 'intentionId', 'transactionId', 'manualPaymentReference', 'activatedBy', 'refundedAt', 'refundedBy'].includes(k)));
      if (Object.keys(patch).length) await repo.orders.update(q, o.reference, patch);
      n.orders++;
    }
    for (const t of doc.supportTickets || []) {
      if (!t?.reference || await has(q, 'SELECT 1 FROM support_tickets WHERE reference = $1', [t.reference])) { n.skipped++; continue; }
      await repo.tickets.create(q, {...t, userId: (await known(t.userId)) ? t.userId : null, createdAt: t.createdAt || new Date().toISOString(), updatedAt: t.updatedAt || t.createdAt || new Date().toISOString()});
      if (t.resolution || t.updatedBy) await q.query('UPDATE support_tickets SET resolution = $1, updated_by = $2 WHERE reference = $3', [t.resolution || null, t.updatedBy || null, t.reference]);
      n.tickets++;
    }
    for (const t of doc.securityTokens || []) {
      if (!t?.hash || !(await known(t.userId)) || t.expires <= Date.now()) { n.skipped++; continue; }
      await q.query('INSERT INTO security_tokens (hash, user_id, purpose, expires, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (hash) DO NOTHING', [t.hash, t.userId, t.purpose, t.expires, t.createdAt || Date.now()]); n.tokens++;
    }
    for (const l of doc.leads || []) { if (!l?.reference) { n.skipped++; continue; } await repo.leads.create(q, l); n.leads++; }
    for (const a of doc.admins || []) {
      if (!a?.id || await has(q, 'SELECT 1 FROM admins WHERE id = $1 OR lower(email) = lower($2)', [a.id, a.email])) { n.skipped++; continue; }
      await repo.admins.create(q, a);
      if (a.lastLoginAt || a.mfa) await repo.admins.update(q, a.id, {lastLoginAt: a.lastLoginAt || null, mfa: a.mfa || null});
      n.admins++;
    }
    for (const s of doc.adminSessions || []) {
      if (!s?.hash || !(await has(q, 'SELECT 1 FROM admins WHERE id = $1', [s.adminId])) || s.expires <= Date.now()) { n.skipped++; continue; }
      await repo.adminSessions.create(q, s); n.adminSessions++;
    }
    // Audit: chained entries keep seq/hash; pre-chain (legacy) entries get negative seq and are excluded from verification.
    let legacySeq = -((await q.query('SELECT count(*) AS n FROM audit_log WHERE seq < 0')).rows[0].n * 1) - 1;
    for (const e of doc.auditLog || []) {
      if (e?.hash && Number.isFinite(e.seq)) {
        await q.query('INSERT INTO audit_log (seq, id, at, event, actor, target, meta, kid, prev_hash, hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10) ON CONFLICT (seq) DO NOTHING',
          [e.seq, e.id, e.at, e.event, JSON.stringify(e.actor ?? null), JSON.stringify(e.target ?? null), JSON.stringify(e.meta ?? {}), e.kid ?? null, e.prevHash, e.hash]);
      } else if (e) {
        await q.query('INSERT INTO audit_log (seq, id, at, event, meta, legacy) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [legacySeq--, e.id || 'legacy', e.at || new Date(0).toISOString(), e.event || 'legacy', JSON.stringify(e.meta ?? {}), JSON.stringify({userId: e.userId ?? null})]);
      }
      n.audit++;
    }
    if (doc.auditChain) await q.query('UPDATE audit_chain SET seq = $1, head = $2, anchor_seq = $3, anchor_hash = $4 WHERE id = 1', [doc.auditChain.seq, doc.auditChain.head, doc.auditChain.anchorSeq ?? 0, doc.auditChain.anchorHash ?? 'GENESIS']);
    for (const ev of doc.analytics || []) {
      if (!ev?.id) continue;
      await q.query('INSERT INTO analytics_events (id, name, user_id, path, meta, at) VALUES ($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT (id) DO NOTHING', [ev.id, ev.name, ev.userId ?? null, ev.path ?? null, JSON.stringify(ev.meta ?? {}), ev.at || new Date().toISOString()]); n.analytics++;
    }
    if (doc.meta?.leadsImported) await repo.meta.set(q, 'leads_jsonl_imported', {at: doc.meta.leadsImportedAt || new Date().toISOString(), count: doc.meta.leadsImportedCount ?? null});
    const record = {at: new Date().toISOString(), source, counts: n};
    await repo.meta.set(q, 'legacy_imported', record);
    return {imported: true, ...record};
  });
}

// Called at startup: imports only when the tables hold no users/admins yet and a legacy document exists.
export async function autoImport(db, {jsonFile} = {}) {
  if (await repo.meta.get(db, 'legacy_imported')) return {imported: false, reason: 'already imported'};
  const doc = await readLegacyDocument(db, {jsonFile});
  if (!doc) return {imported: false, reason: 'no legacy document'};
  return importDocument(db, doc, {source: db.backend === 'postgres' ? 'app_state' : jsonFile});
}
