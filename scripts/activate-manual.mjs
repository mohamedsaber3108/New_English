// Staff-only: run after independently reconciling the payment in merchant records.
import 'dotenv/config';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);const [reference,paymentReference]=args;
if(!/^USL-[A-F0-9-]{12}$/.test(reference||'')||!paymentReference||paymentReference.length<6){console.error('Usage: npm run admin:activate -- USL-XXXXXXXXXXXX VERIFIED_PAYMENT_REFERENCE');process.exit(2)}
const file=process.env.CUSTOMER_DB_FILE||join(dirname(fileURLToPath(import.meta.url)),'..','data','customers.json');
const db=JSON.parse(await readFile(file,'utf8'));
const order=db.orders.find(o=>o.reference===reference);if(!order||order.status!=='pending_contact'){console.error('Order is missing or is not awaiting manual activation.');process.exit(2)}
if(db.orders.some(o=>o.manualPaymentReference===paymentReference)){console.error('Payment reference already used.');process.exit(2)}
const user=db.users.find(u=>u.id===order.userId);if(!user){console.error('User missing.');process.exit(2)}
const now=Date.now(),start=Math.max(now,user.entitlements?.[order.language]?.expiresAt||0);const expires=new Date(start);expires.setUTCMonth(expires.getUTCMonth()+(order.term==='yearly'?12:1));order.status='paid';order.paidAt=new Date(now).toISOString();order.expiresAt=expires.getTime();order.manualPaymentReference=paymentReference;user.entitlements??={};user.entitlements[order.language]={plan:order.plan,expiresAt:order.expiresAt,orderReference:order.reference};const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(db),{mode:0o600});await rename(tmp,file);console.log(`Activated ${reference} through ${new Date(order.expiresAt).toISOString()}`);
