// Storage adapter layer for USAM Language.
//
// Exposes a single logical document (collections: users, sessions, orders, supportTickets,
// securityTokens, auditLog, analytics) behind a stable contract:
//   store()      -> Promise<document>   (cached after first load)
//   mutate(fn)   -> Promise<result>     (serialized; fn(document) may mutate; persisted atomically)
//   backend()    -> 'json' | 'postgres'
//   healthCheck()-> Promise<{ok, backend, latencyMs}>
//   close()      -> Promise<void>
//
// Two interchangeable backends with identical semantics so the whole app and its test suite run
// unchanged against either:
//
//   JSON (default): single file, atomic temp-file+rename write, in-process write queue.
//     - Zero infrastructure. Single Node process only. Used in dev/staging and tests.
//
//   PostgreSQL (when DATABASE_URL is set): the document is stored as one JSONB row and each mutate
//     runs inside a transaction with SELECT ... FOR UPDATE row locking. This provides durability,
//     connection pooling, point-in-time backup/restore and shared access across app restarts.
//     NOTE: this is a durable "document in Postgres" model. It is a correct, backward-compatible
//     first migration step. Per-entity normalized tables (for high write-concurrency at the very top
//     of the 100k range) are the documented next step and do not change this public contract.
//
// The selected backend is reported by backend() and surfaced in /api/health.

import {readFile, writeFile, mkdir, rename, chmod} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const COLLECTIONS = ['users', 'sessions', 'orders', 'supportTickets', 'securityTokens', 'auditLog', 'analytics', 'leads', 'admins', 'adminSessions'];

function emptyDocument() {
  return Object.fromEntries(COLLECTIONS.map(k => [k, []]));
}

function ensureCollections(doc) {
  for (const key of COLLECTIONS) doc[key] ??= [];
  return doc;
}

// ---------------------------------------------------------------------------
// JSON backend (default) — preserves the original behavior exactly.
// ---------------------------------------------------------------------------
function createJsonStorage(dbFile) {
  let state;
  let writes = Promise.resolve();

  let loading = null; // single-flight: concurrent first reads share ONE file load instead of each parsing it
  let loads = 0;
  async function store() {
    if (!state) {
      loading ??= (async () => {
        loads++;
        try { return JSON.parse(await readFile(dbFile, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; return emptyDocument(); }
      })().finally(() => { loading = null; });
      const loaded = await loading;
      state ??= loaded;
    }
    return ensureCollections(state);
  }

  async function mutate(fn) {
    const run = writes.catch(() => {}).then(async () => {
      const db = await store();
      const out = await fn(db);
      await mkdir(dirname(dbFile), {recursive: true, mode: 0o700});
      const tmp = dbFile + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, JSON.stringify(db), {mode: 0o600});
      await rename(tmp, dbFile);
      await chmod(dbFile, 0o600);
      return out;
    });
    writes = run.then(() => {}, () => {});
    return run;
  }

  async function healthCheck() {
    const t = Date.now();
    await store();
    return {ok: true, backend: 'json', latencyMs: Date.now() - t};
  }

  return {store, mutate, backend: () => 'json', healthCheck, close: async () => {}, stats: () => ({documentLoads: loads})};
}

// ---------------------------------------------------------------------------
// PostgreSQL backend — durable document model with row-locked transactions.
// ---------------------------------------------------------------------------
function createPostgresStorage(connectionString) {
  // Lazy-require pg so the JSON path never needs the driver installed.
  let pool;
  let ready;
  let cache;
  let cacheVersion = -1; // version of the document held in `cache`
  let writes = Promise.resolve();

  async function init() {
    if (ready) return ready;
    ready = (async () => {
      const {default: pg} = await import('pg');
      const {Pool} = pg;
      pool = new Pool({
        connectionString,
        max: Number(process.env.PG_POOL_MAX || 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 8000),
        ...(process.env.PGSSL === 'require' ? {ssl: {rejectUnauthorized: false}} : {}),
      });
      // An idle pooled client can error (DB restart/failover). Unhandled, that event crashes the process.
      // The pool discards the broken client; the next query gets a fresh connection.
      pool.on('error', err => { console.error(JSON.stringify({level: 'error', msg: 'pg pool idle client error', error: err.message})); });
      await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
        id integer PRIMARY KEY DEFAULT 1,
        document jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT app_state_singleton CHECK (id = 1)
      )`);
      // Monotonic version, bumped on every write. Lets each instance detect writes made by OTHER instances
      // with a cheap single-column read instead of trusting a stale in-process cache.
      await pool.query('ALTER TABLE app_state ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 0');
      await pool.query(
        `INSERT INTO app_state (id, document) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(emptyDocument())]
      );
    })();
    return ready;
  }

  let refetching = null; // single-flight: concurrent readers that see a new version share ONE document fetch
  let loads = 0;
  async function store() {
    await init();
    // Cheap freshness check every read; refetch the document only when another instance has written.
    const v = await pool.query('SELECT version FROM app_state WHERE id = 1');
    const current = Number(v.rows[0]?.version ?? 0);
    if (!cache || current > cacheVersion) {
      refetching ??= (async () => {
        loads++;
        const res = await pool.query('SELECT document, version FROM app_state WHERE id = 1');
        const version = Number(res.rows[0]?.version ?? 0);
        // Never replace a newer cache (e.g. one just set by this instance's own commit) with an older fetch.
        if (!cache || version > cacheVersion) { cache = ensureCollections(res.rows[0]?.document || emptyDocument()); cacheVersion = version; }
      })().finally(() => { refetching = null; });
      await refetching;
    }
    return cache;
  }

  async function mutate(fn) {
    const run = writes.catch(() => {}).then(async () => {
      await init();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Lock the singleton row and read the authoritative document (survives multi-instance).
        const res = await client.query('SELECT document FROM app_state WHERE id = 1 FOR UPDATE');
        const db = ensureCollections(res.rows[0]?.document || emptyDocument());
        const out = await fn(db);
        const up = await client.query('UPDATE app_state SET document = $1::jsonb, updated_at = now(), version = version + 1 WHERE id = 1 RETURNING version', [JSON.stringify(db)]);
        await client.query('COMMIT');
        cache = db; // refresh cache with the committed document
        cacheVersion = Number(up.rows[0].version);
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch {}
        throw e;
      } finally {
        client.release();
      }
    });
    writes = run.then(() => {}, () => {});
    return run;
  }

  async function healthCheck() {
    const t = Date.now();
    await init();
    await pool.query('SELECT 1');
    return {ok: true, backend: 'postgres', latencyMs: Date.now() - t};
  }

  async function close() { if (pool) await pool.end(); }

  return {store, mutate, backend: () => 'postgres', healthCheck, close, stats: () => ({documentLoads: loads})};
}

// ---------------------------------------------------------------------------
// Factory — chooses the backend from the environment.
// ---------------------------------------------------------------------------
export function createStorage({dbFile, databaseUrl} = {}) {
  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (url) return createPostgresStorage(url);
  return createJsonStorage(dbFile);
}

export {COLLECTIONS, emptyDocument};
