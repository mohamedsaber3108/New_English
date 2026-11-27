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
  await db.close();

  // ---- insert-only app role (needs a real PostgreSQL server and a role that may create databases and roles) ----
  if (!process.env.DATABASE_URL) {
    console.log('  SKIP: restricted-role test needs DATABASE_URL (PostgreSQL); PGlite has no roles.');
  } else {
    const {default: pg} = await import('pg');
    const id = 'ar' + Date.now() + Math.random().toString(36).slice(2, 6);
    const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
    const dbName = 'usam_' + id, appRole = 'app_' + id, retRole = 'ret_' + id;
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
      const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + dbName;
      const real = await createDb({databaseUrl: u.toString()});
      await real.tx(q => repo.audit.append(q, {event: 'role_test'}));
      await real.query(`CREATE ROLE ${appRole} NOLOGIN`); await real.query(`CREATE ROLE ${retRole} NOLOGIN`);
      const sql = (await readFile(new URL('../docs/audit-roles.sql', import.meta.url), 'utf8')).replaceAll(':app_role', appRole).replaceAll(':retention_role', retRole);
      for (const stmt of sql.split('\n').filter(l => !l.startsWith('--') && l.trim()).join('\n').split(';').map(s => s.trim()).filter(Boolean)) await real.query(stmt);
      const as = async (role, text) => real.tx(async q => { await q.query(`SET LOCAL ROLE ${role}`); return q.query(text); }).then(() => null, e => e.code);
      ok(await as(appRole, "UPDATE audit_log SET event = 'x'") === '42501', 'app role cannot UPDATE audit_log');
      ok(await as(appRole, 'DELETE FROM audit_log') === '42501', 'app role cannot DELETE from audit_log');
      ok(await as(appRole, 'UPDATE audit_chain SET anchor_seq = 0') === '42501', 'app role cannot move the retention anchor');
      ok(await as(appRole, 'DELETE FROM audit_chain') === '42501', 'app role cannot DELETE audit_chain');
      ok(await as(appRole, 'SELECT count(*) FROM audit_log') === null, 'app role can still read audit_log');
      ok(await as(retRole, "UPDATE audit_log SET event = 'x'") === '42501', 'retention role cannot UPDATE audit_log');
      await real.close();
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${appRole}`).catch(() => {}); await admin.query(`DROP ROLE IF EXISTS ${retRole}`).catch(() => {});
      await admin.end();
    }
  }
} finally { await rm(dir, {recursive: true, force: true}); }
if (failures) { console.error(`\nAudit retention tests FAILED (${failures}).`); process.exit(1); }
console.log('\nAudit retention tests passed.');
