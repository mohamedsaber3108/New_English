// Database access: one SQL implementation, two drivers.
//   DATABASE_URL set  -> PostgreSQL via `pg` (production; pooled; PG 16 compatible SQL only)
//   otherwise         -> PGlite (Postgres compiled to WASM, in-process) for development and tests
//
// createDb() returns {query(sql, params) -> {rows}, tx(fn) -> fn's result, backend, health(), close()}.
// tx(fn) runs fn(q) inside BEGIN/COMMIT; q has the same .query(). Any throw rolls back.
// Migrations in ./migrations are applied in filename order, each in its own transaction, recorded in
// schema_migrations. On PostgreSQL an advisory lock serializes concurrent instances during startup.
import {readFile, readdir, mkdir, writeFile, unlink} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_LOCK = 4821337; // arbitrary app-specific advisory lock key

async function migrate(run) {
  await run(async q => { await q.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'); });
  const files = (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort();
  const applied = [];
  for (const name of files) {
    const did = await run(async q => {
      const done = await q.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
      if (done.rows.length) return false;
      await q.exec(await readFile(join(MIGRATIONS, name), 'utf8'));
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      return true;
    });
    if (did) applied.push(name);
  }
  return applied;
}

// ---------------------------------------------------------------- PostgreSQL
async function createPg(url) {
  const {default: pg} = await import('pg');
  pg.types.setTypeParser(20, v => Number(v)); // bigint -> number (all our bigints are epoch ms / counters < 2^53)
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 8000),
    ...(process.env.PGSSL === 'require' ? {ssl: {rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== 'false'}} : {}),
  });
  // An idle pooled client can error (DB restart/failover); unhandled, that event would crash the process.
  pool.on('error', err => console.error(JSON.stringify({level: 'error', msg: 'pg pool idle client error', error: err.message})));
  const wrap = c => ({query: (s, p) => c.query(s, p), exec: s => c.query(s)});
  async function tx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(wrap(c));
      await c.query('COMMIT');
      return out;
    } catch (e) { try { await c.query('ROLLBACK'); } catch {} throw e; }
    finally { c.release(); }
  }
  const lockClient = await pool.connect();
  let applied;
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    applied = await migrate(tx);
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    lockClient.release();
  }
  return {
    backend: 'postgres', applied,
    query: (s, p) => pool.query(s, p),
    tx,
    health: async () => { const t = Date.now(); await pool.query('SELECT 1'); return {ok: true, backend: 'postgres', latencyMs: Date.now() - t}; },
    close: () => pool.end(),
  };
}

// ---------------------------------------------------------------- PGlite
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

async function createPglite(dataDir) {
  const {PGlite} = await import('@electric-sql/pglite');
  let lockFile = null;
  if (dataDir !== 'memory://') {
    // PGlite has no cross-process locking; two processes on one data dir would corrupt it. Refuse instead.
    await mkdir(dataDir, {recursive: true});
    lockFile = join(dataDir, '.usam-lock');
    try {
      const other = Number((await readFile(lockFile, 'utf8')).trim());
      if (other && other !== process.pid && pidAlive(other)) throw Object.assign(Error(`PGlite data directory ${dataDir} is in use by process ${other}. Stop it first (or use DATABASE_URL for shared access).`), {code: 'DATA_DIR_LOCKED'});
    } catch (e) { if (e.code === 'DATA_DIR_LOCKED') throw e; }
    await writeFile(lockFile, String(process.pid));
  }
  const db = new PGlite(dataDir === 'memory://' ? undefined : dataDir);
  await db.waitReady;
  // PGlite runs one statement at a time; serialize transactions explicitly so interleaved async work in two
  // transactions can never share the single connection.
  let chain = Promise.resolve();
  const wrap = t => ({query: (s, p) => t.query(s, p), exec: s => t.exec(s)});
  const tx = fn => {
    const run = chain.then(() => db.transaction(t => fn(wrap(t))));
    chain = run.catch(() => {});
    return run;
  };
  // Plain queries also go through the queue so they never land inside another caller's open transaction.
  const query = (s, p) => { const run = chain.then(() => db.query(s, p)); chain = run.catch(() => {}); return run; };
  const applied = await migrate(tx);
  return {
    backend: 'pglite', applied, dataDir,
    query, tx,
    health: async () => { const t = Date.now(); await query('SELECT 1'); return {ok: true, backend: 'pglite', latencyMs: Date.now() - t}; },
    close: async () => { await chain.catch(() => {}); await db.close(); if (lockFile) await unlink(lockFile).catch(() => {}); },
  };
}

export function pgliteDirFromEnv(root) {
  if (process.env.PGLITE_DATA_DIR) return process.env.PGLITE_DATA_DIR;
  if (process.env.CUSTOMER_DB_FILE) return process.env.CUSTOMER_DB_FILE.replace(/\.json$/i, '') + '-pglite';
  return join(root, 'data', 'pglite');
}

export async function createDb({databaseUrl = process.env.DATABASE_URL, dataDir} = {}) {
  if (databaseUrl) return createPg(databaseUrl);
  if (!dataDir) throw Error('createDb: dataDir is required when DATABASE_URL is not set');
  return createPglite(dataDir);
}

// Converts a unique-violation into a typed error the routes can map to 409.
export const isUniqueViolation = e => e?.code === '23505';
