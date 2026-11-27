// A-1 audit retention: archive-then-delete, and (PostgreSQL only) the insert-only app role.
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDb} from '../server/db/index.js';
import * as repo from '../server/db/repo.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const count = async (db, t) => Number((await db.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
process.env.AUDIT_HMAC_KEY = 'test-audit-key-0123456789';
delete process.env.AUDIT_MAX_ENTRIES;

const dir = await mkdtemp(join(tmpdir(), 'usam-audret-'));
try {
  const db = await createDb({databaseUrl: '', dataDir: join(dir, 'pg')});
  for (let i = 0; i < 8; i++) await db.tx(q => repo.audit.append(q, {event: 'retention_test', meta: {i}}));
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  await db.query('UPDATE audit_log SET at = $1 WHERE seq <= 5', [old]); // age the first five (content hash is not re-checked once archived)
  ok(await db.tx(q => repo.audit.trim(q, {retentionDays: 365})) === 5, 'rows older than the retention period are archived and removed');
  ok(await count(db, 'audit_log') === 3 && await count(db, 'audit_archive') === 5, 'audit_log keeps 3 rows and audit_archive holds the 5 removed rows');
  ok((await db.query('SELECT count(*) AS n FROM audit_archive WHERE archived_at IS NOT NULL AND hash IS NOT NULL')).rows[0].n == 5, 'archived rows keep their hashes and have an archive time');
  const v = await repo.audit.verify(db);
  ok(v.ok && v.checked === 3, 'chain verification still passes after the trim (anchor moved)');
  ok(await db.tx(q => repo.audit.trim(q, {retentionDays: 365})) === 0, 'a second trim removes nothing');
  await db.tx(q => repo.audit.trim(q, {retentionDays: 1, now: Date.now() + 10 * 86400000})); // everything is "old"
  ok(await count(db, 'audit_log') === 1 && (await repo.audit.verify(db)).ok, 'the newest entry is never removed and the chain still verifies');
  await db.tx(q => repo.audit.append(q, {event: 'after_trim'}));
  ok((await repo.audit.verify(db)).ok, 'new entries continue the chain after a trim');
  // stale approvals: an expired open request must not block a new one for the same item
  const mk = (id, at) => ({id, kind: 'refund', target: 'ORD-1', payload: {}, reason: 'test reason', requestedBy: 'a1', requestedAt: at});
  await db.tx(q => repo.approvals.create(q, mk('ap1', Date.now() - 2 * 86400000)));
  await db.tx(async q => { await repo.approvals.expireStale(q, 'refund', 'ORD-1', Date.now() - 86400000); await repo.approvals.create(q, mk('ap2', Date.now())); });
  ok((await db.tx(q => repo.approvals.byId(q, 'ap1'))).status === 'expired' && (await db.tx(q => repo.approvals.byId(q, 'ap2'))).status === 'pending', 'a stale pending request is expired when a new one is created');
  await db.close();

  // ---- insert-only app role (needs a real PostgreSQL server and a role that may create databases and roles) ----
  if (!process.env.DATABASE_URL) {
    console.log('  SKIP: restricted-role test needs DATABASE_URL (PostgreSQL); PGlite has no roles.');
  } else {
    const {default: pg} = await import('pg');
    const id = 'ar' + Date.now() + Math.random().toString(36).slice(2, 6);
    const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
    const dbName = 'usam_' + id, appRole = 'app_' + id, retRole = 'ret_' + id;
    process.env.AUDIT_HMAC_KEY = 'test-audit-key-0123456789';
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + dbName;
      const owner = await createDb({databaseUrl: u.toString()}); // migrations run as the owner role, once
      const pw = 'pw' + id;
      await owner.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${pw}'`); await owner.query(`CREATE ROLE ${retRole} LOGIN PASSWORD '${pw}'`);
      const sql = (await readFile(new URL('../docs/audit-roles.sql', import.meta.url), 'utf8')).replaceAll(':app_role', appRole).replaceAll(':retention_role', retRole);
      for (const stmt of sql.split('\n').filter(l => !l.startsWith('--') && l.trim()).join('\n').split(';').map(s => s.trim()).filter(Boolean)) await owner.query(stmt);
      // From here the app and the retention script connect as their own roles and skip migrations.
      process.env.DB_SKIP_MIGRATIONS = '1';
      const as = role => { const x = new URL(u); x.username = role; x.password = pw; return createDb({databaseUrl: x.toString()}); };
      const app = await as(appRole), ret = await as(retRole);
      const code = (db, text, params) => db.query(text, params).then(() => null, e => e.code);
      ok(app.applied.length === 0 && ret.applied.length === 0, 'with DB_SKIP_MIGRATIONS=1 restricted roles start without running migrations');
      for (let i = 0; i < 4; i++) await app.tx(q => repo.audit.append(q, {event: 'role_test', meta: {i}}));
      ok((await repo.audit.verify(app)).ok, 'app role: repo.audit.append works and the chain verifies');
      ok(await code(app, "UPDATE audit_log SET event = 'x'") === '42501', 'app role cannot UPDATE audit_log');
      ok(await code(app, "UPDATE audit_log SET meta = '{}'") === '42501', 'app role cannot rewrite audit_log meta');
      ok(await code(app, 'DELETE FROM audit_log') === '42501', 'app role cannot DELETE from audit_log');
      ok(await code(app, 'UPDATE audit_chain SET anchor_seq = 0') === '42501', 'app role cannot move the retention anchor');
      ok(await code(app, 'DELETE FROM audit_chain') === '42501', 'app role cannot DELETE audit_chain');
      ok(await code(app, 'DELETE FROM audit_archive') === '42501', 'app role cannot touch audit_archive');
      ok(await code(app, 'CREATE TABLE app_ddl (x int)') === '42501', 'app role cannot run DDL');
      ok(await code(app, "INSERT INTO meta (key, value) VALUES ('t', '{}')") === null, 'app role keeps normal DML on other tables');
      ok(await code(app, 'SELECT count(*) FROM audit_log') === null, 'app role can read audit_log');
      ok(await app.tx(q => repo.audit.forgetUser(q, 'nobody')).then(() => true, () => false), 'app role: account erasure (audit_log.legacy update) works');
      ok(await code(ret, "UPDATE audit_log SET event = 'x'") === '42501', 'retention role cannot UPDATE audit_log');
      ok(await code(ret, "INSERT INTO meta (key, value) VALUES ('r', '{}')") === '42501', 'retention role has no access to application tables');
      const n = await ret.tx(q => repo.audit.trim(q, {retentionDays: 1, now: Date.now() + 10 * 86400000}));
      ok(n === 3, 'retention role: repo.audit.trim archives and deletes (keeps the newest entry)');
      ok((await repo.audit.verify(ret)).ok, 'chain still verifies after the retention role trimmed');
      await app.tx(q => repo.audit.append(q, {event: 'after_trim'}));
      ok((await repo.audit.verify(app)).ok, 'app role appends after the trim and the chain verifies');
      delete process.env.DB_SKIP_MIGRATIONS;
      await app.close(); await ret.close(); await owner.close();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${appRole}`).catch(() => {}); await admin.query(`DROP ROLE IF EXISTS ${retRole}`).catch(() => {});
      await admin.end();
    }
  }
} finally { await rm(dir, {recursive: true, force: true}); }
if (failures) { console.error(`\nAudit retention tests FAILED (${failures}).`); process.exit(1); }
console.log('\nAudit retention tests passed.');
