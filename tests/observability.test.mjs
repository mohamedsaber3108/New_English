// Observability: request ids, structured logs without secrets/PII, metrics access + content, API 404s, bad JSON.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {freePort, stopServer} from './helpers.mjs';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOKEN = 'metrics-token-0123456789abcdef';
const dir = await mkdtemp(join(tmpdir(), 'usam-obs-'));
const procs = [];
async function start(extra) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {env: {...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: '', REDIS_URL: '', CUSTOMER_DB_FILE: join(dir, port + '.json'), LEADS_FILE: join(dir, 'l.jsonl'), RATE_LIMIT_PREFIX: 'obs' + Date.now(), ...extra}, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  procs.push(child);
  const s = {child, origin: `http://127.0.0.1:${port}`, out: ''};
  child.stdout.on('data', d => s.out += d); child.stderr.on('data', d => s.out += d);
  for (let i = 0; i < 300; i++) { try { if ((await fetch(s.origin + '/api/health')).ok) return s; } catch {} if (child.exitCode !== null) break; await sleep(100); }
  throw Error('server did not start (exit ' + child.exitCode + '): ' + s.out.slice(-800));
}
try {
  const S = await start({METRICS_TOKEN: TOKEN, LOG_LEVEL: 'debug'});
  const r1 = await fetch(S.origin + '/api/customer/catalog?token=SECRET-QUERY-VALUE', {headers: {Cookie: 'usam_session=' + 'c'.repeat(64)}});
  ok(/^[0-9a-f-]{36}$/.test(r1.headers.get('x-request-id') || ''), 'every response carries a generated X-Request-Id');
  const r2 = await fetch(S.origin + '/api/customer/catalog', {headers: {'X-Request-Id': 'lb-trace-12345678'}});
  ok(r2.headers.get('x-request-id') === 'lb-trace-12345678', 'a valid incoming X-Request-Id (e.g. from the load balancer) is kept');
  const r3 = await fetch(S.origin + '/api/customer/catalog', {headers: {'X-Request-Id': 'bad id with spaces <script>'}});
  ok(r3.headers.get('x-request-id') !== 'bad id with spaces <script>', 'an invalid incoming request id is replaced, not echoed');
  await fetch(S.origin + '/api/customer/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: 'private.person@example.com', password: 'not-a-real-password-123'})});
  const nf = await fetch(S.origin + '/api/does-not-exist');
  ok(nf.status === 404 && (nf.headers.get('content-type') || '').includes('application/json'), 'unknown API path -> JSON 404 (not the HTML app with 200)');
  const bad = await fetch(S.origin + '/api/customer/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{"email": broken'});
  ok(bad.status === 400 && (await bad.json()).error === 'Invalid JSON body.', 'malformed JSON -> 400 JSON error');
  ok((await fetch(S.origin + '/')).status === 200, 'the frontend still serves at /');
  for (const f of ['/sw.js', '/sw-policy.js', '/offline.html', '/offline.js']) {
    const r = await fetch(S.origin + f);
    ok(r.status === 200 && r.headers.get('cache-control') === 'no-cache', `${f} is served with Cache-Control: no-cache (service worker updates are not delayed)`);
  }
  ok((await fetch(S.origin + '/manifest.webmanifest')).headers.get('cache-control') !== 'no-cache', 'other static files keep their normal cache lifetime');

  ok((await fetch(S.origin + '/api/metrics')).status === 401, 'metrics without a token -> 401');
  ok((await fetch(S.origin + '/api/metrics', {headers: {Authorization: 'Bearer wrong-token-wrong-token'}})).status === 401, 'metrics with a wrong token -> 401');
  const m = await fetch(S.origin + '/api/metrics', {headers: {Authorization: 'Bearer ' + TOKEN}});
  const text = await m.text();
  ok(m.status === 200 && (m.headers.get('content-type') || '').startsWith('text/plain'), 'metrics with the token -> Prometheus text');
  ok(/http_requests_total\{method="GET",route="\/api\/customer\/catalog",status="200"\} [3-9]/.test(text), 'request counter labelled by route template and status');
  ok(/http_requests_total\{method="POST",route="\/api\/customer\/login",status="401"\} 1/.test(text), 'failed logins are visible as 401s in metrics');
  ok(/http_requests_total\{method="GET",route="unmatched_api",status="404"\} 1/.test(text), 'unknown API paths are grouped (bounded label cardinality)');
  ok(/http_request_duration_seconds_bucket\{method="GET",route="\/api\/customer\/catalog",le="\+Inf"\} \d+/.test(text) && /http_request_duration_seconds_sum/.test(text), 'latency histogram exported');
  ok(/process_resident_memory_bytes \d+/.test(text) && /nodejs_eventloop_lag_p99_seconds [\d.]+/.test(text) && /websocket_clients 0/.test(text), 'process, event-loop and WebSocket gauges exported');
  ok(!text.includes('SECRET-QUERY-VALUE') && !text.includes('private.person'), 'metrics contain no query values or emails');

  await sleep(200);
  const lines = S.out.split('\n').filter(l => l.trim());
  const parsed = lines.map(l => { try { return JSON.parse(l); } catch { return null; } });
  ok(parsed.every(Boolean), `every log line is JSON (${lines.length} lines)`);
  const reqs = parsed.filter(p => p?.msg === 'request');
  ok(reqs.length >= 5 && reqs.every(p => p.requestId && p.route && p.status && typeof p.ms === 'number'), 'request log lines carry requestId, route, status and duration');
  ok(reqs.some(p => p.requestId === 'lb-trace-12345678'), 'the log line uses the same request id as the response header');
  ok(!S.out.includes('SECRET-QUERY-VALUE') && !S.out.includes('c'.repeat(64)) && !S.out.includes('private.person@example.com') && !S.out.includes('not-a-real-password'), 'logs contain no query strings, cookies, emails or passwords');
  await stopServer(S.child);

  const N = await start({METRICS_TOKEN: ''});
  ok((await fetch(N.origin + '/api/metrics')).status === 404, 'metrics endpoint is disabled (404) when METRICS_TOKEN is not set');
  await stopServer(N.child);
} catch (e) { console.error('  FAIL: unexpected error', e); failures++; }
finally {
  for (const p of procs) try { p.kill(); } catch {}
  await sleep(300);
  await rm(dir, {recursive: true, force: true});
}
if (failures) { console.error(`\nObservability tests FAILED (${failures}).`); process.exit(1); }
console.log('\nObservability tests passed.');
process.exit(0);
