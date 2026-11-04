// Group practice room coordination.
//
// A hub tracks which members are in which room and fans out room events to every connected socket.
//   join(code, member, socket) -> {ok:true} | {ok:false, reason:'full'}
//   leave(code, memberId)
//   publish(code, event)       -> event reaches every socket in the room, on every instance
//   members(code)              -> [{id,name}]
//   status() / close()
//
// Backends:
//   memory (default): one process. Correct for a single instance.
//   redis  (REDIS_URL): membership in a Redis hash, joined through an atomic Lua script so the room cap
//          holds across instances; events travel over Redis pub/sub so learners connected to different
//          instances share one room. Members heartbeat; entries not refreshed within STALE_MS (e.g. the
//          instance crashed) are pruned, so ghost members cannot keep a room "full" forever.
import {createClient} from 'redis';
import {randomUUID} from 'node:crypto';

const STALE_MS = 45000;
const HEARTBEAT_MS = 15000;

// KEYS[1]=members hash. ARGV: memberId, json, capacity, now, staleMs, ttlMs. Returns 1 joined, 0 full.
const JOIN_LUA = `
local all = redis.call('HGETALL', KEYS[1])
local now = tonumber(ARGV[4]); local stale = tonumber(ARGV[5])
for i = 1, #all, 2 do
  local ok, v = pcall(cjson.decode, all[i+1])
  if (not ok) or (tonumber(v.seen) or 0) < now - stale then redis.call('HDEL', KEYS[1], all[i]) end
end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 0 and redis.call('HLEN', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[6]))
return 1`;

export function createRoomHub({redisUrl = process.env.REDIS_URL, prefix = (process.env.RATE_LIMIT_PREFIX || 'usam') + ':room:', capacity = 4} = {}) {
  const instanceId = randomUUID();
  const local = new Map(); // code -> Map(memberId -> {socket, name})
  let pub, sub, ready = false, degraded = false, starting;
  const timers = new Map(); // memberId -> heartbeat interval

  const deliverLocal = (code, event) => {
    const room = local.get(code);
    if (!room) return;
    const data = JSON.stringify(event);
    for (const {socket} of room.values()) if (socket.readyState === 1) socket.send(data);
  };

  async function start() {
    if (!redisUrl) return false;
    if (ready) return true;
    if (!starting) {
      starting = (async () => {
        pub = createClient({url: redisUrl, socket: {connectTimeout: 2000, reconnectStrategy: r => Math.min(r * 200, 3000)}});
        sub = pub.duplicate();
        for (const c of [pub, sub]) { c.on('error', () => { degraded = true; }); }
        await Promise.race([Promise.all([pub.connect(), sub.connect()]), new Promise((_, j) => setTimeout(() => j(Error('timeout')), 2000))]);
        await sub.pSubscribe(prefix + 'evt:*', (message, channel) => {
          const code = channel.slice((prefix + 'evt:').length);
          try { deliverLocal(code, JSON.parse(message)); } catch {}
        });
        ready = true; degraded = false;
      })().catch(() => { degraded = true; ready = false; });
    }
    await starting;
    return ready;
  }

  const useRedis = async () => redisUrl && (await start()) && pub?.isReady;
  const membersKey = code => prefix + 'members:' + code;

  async function join(code, member, socket) {
    if (await useRedis()) {
      try {
        const joined = await pub.eval(JOIN_LUA, {keys: [membersKey(code)], arguments: [member.id, JSON.stringify({name: member.name, instance: instanceId, seen: Date.now()}), String(capacity), String(Date.now()), String(STALE_MS), String(STALE_MS * 4)]});
        if (Number(joined) !== 1) return {ok: false, reason: 'full'};
      } catch { degraded = true; return joinLocalOnly(code, member, socket); }
      addLocal(code, member, socket);
      timers.set(member.id, setInterval(() => {
        pub.hSet(membersKey(code), member.id, JSON.stringify({name: member.name, instance: instanceId, seen: Date.now()})).catch(() => { degraded = true; });
      }, HEARTBEAT_MS));
      return {ok: true};
    }
    return joinLocalOnly(code, member, socket);
  }

  function joinLocalOnly(code, member, socket) {
    const room = local.get(code);
    if (room && room.size >= capacity) return {ok: false, reason: 'full'};
    addLocal(code, member, socket);
    return {ok: true};
  }

  function addLocal(code, member, socket) {
    if (!local.has(code)) local.set(code, new Map());
    local.get(code).set(member.id, {socket, name: member.name});
  }

  async function leave(code, memberId) {
    clearInterval(timers.get(memberId)); timers.delete(memberId);
    const room = local.get(code);
    if (room) { room.delete(memberId); if (!room.size) local.delete(code); }
    if (await useRedis()) await pub.hDel(membersKey(code), memberId).catch(() => { degraded = true; });
  }

  async function members(code) {
    if (await useRedis()) {
      try {
        const all = await pub.hGetAll(membersKey(code));
        const now = Date.now();
        return Object.entries(all).map(([id, v]) => { try { const x = JSON.parse(v); return x.seen >= now - STALE_MS ? {id, name: x.name} : null; } catch { return null; } }).filter(Boolean);
      } catch { degraded = true; }
    }
    return [...(local.get(code)?.entries() || [])].map(([id, x]) => ({id, name: x.name}));
  }

  async function publish(code, event) {
    if (await useRedis()) {
      try { await pub.publish(prefix + 'evt:' + code, JSON.stringify(event)); return; } catch { degraded = true; }
    }
    deliverLocal(code, event);
  }

  const status = () => ({backend: redisUrl ? 'redis' : 'memory', degraded: redisUrl ? degraded || !ready : false, localRooms: local.size, instanceId});

  async function close() {
    for (const t of timers.values()) clearInterval(t);
    timers.clear();
    for (const c of [sub, pub]) {
      if (!c) continue;
      try { c.removeAllListeners(); c.on('error', () => {}); } catch {}
      try { await Promise.race([c.disconnect(), new Promise(r => setTimeout(r, 500))]); } catch {}
    }
  }

  return {join, leave, members, publish, status, close, capacity};
}
