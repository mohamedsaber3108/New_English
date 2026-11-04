// Create an administrator account (use it to bootstrap the first owner).
//
//   ADMIN_PASSWORD='a-long-unique-password' node scripts/create-admin.mjs --email owner@your-domain --name "Full Name" --role owner
//   echo 'a-long-unique-password' | node scripts/create-admin.mjs --email ... --name ... --role owner --password-stdin
//
// The password is never accepted as a command-line argument (it would leak into shell history / process lists).
// Uses the same database as the server: PostgreSQL when DATABASE_URL is set (works while the server runs), otherwise
// the embedded PGlite data directory (the server must be stopped; the directory lock refuses concurrent use).
import 'dotenv/config';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDb, pgliteDirFromEnv, isUniqueViolation} from '../server/db/index.js';
import {autoImport} from '../server/db/legacy-import.js';
import * as repo from '../server/db/repo.js';
import {buildAdmin, ROLES} from '../server/admin.js';

const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const usage = () => { console.error(`Usage: ADMIN_PASSWORD=... node scripts/create-admin.mjs --email EMAIL --name "NAME" --role ${Object.keys(ROLES).join('|')} [--password-stdin]`); process.exit(2); };

const email = arg('email'), name = arg('name'), role = arg('role') || 'owner';
if (!email || !name) usage();
let password = process.env.ADMIN_PASSWORD;
if (args.includes('--password-stdin')) {
  let buf = '';
  for await (const chunk of process.stdin) buf += chunk;
  password = buf.split(/\r?\n/)[0];
}
if (!password) usage();

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let db;
try {
  const admin = await buildAdmin({email, name, role, password, createdBy: 'cli'});
  db = await createDb({dataDir: pgliteDirFromEnv(root)});
  await autoImport(db, {jsonFile: process.env.CUSTOMER_DB_FILE || join(root, 'data', 'customers.json')});
  await db.tx(async q => {
    await repo.admins.create(q, admin);
    await repo.audit.append(q, {event: 'admin_created', actor: {type: 'cli'}, target: {type: 'admin', id: admin.id}, meta: {role}});
  });
  console.log(`Created ${role} administrator ${admin.email} (${admin.id}) on ${db.backend}.`);
} catch (e) {
  console.error(isUniqueViolation(e) ? 'An administrator with this email already exists.' : e.message);
  process.exitCode = 1;
} finally {
  await db?.close();
}
