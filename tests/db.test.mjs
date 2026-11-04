// Database layer tests: migrations, constraints, transactions, row-level concurrency, data-dir lock.
// Runs on PGlite always; on PostgreSQL too when DATABASE_URL is set (isolated throwaway database).
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {createDb, isUniqueViolation} from '../server/db/index.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };

async function suite(label, open) {
  console.log(`-- ${label}`);
  const db = await open();
  try {
    ok(db.applied.includes('001_init.sql'), `${label}: 001_init applied on first open`);
    const tables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map(r => r.table_name);
    ok(['users', 'sessions', 'entitlements', 'orders', 'support_tickets', 'security_tokens', 'leads', 'admins', 'admin_sessions', 'audit_log', 'audit_chain', 'analytics_events', 'meta'].every(t => tables.includes(t)), `${label}: all tables exist`);
    const ins = (id, email) => db.query('INSERT INTO users (id, email, name, password) VALUES ($1, $2, $3, $4)', [id, email, 'N', 'x:y']);
    await ins('u1', 'Learner@Example.com');
    let e = null; try { await ins('u2', 'learner@example.COM'); } catch (x) { e = x; }
    ok(isUniqueViolation(e), `${label}: email uniqueness is case-insensitive (23505)`);
    e = null; try { await db.query("UPDATE users SET status = 'banned' WHERE id = 'u1'"); } catch (x) { e = x; }
    ok(e?.code === '23514', `${label}: CHECK constraint rejects an invalid status`);
    e = null; try { await db.query("INSERT INTO sessions (id, hash, user_id, created_at, last_seen, expires) VALUES ('s','h','nope',1,1,1)"); } catch (x) { e = x; }
    ok(e?.code === '23503', `${label}: foreign key rejects a session for a missing user`);
    await db.query("INSERT INTO sessions (id, hash, user_id, created_at, last_seen, expires) VALUES ('s1','h1','u1',1,1,9999999999999)");
    await db.query("INSERT INTO entitlements (user_id, language, plan, expires_at) VALUES ('u1','English','plus',9999999999999)");
    await db.query("DELETE FROM users WHERE id = 'u1'");
    const left = (await db.query("SELECT (SELECT count(*) FROM sessions WHERE user_id='u1') + (SELECT count(*) FROM entitlements WHERE user_id='u1') AS n")).rows[0].n;
    ok(Number(left) === 0, `${label}: deleting a user cascades to sessions and entitlements`);
    await ins('u3', 'tx@example.com');
    try { await db.tx(async q => { await q.query("UPDATE users SET name = 'changed' WHERE id = 'u3'"); throw Error('boom'); }); } catch {}
    ok((await db.query("SELECT name FROM users WHERE id='u3'")).rows[0].name === 'N', `${label}: a failed transaction rolls back`);
    // Row-level writes: 40 concurrent increments to ONE user's profile must all land (no lost updates).
    await db.query(`UPDATE users SET profile = '{"xp":0}' WHERE id = 'u3'`);
    await Promise.all(Array.from({length: 40}, () => db.tx(async q => {
      const r = await q.query("SELECT profile FROM users WHERE id = 'u3' FOR UPDATE");
      await q.query('UPDATE users SET profile = $1 WHERE id = $2', [{xp: r.rows[0].profile.xp + 1}, 'u3']);
    })));
    ok((await db.query("SELECT profile FROM users WHERE id='u3'")).rows[0].profile.xp === 40, `${label}: 40 concurrent row updates, no lost updates`);
    const big = Number((await db.query("SELECT expires FROM sessions LIMIT 0")).rows.length) === 0;
    await db.query("INSERT INTO sessions (id, hash, user_id, created_at, last_seen, expires) VALUES ('s9','h9','u3',1,1,1893456000000)");
    ok(typeof (await db.query("SELECT expires FROM sessions WHERE id='s9'")).rows[0].expires === 'number' && big, `${label}: bigint epoch-ms columns come back as JS numbers`);
  } finally { await db.close(); }
  const again = await open();
  ok(again.applied.length === 0, `${label}: reopening applies no migrations twice (idempotent)`);
  await again.close();
}

const dir = await mkdtemp(join(tmpdir(), 'usam-db-'));
try {
  const dataDir = join(dir, 'pglite');
  await suite('pglite', () => createDb({databaseUrl: '', dataDir}));
  // Lock: a second live process must not open the same PGlite directory.
  const held = await createDb({databaseUrl: '', dataDir});
  const child = await new Promise(res => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `import {createDb} from './server/db/index.js'; try { await createDb({databaseUrl: '', dataDir: ${JSON.stringify(dataDir)}}); console.log('OPENED'); } catch (e) { console.log(e.code); }`], {stdio: ['ignore', 'pipe', 'pipe']});
    let o = ''; p.stdout.on('data', d => o += d); p.on('exit', () => res(o.trim()));
  });
  ok(child === 'DATA_DIR_LOCKED', `pglite: a second process is refused while the data directory is in use (${child})`);
  await held.close();

  if (process.env.DATABASE_URL) {
    const {default: pg} = await import('pg');
    const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
    const name = 'usam_dbtest_' + Date.now();
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + name;
    try {
      await suite('postgres', () => createDb({databaseUrl: u.toString()}));
      // Concurrent startup: 4 instances migrating at once must not collide (advisory lock).
      const name2 = name + '_race'; await admin.query(`CREATE DATABASE ${name2}`);
      const u2 = new URL(process.env.DATABASE_URL); u2.pathname = '/' + name2;
      const dbs = await Promise.all(Array.from({length: 4}, () => createDb({databaseUrl: u2.toString()})));
      ok(dbs.reduce((n, d) => n + d.applied.length, 0) === 1, 'postgres: 4 instances starting together apply the migration exactly once');
      await Promise.all(dbs.map(d => d.close()));
      await admin.query(`DROP DATABASE IF EXISTS ${name2} WITH (FORCE)`);
    } finally { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); }
  } else console.log('DATABASE_URL not set — skipping PostgreSQL suite.');
} finally { await rm(dir, {recursive: true, force: true}); }
if (failures) { console.error(`\nDB tests FAILED (${failures}).`); process.exit(1); }
console.log('\nDB tests passed.');
process.exit(0);
