// Administration: individual admin accounts, role-based access control, admin sessions and operations APIs.
//
// Security model
//  - Admins are separate from learners (own collection, own cookie, own sessions). A learner session can never
//    reach /api/admin, and an admin session is never sent to learner endpoints (cookie Path=/api/admin).
//  - Cookie: HttpOnly; SameSite=Strict; Secure in production. Absolute lifetime ADMIN_SESSION_MS (8h),
//    idle timeout ADMIN_IDLE_MS (30 min). Session tokens are stored only as SHA-256 hashes.
//  - Every route declares the permission it needs; roles map to permission sets (see ROLES).
//  - Every state-changing action is recorded in the tamper-evident audit chain inside the same storage
//    transaction as the change itself. Sensitive actions require a written reason.
//  - CSRF: SameSite=Strict cookie + the app-wide Origin check on non-GET requests.
//  - Legacy shared token (ADMIN_ACCESS_TOKEN) is DISABLED by default. ADMIN_LEGACY_TOKEN=true re-enables it
//    temporarily during migration, read-only (viewer role), and every use is audited.
import express from 'express';
import {readFile} from 'node:fs/promises';
import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {appendAudit, verifyAudit} from './audit.js';
import {passwordHash, checkPassword, dummyCheck, validPassword} from './passwords.js';
import {newSecret, verifyTotp, otpauthUri, sealSecret, openSecret, base32Encode} from './totp.js';

export const PERMISSIONS = {
  'dashboard.read': 'View the operations overview and integration status',
  'users.read': 'View learner accounts, subscriptions and activity summaries',
  'users.write': 'Suspend/reactivate learners, revoke their sessions, mark email verified',
  'orders.read': 'View orders and payment status',
  'orders.write': 'Activate manual payments, record refunds, grant/revoke entitlements',
  'support.read': 'View support tickets',
  'support.write': 'Update support ticket status and resolution',
  'leads.read': 'View leads and contact requests',
  'leads.write': 'Update lead status and add notes',
  'audit.read': 'View and verify the audit log',
  'admins.read': 'View administrator accounts and the role matrix',
  'admins.write': 'Create administrators, change roles, disable administrators',
};
const ALL = Object.keys(PERMISSIONS);
export const ROLES = {
  owner: {label: 'Owner', description: 'Full control, including administrator accounts', permissions: ALL},
  admin: {label: 'Administrator', description: 'All operations except managing administrator accounts', permissions: ALL.filter(p => p !== 'admins.write')},
  finance: {label: 'Finance', description: 'Orders, payments, refunds and entitlements', permissions: ['dashboard.read', 'users.read', 'orders.read', 'orders.write', 'audit.read']},
  support: {label: 'Support', description: 'Support tickets and leads; read-only accounts and orders', permissions: ['dashboard.read', 'users.read', 'orders.read', 'support.read', 'support.write', 'leads.read', 'leads.write']},
  viewer: {label: 'Viewer', description: 'Read-only access to operations data', permissions: ['dashboard.read', 'users.read', 'orders.read', 'support.read', 'leads.read']},
};
export const can = (role, perm) => !!ROLES[role]?.permissions.includes(perm);

const COOKIE = 'usam_admin';
const sessionMs = () => Number(process.env.ADMIN_SESSION_MS || 8 * 3600 * 1000);
const idleMs = () => Number(process.env.ADMIN_IDLE_MS || 30 * 60 * 1000);
const sha = v => createHash('sha256').update(v).digest('hex');
const same = (a, b) => { const x = Buffer.from(sha(String(a))), y = Buffer.from(sha(String(b))); return timingSafeEqual(x, y); };
const clean = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const nowIso = () => new Date().toISOString();
const EMAIL_RE = /^\S+@\S+\.\S+$/;

export const publicAdmin = a => ({id: a.id, email: a.email, name: a.name, role: a.role, status: a.status, createdAt: a.createdAt, lastLoginAt: a.lastLoginAt || null, mfaEnabled: !!a.mfa?.enabled});

// ---- MFA (TOTP) settings ----
//   ADMIN_MFA_KEY      encrypts TOTP secrets at rest (AES-256-GCM). Required to enroll or verify MFA.
//   ADMIN_REQUIRE_MFA  when "true", an admin without MFA can sign in but can do nothing except enroll.
const mfaKey = () => process.env.ADMIN_MFA_KEY || '';
const mfaRequired = () => process.env.ADMIN_REQUIRE_MFA === 'true';
const CHALLENGE_MS = 5 * 60 * 1000, CHALLENGE_ATTEMPTS = 5, RECOVERY_CODES = 8;
const newRecoveryCode = () => { const s = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase(); return s.slice(0, 5) + '-' + s.slice(5); };
const recoveryHash = c => sha('usam-recovery:' + String(c).toLowerCase().replace(/[^a-z0-9]/g, ''));
const mfaUnavailable = () => Object.assign(Error('MFA is not configured on this server (set ADMIN_MFA_KEY).'), {status: 503});

// Pure helper used by the API and by the CLI bootstrap script.
export async function buildAdmin({email, name, role, password, createdBy = null}) {
  email = clean(email, 120).toLowerCase(); name = clean(name, 80);
  if (!EMAIL_RE.test(email)) throw Object.assign(Error('A valid email is required.'), {status: 400});
  if (name.length < 2) throw Object.assign(Error('Name must be at least 2 characters.'), {status: 400});
  if (!ROLES[role]) throw Object.assign(Error('Unknown role.'), {status: 400});
  if (!validPassword(password)) throw Object.assign(Error('Password must be 12-128 characters.'), {status: 400});
  return {id: randomUUID(), email, name, role, status: 'active', password: await passwordHash(password), createdAt: nowIso(), createdBy};
}

