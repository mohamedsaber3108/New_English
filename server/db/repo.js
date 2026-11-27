// Repository: every SQL statement the application runs, with row <-> object mapping.
// Each function takes `q` = a db or a transaction handle (anything with .query(sql, params)).
// Objects keep the shapes routes used with the old document store (camelCase, epoch-ms numbers for session and
// entitlement times, ISO strings for timestamps) so route logic is unchanged.
import {makeEntry, createVerifier} from '../audit.js';

const J = v => (v === undefined || v === null ? null : JSON.stringify(v)); // always pass jsonb as text: pg turns JS arrays into PG arrays
const iso = v => (v ? new Date(v).toISOString() : null);
const num = v => (v === null || v === undefined ? null : Number(v));
const like = s => '%' + String(s).replace(/[\\%_]/g, m => '\\' + m) + '%';
const page = (p = 1, size = 25) => { const pg = Math.max(1, parseInt(p, 10) || 1), ps = Math.min(100, Math.max(1, parseInt(size, 10) || 25)); return {page: pg, pageSize: ps, offset: (pg - 1) * ps}; };
const paged = (rows, total, {page: pg, pageSize}) => ({items: rows, total, page: pg, pageSize, pages: Math.max(1, Math.ceil(total / pageSize))});
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

// ---------------------------------------------------------------- users + entitlements
const USER_COLS = `u.id, u.email, u.name, u.phone, u.password, u.status, u.email_verified, u.preferences, u.profile, u.created_at, u.learning_imported,
  COALESCE((SELECT json_agg(json_build_object('language', e.language, 'plan', e.plan, 'expiresAt', e.expires_at, 'orderReference', e.order_reference,
    'source', e.source, 'grantedBy', e.granted_by, 'grantedAt', e.granted_at)) FROM entitlements e WHERE e.user_id = u.id), '[]'::json) AS ents`;
