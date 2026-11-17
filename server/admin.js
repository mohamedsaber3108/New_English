// Administration: individual admin accounts, role-based access control, admin sessions and operations APIs.
//
// Security model
//  - Admins are separate from learners (own table, own cookie, own sessions). A learner session can never
//    reach /api/admin, and an admin session is never sent to learner endpoints (cookie Path=/api/admin).
//  - Cookie: HttpOnly; SameSite=Strict; Secure in production. Absolute lifetime ADMIN_SESSION_MS (8h),
//    idle timeout ADMIN_IDLE_MS (30 min). Session tokens are stored only as SHA-256 hashes.
//  - Every route declares the permission it needs; roles map to permission sets (see ROLES).
//  - Every state-changing action is recorded in the tamper-evident audit chain inside the same database
//    transaction as the change itself. Sensitive actions require a written reason.
//  - CSRF: SameSite=Strict cookie + the app-wide Origin check on non-GET requests.
//  - Legacy shared token (ADMIN_ACCESS_TOKEN) is DISABLED by default. ADMIN_LEGACY_TOKEN=true re-enables it
//    temporarily during migration, read-only (viewer role), and every use is audited.
import express from 'express';
import {readFile} from 'node:fs/promises';
import {randomBytes, randomUUID, createHash, timingSafeEqual} from 'node:crypto';
import {passwordHash, checkPassword, dummyCheck, validPassword} from './passwords.js';
import {newSecret, verifyTotp, otpauthUri, sealSecret, openSecret, base32Encode} from './totp.js';
import {isUniqueViolation} from './db/index.js';

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

const needle = req => clean(req.query.q, 100);
const paging = req => ({page: req.query.page, pageSize: req.query.pageSize});
const reasonOf = req => { const r = clean(req.body?.reason, 500); if (r.length < 5) throw Object.assign(Error('A reason of at least 5 characters is required for this action.'), {status: 400}); return r; };
const httpError = (status, error) => Object.assign(Error(error), {status});

