// AI usage metering and per-plan caps (E-8) against a FAKE OpenAI-compatible provider (no real key, no real spend).
// Covers: usage numbers per learner and day, Prometheus counters, per-plan cap, 429 message with the Cairo reset time (Arabic
// and English), admin route, and that no message text is stored (table columns + API output).
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {freePort, stopServer} from './helpers.mjs';
import {estimateCostMicro, dailyCap, capNotice} from '../server/aiusage.js';
import {msUntilCairoMidnight} from '../server/learning.js';
import {createDb} from '../server/db/index.js';
import * as repo from '../server/db/repo.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = () => randomBytes(32).toString('hex'); // generated per run, never a literal (secret scan)
const noRetry = {recursive: true, force: true, maxRetries: 5, retryDelay: 200};

// ---------------------------------------------------------------- pure helpers
console.log('-- helpers');
ok(estimateCostMicro(120, 30, {}) === 0 && estimateCostMicro(1000, 1000, {AI_PRICE_IN_PER_1K_MICRO: 'x'}) === 0, 'without prices the cost estimate is 0 (nothing is invented)');
ok(estimateCostMicro(120, 30, {AI_PRICE_IN_PER_1K_MICRO: '150000', AI_PRICE_OUT_PER_1K_MICRO: '600000'}) === 36000, 'cost = tokens x price per 1K (120 in, 30 out -> 36,000 micro-USD)');
ok(dailyCap('plus', {}) === 150 && dailyCap('essential', {}) === 150, 'default cap is the old single value, 150');
ok(dailyCap('plus', {AI_DAILY_REQUESTS_PER_USER: '40'}) === 40 && dailyCap('essential', {AI_DAILY_REQUESTS_PER_USER: '40'}) === 40, 'AI_DAILY_REQUESTS_PER_USER is the fallback for both plans');
ok(dailyCap('plus', {AI_DAILY_CAP_PLUS: '90', AI_DAILY_CAP_ESSENTIAL: '30'}) === 90 && dailyCap('essential', {AI_DAILY_CAP_PLUS: '90', AI_DAILY_CAP_ESSENTIAL: '30'}) === 30, 'the cap is set per plan');
ok(dailyCap('plus', {AI_DAILY_CAP_PLUS: '-5', AI_DAILY_REQUESTS_PER_USER: '40'}) === 40 && dailyCap('essential', {AI_DAILY_CAP_ESSENTIAL: 'abc'}) === 150, 'a bad per-plan value falls back instead of disabling the cap');
const left = msUntilCairoMidnight();
ok(left >= 1000 && left <= 86400000 + 1000, `time to Cairo midnight is within a day (${Math.round(left / 60000)} min)`);
const n = capNotice(5 * 3600000 + 20 * 60000, Date.parse('2026-11-27T10:00:00Z'));
ok(/midnight Cairo time/.test(n.error) && /5 h 20 min/.test(n.error) && /limit/.test(n.error), 'the English cap message says Cairo midnight and how long is left');
ok(/[\u0600-\u06FF]/.test(n.errorAr) && /منتصف الليل بتوقيت القاهرة/.test(n.errorAr) && /5 ساعة و20 دقيقة/.test(n.errorAr), 'the Arabic cap message says Cairo midnight and how long is left');
ok(n.resetsAt === '2026-11-27T15:20:00.000Z' && n.resetsInMinutes === 320, 'the message carries the reset time as an ISO timestamp');