function pageOf(req, items) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const total = items.length;
  return {items: items.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize))};
}
const needle = req => clean(req.query.q, 100).toLowerCase();
const hit = (n, ...fields) => !n || fields.some(f => String(f ?? '').toLowerCase().includes(n));
const newest = (a, b) => String(b.createdAt || b.at || '').localeCompare(String(a.createdAt || a.at || ''));
const reasonOf = req => { const r = clean(req.body?.reason, 500); if (r.length < 5) throw Object.assign(Error('A reason of at least 5 characters is required for this action.'), {status: 400}); return r; };

export function adminRouter(customer, {root, leadsFile, integrations = () => ({})} = {}) {
  const router = express.Router();
  const actorOf = req => req.admin.legacy ? {type: 'legacy-token'} : {type: 'admin', id: req.admin.id, role: req.admin.role};
  const fail = (res, e) => res.status(e.status || 500).json({error: e.status ? e.message : 'Unexpected server error.'});

  function readCookie(req) {
    const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
  }
  function currentAdmin(req, db) {
    const raw = readCookie(req);
    if (!raw) return null;
    const h = sha(raw), now = Date.now();
    // Only fully authenticated sessions grant access. An MFA challenge session (stage 'mfa') never does.
    const session = db.adminSessions.find(s => s.hash === h && (s.stage || 'full') === 'full' && s.expires > now && s.lastSeen > now - idleMs());
    if (!session) return null;
    const admin = db.admins.find(a => a.id === session.adminId && a.status === 'active');
    return admin ? {admin, session} : null;
  }
  function currentChallenge(req, db) {
    const raw = readCookie(req);
    if (!raw) return null;
    const session = db.adminSessions.find(s => s.hash === sha(raw) && s.stage === 'mfa' && s.expires > Date.now());
    const admin = session && db.admins.find(a => a.id === session.adminId && a.status === 'active');
    return admin ? {admin, session} : null;
  }
  // Creates a full session (fresh token) and sets the cookie. Must run inside mutate().
  function issueFullSession(db, req, admin, now) {
    const token = randomBytes(32).toString('hex');
    db.adminSessions = db.adminSessions.filter(s => s.expires > now && ((s.stage || 'full') === 'mfa' || s.lastSeen > now - idleMs()));
    db.adminSessions.push({id: randomUUID(), hash: sha(token), adminId: admin.id, stage: 'full', createdAt: now, lastSeen: now, expires: now + sessionMs(), device: clean(req.get('user-agent') || 'Browser', 120)});
    const a = db.admins.find(x => x.id === admin.id); if (a) a.lastLoginAt = nowIso();
    return token;
  }
  const sessionPayload = admin => ({admin: publicAdmin(admin), permissions: ROLES[admin.role].permissions, mfaEnrollmentRequired: mfaRequired() && !admin.mfa?.enabled});
  function setCookie(req, res, token, maxAgeMs) {
    const secure = req.secure || process.env.NODE_ENV === 'production';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`);
  }

  // Authorization middleware. Every admin route goes through this with the permission it requires.
  // allowUnenrolled: routes an admin may use before enrolling MFA when ADMIN_REQUIRE_MFA=true
  // (session info, password change, MFA enrollment). Everything else is blocked until MFA is on.
  const requireAdmin = (perm, {allowUnenrolled = false} = {}) => async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const legacyToken = String(process.env.ADMIN_ACCESS_TOKEN || '');
      if (bearer && process.env.ADMIN_LEGACY_TOKEN === 'true' && legacyToken.length >= 32 && same(bearer, legacyToken)) {
        if (req.method !== 'GET' || !can('viewer', perm)) return res.status(403).json({error: 'The legacy token is read-only. Sign in with an administrator account.'});
        req.admin = {id: 'legacy-token', name: 'Legacy token', role: 'viewer', legacy: true};
        await customer.mutate(db => { appendAudit(db, {event: 'admin_legacy_token_used', actor: {type: 'legacy-token'}, meta: {path: req.path}}); });
        return next();
      }
      const db = await customer.store();
      const found = currentAdmin(req, db);
      if (!found) return res.status(401).json({error: 'Administrator sign-in required.'});
      if (mfaRequired() && !found.admin.mfa?.enabled && !allowUnenrolled) return res.status(403).json({error: 'Two-factor authentication must be enabled before using the console.', mfaEnrollmentRequired: true});
      if (perm && !can(found.admin.role, perm)) {
        await customer.mutate(d => { appendAudit(d, {event: 'admin_permission_denied', actor: {type: 'admin', id: found.admin.id, role: found.admin.role}, meta: {permission: perm, method: req.method, path: req.path}}); });
        return res.status(403).json({error: 'Your role does not allow this action.'});
      }
      req.admin = found.admin; req.adminSession = found.session;
      if (Date.now() - found.session.lastSeen > 60000) {
        await customer.mutate(d => { const s = d.adminSessions.find(x => x.id === found.session.id); if (s) s.lastSeen = Date.now(); });
      }
      next();
    } catch (e) { fail(res, e); }
  };

  // ---------------- Authentication ----------------
  router.post('/admin/auth/login', customer.throttle, async (req, res) => {
    const email = clean(req.body?.email, 120).toLowerCase(), password = String(req.body?.password || '');
    try {
      const admin = (await customer.store()).admins.find(a => a.email === email);
      const valid = admin ? await checkPassword(password, admin.password) : await dummyCheck(password);
      if (!admin || !valid || admin.status !== 'active') {
        await customer.mutate(db => { appendAudit(db, {event: 'admin_login_failed', actor: admin ? {type: 'admin', id: admin.id} : null, meta: {emailHash: sha(email).slice(0, 16), reason: !admin ? 'unknown' : !valid ? 'password' : 'disabled'}}); });
        return res.status(401).json({error: 'Incorrect email or password.'});
      }
      const now = Date.now();
      if (admin.mfa?.enabled) {
        // Password is correct but MFA is on: issue a short-lived challenge session that grants nothing.
        const challenge = randomBytes(32).toString('hex');
        await customer.mutate(db => {
          db.adminSessions = db.adminSessions.filter(s => s.expires > now);
          db.adminSessions.push({id: randomUUID(), hash: sha(challenge), adminId: admin.id, stage: 'mfa', attempts: 0, createdAt: now, lastSeen: now, expires: now + CHALLENGE_MS});
          appendAudit(db, {event: 'admin_login_mfa_challenge', actor: {type: 'admin', id: admin.id}});
        });
        setCookie(req, res, challenge, CHALLENGE_MS);
        return res.json({mfaRequired: true});
      }
      let token;
      await customer.mutate(db => {
        token = issueFullSession(db, req, admin, now);
        appendAudit(db, {event: 'admin_login', actor: {type: 'admin', id: admin.id, role: admin.role}, meta: {mfa: 'none'}});
      });
      setCookie(req, res, token, sessionMs());
      res.json(sessionPayload(admin));
    } catch (e) { fail(res, e); }
  });

  // Second sign-in step: an authenticator code (or a one-time recovery code) upgrades the challenge to a full
  // session under a NEW token. Max CHALLENGE_ATTEMPTS tries per challenge; codes cannot be replayed.
  router.post('/admin/auth/mfa', customer.throttle, async (req, res) => {
    try {
      const code = String(req.body?.code || ''), recovery = String(req.body?.recoveryCode || '');
      if (!mfaKey()) throw mfaUnavailable();
      let outcome;
      await customer.mutate(db => {
        const ch = currentChallenge(req, db);
        if (!ch) { outcome = {status: 401, error: 'Sign-in expired. Enter your email and password again.'}; return; }
        const s = db.adminSessions.find(x => x.id === ch.session.id), a = db.admins.find(x => x.id === ch.admin.id);
        s.attempts = (s.attempts || 0) + 1;
        let method = null;
        if (recovery) {
          const h = recoveryHash(recovery), rc = (a.mfa.recovery || []).find(r => r.hash === h && !r.usedAt);
          if (rc) { rc.usedAt = nowIso(); method = 'recovery'; }
        } else {
          const v = verifyTotp(openSecret(a.mfa.secret, mfaKey()), code, {lastStep: a.mfa.lastStep ?? -1});
          if (v.ok) { a.mfa.lastStep = v.step; method = 'totp'; }
        }
        if (!method) {
          const exhausted = s.attempts >= CHALLENGE_ATTEMPTS;
          if (exhausted) db.adminSessions = db.adminSessions.filter(x => x.id !== s.id);
          appendAudit(db, {event: 'admin_mfa_failed', actor: {type: 'admin', id: a.id}, meta: {attempt: s.attempts, exhausted, kind: recovery ? 'recovery' : 'totp'}});
          outcome = {status: 401, error: exhausted ? 'Too many incorrect codes. Sign in again.' : 'Incorrect code.', restart: exhausted};
          return;
        }
        db.adminSessions = db.adminSessions.filter(x => x.id !== s.id);
        const token = issueFullSession(db, req, a, Date.now());
        const left = (a.mfa.recovery || []).filter(r => !r.usedAt).length;
        appendAudit(db, {event: 'admin_login', actor: {type: 'admin', id: a.id, role: a.role}, meta: {mfa: method, ...(method === 'recovery' ? {recoveryCodesLeft: left} : {})}});
        outcome = {status: 200, token, admin: a, left, method};
      });
      if (outcome.status !== 200) return res.status(outcome.status).json({error: outcome.error, restart: !!outcome.restart});
      setCookie(req, res, outcome.token, sessionMs());
      res.json({...sessionPayload(outcome.admin), ...(outcome.method === 'recovery' ? {recoveryCodesLeft: outcome.left} : {})});
    } catch (e) { fail(res, e); }
  });

  // ---------------- MFA enrollment ----------------
  router.post('/admin/mfa/setup', requireAdmin(null, {allowUnenrolled: true}), async (req, res) => {
    try {
      if (req.admin.legacy) return res.status(403).json({error: 'Not available for the legacy token.'});
      if (!mfaKey()) throw mfaUnavailable();
      if (req.admin.mfa?.enabled) return res.status(409).json({error: 'Two-factor authentication is already enabled.'});
      const secret = newSecret();
      await customer.mutate(db => { const a = db.admins.find(x => x.id === req.admin.id); a.mfa = {enabled: false, pending: sealSecret(secret, mfaKey()), pendingAt: Date.now()}; });
      // The secret is shown once so the admin can add it to an authenticator app; only the sealed form is stored.
      res.json({secret, otpauthUri: otpauthUri({secret, account: req.admin.email})});
    } catch (e) { fail(res, e); }
  });
  router.post('/admin/mfa/enable', requireAdmin(null, {allowUnenrolled: true}), async (req, res) => {
    try {
      if (!mfaKey()) throw mfaUnavailable();
      let outcome;
      const codes = Array.from({length: RECOVERY_CODES}, newRecoveryCode);
      await customer.mutate(db => {
        const a = db.admins.find(x => x.id === req.admin.id);
        if (a.mfa?.enabled) { outcome = {status: 409, error: 'Two-factor authentication is already enabled.'}; return; }
        if (!a.mfa?.pending || Date.now() - a.mfa.pendingAt > 15 * 60 * 1000) { outcome = {status: 409, error: 'Start setup again (the setup key expired after 15 minutes).'}; return; }
        const secret = openSecret(a.mfa.pending, mfaKey());
        const v = verifyTotp(secret, req.body?.code);
        if (!v.ok) { outcome = {status: 400, error: 'Incorrect code. Check the time on your phone and try again.'}; return; }
        a.mfa = {enabled: true, secret: a.mfa.pending, enabledAt: nowIso(), lastStep: v.step, recovery: codes.map(c => ({hash: recoveryHash(c)}))};
        // Other sessions were authenticated without MFA: end them, keep the current one.
        db.adminSessions = db.adminSessions.filter(s => s.adminId !== a.id || s.id === req.adminSession.id);
        appendAudit(db, {event: 'admin_mfa_enabled', actor: {type: 'admin', id: a.id, role: a.role}});
        outcome = {status: 200};
      });
      if (outcome.status !== 200) return res.status(outcome.status).json({error: outcome.error});
      res.json({ok: true, recoveryCodes: codes, message: 'Two-factor authentication is on. Store these recovery codes somewhere safe; each works once and they are not shown again.'});
    } catch (e) { fail(res, e); }
  });
  router.post('/admin/mfa/disable', requireAdmin(null, {allowUnenrolled: true}), async (req, res) => {
    try {
      if (!mfaKey()) throw mfaUnavailable();
      if (!req.admin.mfa?.enabled) return res.status(409).json({error: 'Two-factor authentication is not enabled.'});
      if (!await checkPassword(String(req.body?.password || ''), req.admin.password)) return res.status(403).json({error: 'Password is incorrect.'});
      let ok = false;
      await customer.mutate(db => {
        const a = db.admins.find(x => x.id === req.admin.id);
        const v = verifyTotp(openSecret(a.mfa.secret, mfaKey()), req.body?.code, {lastStep: a.mfa.lastStep ?? -1});
        if (!v.ok) return;
        delete a.mfa; ok = true;
        appendAudit(db, {event: 'admin_mfa_disabled', actor: {type: 'admin', id: a.id, role: a.role}});
      });
      if (!ok) return res.status(400).json({error: 'Incorrect code.'});
      res.json({ok: true, mfaEnrollmentRequired: mfaRequired()});
    } catch (e) { fail(res, e); }
  });

  router.post('/admin/auth/logout', async (req, res) => {
    const raw = readCookie(req);
    if (raw) await customer.mutate(db => {
      const s = db.adminSessions.find(x => x.hash === sha(raw));
      db.adminSessions = db.adminSessions.filter(x => x.hash !== sha(raw));
      if (s) appendAudit(db, {event: 'admin_logout', actor: {type: 'admin', id: s.adminId}});
    });
    setCookie(req, res, '', 0);
    res.json({ok: true});
  });

  router.get('/admin/auth/me', requireAdmin(null, {allowUnenrolled: true}), (req, res) => {
    if (req.admin.legacy) return res.json({admin: {id: 'legacy-token', name: 'Legacy token', role: 'viewer'}, permissions: ROLES.viewer.permissions, legacy: true});
    res.json({...sessionPayload(req.admin), idleTimeoutMs: idleMs(), sessionExpiresAt: req.adminSession.expires, mfaAvailable: !!mfaKey(), recoveryCodesLeft: req.admin.mfa?.enabled ? (req.admin.mfa.recovery || []).filter(r => !r.usedAt).length : null});
  });

  router.post('/admin/auth/password', requireAdmin(null, {allowUnenrolled: true}), async (req, res) => {
    try {
      if (req.admin.legacy) return res.status(403).json({error: 'Not available for the legacy token.'});
      const current = String(req.body?.currentPassword || ''), next = String(req.body?.newPassword || '');
      if (!await checkPassword(current, req.admin.password)) return res.status(403).json({error: 'Current password is incorrect.'});
      if (!validPassword(next) || next === current) return res.status(400).json({error: 'New password must be 12-128 characters and different from the current one.'});
      const digest = await passwordHash(next);
      await customer.mutate(db => {
        const a = db.admins.find(x => x.id === req.admin.id); if (a) a.password = digest;
        db.adminSessions = db.adminSessions.filter(s => s.adminId !== req.admin.id || s.id === req.adminSession.id);
        appendAudit(db, {event: 'admin_password_changed', actor: actorOf(req)});
      });
      res.json({ok: true, message: 'Password changed. Other administrator sessions were signed out.'});
    } catch (e) { fail(res, e); }
  });

  // ---------------- Overview ----------------
  router.get('/admin/overview', requireAdmin('dashboard.read'), async (_req, res) => {
    const db = await customer.store(), now = Date.now();
    res.json({
      users: db.users.length,
      suspended: db.users.filter(u => u.status === 'suspended').length,
      verified: db.users.filter(u => u.emailVerified).length,
      activeEntitlements: db.users.reduce((n, u) => n + Object.values(u.entitlements || {}).filter(e => e.expiresAt > now).length, 0),
      paidOrders: db.orders.filter(o => o.status === 'paid').length,
      pendingOrders: db.orders.filter(o => ['pending_contact', 'pending_payment'].includes(o.status)).length,
      refundedOrders: db.orders.filter(o => o.status === 'refunded').length,
      revenuePaidEGP: db.orders.filter(o => o.status === 'paid').reduce((n, o) => n + (Number(o.amount) || 0), 0),
      openTickets: db.supportTickets.filter(t => ['open', 'in_progress'].includes(t.status)).length,
      newLeads: db.leads.filter(l => (l.status || 'new') === 'new').length,
      integrations: integrations(),
    });
  });

  // ---------------- Users ----------------
  const userRow = (u, now = Date.now()) => {
    const e = u.entitlements?.English;
    return {id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt, emailVerified: !!u.emailVerified, status: u.status || 'active', subscription: e ? {plan: e.plan, expiresAt: e.expiresAt, active: e.expiresAt > now, source: e.source || 'payment'} : null, hasProfile: !!u.profile};
  };
  router.get('/admin/users', requireAdmin('users.read'), async (req, res) => {
    const db = await customer.store(), n = needle(req), now = Date.now();
    const status = clean(req.query.status, 20), sub = clean(req.query.subscription, 20), verified = clean(req.query.verified, 5);
    const rows = db.users.map(u => userRow(u, now)).filter(u => hit(n, u.name, u.email, u.phone, u.id)
      && (!status || u.status === status)
      && (!verified || String(u.emailVerified) === verified)
      && (!sub || (sub === 'active' ? u.subscription?.active : !u.subscription?.active))).sort(newest);
    res.json(pageOf(req, rows));
  });
  router.get('/admin/users/:id', requireAdmin('users.read'), async (req, res) => {
    const db = await customer.store(), u = db.users.find(x => x.id === req.params.id);
    if (!u) return res.status(404).json({error: 'User not found.'});
    const p = u.profile || {};
    res.json({
      user: userRow(u),
      learning: {level: p.level || null, xp: p.xp || 0, streak: p.streak || 0, sessions: Array.isArray(p.sessions) ? p.sessions.length : 0, reviews: Array.isArray(p.reviews) ? p.reviews.length : 0, lastActive: p.lastActive || null},
      activeSessions: db.sessions.filter(s => s.userId === u.id && s.expires > Date.now()).length,
      orders: db.orders.filter(o => o.userId === u.id).sort(newest).map(({reference, plan, term, amount, status, createdAt, paidAt, expiresAt}) => ({reference, plan, term, amount, status, createdAt, paidAt, expiresAt})),
      tickets: db.supportTickets.filter(t => t.userId === u.id).sort(newest).map(({reference, subject, status, category, createdAt}) => ({reference, subject, status, category, createdAt})),
    });
  });
  router.patch('/admin/users/:id/status', requireAdmin('users.write'), async (req, res) => {
    try {
      const status = clean(req.body?.status, 20), reason = reasonOf(req);
      if (!['active', 'suspended'].includes(status)) return res.status(400).json({error: 'Status must be active or suspended.'});
      let found;
      await customer.mutate(db => {
        found = db.users.find(x => x.id === req.params.id); if (!found) return;
        const from = found.status || 'active'; found.status = status;
        if (status === 'suspended') db.sessions = db.sessions.filter(s => s.userId !== found.id);
        appendAudit(db, {event: 'user_status_changed', actor: actorOf(req), target: {type: 'user', id: found.id}, meta: {from, to: status, reason}});
      });
      if (!found) return res.status(404).json({error: 'User not found.'});
      res.json({user: userRow(found)});
    } catch (e) { fail(res, e); }
  });
  router.post('/admin/users/:id/revoke-sessions', requireAdmin('users.write'), async (req, res) => {
    try {
      const reason = reasonOf(req); let found, count = 0;
      await customer.mutate(db => {
        found = db.users.find(x => x.id === req.params.id); if (!found) return;
        count = db.sessions.filter(s => s.userId === found.id).length;
        db.sessions = db.sessions.filter(s => s.userId !== found.id);
        appendAudit(db, {event: 'user_sessions_revoked', actor: actorOf(req), target: {type: 'user', id: found.id}, meta: {count, reason}});
      });
      if (!found) return res.status(404).json({error: 'User not found.'});
      res.json({ok: true, revoked: count});
    } catch (e) { fail(res, e); }
  });
  router.post('/admin/users/:id/verify-email', requireAdmin('users.write'), async (req, res) => {
    try {
      const reason = reasonOf(req); let found;
      await customer.mutate(db => {
        found = db.users.find(x => x.id === req.params.id); if (!found) return;
        found.emailVerified = true;
        appendAudit(db, {event: 'user_email_marked_verified', actor: actorOf(req), target: {type: 'user', id: found.id}, meta: {reason}});
      });
      if (!found) return res.status(404).json({error: 'User not found.'});
      res.json({user: userRow(found)});
    } catch (e) { fail(res, e); }
  });
  router.post('/admin/users/:id/entitlements', requireAdmin('orders.write'), async (req, res) => {
    try {
      const reason = reasonOf(req), plan = clean(req.body?.plan, 20), days = parseInt(req.body?.days, 10);
      if (!['essential', 'plus'].includes(plan) || !(days >= 1 && days <= 400)) return res.status(400).json({error: 'Choose a plan (essential/plus) and 1-400 days.'});
      let found;
      await customer.mutate(db => {
        found = db.users.find(x => x.id === req.params.id); if (!found) return;
        found.entitlements ??= {};
        const now = Date.now(), prior = found.entitlements.English;
        const start = prior?.expiresAt > now ? prior.expiresAt : now;
        found.entitlements.English = {plan, expiresAt: start + days * 86400000, source: 'manual', grantedBy: req.admin.id, grantedAt: nowIso()};
        appendAudit(db, {event: 'entitlement_granted', actor: actorOf(req), target: {type: 'user', id: found.id}, meta: {language: 'English', plan, days, expiresAt: found.entitlements.English.expiresAt, reason}});
      });
      if (!found) return res.status(404).json({error: 'User not found.'});
      res.json({user: userRow(found)});
    } catch (e) { fail(res, e); }
  });
  router.delete('/admin/users/:id/entitlements/English', requireAdmin('orders.write'), async (req, res) => {
    try {
      const reason = reasonOf(req); let found, had = false;
      await customer.mutate(db => {
        found = db.users.find(x => x.id === req.params.id); if (!found) return;
        had = !!found.entitlements?.English;
        if (had) delete found.entitlements.English;
        appendAudit(db, {event: 'entitlement_revoked', actor: actorOf(req), target: {type: 'user', id: found.id}, meta: {language: 'English', existed: had, reason}});
      });
      if (!found) return res.status(404).json({error: 'User not found.'});
      res.json({user: userRow(found), revoked: had});
    } catch (e) { fail(res, e); }
  });

  // ---------------- Orders ----------------
  router.get('/admin/orders', requireAdmin('orders.read'), async (req, res) => {
    const db = await customer.store(), n = needle(req), status = clean(req.query.status, 30), plan = clean(req.query.plan, 20);
    const byId = new Map(db.users.map(u => [u.id, u]));
    const rows = db.orders.map(o => ({...o, customer: byId.get(o.userId) ? {id: o.userId, name: byId.get(o.userId).name, email: byId.get(o.userId).email} : null}))
      .filter(o => hit(n, o.reference, o.customer?.email, o.customer?.name, o.paymobOrderId, o.manualPaymentReference) && (!status || o.status === status) && (!plan || o.plan === plan))
      .sort(newest).map(({intentionId, ...o}) => o);
    res.json(pageOf(req, rows));
  });
  // Manual activation after staff independently reconciled the payment (replaces scripts/activate-manual.mjs).
  router.post('/admin/orders/:reference/activate', requireAdmin('orders.write'), async (req, res) => {
    try {
      const reason = reasonOf(req), paymentReference = clean(req.body?.paymentReference, 80);
      if (paymentReference.length < 6) return res.status(400).json({error: 'Enter the verified payment reference (at least 6 characters).'});
      let outcome;
      await customer.mutate(db => {
        const o = db.orders.find(x => x.reference === req.params.reference);
        if (!o) { outcome = {status: 404, error: 'Order not found.'}; return; }
        if (o.status !== 'pending_contact') { outcome = {status: 409, error: `Only orders awaiting manual payment can be activated (this one is ${o.status}).`}; return; }
        if (db.orders.some(x => x.manualPaymentReference === paymentReference)) { outcome = {status: 409, error: 'This payment reference was already used for another order.'}; return; }
        const u = db.users.find(x => x.id === o.userId);
        if (!u) { outcome = {status: 409, error: 'The customer account no longer exists.'}; return; }
        const now = Date.now(), prior = u.entitlements?.[o.language];
        const d = new Date(prior?.expiresAt > now ? prior.expiresAt : now); d.setUTCMonth(d.getUTCMonth() + (o.term === 'yearly' ? 12 : 1));
        Object.assign(o, {status: 'paid', paidAt: new Date(now).toISOString(), expiresAt: d.getTime(), manualPaymentReference: paymentReference, activatedBy: req.admin.id});
        u.entitlements ??= {};
        u.entitlements[o.language] = {plan: o.plan, expiresAt: o.expiresAt, orderReference: o.reference, source: 'manual_payment'};
        appendAudit(db, {event: 'order_manually_activated', actor: actorOf(req), target: {type: 'order', id: o.reference}, meta: {userId: u.id, amount: o.amount, paymentReference, expiresAt: o.expiresAt, reason}});
        outcome = {status: 200, order: o};
      });
      if (outcome.status !== 200) return res.status(outcome.status).json({error: outcome.error});
      res.json({order: outcome.order});
    } catch (e) { fail(res, e); }
  });
  // Records a refund decision and removes the access it paid for. The money itself is returned through the
  // payment provider's merchant dashboard; this endpoint does NOT move money.
  router.post('/admin/orders/:reference/refund', requireAdmin('orders.write'), async (req, res) => {
    try {
      const reason = reasonOf(req); let outcome;
      await customer.mutate(db => {
        const o = db.orders.find(x => x.reference === req.params.reference);
        if (!o) { outcome = {status: 404, error: 'Order not found.'}; return; }
        if (o.status !== 'paid') { outcome = {status: 409, error: `Only paid orders can be marked refunded (this one is ${o.status}).`}; return; }
        const u = db.users.find(x => x.id === o.userId);
        let revoked = false;
        if (u?.entitlements?.[o.language]?.orderReference === o.reference) { delete u.entitlements[o.language]; revoked = true; }
        Object.assign(o, {status: 'refunded', refundedAt: nowIso(), refundedBy: req.admin.id});
        appendAudit(db, {event: 'order_refund_recorded', actor: actorOf(req), target: {type: 'order', id: o.reference}, meta: {userId: o.userId, amount: o.amount, entitlementRevoked: revoked, reason}});
        outcome = {status: 200, order: o, entitlementRevoked: revoked};
      });
      if (outcome.status !== 200) return res.status(outcome.status).json({error: outcome.error});
      res.json({order: outcome.order, entitlementRevoked: outcome.entitlementRevoked, notice: 'Refund recorded. Return the money in the payment provider dashboard; this action does not move funds.'});
    } catch (e) { fail(res, e); }
  });

  // ---------------- Support ----------------
  const TICKET_STATUS = ['open', 'in_progress', 'resolved', 'closed'];
  router.get('/admin/support', requireAdmin('support.read'), async (req, res) => {
    const db = await customer.store(), n = needle(req), status = clean(req.query.status, 20), category = clean(req.query.category, 30);
    const byId = new Map(db.users.map(u => [u.id, u]));
    const rows = db.supportTickets.map(t => ({...t, customer: byId.get(t.userId) ? {id: t.userId, name: byId.get(t.userId).name, email: byId.get(t.userId).email} : null}))
      .filter(t => hit(n, t.reference, t.subject, t.message, t.customer?.email) && (!status || t.status === status) && (!category || t.category === category)).sort(newest);
    res.json(pageOf(req, rows));
  });
  router.patch('/admin/support/:reference', requireAdmin('support.write'), async (req, res) => {
    const status = clean(req.body?.status, 20), resolution = clean(req.body?.resolution, 800);
    if (!TICKET_STATUS.includes(status)) return res.status(400).json({error: 'Invalid status.'});
    let found;
    await customer.mutate(db => {
      found = db.supportTickets.find(x => x.reference === req.params.reference); if (!found) return;
      const from = found.status; found.status = status; found.resolution = resolution; found.updatedAt = nowIso(); found.updatedBy = req.admin.id;
      appendAudit(db, {event: 'support_updated', actor: actorOf(req), target: {type: 'ticket', id: found.reference}, meta: {from, to: status}});
    });
    if (!found) return res.status(404).json({error: 'Ticket not found.'});
    res.json({ticket: found});
  });

  // ---------------- Leads ----------------
  const LEAD_STATUS = ['new', 'contacted', 'qualified', 'converted', 'closed'];
  // One-time import of the legacy JSONL leads file into the primary store (idempotent, by reference).
  async function importLegacyLeads() {
    const db = await customer.store();
    if (db.meta?.leadsImported || !leadsFile) return;
    let rows = [];
    try { rows = (await readFile(leadsFile, 'utf8')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await customer.mutate(d => {
      if (d.meta?.leadsImported) return;
      const known = new Set(d.leads.map(l => l.reference));
      const fresh = rows.filter(r => r.reference && !known.has(r.reference));
      d.leads.push(...fresh);
      d.meta = {...(d.meta || {}), leadsImported: true, leadsImportedAt: nowIso(), leadsImportedCount: fresh.length};
      if (fresh.length) appendAudit(d, {event: 'leads_imported', actor: {type: 'system'}, meta: {count: fresh.length}});
    });
  }
  router.get('/admin/leads', requireAdmin('leads.read'), async (req, res) => {
    try {
      await importLegacyLeads();
      const db = await customer.store(), n = needle(req), status = clean(req.query.status, 20), kind = clean(req.query.kind, 20);
      const rows = db.leads.map(l => ({...l, status: l.status || 'new'}))
        .filter(l => hit(n, l.reference, l.name, l.email, l.phone, l.company, l.message) && (!status || l.status === status) && (!kind || l.kind === kind)).sort(newest);
      res.json(pageOf(req, rows));
    } catch (e) { fail(res, e); }
  });
  router.patch('/admin/leads/:reference', requireAdmin('leads.write'), async (req, res) => {
    const status = clean(req.body?.status, 20), note = clean(req.body?.note, 1000);
    if (!LEAD_STATUS.includes(status)) return res.status(400).json({error: 'Invalid lead status.'});
    let found;
    await customer.mutate(db => {
      found = db.leads.find(x => x.reference === req.params.reference); if (!found) return;
      const from = found.status || 'new'; found.status = status; found.updatedAt = nowIso();
      if (note) (found.notes ??= []).push({at: nowIso(), adminId: req.admin.id, text: note});
      appendAudit(db, {event: 'lead_updated', actor: actorOf(req), target: {type: 'lead', id: found.reference}, meta: {from, to: status, noted: !!note}});
    });
    if (!found) return res.status(404).json({error: 'Lead not found.'});
    res.json({lead: found});
  });

  // ---------------- Audit ----------------
  router.get('/admin/audit', requireAdmin('audit.read'), async (req, res) => {
    const db = await customer.store(), n = needle(req), event = clean(req.query.event, 60), actorType = clean(req.query.actorType, 20);
    const adminsById = new Map(db.admins.map(a => [a.id, a]));
    const rows = [...db.auditLog].reverse().map(e => ({
      seq: e.seq || null, id: e.id, at: e.at, event: e.event, chained: !!e.hash,
      actor: e.actor || (e.userId ? {type: 'user', id: e.userId} : null),
      actorLabel: e.actor?.type === 'admin' ? (adminsById.get(e.actor.id)?.email || 'deleted admin') : e.actor?.type || (e.userId ? 'user' : 'system'),
      target: e.target || null, meta: e.meta || {},
    })).filter(e => (!event || e.event === event) && (!actorType || e.actor?.type === actorType) && hit(n, e.event, e.actorLabel, e.target?.id, e.actor?.id, JSON.stringify(e.meta)));
    res.json({...pageOf(req, rows), events: [...new Set(db.auditLog.map(e => e.event))].sort()});
  });
  router.get('/admin/audit/verify', requireAdmin('audit.read'), async (req, res) => {
    const result = verifyAudit(await customer.store());
    await customer.mutate(db => { appendAudit(db, {event: 'audit_verified', actor: actorOf(req), meta: {ok: result.ok, checked: result.checked}}); });
    res.json(result);
  });

  // ---------------- Roles & administrators ----------------
  router.get('/admin/roles', requireAdmin('admins.read'), (_req, res) => res.json({roles: ROLES, permissions: PERMISSIONS}));
  router.get('/admin/admins', requireAdmin('admins.read'), async (req, res) => {
    const db = await customer.store(), n = needle(req);
    res.json(pageOf(req, db.admins.filter(a => hit(n, a.email, a.name, a.role)).sort(newest).map(publicAdmin)));
  });
  router.post('/admin/admins', requireAdmin('admins.write'), async (req, res) => {
    try {
      const role = clean(req.body?.role, 20);
      if (role === 'owner' && req.admin.role !== 'owner') return res.status(403).json({error: 'Only an owner can create another owner.'});
      const a = await buildAdmin({email: req.body?.email, name: req.body?.name, role, password: String(req.body?.password || ''), createdBy: req.admin.id});
      let dup = false;
      await customer.mutate(db => {
        if (db.admins.some(x => x.email === a.email)) { dup = true; return; }
        db.admins.push(a);
        appendAudit(db, {event: 'admin_created', actor: actorOf(req), target: {type: 'admin', id: a.id}, meta: {role}});
      });
      if (dup) return res.status(409).json({error: 'An administrator with this email already exists.'});
      res.status(201).json({admin: publicAdmin(a)});
    } catch (e) { fail(res, e); }
  });
  // Lost authenticator: an owner/admins.write holder resets another admin's MFA (they re-enroll at next sign-in).
  router.post('/admin/admins/:id/mfa/reset', requireAdmin('admins.write'), async (req, res) => {
    try {
      const reason = reasonOf(req);
      if (req.params.id === req.admin.id) return res.status(409).json({error: 'Use your own security settings to change your two-factor authentication.'});
      let outcome;
      await customer.mutate(db => {
        const a = db.admins.find(x => x.id === req.params.id);
        if (!a) { outcome = {status: 404, error: 'Administrator not found.'}; return; }
        const had = !!a.mfa?.enabled;
        delete a.mfa;
        db.adminSessions = db.adminSessions.filter(s => s.adminId !== a.id);
        appendAudit(db, {event: 'admin_mfa_reset', actor: actorOf(req), target: {type: 'admin', id: a.id}, meta: {wasEnabled: had, reason}});
        outcome = {status: 200, admin: publicAdmin(a)};
      });
      if (outcome.status !== 200) return res.status(outcome.status).json({error: outcome.error});
      res.json({admin: outcome.admin});
    } catch (e) { fail(res, e); }
  });

  router.patch('/admin/admins/:id', requireAdmin('admins.write'), async (req, res) => {
    const role = req.body?.role === undefined ? undefined : clean(req.body.role, 20);
    const status = req.body?.status === undefined ? undefined : clean(req.body.status, 20);
    if (req.params.id === req.admin.id) return res.status(409).json({error: 'You cannot change your own role or status.'});
    if (role !== undefined && !ROLES[role]) return res.status(400).json({error: 'Unknown role.'});
    if (status !== undefined && !['active', 'disabled'].includes(status)) return res.status(400).json({error: 'Status must be active or disabled.'});
    if (role === 'owner' && req.admin.role !== 'owner') return res.status(403).json({error: 'Only an owner can grant the owner role.'});
    let outcome;
    await customer.mutate(db => {
      const a = db.admins.find(x => x.id === req.params.id);
      if (!a) { outcome = {status: 404, error: 'Administrator not found.'}; return; }
      const next = {role: role ?? a.role, status: status ?? a.status};
      const ownersAfter = db.admins.filter(x => (x.id === a.id ? next.role === 'owner' && next.status === 'active' : x.role === 'owner' && x.status === 'active')).length;
      if (ownersAfter === 0) { outcome = {status: 409, error: 'At least one active owner must remain.'}; return; }
      const before = {role: a.role, status: a.status};
      Object.assign(a, next);
      if (next.status === 'disabled' || next.role !== before.role) db.adminSessions = db.adminSessions.filter(s => s.adminId !== a.id);
      appendAudit(db, {event: 'admin_updated', actor: actorOf(req), target: {type: 'admin', id: a.id}, meta: {before, after: next}});
      outcome = {status: 200, admin: publicAdmin(a)};
    });
    if (outcome.status !== 200) return res.status(outcome.status).json({error: outcome.error});
    res.json({admin: outcome.admin});
  });

  return router;
}
