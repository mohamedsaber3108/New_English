// Group room (WebSocket) tests with real server processes and real WS clients.
// With REDIS_URL set, also proves rooms span two server instances.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import WebSocket from 'ws';
import {freePort} from './helpers.mjs';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RUN = 'rooms' + Date.now() + Math.random().toString(36).slice(2, 8);
const procs = [];

async function start(dir, extra = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {env: {...process.env, PORT: String(port), CUSTOMER_DB_FILE: join(dir, port + '.json'), LEADS_FILE: join(dir, 'l.jsonl'), NODE_ENV: 'test', RATE_LIMIT_PREFIX: RUN, ...extra}, stdio: ['ignore', 'ignore', 'pipe']});
  procs.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 300; i++) { try { if ((await fetch(origin + '/api/health')).ok) return {origin, port}; } catch {} await sleep(100); }
  throw Error('server did not start');
}

function connect(port, code, name, cookie) {
  return new Promise(resolve => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms?code=${code}&name=${encodeURIComponent(name)}`, cookie ? {headers: {Cookie: cookie}} : {});
    const c = {ws, events: [], close: null};
    ws.on('message', d => c.events.push(JSON.parse(d)));
    ws.on('close', (code, reason) => { c.close = {code, reason: String(reason)}; resolve(c); });
    ws.on('open', () => resolve(c));
    ws.on('error', () => {});
  });
}
const lastMembers = c => [...c.events].reverse().find(e => e.type === 'members')?.members || [];
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } return fn(); };

const dir = await mkdtemp(join(tmpdir(), 'usam-rooms-'));
try {
  // ---------- single instance, memory hub, open access ----------
  const s = await start(dir, {ACCESS_ENFORCEMENT: 'open', REDIS_URL: ''});
  const code = 'ROOM' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const a = await connect(s.port, code, 'Amal');
  const b = await connect(s.port, code, 'Bassem');
  ok(await until(() => lastMembers(a).length === 2), 'both members see a 2-person member list');
  a.ws.send(JSON.stringify({type: 'message', text: 'Hello from Amal'}));
  ok(await until(() => b.events.some(e => e.type === 'message' && e.text === 'Hello from Amal' && e.name === 'Amal')), 'message fans out to the other member');
  b.ws.send(JSON.stringify({type: 'message', text: 'can you give me a hint?'}));
  ok(await until(() => a.events.some(e => e.type === 'coach')), 'coach hint triggers on "hint" with 2+ members');
  const c3 = await connect(s.port, code, 'C'), c4 = await connect(s.port, code, 'D');
  const c5 = await connect(s.port, code, 'E');
  await until(() => c5.close);
  ok(c5.close?.code === 1008 && /full/i.test(c5.close.reason), 'fifth participant is rejected (room cap 4)');
  const bad = await connect(s.port, 'AB', 'X');
  await until(() => bad.close);
  ok(bad.close?.code === 1008 && /invalid/i.test(bad.close.reason), 'room code shorter than 4 chars is rejected');
  // flood from a connection that has not sent anything yet: 30 quickly -> exactly 20 delivered, sender notified
  for (let i = 0; i < 30; i++) c3.ws.send(JSON.stringify({type: 'message', text: 'flood ' + i}));
  await sleep(800);
  const got = b.events.filter(e => e.type === 'message' && e.text.startsWith('flood')).length;
  ok(got === 20, `per-connection flood limit: 30 sent, ${got} delivered (expected 20 per 10s)`);
  ok(c3.events.some(e => e.type === 'notice'), 'flooding sender receives a slow-down notice');
  c3.ws.close(); c4.ws.close();
  ok(await until(() => lastMembers(a).length === 2), 'member list shrinks when participants leave');
  a.ws.close(); b.ws.close();

  // ---------- entitlement enforcement on the socket ----------
  const e = await start(dir, {REDIS_URL: ''}); // default = enforced
  const anon = await connect(e.port, 'SECURE1', 'Anon');
  await until(() => anon.close);
  ok(anon.close?.code === 1008 && /subscription/i.test(anon.close.reason), 'enforced deployment rejects anonymous socket (1008 Subscription required)');

  // ---------- account name wins over a spoofed query name ----------
  const n = await start(dir, {ACCESS_ENFORCEMENT: 'open', REDIS_URL: ''});
  const reg = await fetch(n.origin + '/api/customer/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Mona Real', email: `mona-${Date.now()}@example.com`, phone: '01000000000', password: 'correct-horse-battery'})});
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  const room = 'NAME' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const m = await connect(n.port, room, 'Admin<script>', cookie);
  ok(await until(() => lastMembers(m).includes('Mona')) && !lastMembers(m).some(x => /Admin|script/.test(x)), 'logged-in member is shown by account name, spoofed query name ignored');
  m.ws.close();

  // ---------- two instances sharing Redis ----------
  if (process.env.REDIS_URL) {
    const i1 = await start(dir, {ACCESS_ENFORCEMENT: 'open'});
    const i2 = await start(dir, {ACCESS_ENFORCEMENT: 'open'});
    const shared = 'MULT' + Math.random().toString(36).slice(2, 6).toUpperCase();
    const x = await connect(i1.port, shared, 'OnOne');
    const y = await connect(i2.port, shared, 'OnTwo');
    ok(await until(() => lastMembers(x).length === 2 && lastMembers(y).length === 2), 'members on different instances see each other (2-person list on both)');
    x.ws.send(JSON.stringify({type: 'message', text: 'cross-instance hello'}));
    ok(await until(() => y.events.some(ev => ev.type === 'message' && ev.text === 'cross-instance hello')), 'message from instance 1 reaches a member on instance 2');
    const z = await connect(i1.port, shared, 'Third'), w = await connect(i2.port, shared, 'Fourth');
    const overflow = await connect(i2.port, shared, 'Fifth');
    await until(() => overflow.close);
    ok(overflow.close?.code === 1008 && /full/i.test(overflow.close.reason), 'room cap of 4 holds across instances (5th rejected)');
    for (const c of [x, y, z, w]) c.ws.close();
  } else console.log('REDIS_URL not set — skipping multi-instance room test.');
} finally {
  for (const p of procs) try { p.kill(); } catch {}
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nRoom tests FAILED (${failures}).`); process.exit(1); }
console.log('\nRoom tests passed.');
process.exit(0);
