// Password hashing shared by learner accounts, admin accounts and CLI scripts.
// scrypt N=2^17, r=8, p=1, 64-byte key, 16-byte random salt. Stored as "salt:hash" (hex).
import {randomBytes, timingSafeEqual, scrypt as scryptCb} from 'node:crypto';
import {promisify} from 'node:util';

const scrypt = promisify(scryptCb);
const PARAMS = {N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024};

export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, Buffer.from(salt, 'hex'), 64, PARAMS);
  return `${salt}:${derived.toString('hex')}`;
}

export async function checkPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const derived = await scrypt(String(password), Buffer.from(salt, 'hex'), 64, PARAMS);
  const a = Buffer.from(derived.toString('hex')), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A real hash of a random password, used to spend the same scrypt time when an account does not exist
// (prevents account enumeration through response timing).
let dummy;
export async function dummyCheck(password) {
  dummy ??= await passwordHash(randomBytes(16).toString('hex'));
  await checkPassword(password, dummy);
  return false;
}

export const PASSWORD_MIN = 12, PASSWORD_MAX = 128;
export const validPassword = p => typeof p === 'string' && p.length >= PASSWORD_MIN && p.length <= PASSWORD_MAX;