export function adminRouter(customer, {leadsFile, integrations = () => ({}), configFindings = () => []} = {}) {
  const router = express.Router();
  const {repo} = customer;
  const db = () => customer.db();
  const audit = (q, input) => repo.audit.append(q, input);
  const actorOf = req => req.admin.legacy ? {type: 'legacy-token'} : {type: 'admin', id: req.admin.id, role: req.admin.role};
  const fail = (res, e) => res.status(e.status || 500).json({error: e.status ? e.message : 'Unexpected server error.'});

  function readCookie(req) {
    const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1);
    return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
  }
  // Only fully authenticated sessions grant access. An MFA challenge session (stage 'mfa') never does.
  async function currentAdmin(req, q) {
    const raw = readCookie(req);
    if (!raw) return null;
    const now = Date.now(), s = await repo.adminSessions.byHash(q, sha(raw));
    if (!s || s.stage !== 'full' || s.expires <= now || s.lastSeen <= now - idleMs()) return null;
    const admin = await repo.admins.byId(q, s.adminId);
    return admin?.status === 'active' ? {admin, session: s} : null;
  }
  // Creates a full session under a fresh token. Runs inside the caller's transaction.
  async function issueFullSession(q, req, admin, now) {
    const token = randomBytes(32).toString('hex');
    await repo.adminSessions.purge(q, now, idleMs());
    await repo.adminSessions.create(q, {id: randomUUID(), hash: sha(token), adminId: admin.id, stage: 'full', createdAt: now, lastSeen: now, expires: now + sessionMs(), device: clean(req.get('user-agent') || 'Browser', 120)});
    await repo.admins.update(q, admin.id, {lastLoginAt: nowIso()});
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
        await (await db()).tx(q => audit(q, {event: 'admin_legacy_token_used', actor: {type: 'legacy-token'}, meta: {path: req.path}}));
        return next();
      }
      const d = await db();
      const found = await currentAdmin(req, d);
      if (!found) return res.status(401).json({error: 'Administrator sign-in required.'});
      if (mfaRequired() && !found.admin.mfa?.enabled && !allowUnenrolled) return res.status(403).json({error: 'Two-factor authentication must be enabled before using the console.', mfaEnrollmentRequired: true});
      if (perm && !can(found.admin.role, perm)) {
        await d.tx(q => audit(q, {event: 'admin_permission_denied', actor: {type: 'admin', id: found.admin.id, role: found.admin.role}, meta: {permission: perm, method: req.method, path: req.path}}));
        return res.status(403).json({error: 'Your role does not allow this action.'});
      }
      req.admin = found.admin; req.adminSession = found.session;
      if (Date.now() - found.session.lastSeen > 60000) await repo.adminSessions.touch(d, found.session.id, Date.now());
      next();
    } catch (e) { fail(res, e); }
  };

  // ---------------- Authentication ----------------
  router.post('/admin/auth/login', customer.throttle, async (req, res) => {
    const email = clean(req.body?.email, 120).toLowerCase(), password = String(req.body?.password || '');
    try {
      const d = await db();
      const admin = await repo.admins.byEmail(d, email);
      const valid = admin ? await checkPassword(password, admin.password) : await dummyCheck(password);
      if (!admin || !valid || admin.status !== 'active') {
        await d.tx(q => audit(q, {event: 'admin_login_failed', actor: admin ? {type: 'admin', id: admin.id} : null, meta: {emailHash: sha(email).slice(0, 16), reason: !admin ? 'unknown' : !valid ? 'password' : 'disabled'}}));
        return res.status(401).json({error: 'Incorrect email or password.'});
      }
      const now = Date.now();
      if (admin.mfa?.enabled) {
        // Password is correct but MFA is on: issue a short-lived challenge session that grants nothing.
        const challenge = randomBytes(32).toString('hex');
        await d.tx(async q => {
          await repo.adminSessions.create(q, {id: randomUUID(), hash: sha(challenge), adminId: admin.id, stage: 'mfa', attempts: 0, createdAt: now, lastSeen: now, expires: now + CHALLENGE_MS});
          await audit(q, {event: 'admin_login_mfa_challenge', actor: {type: 'admin', id: admin.id}});
        });
        setCookie(req, res, challenge, CHALLENGE_MS);
        return res.json({mfaRequired: true});
      }
      const token = await d.tx(async q => {
        const t = await issueFullSession(q, req, admin, now);
        await audit(q, {event: 'admin_login', actor: {type: 'admin', id: admin.id, role: admin.role}, meta: {mfa: 'none'}});
        return t;
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
      const raw = readCookie(req);
      const outcome = await (await db()).tx(async q => {
        const s = raw && await repo.adminSessions.byHash(q, sha(raw), {lock: true});
        const a = s && s.stage === 'mfa' && s.expires > Date.now() && await repo.admins.byId(q, s.adminId, {lock: true});
        if (!a || a.status !== 'active' || !a.mfa?.enabled) return {status: 401, error: 'Sign-in expired. Enter your email and password again.'};
        const attempts = (s.attempts || 0) + 1;
        let method = null, mfa = a.mfa;
        if (recovery) {
          const h = recoveryHash(recovery), rc = (mfa.recovery || []).find(r => r.hash === h && !r.usedAt);
          if (rc) { mfa = {...mfa, recovery: mfa.recovery.map(r => r === rc ? {...r, usedAt: nowIso()} : r)}; method = 'recovery'; }
        } else {
          const v = verifyTotp(openSecret(mfa.secret, mfaKey()), code, {lastStep: mfa.lastStep ?? -1});
          if (v.ok) { mfa = {...mfa, lastStep: v.step}; method = 'totp'; }
        }
        if (!method) {
          const exhausted = attempts >= CHALLENGE_ATTEMPTS;
          if (exhausted) await repo.adminSessions.remove(q, s.id); else await repo.adminSessions.setAttempts(q, s.id, attempts);
          await audit(q, {event: 'admin_mfa_failed', actor: {type: 'admin', id: a.id}, meta: {attempt: attempts, exhausted, kind: recovery ? 'recovery' : 'totp'}});
          return {status: 401, error: exhausted ? 'Too many incorrect codes. Sign in again.' : 'Incorrect code.', restart: exhausted};
        }
        await repo.admins.update(q, a.id, {mfa});
        await repo.adminSessions.remove(q, s.id);
        const token = await issueFullSession(q, req, a, Date.now());
        const left = (mfa.recovery || []).filter(r => !r.usedAt).length;
        await audit(q, {event: 'admin_login', actor: {type: 'admin', id: a.id, role: a.role}, meta: {mfa: method, ...(method === 'recovery' ? {recoveryCodesLeft: left} : {})}});
        return {status: 200, token, admin: {...a, mfa}, left, method};
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
      await repo.admins.update(await db(), req.admin.id, {mfa: {enabled: false, pending: sealSecret(secret, mfaKey()), pendingAt: Date.now()}});
      // The secret is shown once so the admin can add it to an authenticator app; only the sealed form is stored.
      res.json({secret, otpauthUri: otpauthUri({secret, account: req.admin.email})});
    } catch (e) { fail(res, e); }
  });
  router.post('/admin/mfa/enable', requireAdmin(null, {allowUnenrolled: true}), async (req, res) => {
    try {
      if (!mfaKey()) throw mfaUnavailable();
      const codes = Array.from({length: RECOVERY_CODES}, newRecoveryCode);
      const outcome = await (await db()).tx(async q => {
        const a = await repo.admins.byId(q, req.admin.id, {lock: true});
        if (a.mfa?.enabled) return {status: 409, error: 'Two-factor authentication is already enabled.'};
        if (!a.mfa?.pending || Date.now() - a.mfa.pendingAt > 15 * 60 * 1000) return {status: 409, error: 'Start setup again (the setup key expired after 15 minutes).'};
        const v = verifyTotp(openSecret(a.mfa.pending, mfaKey()), req.body?.code);
        if (!v.ok) return {status: 400, error: 'Incorrect code. Check the time on your phone and try again.'};
        await repo.admins.update(q, a.id, {mfa: {enabled: true, secret: a.mfa.pending, enabledAt: nowIso(), lastStep: v.step, recovery: codes.map(c => ({hash: recoveryHash(c)}))}});
        // Other sessions were authenticated without MFA: end them, keep the current one.
        await repo.adminSessions.removeForAdmin(q, a.id, req.adminSession.id);
        await audit(q, {event: 'admin_mfa_enabled', actor: {type: 'admin', id: a.id, role: a.role}});
        return {status: 200};
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
      const ok = await (await db()).tx(async q => {
        const a = await repo.admins.byId(q, req.admin.id, {lock: true});
        const v = verifyTotp(openSecret(a.mfa.secret, mfaKey()), req.body?.code, {lastStep: a.mfa.lastStep ?? -1});
        if (!v.ok) return false;
        await repo.admins.update(q, a.id, {mfa: null});
        await audit(q, {event: 'admin_mfa_disabled', actor: {type: 'admin', id: a.id, role: a.role}});
        return true;
      });
      if (!ok) return res.status(400).json({error: 'Incorrect code.'});
      res.json({ok: true, mfaEnrollmentRequired: mfaRequired()});
    } catch (e) { fail(res, e); }
  });

  router.post('/admin/auth/logout', async (req, res) => {
    try {
      const raw = readCookie(req);
      if (raw) await (await db()).tx(async q => { const s = await repo.adminSessions.removeByHash(q, sha(raw)); if (s) await audit(q, {event: 'admin_logout', actor: {type: 'admin', id: s.adminId}}); });
    } catch {}
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
      await (await db()).tx(async q => {
        await repo.admins.update(q, req.admin.id, {password: digest});
        await repo.adminSessions.removeForAdmin(q, req.admin.id, req.adminSession.id);
        await audit(q, {event: 'admin_password_changed', actor: actorOf(req)});
      });
      res.json({ok: true, message: 'Password changed. Other administrator sessions were signed out.'});
    } catch (e) { fail(res, e); }
  });

  // ---------------- Overview ----------------
  router.get('/admin/overview', requireAdmin('dashboard.read'), async (_req, res) => {
    try { res.json({...await repo.overview(await db()), integrations: integrations(), configWarnings: configFindings()}); } catch (e) { fail(res, e); }
  });

  // ---------------- Users ----------------
  const userRow = (u, now = Date.now()) => {
    const e = u.entitlements?.English;
    return {id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt, emailVerified: !!u.emailVerified, status: u.status || 'active', subscription: e ? {plan: e.plan, expiresAt: e.expiresAt, active: e.expiresAt > now, source: e.source || 'payment'} : null, hasProfile: !!u.profile};
  };
  router.get('/admin/users', requireAdmin('users.read'), async (req, res) => {
    try {
      const r = await repo.users.list(await db(), {needle: needle(req), status: clean(req.query.status, 20), verified: clean(req.query.verified, 5), subscription: clean(req.query.subscription, 20), ...paging(req)});
      res.json({...r, items: r.items.map(u => userRow(u))});
    } catch (e) { fail(res, e); }
  });
  router.get('/admin/users/:id', requireAdmin('users.read'), async (req, res) => {
    try {
      const d = await db(), u = await repo.users.byId(d, req.params.id);
      if (!u) return res.status(404).json({error: 'User not found.'});
      const p = {...(u.profile || {}), ...await customer.learning.progress(d, u)}; // server-computed progress
      const due = (p.reviews || []).filter(c => c.due <= Date.now()).length;
      res.json({
        user: userRow(u),
        learning: {level: p.level || null, xp: p.xp || 0, streak: p.streak || 0, sessions: (await repo.learning.history(d, u.id, {pageSize: 1})).total, reviews: (p.reviews || []).length, reviewsDue: due, lastActive: p.lastActive || null, assessedAt: p.assessedAt || null},
        recentActivity: (p.sessions || []).slice(0, 10).map(({id, title, date, xp}) => ({ref: id, title, date, xp})),
        activeSessions: await repo.sessions.countForUser(d, u.id),
        orders: (await repo.orders.listForUser(d, u.id)).map(({reference, plan, term, amount, status, createdAt, paidAt, expiresAt}) => ({reference, plan, term, amount, status, createdAt, paidAt, expiresAt})),
        tickets: (await repo.tickets.listForUser(d, u.id)).map(({reference, subject, status, category, createdAt}) => ({reference, subject, status, category, createdAt})),
      });
    } catch (e) { fail(res, e); }
  });
  // Shared shape for "act on one learner inside a transaction, audit it, return the updated row".
  const userAction = (perm, fn) => [requireAdmin(perm), async (req, res) => {
    try {
      const out = await (await db()).tx(async q => {
        const u = await repo.users.lockById(q, req.params.id);
        if (!u) throw httpError(404, 'User not found.');
        const extra = await fn(q, u, req);
        return {user: userRow(await repo.users.byId(q, u.id)), ...extra};
      });
      res.json(out);
    } catch (e) { fail(res, e); }
  }];
  router.patch('/admin/users/:id/status', ...userAction('users.write', async (q, u, req) => {
    const status = clean(req.body?.status, 20), reason = reasonOf(req);
    if (!['active', 'suspended'].includes(status)) throw httpError(400, 'Status must be active or suspended.');
    await repo.users.update(q, u.id, {status});
    if (status === 'suspended') await repo.sessions.removeForUser(q, u.id);
    await audit(q, {event: 'user_status_changed', actor: actorOf(req), target: {type: 'user', id: u.id}, meta: {from: u.status || 'active', to: status, reason}});
  }));
  router.post('/admin/users/:id/revoke-sessions', ...userAction('users.write', async (q, u, req) => {
    const reason = reasonOf(req), count = await repo.sessions.removeForUser(q, u.id);
    await audit(q, {event: 'user_sessions_revoked', actor: actorOf(req), target: {type: 'user', id: u.id}, meta: {count, reason}});
    return {ok: true, revoked: count};
  }));
  router.post('/admin/users/:id/verify-email', ...userAction('users.write', async (q, u, req) => {
    const reason = reasonOf(req);
    await repo.users.update(q, u.id, {emailVerified: true});
    await audit(q, {event: 'user_email_marked_verified', actor: actorOf(req), target: {type: 'user', id: u.id}, meta: {reason}});
  }));
  router.post('/admin/users/:id/entitlements', ...userAction('orders.write', async (q, u, req) => {
    const reason = reasonOf(req), plan = clean(req.body?.plan, 20), days = parseInt(req.body?.days, 10);
    if (!['essential', 'plus'].includes(plan) || !(days >= 1 && days <= 400)) throw httpError(400, 'Choose a plan (essential/plus) and 1-400 days.');
    const now = Date.now(), prior = u.entitlements?.English, start = prior?.expiresAt > now ? prior.expiresAt : now;
    const expiresAt = start + days * 86400000;
    await repo.entitlements.set(q, u.id, 'English', {plan, expiresAt, source: 'manual', grantedBy: req.admin.id, grantedAt: nowIso()});
    await audit(q, {event: 'entitlement_granted', actor: actorOf(req), target: {type: 'user', id: u.id}, meta: {language: 'English', plan, days, expiresAt, reason}});
  }));
  router.delete('/admin/users/:id/entitlements/English', ...userAction('orders.write', async (q, u, req) => {
    const reason = reasonOf(req), had = await repo.entitlements.remove(q, u.id, 'English');
    await audit(q, {event: 'entitlement_revoked', actor: actorOf(req), target: {type: 'user', id: u.id}, meta: {language: 'English', existed: had, reason}});
    return {revoked: had};
  }));

  // ---------------- Orders ----------------
  router.get('/admin/orders', requireAdmin('orders.read'), async (req, res) => {
    try {
      const r = await repo.orders.list(await db(), {needle: needle(req), status: clean(req.query.status, 30), plan: clean(req.query.plan, 20), ...paging(req)});
      res.json({...r, items: r.items.map(({intentionId, ...o}) => o)});
    } catch (e) { fail(res, e); }
  });
  // Manual activation after staff independently reconciled the payment (replaces scripts/activate-manual.mjs).
  router.post('/admin/orders/:reference/activate', requireAdmin('orders.write'), async (req, res) => {
    try {
      const reason = reasonOf(req), paymentReference = clean(req.body?.paymentReference, 80);
      if (paymentReference.length < 6) return res.status(400).json({error: 'Enter the verified payment reference (at least 6 characters).'});
      const order = await (await db()).tx(async q => {
        const o = await repo.orders.byRef(q, req.params.reference, {lock: true});
        if (!o) throw httpError(404, 'Order not found.');
        if (o.status !== 'pending_contact') throw httpError(409, `Only orders awaiting manual payment can be activated (this one is ${o.status}).`);
        if (await repo.orders.manualRefUsed(q, paymentReference)) throw httpError(409, 'This payment reference was already used for another order.');
        const u = o.userId && await repo.users.lockById(q, o.userId);
        if (!u) throw httpError(409, 'The customer account no longer exists.');
        const now = Date.now(), prior = u.entitlements?.[o.language];
        const d = new Date(prior?.expiresAt > now ? prior.expiresAt : now); d.setUTCMonth(d.getUTCMonth() + (o.term === 'yearly' ? 12 : 1));
        const patch = {status: 'paid', paidAt: new Date(now).toISOString(), expiresAt: d.getTime(), manualPaymentReference: paymentReference, activatedBy: req.admin.id};
        try { await repo.orders.update(q, o.reference, patch); }
        catch (e) { if (isUniqueViolation(e)) throw httpError(409, 'This payment reference was already used for another order.'); throw e; }
        await repo.entitlements.set(q, u.id, o.language, {plan: o.plan, expiresAt: d.getTime(), orderReference: o.reference, source: 'manual_payment'});
        await audit(q, {event: 'order_manually_activated', actor: actorOf(req), target: {type: 'order', id: o.reference}, meta: {userId: u.id, amount: o.amount, paymentReference, expiresAt: d.getTime(), reason}});
        return {...o, ...patch};
      });
      res.json({order});
    } catch (e) { fail(res, e); }
  });
  // Records a refund decision and removes the access it paid for. The money itself is returned through the
  // payment provider's merchant dashboard; this endpoint does NOT move money.
  router.post('/admin/orders/:reference/refund', requireAdmin('orders.write'), async (req, res) => {
    try {
      const reason = reasonOf(req);
      const out = await (await db()).tx(async q => {
        const o = await repo.orders.byRef(q, req.params.reference, {lock: true});
        if (!o) throw httpError(404, 'Order not found.');
        if (o.status !== 'paid') throw httpError(409, `Only paid orders can be marked refunded (this one is ${o.status}).`);
        const revoked = o.userId ? await repo.entitlements.removeIfOrder(q, o.userId, o.language, o.reference) : false;
        const patch = {status: 'refunded', refundedAt: nowIso(), refundedBy: req.admin.id};
        await repo.orders.update(q, o.reference, patch);
        await audit(q, {event: 'order_refund_recorded', actor: actorOf(req), target: {type: 'order', id: o.reference}, meta: {userId: o.userId, amount: o.amount, entitlementRevoked: revoked, reason}});
        return {order: {...o, ...patch}, entitlementRevoked: revoked};
      });
      res.json({...out, notice: 'Refund recorded. Return the money in the payment provider dashboard; this action does not move funds.'});
    } catch (e) { fail(res, e); }
  });

  // ---------------- Support ----------------
  const TICKET_STATUS = ['open', 'in_progress', 'resolved', 'closed'];
  router.get('/admin/support', requireAdmin('support.read'), async (req, res) => {
    try { res.json(await repo.tickets.list(await db(), {needle: needle(req), status: clean(req.query.status, 20), category: clean(req.query.category, 30), ...paging(req)})); } catch (e) { fail(res, e); }
  });
  router.patch('/admin/support/:reference', requireAdmin('support.write'), async (req, res) => {
    try {
      const status = clean(req.body?.status, 20), resolution = clean(req.body?.resolution, 800);
      if (!TICKET_STATUS.includes(status)) return res.status(400).json({error: 'Invalid status.'});
      const ticket = await (await db()).tx(async q => {
        const t = await repo.tickets.byRef(q, req.params.reference);
        if (!t) throw httpError(404, 'Ticket not found.');
        await repo.tickets.update(q, t.reference, {status, resolution, updatedBy: req.admin.id});
        await audit(q, {event: 'support_updated', actor: actorOf(req), target: {type: 'ticket', id: t.reference}, meta: {from: t.status, to: status}});
        return repo.tickets.byRef(q, t.reference);
      });
      res.json({ticket});
    } catch (e) { fail(res, e); }
  });

  // ---------------- Leads ----------------
  const LEAD_STATUS = ['new', 'contacted', 'qualified', 'converted', 'closed'];
  // One-time import of the legacy JSONL leads file (idempotent by reference).
  async function importLegacyLeads() {
    const d = await db();
    if (!leadsFile || await repo.meta.get(d, 'leads_jsonl_imported')) return;
    let rows = [];
    try { rows = (await readFile(leadsFile, 'utf8')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r?.reference); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await d.tx(async q => {
      if (await repo.meta.get(q, 'leads_jsonl_imported')) return;
      for (const r of rows) await repo.leads.create(q, r);
      await repo.meta.set(q, 'leads_jsonl_imported', {at: nowIso(), count: rows.length});
      if (rows.length) await audit(q, {event: 'leads_imported', actor: {type: 'system'}, meta: {count: rows.length}});
    });
  }
  router.get('/admin/leads', requireAdmin('leads.read'), async (req, res) => {
    try {
      await importLegacyLeads();
      res.json(await repo.leads.list(await db(), {needle: needle(req), status: clean(req.query.status, 20), kind: clean(req.query.kind, 20), ...paging(req)}));
    } catch (e) { fail(res, e); }
  });
  router.patch('/admin/leads/:reference', requireAdmin('leads.write'), async (req, res) => {
    try {
      const status = clean(req.body?.status, 20), note = clean(req.body?.note, 1000);
      if (!LEAD_STATUS.includes(status)) return res.status(400).json({error: 'Invalid lead status.'});
      const lead = await (await db()).tx(async q => {
        const before = await repo.leads.byRef(q, req.params.reference);
        if (!before) throw httpError(404, 'Lead not found.');
        const after = await repo.leads.update(q, before.reference, {status, note: note || null, adminId: req.admin.id});
        await audit(q, {event: 'lead_updated', actor: actorOf(req), target: {type: 'lead', id: before.reference}, meta: {from: before.status || 'new', to: status, noted: !!note}});
        return after;
      });
      res.json({lead});
    } catch (e) { fail(res, e); }
  });

  // ---------------- Audit ----------------
  router.get('/admin/audit', requireAdmin('audit.read'), async (req, res) => {
    try {
      const d = await db();
      const r = await repo.audit.list(d, {needle: needle(req), event: clean(req.query.event, 60), actorType: clean(req.query.actorType, 20), ...paging(req)});
      const emails = await repo.admins.emailsById(d, [...new Set(r.items.filter(e => e.actor?.type === 'admin').map(e => e.actor.id))]);
      const items = r.items.map(e => {
        const actor = e.actor || (e.legacy?.userId ? {type: 'user', id: e.legacy.userId} : null);
        return {seq: e.seq > 0 ? e.seq : null, id: e.id, at: e.at, event: e.event, chained: !!e.hash, actor,
          actorLabel: actor?.type === 'admin' ? (emails.get(actor.id) || 'deleted admin') : actor?.type || 'system', target: e.target || null, meta: e.meta || {}};
      });
      res.json({...r, items, events: await repo.audit.events(d)});
    } catch (e) { fail(res, e); }
  });
  router.get('/admin/audit/verify', requireAdmin('audit.read'), async (req, res) => {
    try {
      const d = await db(), result = await repo.audit.verify(d);
      await d.tx(q => audit(q, {event: 'audit_verified', actor: actorOf(req), meta: {ok: result.ok, checked: result.checked}}));
      res.json(result);
    } catch (e) { fail(res, e); }
  });

  // ---------------- Roles & administrators ----------------
  router.get('/admin/roles', requireAdmin('admins.read'), (_req, res) => res.json({roles: ROLES, permissions: PERMISSIONS}));
  router.get('/admin/admins', requireAdmin('admins.read'), async (req, res) => {
    try { const r = await repo.admins.list(await db(), {needle: needle(req), ...paging(req)}); res.json({...r, items: r.items.map(publicAdmin)}); } catch (e) { fail(res, e); }
  });
  router.post('/admin/admins', requireAdmin('admins.write'), async (req, res) => {
    try {
      const role = clean(req.body?.role, 20);
      if (role === 'owner' && req.admin.role !== 'owner') return res.status(403).json({error: 'Only an owner can create another owner.'});
      const a = await buildAdmin({email: req.body?.email, name: req.body?.name, role, password: String(req.body?.password || ''), createdBy: req.admin.id});
      try {
        await (await db()).tx(async q => { await repo.admins.create(q, a); await audit(q, {event: 'admin_created', actor: actorOf(req), target: {type: 'admin', id: a.id}, meta: {role}}); });
      } catch (e) { if (isUniqueViolation(e)) return res.status(409).json({error: 'An administrator with this email already exists.'}); throw e; }
      res.status(201).json({admin: publicAdmin(a)});
    } catch (e) { fail(res, e); }
  });
  // Lost authenticator: an owner/admins.write holder resets another admin's MFA (they re-enroll at next sign-in).
  router.post('/admin/admins/:id/mfa/reset', requireAdmin('admins.write'), async (req, res) => {
    try {
      const reason = reasonOf(req);
      if (req.params.id === req.admin.id) return res.status(409).json({error: 'Use your own security settings to change your two-factor authentication.'});
      const admin = await (await db()).tx(async q => {
        const a = await repo.admins.byId(q, req.params.id, {lock: true});
        if (!a) throw httpError(404, 'Administrator not found.');
        await repo.admins.update(q, a.id, {mfa: null});
        await repo.adminSessions.removeForAdmin(q, a.id);
        await audit(q, {event: 'admin_mfa_reset', actor: actorOf(req), target: {type: 'admin', id: a.id}, meta: {wasEnabled: !!a.mfa?.enabled, reason}});
        return publicAdmin({...a, mfa: null});
      });
      res.json({admin});
    } catch (e) { fail(res, e); }
  });
  router.patch('/admin/admins/:id', requireAdmin('admins.write'), async (req, res) => {
    try {
      const role = req.body?.role === undefined ? undefined : clean(req.body.role, 20);
      const status = req.body?.status === undefined ? undefined : clean(req.body.status, 20);
      if (req.params.id === req.admin.id) return res.status(409).json({error: 'You cannot change your own role or status.'});
      if (role !== undefined && !ROLES[role]) return res.status(400).json({error: 'Unknown role.'});
      if (status !== undefined && !['active', 'disabled'].includes(status)) return res.status(400).json({error: 'Status must be active or disabled.'});
      if (role === 'owner' && req.admin.role !== 'owner') return res.status(403).json({error: 'Only an owner can grant the owner role.'});
      const admin = await (await db()).tx(async q => {
        const a = await repo.admins.byId(q, req.params.id, {lock: true});
        if (!a) throw httpError(404, 'Administrator not found.');
        const next = {role: role ?? a.role, status: status ?? a.status};
        const ownersAfter = await repo.admins.activeOwnersExcept(q, a.id) + (next.role === 'owner' && next.status === 'active' ? 1 : 0);
        if (ownersAfter === 0) throw httpError(409, 'At least one active owner must remain.');
        const before = {role: a.role, status: a.status};
        await repo.admins.update(q, a.id, next);
        if (next.status === 'disabled' || next.role !== before.role) await repo.adminSessions.removeForAdmin(q, a.id);
        await audit(q, {event: 'admin_updated', actor: actorOf(req), target: {type: 'admin', id: a.id}, meta: {before, after: next}});
        return publicAdmin({...a, ...next});
      });
      res.json({admin});
    } catch (e) { fail(res, e); }
  });

  return router;
}
