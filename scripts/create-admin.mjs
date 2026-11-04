// Create an administrator account (use it to bootstrap the first owner).
//
//   ADMIN_PASSWORD='a-long-unique-password' node scripts/create-admin.mjs --email owner@your-domain --name "Full Name" --role owner
//   echo 'a-long-unique-password' | node scripts/create-admin.mjs --email ... --name ... --role owner --password-stdin
//
// The password is never accepted as a command-line argument (it would leak into shell history / process lists).
// Works with both storage backends (CUSTOMER_DB_FILE or DATABASE_URL). With the JSON backend, stop the server
// first or restart it afterwards (the running server caches the file). With PostgreSQL it takes effect at once.
import 'dotenv/config';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStorage} from '../server/storage.js';
import {buildAdmin, ROLES} from '../server/admin.js';
import {appendAudit} from '../server/audit.js';

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
const storage = createStorage({dbFile: process.env.CUSTOMER_DB_FILE || join(root, 'data', 'customers.json')});
try {
  const admin = await buildAdmin({email, name, role, password, createdBy: 'cli'});
  let dup = false;
  await storage.mutate(db => {
    if (db.admins.some(a => a.email === admin.email)) { dup = true; return; }
    db.admins.push(admin);
    appendAudit(db, {event: 'admin_created', actor: {type: 'cli'}, target: {type: 'admin', id: admin.id}, meta: {role}});
  });
  if (dup) { console.error('An administrator with this email already exists.'); process.exitCode = 1; }
  else console.log(`Created ${role} administrator ${admin.email} (${admin.id}) on ${storage.backend()} storage.`);
} catch (e) {
  console.error(e.message); process.exitCode = 1;
} finally {
  await storage.close();
}
