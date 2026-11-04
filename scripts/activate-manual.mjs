// Staff-only fallback: activate an order after independently reconciling the payment in merchant records.
// Prefer the admin UI (Orders > Activate), which applies the same rules and requires a signed-in finance/owner/admin.
//
//   node scripts/activate-manual.mjs USL-XXXXXXXXXXXX VERIFIED_PAYMENT_REFERENCE "reason for the audit log"
//
// Works with both storage backends and records the activation in the tamper-evident audit log.
// With the JSON backend, stop the server first (it caches the file) and restart it afterwards.
import 'dotenv/config';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createStorage} from '../server/storage.js';
import {appendAudit} from '../server/audit.js';

const [reference, paymentReference, reason = 'manual activation via CLI'] = process.argv.slice(2);
if (!/^USL-[A-F0-9-]{12}$/.test(reference || '') || !paymentReference || paymentReference.length < 6) {
  console.error('Usage: node scripts/activate-manual.mjs USL-XXXXXXXXXXXX VERIFIED_PAYMENT_REFERENCE "reason"');
  process.exit(2);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const storage = createStorage({dbFile: process.env.CUSTOMER_DB_FILE || join(root, 'data', 'customers.json')});
let error = null, result = null;
await storage.mutate(db => {
  const order = db.orders.find(o => o.reference === reference);
  if (!order || order.status !== 'pending_contact') { error = 'Order is missing or is not awaiting manual activation.'; return; }
  if (db.orders.some(o => o.manualPaymentReference === paymentReference)) { error = 'Payment reference already used.'; return; }
  const user = db.users.find(u => u.id === order.userId);
  if (!user) { error = 'User missing.'; return; }
  const now = Date.now(), start = Math.max(now, user.entitlements?.[order.language]?.expiresAt || 0);
  const expires = new Date(start); expires.setUTCMonth(expires.getUTCMonth() + (order.term === 'yearly' ? 12 : 1));
  Object.assign(order, {status: 'paid', paidAt: new Date(now).toISOString(), expiresAt: expires.getTime(), manualPaymentReference: paymentReference, activatedBy: 'cli'});
  user.entitlements ??= {};
  user.entitlements[order.language] = {plan: order.plan, expiresAt: order.expiresAt, orderReference: order.reference, source: 'manual_payment'};
  appendAudit(db, {event: 'order_manually_activated', actor: {type: 'cli'}, target: {type: 'order', id: order.reference}, meta: {userId: user.id, amount: order.amount, paymentReference, expiresAt: order.expiresAt, reason}});
  result = order;
});
await storage.close();
if (error) { console.error(error); process.exit(2); }
console.log(`Activated ${reference} through ${new Date(result.expiresAt).toISOString()}`);
