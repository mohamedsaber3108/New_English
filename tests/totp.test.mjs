// TOTP unit tests against the RFC 6238 Appendix B test vectors (SHA-1 key "12345678901234567890").
import {totpAt, verifyTotp, base32Encode, base32Decode, newSecret, otpauthUri, sealSecret, openSecret} from '../server/totp.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const key = Buffer.from('12345678901234567890');
const secret = base32Encode(key);

// RFC 6238 Appendix B (8-digit values); the 6-digit code is the last 6 digits.
for (const [t, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
  ok(totpAt(secret, t * 1000, {digits: 8}) === expected, `RFC 6238 vector t=${t} -> ${expected}`);
  ok(totpAt(secret, t * 1000) === expected.slice(-6), `6-digit code at t=${t} -> ${expected.slice(-6)}`);
}
ok(base32Decode(base32Encode(Buffer.from('hello world!'))).toString() === 'hello world!', 'base32 round-trips');
ok(base32Decode('gezd gnbv-gy3t qojq'.toUpperCase().replace(/[\s-]/g, '')).toString() === '1234567890', 'base32 decode tolerates spaces/hyphens/lowercase after normalisation');

const s = newSecret();
ok(base32Decode(s).length === 20 && /^[A-Z2-7]+$/.test(s), 'newSecret is 160-bit base32');
const now = 1_800_000_000_000;
const code = totpAt(s, now);
let r = verifyTotp(s, code, {now});
ok(r.ok && typeof r.step === 'number', 'current code verifies');
ok(verifyTotp(s, totpAt(s, now - 30000), {now}).ok, 'previous 30s step accepted (clock drift window)');
ok(verifyTotp(s, totpAt(s, now + 30000), {now}).ok, 'next 30s step accepted (clock drift window)');
ok(!verifyTotp(s, totpAt(s, now - 90000), {now}).ok, 'code 3 steps old is rejected');
ok(!verifyTotp(s, code, {now, lastStep: r.step}).ok, 'the same code cannot be used twice (replay)');
ok(!verifyTotp(s, '12345', {now}).ok && !verifyTotp(s, 'abcdef', {now}).ok, 'malformed codes are rejected');
ok(verifyTotp(s, code.slice(0, 3) + ' ' + code.slice(3), {now}).ok, 'a code typed with a space still verifies');

const uri = otpauthUri({secret: s, account: 'owner@example.com', issuer: 'USAM Language'});
ok(uri.startsWith('otpauth://totp/USAM%20Language:owner%40example.com?') && uri.includes('secret=' + s) && uri.includes('issuer=USAM%20Language'), 'otpauth URI is well-formed');

const k = 'mfa-test-key-0123456789';
const sealed = sealSecret(s, k);
ok(!sealed.includes(s), 'sealed secret does not contain the plaintext');
ok(openSecret(sealed, k) === s, 'sealed secret opens with the right key');
let threw = false; try { openSecret(sealed, 'wrong-key-zzzzzzzzzzzz'); } catch { threw = true; }
ok(threw, 'opening with the wrong key fails (AES-GCM authentication)');
threw = false; try { const t = sealed.split('.'); t[2] = t[2].slice(0, -2) + (t[2].slice(-2) === 'AA' ? 'BB' : 'AA'); openSecret(t.join('.'), k); } catch { threw = true; }
ok(threw, 'a tampered ciphertext is rejected');

if (failures) { console.error(`\nTOTP tests FAILED (${failures}).`); process.exit(1); }
console.log('\nTOTP tests passed.');