// ---------------------------------------------------------------- table: columns, one row per learner/day/route, down script
console.log('-- ai_usage table');
{
  const db = await createDb({databaseUrl: '', dataDir: 'memory://'});
  ok(db.applied.includes('004_ai_usage.sql'), 'migration 004 is applied');
  const cols = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_usage' ORDER BY ordinal_position")).rows.map(r => r.column_name);
  ok(JSON.stringify(cols) === JSON.stringify(['user_id', 'day', 'route', 'calls', 'tokens_in', 'tokens_out', 'est_cost_micro_usd']), `ai_usage has only numbers and ids, no text column (${cols.join(', ')})`);
  await db.tx(q => repo.users.create(q, {id: 'u-usage', email: 'usage@example.com', name: 'Usage Tester', password: 'x'}));
  await db.tx(q => repo.aiUsage.add(q, {userId: 'u-usage', day: '2026-11-27', route: 'coach', tokensIn: 100, tokensOut: 20, costMicro: 5}));
  await db.tx(q => repo.aiUsage.add(q, {userId: 'u-usage', day: '2026-11-27', route: 'coach', tokensIn: 50, tokensOut: 10, costMicro: 2}));
  const rows = (await db.query('SELECT * FROM ai_usage')).rows;
  ok(rows.length === 1 && Number(rows[0].calls) === 2 && Number(rows[0].tokens_in) === 150 && Number(rows[0].est_cost_micro_usd) === 7, 'one row per learner, day and route; calls, tokens and cost add up');
  await db.tx(q => repo.users.remove(q, 'u-usage'));
  ok((await db.query('SELECT 1 FROM ai_usage')).rows.length === 0, 'deleting the learner deletes their usage rows');
  await db.tx(async q => q.exec(await readFile(new URL('../server/db/migrations-down/004_ai_usage.down.sql', import.meta.url), 'utf8')));
  ok((await db.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'ai_usage'")).rows.length === 0 && (await db.query("SELECT 1 FROM schema_migrations WHERE name = '004_ai_usage.sql'")).rows.length === 0, 'the down script removes the table and the migration record');
  await db.close();
}

// ---------------------------------------------------------------- live server with a fake provider
console.log('-- server, caps and metering');
const MARK = 'zebra-marker-7781';
const fake = {calls: 0};
const provider = createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    fake.calls++;
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: 'Fake tutor reply.'}}], usage: {prompt_tokens: 120, completion_tokens: 30}}));
  });
});
await new Promise(r => provider.listen(0, '127.0.0.1', r));
const dir = await mkdtemp(join(tmpdir(), 'usam-aiu-'));
const port = await freePort(), o = `http://127.0.0.1:${port}`;
const PW = rnd(), METRICS = rnd(), RUN = 'aiu' + Date.now();
const env = {...process.env, NODE_ENV: 'test', PORT: String(port), DATABASE_URL: '', REDIS_URL: '', CUSTOMER_DB_FILE: join(dir, 'db.json'), LEADS_FILE: join(dir, 'l.jsonl'), RATE_LIMIT_PREFIX: RUN, AUTH_IP_LIMIT: '1000', AUDIT_HMAC_KEY: rnd(),
  ACCESS_ENFORCEMENT: 'enforced', OPENAI_API_KEY: rnd(), OPENAI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, AI_TIMEOUT_MS: '2000',
  AI_DAILY_CAP_ESSENTIAL: '2', AI_DAILY_CAP_PLUS: '4', AI_PRICE_IN_PER_1K_MICRO: '150000', AI_PRICE_OUT_PER_1K_MICRO: '600000', METRICS_TOKEN: METRICS};
