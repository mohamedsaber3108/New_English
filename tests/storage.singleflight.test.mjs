// Concurrent cold reads must share ONE document load (no thundering herd when a server restarts under traffic).
// JSON always; PostgreSQL too when DATABASE_URL is set (isolated throwaway database).
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStorage} from '../server/storage.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const dir = await mkdtemp(join(tmpdir(), 'usam-sf-'));
const file = join(dir, 'db.json');
await writeFile(file, JSON.stringify({users: Array.from({length: 2000}, (_, i) => ({id: 'u' + i, email: `u${i}@x.com`}))}));
try {
  const s = createStorage({dbFile: file, databaseUrl: ''});
  const docs = await Promise.all(Array.from({length: 50}, () => s.store()));
  ok(docs.every(d => d.users.length === 2000), 'JSON: 50 concurrent cold reads all get the data');
  ok(s.stats().documentLoads === 1, `JSON: the file was loaded once, not once per request (loads=${s.stats().documentLoads})`);

  if (process.env.DATABASE_URL) {
    const {default: pg} = await import('pg');
    const admin = new pg.Client({connectionString: process.env.DATABASE_URL}); await admin.connect();
    const name = 'usam_sf_' + Date.now();
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(process.env.DATABASE_URL); u.pathname = '/' + name;
    try {
      const writer = createStorage({databaseUrl: u.toString()}), reader = createStorage({databaseUrl: u.toString()});
      await writer.mutate(db => { db.users = Array.from({length: 2000}, (_, i) => ({id: 'u' + i})); });
      await reader.store();
      const before = reader.stats().documentLoads;
      await writer.mutate(db => { db.users.push({id: 'new'}); }); // another instance writes -> version bump
      const docs2 = await Promise.all(Array.from({length: 50}, () => reader.store()));
      ok(docs2.every(d => d.users.length === 2001), 'PG: 50 concurrent reads after a remote write all see it');
      ok(reader.stats().documentLoads - before === 1, `PG: the new version was fetched once, not once per request (fetches=${reader.stats().documentLoads - before})`);
      await writer.close(); await reader.close();
    } finally { await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end(); }
  } else console.log('DATABASE_URL not set — skipping PG single-flight check.');
} finally {
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nSingle-flight test FAILED (${failures}).`); process.exit(1); }
console.log('\nSingle-flight test passed.');
process.exit(0);
