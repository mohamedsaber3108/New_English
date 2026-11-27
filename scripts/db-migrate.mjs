// Applies pending database migrations once, then exits. Run it as the table-owner role (it needs DDL rights):
//   DATABASE_URL=postgres://owner:...@host/db npm run db:migrate
// The app and scripts/audit-retention.mjs can then run with DB_SKIP_MIGRATIONS=1 under restricted roles.
import 'dotenv/config';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDb, pgliteDirFromEnv} from '../server/db/index.js';

delete process.env.DB_SKIP_MIGRATIONS;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = await createDb({dataDir: pgliteDirFromEnv(root)});
console.log(db.applied.length ? `Applied: ${db.applied.join(', ')}` : 'Database is up to date.');
await db.close();
