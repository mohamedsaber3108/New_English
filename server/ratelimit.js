// Shared rate limiter.
//   consume(key, limit, windowMs) -> {allowed, remaining, retryAfterMs}
// Backends:
//   memory (default): per-process fixed window. Fine for one instance; resets on restart.
//   redis  (REDIS_URL): atomic INCR + PEXPIRE fixed window, shared by every app instance and
//          surviving restarts. If Redis becomes unreachable the limiter FAILS OPEN to the in-memory
//          window for that instance (availability over strictness) and reports it via status().
import {createClient} from 'redis';

// RATE_LIMIT_PREFIX namespaces keys (e.g. per environment: staging vs production sharing one Redis, or isolated test runs).
export function createRateLimiter({redisUrl = process.env.REDIS_URL, prefix = (process.env.RATE_LIMIT_PREFIX || 'usam') + ':rl:'} = {}) {
  const mem = new Map();
  let client, connecting, degraded = false;

  function memConsume(key, limit, windowMs) {
    const now = Date.now();
    let v = mem.get(key);
    if (!v || now >= v.reset) { v = {n: 0, reset: now + windowMs}; mem.set(key, v); }
    v.n++;
    if (mem.size > 50000) for (const [k, x] of mem) if (now >= x.reset) mem.delete(k);
    return {allowed: v.n <= limit, remaining: Math.max(0, limit - v.n), retryAfterMs: Math.max(0, v.reset - now)};
  }

  const CONNECT_WAIT_MS = Number(process.env.RATELIMIT_CONNECT_WAIT_MS || 1000);
  const COOLDOWN_MS = 5000;
  let coolUntil = 0;

  async function connect() {
    if (!redisUrl) return null;
    if (client?.isReady) return client;
    // While Redis is known-down, skip straight to memory instead of making every request wait.
    if (Date.now() < coolUntil) return null;
    if (!client) {
      client = createClient({url: redisUrl, socket: {connectTimeout: 2000, reconnectStrategy: r => Math.min(r * 200, 3000)}});
      client.on('error', () => { degraded = true; });
      client.on('ready', () => { degraded = false; coolUntil = 0; });
      // connect() never settles while reconnectStrategy keeps retrying, so never await it unbounded.
      connecting = client.connect().catch(() => { degraded = true; }).finally(() => { connecting = null; });
    }
    await Promise.race([connecting ?? Promise.resolve(), new Promise(r => setTimeout(r, CONNECT_WAIT_MS))]);
    if (client.isReady) return client;
    degraded = true;
    coolUntil = Date.now() + COOLDOWN_MS;
    return null;
  }

  async function consume(key, limit, windowMs) {
    const c = redisUrl ? await connect() : null;
    if (!c) return memConsume(key, limit, windowMs);
    try {
      const k = prefix + key;
      const n = await c.incr(k);
      if (n === 1) await c.pExpire(k, windowMs);
      let ttl = await c.pTTL(k);
      if (ttl < 0) { await c.pExpire(k, windowMs); ttl = windowMs; } // self-heal a key lost its expiry
      return {allowed: n <= limit, remaining: Math.max(0, limit - n), retryAfterMs: ttl};
    } catch {
      degraded = true;
      return memConsume(key, limit, windowMs);
    }
  }

  // Read the current count for a key without incrementing it. `allowed` = another hit would still fit.
  async function peek(key, limit, windowMs) {
    const c = redisUrl ? await connect() : null;
    if (c) {
      try {
        const n = Number(await c.get(prefix + key)) || 0;
        const ttl = await c.pTTL(prefix + key);
        return {allowed: n < limit, remaining: Math.max(0, limit - n), retryAfterMs: ttl > 0 ? ttl : 0};
      } catch { degraded = true; }
    }
    const v = mem.get(key), now = Date.now();
    const n = v && now < v.reset ? v.n : 0;
    return {allowed: n < limit, remaining: Math.max(0, limit - n), retryAfterMs: v && now < v.reset ? v.reset - now : 0};
  }

  // Express middleware factory.
  function middleware({limit, windowMs, key = req => req.ip || 'local', name = 'rl', message = 'Please slow down and try again.'}) {
    return async (req, res, next) => {
      const r = await consume(`${name}:${key(req)}`, limit, windowMs);
      res.setHeader('RateLimit-Remaining', String(r.remaining));
      if (!r.allowed) {
        res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
        return res.status(429).json({error: message});
      }
      next();
    };
  }

  const status = () => ({backend: redisUrl ? 'redis' : 'memory', degraded: redisUrl ? degraded || !client?.isReady : false});
  async function close() {
    if (!client) return;
    try { client.removeAllListeners(); client.on('error', () => {}); } catch {}
    try { await Promise.race([client.disconnect(), new Promise(r => setTimeout(r, 500))]); } catch {}
  }
  return {consume, peek, middleware, status, close};
}
