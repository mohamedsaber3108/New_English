// Unit tests for the tamper-evident audit chain.
import {appendAudit, verifyAudit} from '../server/audit.js';

let failures = 0;
const ok = (c, m) => { if (c) console.log('  PASS:', m); else { console.error('  FAIL:', m); failures++; } };
const fresh = () => ({auditLog: []});
const clone = o => JSON.parse(JSON.stringify(o));

process.env.AUDIT_HMAC_KEY = 'unit-test-key-0123456789abcdef';
{
  const db = fresh();
  for (let i = 0; i < 5; i++) appendAudit(db, {event: 'test_event', actor: {type: 'admin', id: 'a1'}, meta: {i}});
  const v = verifyAudit(db);
  ok(v.ok && v.checked === 5 && v.keyed, 'clean 5-entry keyed chain verifies');
  ok(db.auditLog[1].prevHash === db.auditLog[0].hash, 'each entry links to the previous hash');

  let t = clone(db); t.auditLog[2].meta.i = 999;
  ok(!verifyAudit(t).ok && verifyAudit(t).brokenAt === 3, 'editing entry content is detected at that entry');
  t = clone(db); t.auditLog.splice(1, 1);
  ok(!verifyAudit(t).ok, 'deleting an entry from the middle is detected');
  t = clone(db); t.auditLog.pop();
  ok(!verifyAudit(t).ok && /head/.test(verifyAudit(t).reason), 'deleting the newest entry is detected (head mismatch)');
  t = clone(db); [t.auditLog[0], t.auditLog[1]] = [t.auditLog[1], t.auditLog[0]];
  ok(!verifyAudit(t).ok, 'reordering entries is detected');

  // Forgery without the key: an attacker with DB write access rebuilds a self-consistent chain using a
  // guessed key. It must not verify under the real key.
  process.env.AUDIT_HMAC_KEY = 'attacker-guess';
  const rebuilt = {auditLog: []};
  for (const e of db.auditLog) appendAudit(rebuilt, {event: e.event, actor: e.actor, meta: e.meta});
  process.env.AUDIT_HMAC_KEY = 'unit-test-key-0123456789abcdef';
  ok(!verifyAudit(rebuilt).ok, 'a chain rebuilt without the secret key does not verify');
}
{
  process.env.AUDIT_MAX_ENTRIES = '10';
  const db = fresh();
  for (let i = 0; i < 25; i++) appendAudit(db, {event: 'e', meta: {i}});
  ok(db.auditLog.length === 10, 'hot log is trimmed to AUDIT_MAX_ENTRIES');
  ok(verifyAudit(db).ok, 'trimmed log still verifies from its anchor');
  ok(db.auditChain.anchorSeq === 15, 'anchor records the last trimmed sequence number');
  delete process.env.AUDIT_MAX_ENTRIES;
}
{
  const db = {auditLog: [{id: 'old', event: 'legacy_event', userId: 'u', at: 'x'}]};
  appendAudit(db, {event: 'new_event'});
  const v = verifyAudit(db);
  ok(v.ok && v.legacy === 1 && v.checked === 1, 'pre-existing unchained (legacy) entries are counted, not treated as tampering');
}
{
  // Key rotation: entries signed with the previous key still verify when it is listed in AUDIT_HMAC_PREVIOUS_KEYS.
  process.env.AUDIT_HMAC_KEY = 'old-key-aaaaaaaaaaaaaaaa';
  const db = fresh();
  appendAudit(db, {event: 'before_rotation'});
  process.env.AUDIT_HMAC_KEY = 'new-key-bbbbbbbbbbbbbbbb';
  appendAudit(db, {event: 'after_rotation'});
  ok(!verifyAudit(db).ok && /unknown key/.test(verifyAudit(db).reason), 'entries signed with a key not in the keyring fail verification');
  process.env.AUDIT_HMAC_PREVIOUS_KEYS = 'old-key-aaaaaaaaaaaaaaaa';
  ok(verifyAudit(db).ok, 'after rotation, old entries verify via AUDIT_HMAC_PREVIOUS_KEYS');
  ok(db.auditLog[0].kid !== db.auditLog[1].kid, 'each entry records the id of the key that signed it');
  const t = clone(db); t.auditLog[0].kid = t.auditLog[1].kid;
  ok(!verifyAudit(t).ok, 'swapping an entry\'s key id is detected (kid is covered by the hash)');
  delete process.env.AUDIT_HMAC_PREVIOUS_KEYS;
}
{
  // Enabling the key later: earlier unkeyed entries still verify; an unkeyed entry AFTER keyed ones is a downgrade.
  delete process.env.AUDIT_HMAC_KEY;
  const db = fresh();
  appendAudit(db, {event: 'unkeyed_early'});
  process.env.AUDIT_HMAC_KEY = 'later-key-cccccccccccccccc';
  appendAudit(db, {event: 'keyed_later'});
  const v = verifyAudit(db);
  ok(v.ok && v.unkeyedEntries === 1 && v.keyedEntries === 1, 'turning the key on later keeps the earlier unkeyed history verifiable');
  delete process.env.AUDIT_HMAC_KEY;
  appendAudit(db, {event: 'unkeyed_after_keyed'});
  process.env.AUDIT_HMAC_KEY = 'later-key-cccccccccccccccc';
  const d = verifyAudit(db);
  ok(!d.ok && /downgrade/.test(d.reason), 'an unkeyed entry after keyed entries is rejected as a downgrade');
}
if (failures) { console.error(`\nAudit tests FAILED (${failures}).`); process.exit(1); }
console.log('\nAudit tests passed.');
