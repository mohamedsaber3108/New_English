// Integration test for the PostgreSQL storage backend.
// Requires a reachable Postgres via DATABASE_URL. Skips (exit 0) if DATABASE_URL is not set,
// so the default test run never depends on external infrastructure.
// Run: DATABASE_URL=postgres://... node tests/storage.pg.test.mjs
import {createStorage} from '../server/storage.js';

const url = process.env.DATABASE_URL;
if (!url) { console.log('storage.pg.test: DATABASE_URL not set — skipping Postgres integration test.'); process.exit(0); }

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  PASS:', msg); else { console.error('  FAIL:', msg); failures++; } };

async function reset(storage) {
  // Clear the singleton document to a known-empty state for a deterministic run.
  await storage.mutate(db => { db.users.length = 0; db.orders.length = 0; db.sessions.length = 0; db.auditLog.length = 0; });
}

(async () => {
  const storage = createStorage({databaseUrl: url});
  ok(storage.backend() === 'postgres', 'factory selects the postgres backend when DATABASE_URL is set');

  // Health check reaches the database.
  const health = await storage.healthCheck();
  ok(health.ok && health.backend === 'postgres', 'healthCheck succeeds against postgres');

  await reset(storage);

  // Write through mutate.
  const created = await storage.mutate(db => { db.users.push({id: 'u1', email: 'a@example.com', entitlements: {}}); return db.users.length; });
  ok(created === 1, 'mutate appends a user and returns the callback result');

  // Read back through store (from cache).
  const doc = await storage.store();
  ok(doc.users.length === 1 && doc.users[0].email === 'a@example.com', 'store reflects the committed write');

  // Durability: a brand-new storage instance (simulating a process/instance restart) sees the data.
  const second = createStorage({databaseUrl: url});
  const doc2 = await second.store();
  ok(doc2.users.length === 1 && doc2.users[0].id === 'u1', 'data persists across a fresh storage instance (survives restart / shared across instances)');

  // Cross-instance freshness: instance A has already cached the document; instance B then writes.
  // A's next store() must see B's write (otherwise sessions created on B are invisible on A).
  {
    const A = createStorage({databaseUrl: url}), B = createStorage({databaseUrl: url});
    await A.store(); // warm A's cache
    await B.mutate(db => { db.sessions.push({id: 'fresh-from-B', hash: 'h', userId: 'u1', expires: Date.now() + 60000}); });
    const seen = (await A.store()).sessions.some(s => s.id === 'fresh-from-B');
    ok(seen, 'a write on instance B is visible to instance A on its next read (no stale cache)');
    await A.close(); await B.close();
  }

  // Concurrency: 25 parallel mutates must all land (row-locked transactions, no lost updates).
  await reset(storage);
  await Promise.all(Array.from({length: 25}, (_, i) => storage.mutate(db => { db.orders.push({reference: 'R' + i}); })));
  const after = await createStorage({databaseUrl: url}).store();
  ok(after.orders.length === 25, `all 25 concurrent mutates persisted without lost updates (got ${after.orders.length})`);

  // Collections are always initialized even on a fresh document.
  ok(Array.isArray(after.supportTickets) && Array.isArray(after.securityTokens) && Array.isArray(after.auditLog), 'all collections initialized');

  await reset(storage);
  await storage.close();
  await second.close();

  if (failures) { console.error(`\nPostgres storage integration test FAILED (${failures} assertion(s)).`); process.exit(1); }
  console.log('\nPostgres storage integration test passed.');
})().catch(e => { console.error('  FAIL: unexpected error', e); process.exit(1); });