function toUser(r) {
  if (!r) return null;
  const ents = typeof r.ents === 'string' ? JSON.parse(r.ents) : (r.ents || []);
  const entitlements = {};
  for (const e of ents) { const {language, ...rest} = e; entitlements[language] = clean({...rest, expiresAt: num(rest.expiresAt), grantedAt: rest.grantedAt ? iso(rest.grantedAt) : null}); }
  return {id: r.id, email: r.email, name: r.name, phone: r.phone, password: r.password, status: r.status, emailVerified: !!r.email_verified,
    preferences: r.preferences || {product: true, learning: true, marketing: false}, profile: r.profile ?? null, createdAt: iso(r.created_at), learningImported: !!r.learning_imported, entitlements};
}
export const users = {
  async byId(q, id) { return toUser((await q.query(`SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [id])).rows[0]); },
  async byEmail(q, email) { return toUser((await q.query(`SELECT ${USER_COLS} FROM users u WHERE lower(u.email) = lower($1)`, [email])).rows[0]); },
  async lockById(q, id) { await q.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]); return users.byId(q, id); },
  async create(q, u) {
    await q.query(`INSERT INTO users (id, email, name, phone, password, status, email_verified, preferences, profile, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)`,
      [u.id, u.email, u.name, u.phone || '', u.password, u.status || 'active', !!u.emailVerified, J(u.preferences || {product: true, learning: true, marketing: false}), J(u.profile), u.createdAt || new Date().toISOString()]);
  },
  // patch keys: name, phone, password, status, emailVerified, preferences, profile
  async update(q, id, patch) {
    const map = {name: 'name', phone: 'phone', password: 'password', status: 'status', emailVerified: 'email_verified', preferences: 'preferences', profile: 'profile'};
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(map)) if (Object.hasOwn(patch, k)) {
      vals.push(['preferences', 'profile'].includes(k) ? J(patch[k]) : patch[k]);
      sets.push(`${col} = $${vals.length}${['preferences', 'profile'].includes(k) ? '::jsonb' : ''}`);
    }
    if (!sets.length) return false;
    vals.push(id);
    return (await q.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals)).rowCount > 0 || (await q.query('SELECT 1 FROM users WHERE id = $1', [id])).rows.length > 0;
  },
  async remove(q, id) { await q.query('DELETE FROM users WHERE id = $1', [id]); }, // cascades to sessions/orders/tickets/tokens/entitlements
  async list(q, {needle = '', status = '', verified = '', subscription = '', page: p, pageSize} = {}, now = Date.now()) {
    const pg = page(p, pageSize), where = [], vals = [];
    if (needle) { vals.push(like(needle)); where.push(`(u.name ILIKE $${vals.length} OR u.email ILIKE $${vals.length} OR u.phone ILIKE $${vals.length} OR u.id ILIKE $${vals.length})`); }
    if (status) { vals.push(status); where.push(`u.status = $${vals.length}`); }
    if (verified === 'true' || verified === 'false') { vals.push(verified === 'true'); where.push(`u.email_verified = $${vals.length}`); }
    if (subscription === 'active' || subscription === 'none') { vals.push(now); where.push(`${subscription === 'active' ? '' : 'NOT '}EXISTS (SELECT 1 FROM entitlements e WHERE e.user_id = u.id AND e.language = 'English' AND e.expires_at > $${vals.length})`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = Number((await q.query(`SELECT count(*) AS n FROM users u ${w}`, vals)).rows[0].n);
    const rows = (await q.query(`SELECT ${USER_COLS} FROM users u ${w} ORDER BY u.created_at DESC, u.id LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, vals)).rows.map(toUser);
    return paged(rows, total, pg);
  },
};
export const entitlements = {
  async set(q, userId, language, e) {
    await q.query(`INSERT INTO entitlements (user_id, language, plan, expires_at, order_reference, source, granted_by, granted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (user_id, language) DO UPDATE SET plan = EXCLUDED.plan, expires_at = EXCLUDED.expires_at, order_reference = EXCLUDED.order_reference,
      source = EXCLUDED.source, granted_by = EXCLUDED.granted_by, granted_at = EXCLUDED.granted_at`,
      [userId, language, e.plan, e.expiresAt, e.orderReference || null, e.source || null, e.grantedBy || null, e.grantedAt || null]);
  },
  async remove(q, userId, language) { return (await q.query('DELETE FROM entitlements WHERE user_id = $1 AND language = $2', [userId, language])).rowCount > 0; },
  // Removes the entitlement only if it was granted by this order (refund/void must not remove a newer purchase).
  async removeIfOrder(q, userId, language, orderReference) { return (await q.query('DELETE FROM entitlements WHERE user_id = $1 AND language = $2 AND order_reference = $3', [userId, language, orderReference])).rowCount > 0; },
};

// ---------------------------------------------------------------- learner sessions
const toSession = r => r && ({id: r.id, hash: r.hash, userId: r.user_id, createdAt: num(r.created_at), lastSeen: num(r.last_seen), device: r.device, expires: num(r.expires)});
export const sessions = {
  async create(q, s) { await q.query('INSERT INTO sessions (id, hash, user_id, created_at, last_seen, device, expires) VALUES ($1,$2,$3,$4,$5,$6,$7)', [s.id, s.hash, s.userId, s.createdAt, s.lastSeen, s.device, s.expires]); },
  async findValid(q, hash, now = Date.now()) { return toSession((await q.query('SELECT * FROM sessions WHERE hash = $1 AND expires > $2', [hash, now])).rows[0]); },
  async listForUser(q, userId, now = Date.now()) { return (await q.query('SELECT * FROM sessions WHERE user_id = $1 AND expires > $2 ORDER BY created_at DESC', [userId, now])).rows.map(toSession); },
  async countForUser(q, userId, now = Date.now()) { return Number((await q.query('SELECT count(*) AS n FROM sessions WHERE user_id = $1 AND expires > $2', [userId, now])).rows[0].n); },
  async removeByHash(q, hash) { await q.query('DELETE FROM sessions WHERE hash = $1', [hash]); },
  async removeById(q, userId, id) { await q.query('DELETE FROM sessions WHERE user_id = $1 AND id = $2', [userId, id]); },
  async removeForUser(q, userId, exceptHash = null) { return (await q.query('DELETE FROM sessions WHERE user_id = $1 AND ($2::text IS NULL OR hash <> $2)', [userId, exceptHash])).rowCount; },
  async purgeExpired(q, now = Date.now()) { await q.query('DELETE FROM sessions WHERE expires <= $1', [now]); },
};

// ---------------------------------------------------------------- orders
const ORDER_MAP = {userId: 'user_id', language: 'language', plan: 'plan', term: 'term', amount: 'amount', status: 'status', createdAt: 'created_at', paidAt: 'paid_at', expiresAt: 'expires_at',
  paymobOrderId: 'paymob_order_id', intentionId: 'intention_id', transactionId: 'transaction_id', manualPaymentReference: 'manual_payment_reference', activatedBy: 'activated_by', refundedAt: 'refunded_at', refundedBy: 'refunded_by', currency: 'currency'};
function toOrder(r) {
  if (!r) return null;
  const o = {reference: r.reference};
  for (const [k, col] of Object.entries(ORDER_MAP)) o[k] = r[col];
  o.amount = num(o.amount); o.expiresAt = num(o.expiresAt); o.createdAt = iso(o.createdAt); o.paidAt = iso(o.paidAt); o.refundedAt = iso(o.refundedAt);
  if (r.c_email !== undefined) o.customer = r.c_id ? {id: r.c_id, name: r.c_name, email: r.c_email} : null;
  return clean(o);
}
export const orders = {
  async create(q, o) { await q.query('INSERT INTO orders (reference, user_id, language, plan, term, amount, status, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [o.reference, o.userId, o.language, o.plan, o.term, o.amount, o.status, o.createdAt]); },
  async byRef(q, ref, {lock = false} = {}) { return toOrder((await q.query(`SELECT * FROM orders WHERE reference = $1${lock ? ' FOR UPDATE' : ''}`, [ref])).rows[0]); },
  async update(q, ref, patch) {
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(patch)) { if (!ORDER_MAP[k]) throw Error('unknown order field ' + k); vals.push(v); sets.push(`${ORDER_MAP[k]} = $${vals.length}`); }
    vals.push(ref);
    await q.query(`UPDATE orders SET ${sets.join(', ')} WHERE reference = $${vals.length}`, vals);
  },
  async listForUser(q, userId) { return (await q.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows.map(toOrder); },
  async byPaymob(q, paymobOrderId, {lock = false} = {}) { return toOrder((await q.query(`SELECT * FROM orders WHERE paymob_order_id = $1${lock ? ' FOR UPDATE' : ''}`, [paymobOrderId])).rows[0]); },
  async manualRefUsed(q, ref) { return (await q.query('SELECT 1 FROM orders WHERE manual_payment_reference = $1', [ref])).rows.length > 0; },
  async list(q, {needle = '', status = '', plan = '', page: p, pageSize} = {}) {
    const pg = page(p, pageSize), where = [], vals = [];
    if (needle) { vals.push(like(needle)); const n = `$${vals.length}`; where.push(`(o.reference ILIKE ${n} OR u.email ILIKE ${n} OR u.name ILIKE ${n} OR o.paymob_order_id ILIKE ${n} OR o.manual_payment_reference ILIKE ${n})`); }
    if (status) { vals.push(status); where.push(`o.status = $${vals.length}`); }
    if (plan) { vals.push(plan); where.push(`o.plan = $${vals.length}`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const from = 'FROM orders o LEFT JOIN users u ON u.id = o.user_id';
    const total = Number((await q.query(`SELECT count(*) AS n ${from} ${w}`, vals)).rows[0].n);
    const rows = (await q.query(`SELECT o.*, u.id AS c_id, u.name AS c_name, u.email AS c_email ${from} ${w} ORDER BY o.created_at DESC, o.reference LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, vals)).rows.map(toOrder);
    return paged(rows, total, pg);
  },
};

// ---------------------------------------------------------------- support tickets
const toTicket = r => r && clean({reference: r.reference, userId: r.user_id, category: r.category, subject: r.subject, message: r.message, status: r.status, resolution: r.resolution, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), updatedBy: r.updated_by,
  ...(r.c_email !== undefined ? {customer: r.c_id ? {id: r.c_id, name: r.c_name, email: r.c_email} : null} : {})});
// ---------------------------------------------------------------- payment events (E-6)
export const paymentEvents = {
  // Claims a provider event for processing, inside the caller's transaction. {replay: true} only when this event was
  // already APPLIED: any other earlier outcome (rejected, unmatched, ignored) is processed again. An existing row is
  // locked, so two concurrent deliveries of one event are processed one after the other. Call setOutcome afterwards.
  async claim(q, {provider, eventId, orderRef = null, rawBody, signatureVerified = true}) {
    const ins = await q.query("INSERT INTO payment_events (provider, event_id, order_ref, raw_body, signature_verified, outcome) VALUES ($1,$2,$3,$4,$5,'ignored') ON CONFLICT (provider, event_id) DO NOTHING RETURNING id", [provider, eventId, orderRef, rawBody, !!signatureVerified]);
    if (ins.rows.length) return {id: ins.rows[0].id, replay: false, previousOrderRef: null};
    const ex = (await q.query('SELECT id, outcome, order_ref FROM payment_events WHERE provider = $1 AND event_id = $2 FOR UPDATE', [provider, eventId])).rows[0];
    return {id: ex.id, replay: ex.outcome === 'applied', previousOrderRef: ex.order_ref};
  },
  async setOutcome(q, id, outcome, orderRef = null) { await q.query('UPDATE payment_events SET outcome = $2, order_ref = COALESCE($3, order_ref) WHERE id = $1', [id, outcome, orderRef]); },
  // Anomaly record written OUTSIDE a transaction that failed (the failed one rolled back its own claim).
  async markRejected(q, {provider, eventId, orderRef = null, rawBody}) {
    await q.query("INSERT INTO payment_events (provider, event_id, order_ref, raw_body, signature_verified, outcome) VALUES ($1,$2,$3,$4,true,'rejected') ON CONFLICT (provider, event_id) DO UPDATE SET outcome = 'rejected'", [provider, eventId, orderRef, rawBody]);
  },
  // Account deletion: remove the provider payloads (billing data) of every order of this learner.
  async removeForUser(q, userId) { await q.query('DELETE FROM payment_events WHERE order_ref IN (SELECT reference FROM orders WHERE user_id = $1)', [userId]); },
};

export const tickets = {
  async create(q, t) { await q.query('INSERT INTO support_tickets (reference, user_id, category, subject, message, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [t.reference, t.userId, t.category, t.subject, t.message, t.status, t.createdAt, t.updatedAt]); },
  async listForUser(q, userId) { return (await q.query('SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows.map(toTicket); },
  async byRef(q, ref) { return toTicket((await q.query('SELECT * FROM support_tickets WHERE reference = $1', [ref])).rows[0]); },
  async update(q, ref, {status, resolution, updatedBy}) { await q.query('UPDATE support_tickets SET status = $1, resolution = $2, updated_at = now(), updated_by = $3 WHERE reference = $4', [status, resolution, updatedBy, ref]); },
  async list(q, {needle = '', status = '', category = '', page: p, pageSize} = {}) {
    const pg = page(p, pageSize), where = [], vals = [];
    if (needle) { vals.push(like(needle)); const n = `$${vals.length}`; where.push(`(t.reference ILIKE ${n} OR t.subject ILIKE ${n} OR t.message ILIKE ${n} OR u.email ILIKE ${n})`); }
    if (status) { vals.push(status); where.push(`t.status = $${vals.length}`); }
    if (category) { vals.push(category); where.push(`t.category = $${vals.length}`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const from = 'FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id';
    const total = Number((await q.query(`SELECT count(*) AS n ${from} ${w}`, vals)).rows[0].n);
    const rows = (await q.query(`SELECT t.*, u.id AS c_id, u.name AS c_name, u.email AS c_email ${from} ${w} ORDER BY t.created_at DESC, t.reference LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, vals)).rows.map(toTicket);
    return paged(rows, total, pg);
  },
};

// ---------------------------------------------------------------- one-use security tokens (verify / reset)
export const tokens = {
  // Replaces any previous token of the same purpose for the user.
  async issue(q, {hash, userId, purpose, expires, now = Date.now()}) {
    await q.query('DELETE FROM security_tokens WHERE expires <= $1 OR (user_id = $2 AND purpose = $3)', [now, userId, purpose]);
    await q.query('INSERT INTO security_tokens (hash, user_id, purpose, expires, created_at) VALUES ($1,$2,$3,$4,$5)', [hash, userId, purpose, expires, now]);
  },
  // Atomically consumes a valid token; returns its userId or null. Single use: the row is deleted.
  async consume(q, hash, purpose, now = Date.now()) { return (await q.query('DELETE FROM security_tokens WHERE hash = $1 AND purpose = $2 AND expires > $3 RETURNING user_id', [hash, purpose, now])).rows[0]?.user_id || null; },
  async removeForUser(q, userId) { await q.query('DELETE FROM security_tokens WHERE user_id = $1', [userId]); },
};

// ---------------------------------------------------------------- leads
const toLead = r => r && clean({reference: r.reference, createdAt: iso(r.created_at), name: r.name, email: r.email, phone: r.phone, company: r.company, kind: r.kind, language: r.language, plan: r.plan, term: r.term,
  groupSize: num(r.group_size), preferredDate: r.preferred_date, preferredTime: r.preferred_time, message: r.message, status: r.status, updatedAt: iso(r.updated_at), notes: r.notes || []});
export const leads = {
  async create(q, l) {
    await q.query(`INSERT INTO leads (reference, created_at, name, email, phone, company, kind, language, plan, term, group_size, preferred_date, preferred_time, message, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) ON CONFLICT (reference) DO NOTHING`,
      [l.reference, l.createdAt || new Date().toISOString(), l.name, l.email, l.phone, l.company || '', l.kind, l.language, l.plan ?? null, l.term ?? null, l.groupSize ?? null, l.preferredDate ?? null, l.preferredTime ?? null, l.message || '', l.status || 'new', J(l.notes || [])]);
  },
  async byRef(q, ref) { return toLead((await q.query('SELECT * FROM leads WHERE reference = $1', [ref])).rows[0]); },
  async update(q, ref, {status, note, adminId}) {
    const r = (await q.query(`UPDATE leads SET status = $1, updated_at = now(),
      notes = CASE WHEN $2::text IS NULL THEN notes ELSE notes || jsonb_build_array(jsonb_build_object('at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'adminId', $3::text, 'text', $2::text)) END
      WHERE reference = $4 RETURNING *`, [status, note || null, adminId, ref])).rows[0];
    return toLead(r);
  },
  async list(q, {needle = '', status = '', kind = '', page: p, pageSize} = {}) {
    const pg = page(p, pageSize), where = [], vals = [];
    if (needle) { vals.push(like(needle)); const n = `$${vals.length}`; where.push(`(reference ILIKE ${n} OR name ILIKE ${n} OR email ILIKE ${n} OR phone ILIKE ${n} OR company ILIKE ${n} OR message ILIKE ${n})`); }
    if (status) { vals.push(status); where.push(`status = $${vals.length}`); }
    if (kind) { vals.push(kind); where.push(`kind = $${vals.length}`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = Number((await q.query(`SELECT count(*) AS n FROM leads ${w}`, vals)).rows[0].n);
    const rows = (await q.query(`SELECT * FROM leads ${w} ORDER BY created_at DESC, reference LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, vals)).rows.map(toLead);
    return paged(rows, total, pg);
  },
};

// ---------------------------------------------------------------- administrators
const toAdmin = r => r && {id: r.id, email: r.email, name: r.name, role: r.role, status: r.status, password: r.password, createdAt: iso(r.created_at), createdBy: r.created_by, lastLoginAt: iso(r.last_login_at), mfa: r.mfa || undefined};
export const admins = {
  async byId(q, id, {lock = false} = {}) { return toAdmin((await q.query(`SELECT * FROM admins WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]); },
  async byEmail(q, email) { return toAdmin((await q.query('SELECT * FROM admins WHERE lower(email) = lower($1)', [email])).rows[0]); },
  async create(q, a) { await q.query('INSERT INTO admins (id, email, name, role, status, password, created_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [a.id, a.email, a.name, a.role, a.status, a.password, a.createdAt, a.createdBy]); },
  // patch keys: role, status, password, lastLoginAt, mfa (null clears)
  async update(q, id, patch) {
    const map = {role: 'role', status: 'status', password: 'password', lastLoginAt: 'last_login_at', mfa: 'mfa'}, sets = [], vals = [];
    for (const [k, col] of Object.entries(map)) if (Object.hasOwn(patch, k)) { vals.push(k === 'mfa' ? J(patch[k]) : patch[k]); sets.push(`${col} = $${vals.length}${k === 'mfa' ? '::jsonb' : ''}`); }
    vals.push(id);
    await q.query(`UPDATE admins SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  },
  async activeOwnersExcept(q, id) { return Number((await q.query("SELECT count(*) AS n FROM admins WHERE role = 'owner' AND status = 'active' AND id <> $1", [id])).rows[0].n); },
  async list(q, {needle = '', page: p, pageSize} = {}) {
    const pg = page(p, pageSize), vals = [], w = needle ? (vals.push(like(needle)), 'WHERE email ILIKE $1 OR name ILIKE $1 OR role ILIKE $1') : '';
    const total = Number((await q.query(`SELECT count(*) AS n FROM admins ${w}`, vals)).rows[0].n);
    return paged((await q.query(`SELECT * FROM admins ${w} ORDER BY created_at DESC, id LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, vals)).rows.map(toAdmin), total, pg);
  },
  async emailsById(q, ids) { if (!ids.length) return new Map(); return new Map((await q.query('SELECT id, email FROM admins WHERE id = ANY($1)', [ids])).rows.map(r => [r.id, r.email])); },
};
const toAdminSession = r => r && {id: r.id, hash: r.hash, adminId: r.admin_id, stage: r.stage, attempts: r.attempts, createdAt: num(r.created_at), lastSeen: num(r.last_seen), expires: num(r.expires), device: r.device};
export const adminSessions = {
  async create(q, s) { await q.query('INSERT INTO admin_sessions (id, hash, admin_id, stage, attempts, created_at, last_seen, expires, device) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [s.id, s.hash, s.adminId, s.stage || 'full', s.attempts || 0, s.createdAt, s.lastSeen, s.expires, s.device || null]); },
  async byHash(q, hash, {lock = false} = {}) { return toAdminSession((await q.query(`SELECT * FROM admin_sessions WHERE hash = $1${lock ? ' FOR UPDATE' : ''}`, [hash])).rows[0]); },
  async touch(q, id, now) { await q.query('UPDATE admin_sessions SET last_seen = $1 WHERE id = $2', [now, id]); },
  async setAttempts(q, id, n) { await q.query('UPDATE admin_sessions SET attempts = $1 WHERE id = $2', [n, id]); },
  async remove(q, id) { await q.query('DELETE FROM admin_sessions WHERE id = $1', [id]); },
  async removeByHash(q, hash) { return toAdminSession((await q.query('DELETE FROM admin_sessions WHERE hash = $1 RETURNING *', [hash])).rows[0]); },
  async removeForAdmin(q, adminId, exceptId = null) { await q.query('DELETE FROM admin_sessions WHERE admin_id = $1 AND ($2::text IS NULL OR id <> $2)', [adminId, exceptId]); },
  async purge(q, now, idleMs) { await q.query("DELETE FROM admin_sessions WHERE expires <= $1 OR (stage = 'full' AND last_seen <= $2)", [now, now - idleMs]); },
};

// ---------------------------------------------------------------- audit chain
const toEntry = r => ({seq: num(r.seq), id: r.id, at: r.at, event: r.event, actor: r.actor ?? null, target: r.target ?? null, meta: r.meta ?? {}, kid: r.kid, prevHash: r.prev_hash, hash: r.hash});
const maxAudit = () => Number(process.env.AUDIT_MAX_ENTRIES || 0); // 0 = keep everything (the table scales; archiving is a follow-up)
export const audit = {
  // Must run inside the transaction of the action it records: locks the chain head so appends are strictly serial.
  async append(q, input) {
    const c = (await q.query('SELECT seq, head FROM audit_chain WHERE id = 1 FOR UPDATE')).rows[0];
    const e = makeEntry({seq: num(c.seq), head: c.head}, input);
    await q.query('INSERT INTO audit_log (seq, id, at, event, actor, target, meta, kid, prev_hash, hash) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10)',
      [e.seq, e.id, e.at, e.event, J(e.actor), J(e.target), J(e.meta), e.kid, e.prevHash, e.hash]);
    await q.query('UPDATE audit_chain SET seq = $1, head = $2 WHERE id = 1', [e.seq, e.hash]);
    const max = maxAudit();
    if (max > 0 && e.seq > max) {
      const cut = e.seq - max;
      const last = (await q.query('SELECT seq, hash FROM audit_log WHERE seq = $1', [cut])).rows[0];
      if (last) { await q.query('DELETE FROM audit_log WHERE seq > 0 AND seq <= $1', [cut]); await q.query('UPDATE audit_chain SET anchor_seq = $1, anchor_hash = $2 WHERE id = 1', [cut, last.hash]); }
    }
    return e;
  },
  async list(q, {needle = '', event = '', actorType = '', page: p, pageSize} = {}) {
    const pg = page(p, pageSize), where = [], vals = [];
    if (event) { vals.push(event); where.push(`event = $${vals.length}`); }
    if (actorType) { vals.push(actorType); where.push(`COALESCE(actor->>'type', CASE WHEN legacy->>'userId' IS NOT NULL THEN 'user' END) = $${vals.length}`); }
    if (needle) { vals.push(like(needle)); const n = `$${vals.length}`; where.push(`(event ILIKE ${n} OR actor::text ILIKE ${n} OR target::text ILIKE ${n} OR meta::text ILIKE ${n} OR id IN (SELECT a.id FROM audit_log a JOIN admins ad ON ad.id = a.actor->>'id' WHERE ad.email ILIKE ${n}))`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = Number((await q.query(`SELECT count(*) AS n FROM audit_log ${w}`, vals)).rows[0].n);
    const rows = (await q.query(`SELECT * FROM audit_log ${w} ORDER BY seq DESC LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, vals)).rows.map(r => ({...toEntry(r), legacy: r.legacy}));
    return paged(rows, total, pg);
  },
  async events(q) { return (await q.query('SELECT DISTINCT event FROM audit_log ORDER BY event')).rows.map(r => r.event); },
  // Streams the chain in pages so verification stays bounded in memory for very large logs.
  async verify(q, pageSize = 5000) {
    const c = (await q.query('SELECT * FROM audit_chain WHERE id = 1')).rows[0];
    const v = createVerifier({seq: num(c.seq), head: c.head, anchorSeq: num(c.anchor_seq), anchorHash: c.anchor_hash});
    let after = num(c.anchor_seq), ok = true;
    while (ok) {
      const rows = (await q.query('SELECT * FROM audit_log WHERE hash IS NOT NULL AND seq > $1 ORDER BY seq LIMIT $2', [after, pageSize])).rows;
      if (!rows.length) break;
      for (const r of rows) if (!v.push(toEntry(r))) { ok = false; break; }
      after = num(rows[rows.length - 1].seq);
    }
    const legacy = Number((await q.query('SELECT count(*) AS n FROM audit_log WHERE hash IS NULL')).rows[0].n);
    return v.finish({legacy});
  },
};

// ---------------------------------------------------------------- learning records
const toActivity = r => r && {id: r.id, ref: r.ref, kind: r.kind, title: r.title, skill: r.skill, words: r.words || [], summary: r.summary, metrics: r.metrics || {}, xp: num(r.xp), day: r.day, createdAt: iso(r.created_at)};
const toCard = r => ({word: r.word, reps: num(r.reps), interval: num(r.interval_days), ease: num(r.ease), due: num(r.due), lapses: num(r.lapses), lastReviewed: num(r.last_reviewed)});
export const learning = {
  // Row lock on the learner: serializes one learner's learning writes (daily caps, card limits stay exact).
  async lockUser(q, userId) { await q.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]); },
  // Returns the current import flag under a row lock (null when the user no longer exists).
  async lockImportFlag(q, userId) { const r = (await q.query('SELECT learning_imported FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0]; return r ? !!r.learning_imported : null; },
  async setImported(q, userId) { await q.query('UPDATE users SET learning_imported = true WHERE id = $1', [userId]); },
  async insertActivity(q, a) {
    await q.query(`INSERT INTO learning_activities (id, user_id, client_id, kind, ref, title, skill, words, summary, metrics, xp, day, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13)`,
      [a.id, a.userId, a.clientId, a.kind, a.ref, a.title, a.skill, J(a.words || []), a.summary || '', J(a.metrics || {}), a.xp, a.day, a.createdAt]);
  },
  async byClientId(q, userId, clientId) { return toActivity((await q.query('SELECT * FROM learning_activities WHERE user_id = $1 AND client_id = $2', [userId, clientId])).rows[0]); },
  async countXpActivitiesOnDay(q, userId, day) { return Number((await q.query("SELECT count(*) AS n FROM learning_activities WHERE user_id = $1 AND day = $2 AND xp > 0 AND kind <> 'legacy'", [userId, day])).rows[0].n); },
  async totalXp(q, userId) { return Number((await q.query('SELECT COALESCE(sum(xp), 0) AS n FROM learning_activities WHERE user_id = $1', [userId])).rows[0].n); },
  async activeDays(q, userId) { return (await q.query("SELECT DISTINCT day FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy' ORDER BY day DESC LIMIT 400", [userId])).rows.map(r => r.day); },
  async lastActivityAt(q, userId) { return (await q.query("SELECT max(created_at) AS t FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy'", [userId])).rows[0].t; },
  async recentActivities(q, userId, limit) { return (await q.query("SELECT * FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy' ORDER BY created_at DESC, id LIMIT $2", [userId, limit])).rows.map(toActivity); },
  async history(q, userId, {page: p, pageSize} = {}) {
    const pg = page(p, pageSize);
    const total = Number((await q.query("SELECT count(*) AS n FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy'", [userId])).rows[0].n);
    const rows = (await q.query(`SELECT * FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy' ORDER BY created_at DESC, id LIMIT ${pg.pageSize} OFFSET ${pg.offset}`, [userId])).rows.map(toActivity);
    return paged(rows, total, pg);
  },
  async evidence(q, userId) { return Object.fromEntries((await q.query("SELECT skill, count(*) AS n FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy' GROUP BY skill", [userId])).rows.map(r => [r.skill, Number(r.n)])); },
  // All aggregates in ONE round trip (xp, active days for the streak, evidence per skill, completed refs, last activity).
  async summary(q, userId) {
    const r = (await q.query(`SELECT
      (SELECT COALESCE(sum(xp), 0) FROM learning_activities WHERE user_id = $1) AS xp,
      (SELECT COALESCE(json_agg(day ORDER BY day DESC), '[]'::json) FROM (SELECT DISTINCT day FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy' ORDER BY day DESC LIMIT 400) d) AS days,
      (SELECT COALESCE(json_object_agg(skill, n), '{}'::json) FROM (SELECT skill, count(*) AS n FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy' GROUP BY skill) e) AS evidence,
      (SELECT COALESCE(json_agg(ref ORDER BY ref), '[]'::json) FROM (SELECT DISTINCT ref FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy') c) AS completed,
      (SELECT max(created_at) FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy') AS last`, [userId])).rows[0];
    const j = v => typeof v === 'string' ? JSON.parse(v) : v;
    return {xp: Number(r.xp), days: j(r.days), evidence: Object.fromEntries(Object.entries(j(r.evidence)).map(([k, v]) => [k, Number(v)])), completed: j(r.completed), last: r.last};
  },
  async completedRefs(q, userId) { return (await q.query("SELECT DISTINCT ref FROM learning_activities WHERE user_id = $1 AND kind <> 'legacy' ORDER BY ref", [userId])).rows.map(r => r.ref); },
  async cards(q, userId) { return (await q.query('SELECT * FROM review_cards WHERE user_id = $1 ORDER BY due, word', [userId])).rows.map(toCard); },
  async dueCards(q, userId, now = Date.now()) { return (await q.query('SELECT * FROM review_cards WHERE user_id = $1 AND due <= $2 ORDER BY due, word', [userId, now])).rows.map(toCard); },
  async cardCount(q, userId) { return Number((await q.query('SELECT count(*) AS n FROM review_cards WHERE user_id = $1', [userId])).rows[0].n); },
  async cardForUpdate(q, userId, word) { const r = (await q.query('SELECT * FROM review_cards WHERE user_id = $1 AND word = $2 FOR UPDATE', [userId, word])).rows[0]; return r ? toCard(r) : null; },
  // onlyIfMissing: insert a new card, never overwrite an existing one. Returns true when a row was written.
  async upsertCard(q, userId, c, now, {onlyIfMissing = false, reviewed = false} = {}) {
    const r = await q.query(`INSERT INTO review_cards (user_id, word, reps, interval_days, ease, due, lapses, last_reviewed, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (user_id, word) DO ${onlyIfMissing ? 'NOTHING' : 'UPDATE SET reps = EXCLUDED.reps, interval_days = EXCLUDED.interval_days, ease = EXCLUDED.ease, due = EXCLUDED.due, lapses = EXCLUDED.lapses, last_reviewed = EXCLUDED.last_reviewed'}`,
      [userId, c.word, c.reps | 0, c.interval | 0, c.ease, c.due, c.lapses | 0, reviewed ? now : null, now]);
    return r.rowCount > 0;
  },
  async insertAssessment(q, a) { await q.query('INSERT INTO assessments (id, user_id, kind, answers, result, created_at) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)', [a.id, a.userId, a.kind, J(a.answers), J(a.result), a.createdAt]); },
  async latestAssessment(q, userId) { const r = (await q.query('SELECT * FROM assessments WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 1', [userId])).rows[0]; return r ? {id: r.id, kind: r.kind, result: r.result, createdAt: iso(r.created_at)} : null; },
  async assessments(q, userId) { return (await q.query('SELECT id, kind, result, created_at FROM assessments WHERE user_id = $1 ORDER BY created_at DESC, id LIMIT 50', [userId])).rows.map(r => ({id: r.id, kind: r.kind, result: r.result, createdAt: iso(r.created_at)})); },
};

// ---------------------------------------------------------------- analytics + meta + aggregates
export const analytics = {
  async add(q, e) { await q.query('INSERT INTO analytics_events (id, name, user_id, path, meta, at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)', [e.id, e.name, e.userId, e.path, J(e.meta || {}), e.at]); },
};
export const meta = {
  async get(q, key) { return (await q.query('SELECT value FROM meta WHERE key = $1', [key])).rows[0]?.value ?? null; },
  async set(q, key, value) { await q.query('INSERT INTO meta (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, J(value)]); },
};
export async function overview(q, now = Date.now()) {
  const r = (await q.query(`SELECT
    (SELECT count(*) FROM users) AS users,
    (SELECT count(*) FROM users WHERE status = 'suspended') AS suspended,
    (SELECT count(*) FROM users WHERE email_verified) AS verified,
    (SELECT count(*) FROM entitlements WHERE expires_at > $1) AS active_entitlements,
    (SELECT count(*) FROM orders WHERE status = 'paid') AS paid_orders,
    (SELECT count(*) FROM orders WHERE status IN ('pending_contact', 'pending_payment')) AS pending_orders,
    (SELECT count(*) FROM orders WHERE status = 'refunded') AS refunded_orders,
    (SELECT COALESCE(sum(amount), 0) FROM orders WHERE status = 'paid') AS revenue,
    (SELECT count(*) FROM support_tickets WHERE status IN ('open', 'in_progress')) AS open_tickets,
    (SELECT count(*) FROM leads WHERE status = 'new') AS new_leads`, [now])).rows[0];
  return {users: +r.users, suspended: +r.suspended, verified: +r.verified, activeEntitlements: +r.active_entitlements, paidOrders: +r.paid_orders, pendingOrders: +r.pending_orders,
    refundedOrders: +r.refunded_orders, revenuePaidEGP: +r.revenue, openTickets: +r.open_tickets, newLeads: +r.new_leads};
}
