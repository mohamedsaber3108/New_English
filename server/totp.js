// Time-based one-time passwords (RFC 6238 / RFC 4226) for administrator MFA. No dependencies.
// Compatible with standard authenticator apps (SHA-1, 30-second step, 6 digits).
// TOTP secrets are stored encrypted with AES-256-GCM under ADMIN_MFA_KEY (sealSecret/openSecret).
import {createHmac, randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual} from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_MS = 30000;

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw Error('invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = () => base32Encode(randomBytes(20)); // 160-bit, as recommended by RFC 4226

function hotp(key, counter, digits) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export function totpAt(secret, timeMs = Date.now(), {digits = 6} = {}) {
  return hotp(base32Decode(secret), Math.floor(timeMs / STEP_MS), digits);
}

// Verifies a code within ±window steps. Rejects any step <= lastStep (replay protection).
// Returns {ok, step}. `step` must be persisted as the admin's last used step.
export function verifyTotp(secret, code, {now = Date.now(), window = 1, lastStep = -1} = {}) {
  const c = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return {ok: false};
  const key = base32Decode(secret), current = Math.floor(now / STEP_MS);
  for (let d = -window; d <= window; d++) {
    const step = current + d;
    if (step <= lastStep) continue;
    const a = Buffer.from(hotp(key, step, 6)), b = Buffer.from(c);
    if (timingSafeEqual(a, b)) return {ok: true, step};
  }
  return {ok: false};
}

export function otpauthUri({secret, account, issuer = 'USAM Language'}) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// AES-256-GCM sealing of the TOTP secret. Format: v1.<iv b64url>.<ciphertext+tag b64url>
const keyOf = k => createHash('sha256').update('usam-admin-mfa:' + k).digest();
export function sealSecret(secret, k) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', keyOf(k), iv);
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}`;
}
export function openSecret(sealed, k) {
  const [v, ivs, data] = String(sealed).split('.');
  if (v !== 'v1') throw Error('unknown sealed format');
  const buf = Buffer.from(data, 'base64url'), d = createDecipheriv('aes-256-gcm', keyOf(k), Buffer.from(ivs, 'base64url'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  return Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString('utf8');
}
