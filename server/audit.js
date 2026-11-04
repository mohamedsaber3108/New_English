// Tamper-evident, append-only audit log.
//
// Each entry carries seq, prevHash, kid and hash = HMAC-SHA256(key[kid], canonical(entry without hash)).
// Entries form a chain: editing, deleting or reordering any entry breaks verification from that point on.
//
// Keys
//  - AUDIT_HMAC_KEY signs new entries. It lives in the environment, NOT in the database, so someone who can
//    write to the database but does not hold the key cannot forge a consistent chain.
//  - Every entry records `kid` (a fingerprint of the signing key, covered by the hash). Verification looks the
//    key up in a keyring: AUDIT_HMAC_KEY plus AUDIT_HMAC_PREVIOUS_KEYS (comma-separated) so keys can be
//    rotated without invalidating history. Entries signed by a key that is not in the keyring fail.
//  - Without a key, entries are hashed with plain SHA-256 (kid "none"): this still detects naive edits but not
//    a deliberate rewrite. Once any keyed entry exists, a later unkeyed entry is rejected as a downgrade.
//
// Retention: the hot log keeps AUDIT_MAX_ENTRIES entries in the primary store. When older entries are trimmed,
// the last trimmed hash is kept as an anchor so the remaining tail still verifies. Archiving trimmed entries to
// cold storage is a documented follow-up.
//
// Privacy: entries reference actors/targets by opaque ids only (no email/name/phone), so erasing an account
// does not require rewriting the chain.
import {createHash, createHmac, randomUUID} from 'node:crypto';

const GENESIS = 'GENESIS';
const maxEntries = () => Number(process.env.AUDIT_MAX_ENTRIES || 5000);
const kidOf = key => key ? createHash('sha256').update('usam-audit-kid:' + key).digest('hex').slice(0, 12) : 'none';

function keyring() {
  const keys = [process.env.AUDIT_HMAC_KEY, ...String(process.env.AUDIT_HMAC_PREVIOUS_KEYS || '').split(',')].map(k => k?.trim()).filter(Boolean);
  return new Map(keys.map(k => [kidOf(k), k]));
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

function digest(entry, key) {
  const {hash, ...rest} = entry;
  const body = canonical(rest);
  return key ? createHmac('sha256', key).update(body).digest('hex') : createHash('sha256').update(body).digest('hex');
}

function chain(db) {
  db.auditChain ??= {seq: 0, head: GENESIS, anchorSeq: 0, anchorHash: GENESIS};
  return db.auditChain;
}

// Must be called inside storage.mutate(db => ...) so the append is atomic with the action it records.
export function appendAudit(db, {event, actor = null, target = null, meta = {}}) {
  db.auditLog ??= [];
  const c = chain(db);
  const key = process.env.AUDIT_HMAC_KEY || null;
  const entry = {seq: c.seq + 1, id: randomUUID(), at: new Date().toISOString(), event: String(event), actor, target, meta, kid: kidOf(key), prevHash: c.head};
  entry.hash = digest(entry, key);
  db.auditLog.push(entry);
  c.seq = entry.seq;
  c.head = entry.hash;
  const max = maxEntries();
  if (db.auditLog.length > max) {
    const removed = db.auditLog.splice(0, db.auditLog.length - max);
    const lastChained = [...removed].reverse().find(x => x.hash);
    if (lastChained) { c.anchorSeq = lastChained.seq; c.anchorHash = lastChained.hash; }
  }
  return entry;
}

// Recomputes the whole chain.
// Returns {ok, checked, legacy, keyed, keyedEntries, unkeyedEntries, head?, seq?, brokenAt?, reason?}.
export function verifyAudit(db) {
  const c = db.auditChain || {seq: 0, head: GENESIS, anchorSeq: 0, anchorHash: GENESIS};
  const ring = keyring();
  const chained = (db.auditLog || []).filter(x => x.hash);
  const legacy = (db.auditLog || []).length - chained.length;
  let prev = c.anchorHash, expectSeq = c.anchorSeq + 1, keyedEntries = 0, unkeyedEntries = 0;
  const result = extra => ({checked: chained.length, legacy, keyed: !!process.env.AUDIT_HMAC_KEY, keyedEntries, unkeyedEntries, ...extra});
  for (const e of chained) {
    if (e.seq !== expectSeq) return result({ok: false, brokenAt: e.seq, reason: `sequence gap: expected ${expectSeq}, found ${e.seq}`});
    if (e.prevHash !== prev) return result({ok: false, brokenAt: e.seq, reason: 'previous-hash link broken'});
    let key = null;
    if (e.kid === 'none') {
      if (keyedEntries > 0) return result({ok: false, brokenAt: e.seq, reason: 'downgrade: unkeyed entry after keyed entries'});
      unkeyedEntries++;
    } else {
      key = ring.get(e.kid);
      if (!key) return result({ok: false, brokenAt: e.seq, reason: `unknown key id ${e.kid ?? '(missing)'}: add the signing key to AUDIT_HMAC_PREVIOUS_KEYS`});
      keyedEntries++;
    }
    if (digest(e, key) !== e.hash) return result({ok: false, brokenAt: e.seq, reason: 'entry content does not match its hash'});
    prev = e.hash; expectSeq++;
  }
  if (prev !== c.head || expectSeq - 1 !== c.seq) return result({ok: false, brokenAt: expectSeq, reason: 'chain head mismatch (entries removed from the end)'});
  return result({ok: true, head: c.head, seq: c.seq});
}
