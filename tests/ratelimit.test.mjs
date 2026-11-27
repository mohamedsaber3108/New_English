// Rate limiter tests. Memory backend always runs; Redis backend runs when REDIS_URL is set.
import {createRateLimiter} from '../server/ratelimit.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const uniq = () => 't' + Date.now() + Math.random().toString(36).slice(2, 8);

async function suite(label, mk) {
  console.log(`-- ${label}`);
  const a = mk(), b = mk(); // two limiter instances == two app instances
  const k = uniq();
  const results = [];
  for (let i = 0; i < 5; i++) results.push((await a.consume(k, 3, 2000)).allowed);
  ok(JSON.stringify(results) === JSON.stringify([true, true, true, false, false]), 'allows exactly `limit` requests then blocks');
  const r = await a.consume(k, 3, 2000);
  ok(r.retryAfterMs > 0 && r.retryAfterMs <= 2000, 'reports a sane retryAfterMs');
  const k2 = uniq();
  ok((await a.consume(k2, 1, 2000)).allowed, 'different keys are independent');
  await new Promise(r => setTimeout(r, 2100));
  ok((await a.consume(k, 3, 2000)).allowed, 'window resets after expiry');
  const k3 = uniq();
  await a.consume(k3, 2, 5000);
  await b.consume(k3, 2, 5000);
  const third = await a.consume(k3, 2, 5000);
  if (label === 'redis') ok(!third.allowed, 'limit is SHARED across instances (instance A sees instance B hits)');
  else ok(third.allowed, 'memory backend is per-instance (documented limitation)');
  // concurrency: 50 parallel hits against limit 10 -> exactly 10 allowed
  const k4 = uniq();
  const par = await Promise.all(Array.from({length: 50}, () => a.consume(k4, 10, 5000)));
  ok(par.filter(x => x.allowed).length === 10, `50 concurrent hits, limit 10 -> exactly 10 allowed (got ${par.filter(x => x.allowed).length})`);
  await a.close(); await b.close();
}

await suite('memory', () => createRateLimiter({redisUrl: ''}));
if (process.env.REDIS_URL) await suite('redis', () => createRateLimiter({redisUrl: process.env.REDIS_URL}));
else console.log('REDIS_URL not set — skipping Redis suite.');

// Redis unreachable: the limiter keeps serving AND keeps enforcing the limit with its in-process window (E-10).
{
  const bad = createRateLimiter({redisUrl: 'redis://127.0.0.1:1'});
  const k = uniq();
  const first = await bad.consume(k, 3, 5000);
  ok(first.allowed === true, 'unreachable Redis: the first request is still served');
  const rest = [];
  for (let i = 0; i < 4; i++) rest.push((await bad.consume(k, 3, 5000)).allowed);
  ok(JSON.stringify(rest) === JSON.stringify([true, true, false, false]), 'unreachable Redis: the limit still holds (3 allowed, then blocked), it does not fail open');
  ok(bad.status().degraded === true, 'status() reports degraded');
  await bad.close();
}

if (failures) { console.error(`\nRate limiter tests FAILED (${failures}).`); process.exit(1); }
console.log('\nRate limiter tests passed.');
process.exit(0);
