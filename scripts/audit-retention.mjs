// Audit retention (A-1): archive-then-delete. Copies audit rows older than AUDIT_RETENTION_DAYS (default 365, i.e. 12 months)
// to audit_archive, deletes them from audit_log and moves the chain anchor, so verification of the remaining tail still passes.
// AUDIT_MAX_ENTRIES (optional) additionally caps the hot store. The newest entry is never removed.
//
// Run it with the RETENTION database role, not the app role (the app role is insert-only on audit_log):
//   DATABASE_URL=postgres://usam_audit_retention:...@host/db node scripts/audit-retention.mjs
// Without DATABASE_URL it runs against the local PGlite store (development).
import 'dotenv/config';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDb, pgliteDirFromEnv} from '../server/db/index.js';
import * as repo from '../server/db/repo.js';

const days = Number(process.env.AUDIT_RETENTION_DAYS || 365);
const max = Number(process.env.AUDIT_MAX_ENTRIES || 0);
if (!(days >= 30)) { console.error('AUDIT_RETENTION_DAYS must be at least 30.'); process.exit(2); }
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = await createDb({dataDir: pgliteDirFromEnv(root)});
let code = 0;
try {
  const archived = await db.tx(q => repo.audit.trim(q, {retentionDays: days, maxEntries: max}));
  const v = await repo.audit.verify(db);
  console.log(`Archived and removed ${archived} audit entries older than ${days} days. Chain verifies: ${v.ok}${v.ok ? '' : ' (' + v.reason + ')'}.`);
  if (!v.ok) code = 1;
} catch (e) { console.error('Retention failed:', e.message); code = 1; }
await db.close();
process.exit(code);
