// Production configuration check: findings per misconfiguration, and refusal to start on fatal ones.
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {checkConfig} from '../server/config.js';
import {freePort, stopServer} from './helpers.mjs';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const keys = env => checkConfig(env).map(f => f.key);
const K = 'k'.repeat(40);
const MFA_KEY = randomBytes(32).toString('hex'); // generated per run, never a literal (secret scan)
ok(checkConfig({NODE_ENV: 'production', SITE_ORIGIN: 'https://x.com', ADMIN_MFA_KEY: MFA_KEY}).find(f => f.key === 'ADMIN_REQUIRE_MFA')?.level === 'fatal', 'production without ADMIN_REQUIRE_MFA=true is a fatal finding');
ok(checkConfig({NODE_ENV: 'production', SITE_ORIGIN: 'https://x.com', ADMIN_REQUIRE_MFA: 'true'}).find(f => f.key === 'ADMIN_MFA_KEY')?.level === 'fatal', 'production without a 32+ character ADMIN_MFA_KEY is a fatal finding');
ok(!checkConfig({NODE_ENV: 'test'}).some(f => f.level === 'fatal'), 'the test and development environments have no fatal findings');
const good = {NODE_ENV: 'production', SITE_ORIGIN: 'https://language.example.com', DATABASE_URL: 'postgres://x', AUDIT_HMAC_KEY: K, ADMIN_MFA_KEY: K, ADMIN_REQUIRE_MFA: 'true', REQUIRE_VERIFIED_EMAIL: 'true', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.c'};
ok(checkConfig(good).length === 0, 'a complete production configuration has no findings');
ok(checkConfig({NODE_ENV: 'production', SITE_ORIGIN: 'http://x.com'}).find(f => f.key === 'SITE_ORIGIN')?.level === 'fatal', 'non-HTTPS SITE_ORIGIN in production is fatal');
const missing = keys({NODE_ENV: 'production', SITE_ORIGIN: 'https://x.com'});
ok(['DATABASE_URL', 'AUDIT_HMAC_KEY', 'ADMIN_MFA_KEY', 'ADMIN_REQUIRE_MFA'].every(k => missing.includes(k)), 'missing database, audit key, MFA key and MFA requirement are reported');
ok(keys({...good, RESEND_API_KEY: ''}).includes('RESEND_API_KEY'), 'required email verification without email delivery is reported (learners could not pay)');
ok(keys({...good, PAYMOB_SECRET_KEY: 'x'}).includes('PAYMOB'), 'partial Paymob configuration is reported');
ok(keys({...good, ACCESS_ENFORCEMENT: 'open'}).includes('ACCESS_ENFORCEMENT'), 'open access in production is reported');
ok(checkConfig({NODE_ENV: 'development'}).length === 0, 'development has no production findings');
ok(!JSON.stringify(checkConfig({...good, AUDIT_HMAC_KEY: 'short-secret-value'})).includes('short-secret-value'), 'findings never contain secret values');

// A production server with a fatal finding refuses to start; a valid one starts and reports warnings in the log.
const dir = await mkdtemp(join(tmpdir(), 'usam-cfg-'));
const run = env => new Promise(async resolve => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], {env: {...process.env, REDIS_URL: '', DATABASE_URL: '', CUSTOMER_DB_FILE: join(dir, port + '.json'), PORT: String(port), ...env}, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);
  let settled = false; // the graceful stop below also fires 'exit'; only an exit BEFORE the timer counts
  const t = setTimeout(async () => { settled = true; let up = false; try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {} await stopServer(child); resolve({code: 'running', up, out}); }, 9000);
  child.on('exit', code => { if (settled) return; clearTimeout(t); resolve({code, out}); });
});
try {
  const bad = await run({NODE_ENV: 'production', SITE_ORIGIN: 'http://insecure.example.com'});
  ok(bad.code === 1 && /refusing to start/.test(bad.out), 'production server with an http:// origin exits with code 1 before listening');
  // E-10: production without MFA enforcement / key is refused, with a clear message naming the setting.
  const noFlag = await run({NODE_ENV: 'production', SITE_ORIGIN: 'https://language.example.com', ADMIN_MFA_KEY: MFA_KEY, ADMIN_REQUIRE_MFA: ''});
  ok(typeof noFlag.code === 'number' && noFlag.code !== 0 && /refusing to start/.test(noFlag.out) && /ADMIN_REQUIRE_MFA=true is required in production/.test(noFlag.out), 'production without ADMIN_REQUIRE_MFA=true exits non-zero with a clear message');
  const noKey = await run({NODE_ENV: 'production', SITE_ORIGIN: 'https://language.example.com', ADMIN_REQUIRE_MFA: 'true', ADMIN_MFA_KEY: ''});
  ok(typeof noKey.code === 'number' && noKey.code !== 0 && /ADMIN_MFA_KEY must be at least 32 characters/.test(noKey.out), 'production with ADMIN_REQUIRE_MFA=true but no ADMIN_MFA_KEY exits non-zero with a clear message');
  const dev = await run({NODE_ENV: 'development', ADMIN_REQUIRE_MFA: '', ADMIN_MFA_KEY: ''});
  ok(dev.code === 'running' && dev.up, 'outside production the MFA settings are not required (development still starts)');
  const warn = await run({NODE_ENV: 'production', SITE_ORIGIN: 'https://language.example.com', ADMIN_MFA_KEY: MFA_KEY, ADMIN_REQUIRE_MFA: 'true'});
  ok(warn.code === 'running' && warn.up && /"msg":"configuration".*AUDIT_HMAC_KEY/.test(warn.out), 'a production server with only warnings starts, serves, and logs each warning');
  if (!(warn.code === 'running' && warn.up)) console.error('    detail: code=' + warn.code + ' up=' + warn.up + ' out=' + warn.out.slice(-600));
} finally { await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); }
if (failures) { console.error(`\nConfig tests FAILED (${failures}).`); process.exit(1); }
console.log('\nConfig tests passed.');
process.exit(0);
