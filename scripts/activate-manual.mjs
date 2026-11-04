// Staff-only fallback: activate an order after independently reconciling the payment in merchant records.
// Prefer the admin UI (Orders > Activate), which applies the same rules and requires a signed-in finance/owner/admin.
//
//   node scripts/activate-manual.mjs USL-XXXXXXXXXXXX VERIFIED_PAYMENT_REFERENCE "reason for the audit log"
//
// Same database as the server (PostgreSQL via DATABASE_URL, or the PGlite directory with the server stopped).
import 'dotenv/config';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDb, pgliteDirFromEnv, isUniqueViolation} from '../server/db/index.js';
import {autoImport} from '../server/db/legacy-import.js';
import * as repo from '../server/db/repo.js';

const [reference, paymentReference, reason = 'manual activation via CLI'] = process.argv.slice(2);
if (!/^USL-[A-F0-9-]{12}$/.test(reference || '') || !paymentReference || paymentReference.length < 6) {
  console.error('Usage: node scripts/activate-manual.mjs USL-XXXXXXXXXXXX VERIFIED_PAYMENT_REFERENCE "reason"');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = await createDb({dataDir: pgliteDirFromEnv(root)});
try {
  await autoImport(db, {jsonFile: process.env.CUSTOMER_DB_FILE || join(root, 'data', 'customers.json')});
  const result = await db.tx(async q => {
    const order = await repo.orders.byRef(q, reference, {lock: true});
    if (!order || order.status !== 'pending_contact') throw Error('Order is missing or is not awaiting manual activation.');
    if (await repo.orders.manualRefUsed(q, paymentReference)) throw Error('Payment reference already used.');
    const user = order.userId && await repo.users.lockById(q, order.userId);
    if (!user) throw Error('User missing.');
    const now = Date.now(), start = Math.max(now, user.entitlements?.[order.language]?.expiresAt || 0);
    const expires = new Date(start); expires.setUTCMonth(expires.getUTCMonth() + (order.term === 'yearly' ? 12 : 1));
    await repo.orders.update(q, reference, {status: 'paid', paidAt: new Date(now).toISOString(), expiresAt: expires.getTime(), manualPaymentReference: paymentReference, activatedBy: 'cli'});
    await repo.entitlements.set(q, user.id, order.language, {plan: order.plan, expiresAt: expires.getTime(), orderReference: reference, source: 'manual_payment'});
    await repo.audit.append(q, {event: 'order_manually_activated', actor: {type: 'cli'}, target: {type: 'order', id: reference}, meta: {userId: user.id, amount: order.amount, paymentReference, expiresAt: expires.getTime(), reason}});
    return expires.getTime();
  });
  console.log(`Activated ${reference} through ${new Date(result).toISOString()}`);
} catch (e) {
  console.error(isUniqueViolation(e) ? 'Payment reference already used.' : e.message);
  process.exitCode = 2;
} finally {
  await db.close();
}