let child;
const call = async (path, {method = 'GET', body, cookie, headers = {}} = {}) => { const r = await fetch(o + path, {method, headers: {...(body ? {'Content-Type': 'application/json'} : {}), ...(cookie ? {Cookie: cookie} : {}), ...headers}, body: body ? JSON.stringify(body) : undefined}); const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch {} return {status: r.status, data, text, headers: r.headers, cookie: (r.headers.get('set-cookie') || '').split(';')[0]}; };
try {
  const ownerEmail = `owner-${RUN}@example.com`;
  const code = await new Promise(r => { const p = spawn(process.execPath, ['scripts/create-admin.mjs', '--email', ownerEmail, '--name', 'Owner', '--role', 'owner'], {env: {...env, ADMIN_PASSWORD: PW}, stdio: 'ignore'}); p.on('exit', r); });
  ok(code === 0, 'owner account created');
  child = spawn(process.execPath, ['server/index.js'], {env, stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
  for (let i = 0; i < 300; i++) { try { if ((await fetch(o + '/api/health')).ok) break; } catch {} await sleep(100); }
  const owner = (await call('/api/admin/auth/login', {method: 'POST', body: {email: ownerEmail, password: PW}})).cookie;
  const learner = async (tag, plan) => {
    const r = await call('/api/customer/register', {method: 'POST', body: {name: `Learner ${tag}`, email: `${tag}-${RUN}@example.com`, phone: '01000000000', password: PW}});
    const g = await call(`/api/admin/users/${r.data.user.id}/entitlements`, {method: 'POST', cookie: owner, body: {plan, days: 30, reason: 'test grant'}});
    return {id: r.data.user.id, cookie: r.cookie, granted: g.status};
  };
  const ess = await learner('ess', 'essential'), plus = await learner('plus', 'plus');
  ok(ess.granted < 300 && plus.granted < 300, 'an Essential and a Plus learner exist');

  // Essential: cap 2 per Cairo day (simulation is the live-AI feature an Essential learner can use)
  const sim = i => call('/api/simulation', {method: 'POST', cookie: ess.cookie, body: {scenario: {id: 'cafe'}, turns: [{role: 'coach', text: 'Hi'}], text: `${MARK} coffee ${i}`}});
  const s = [await sim(1), await sim(2), await sim(3)];
  ok(s[0].data.mode === 'live' && s[1].data.mode === 'live', 'Essential: the first 2 live calls are served (cap 2)');
  ok(s[2].data.mode === 'guided' && /midnight Cairo time/.test(s[2].data.notice) && /[\u0600-\u06FF]/.test(s[2].data.noticeAr) && Date.parse(s[2].data.resetsAt) > Date.now(), 'Essential: the 3rd call continues in guided mode with a notice (English + Arabic) saying when the cap resets');
  ok(fake.calls === 2, 'Essential: the capped call never reached the provider');

  // Plus: cap 4 per Cairo day (coach)
  const coach = i => call('/api/coach', {method: 'POST', cookie: plus.cookie, body: {messages: [{role: 'user', content: `${MARK} question ${i}`}]}});
  const c = []; for (let i = 1; i <= 5; i++) c.push(await coach(i));
  ok(c.slice(0, 4).every(x => x.status === 200), 'Plus: 4 coach calls are served (cap 4, different from Essential)');
  ok(c[4].status === 429 && /midnight Cairo time/.test(c[4].data.error) && /limit/.test(c[4].data.error), 'Plus: the 5th coach call gets 429 with an English message naming Cairo midnight');
  ok(/[\u0600-\u06FF]/.test(c[4].data.errorAr) && /منتصف الليل بتوقيت القاهرة/.test(c[4].data.errorAr), 'the 429 also carries the Arabic message');
  const reset = Date.parse(c[4].data.resetsAt), inMin = (reset - Date.now()) / 60000;
  ok(reset > Date.now() && inMin <= 24 * 60 + 1 && c[4].data.resetsInMinutes >= 1 && Number(c[4].headers.get('retry-after')) > 0, `the 429 carries the reset time (in ${Math.round(inMin)} min) and a Retry-After header`);
  ok(fake.calls === 6, 'the provider saw exactly the 6 served calls (2 simulation + 4 coach)');

  // admin route: per-day totals and top learners, ids only
  const u = await call('/api/admin/ai-usage', {cookie: owner});
  const day = u.data.days?.[0];
  ok(u.status === 200 && u.data.days.length === 1 && day.calls === 6 && day.tokensIn === 720 && day.tokensOut === 180 && day.costMicroUsd === 216000 && day.learners === 2, 'admin: per-day totals (6 calls, 720 in, 180 out, 216,000 micro-USD, 2 learners)');
  ok(u.data.total.calls === 6 && u.data.priceConfigured === true, 'admin: total and "price configured" flag');
  const top = u.data.topLearners;
  ok(top.length === 2 && top[0].userId === plus.id && top[0].calls === 4 && top[0].costMicroUsd === 144000 && top[1].userId === ess.id && top[1].costMicroUsd === 72000, 'admin: top learners are ordered by cost and identified by id only');
  ok(top.every(t => JSON.stringify(Object.keys(t).sort()) === JSON.stringify(['calls', 'costMicroUsd', 'tokensIn', 'tokensOut', 'userId'])), 'admin: a top-learner entry holds only the id and four numbers');
  ok(!u.text.includes(MARK) && !u.text.includes('@example.com'), 'admin: the response has no message text and no email');
  ok((await call('/api/admin/ai-usage')).status === 401 && (await call('/api/admin/ai-usage', {cookie: ess.cookie})).status === 401, 'admin: no admin session -> 401 (a learner session is not enough)');

  // Prometheus counters
  const m = (await call('/api/metrics', {headers: {Authorization: 'Bearer ' + METRICS}})).text;
  const val = re => Number((m.match(re) || [])[1]);
  ok(val(/ai_calls_total\{feature="coach"\} (\d+)/) === 4 && val(/ai_calls_total\{feature="simulation"\} (\d+)/) === 2, 'metrics: ai_calls_total per feature');
  ok(val(/ai_tokens_total\{direction="in",feature="coach"\} (\d+)/) === 480 && val(/ai_tokens_total\{direction="out",feature="coach"\} (\d+)/) === 120, 'metrics: ai_tokens_total per feature and direction');
  ok(val(/ai_cost_micro_usd_total\{feature="coach"\} (\d+)/) === 144000 && val(/ai_cost_micro_usd_total\{feature="simulation"\} (\d+)/) === 72000, 'metrics: ai_cost_micro_usd_total per feature');
  ok(!m.includes(MARK), 'metrics: no message text');
} catch (e) { console.error('  FAIL: unexpected error', e); failures++; }
finally {
  if (child) await stopServer(child);
  provider.close();
  await rm(dir, noRetry);
}
if (failures) { console.error(`\nAI usage tests FAILED (${failures}).`); process.exit(1); }
console.log('\nAI usage tests passed.');
process.exit(0);
