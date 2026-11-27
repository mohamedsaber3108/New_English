// Learner accounts, sessions, learning-profile sync, orders/entitlements and the Paymob webhook.
// Data lives in relational tables (server/db): PostgreSQL when DATABASE_URL is set, embedded PGlite otherwise.
import express from 'express';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID, createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {createRateLimiter} from './ratelimit.js';
import {passwordHash, checkPassword, dummyCheck} from './passwords.js';
import {createDb, pgliteDirFromEnv, isUniqueViolation} from './db/index.js';
import {autoImport} from './db/legacy-import.js';
import * as repo from './db/repo.js';
import {log} from './observability.js';
import {createLearning} from './learning.js';

const learning = createLearning(repo);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const legacyFile = process.env.CUSTOMER_DB_FILE || join(root, 'data', 'customers.json');
const prices = {essential: {monthly: 300, yearly: 3000}, plus: {monthly: 450, yearly: 4500}};
const maxAge = 30 * 24 * 60 * 60 * 1000;

// Database: opened once per process, migrations applied, legacy document imported on first start.
let dbPromise = null, backendName = process.env.DATABASE_URL ? 'postgres' : 'pglite';
function getDb() {
  dbPromise ??= (async () => {
    const db = await createDb({dataDir: pgliteDirFromEnv(root)});
    backendName = db.backend;
    const r = await autoImport(db, {jsonFile: legacyFile});
    if (r.imported) log('info', 'legacy data imported', {source: r.source, counts: r.counts});
    return db;
  })().catch(e => { dbPromise = null; throw e; }); // a failed start (e.g. DB down) is retried on the next request
  return dbPromise;
}

const clean = (value, max = 120) => String(value ?? '').trim().slice(0, max);
const hash = value => createHash('sha256').update(value).digest('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const publicUser = u => ({id: u.id, name: u.name, email: u.email, phone: u.phone, createdAt: u.createdAt, emailVerified: !!u.emailVerified, preferences: u.preferences || {product: true, learning: true, marketing: false}, entitlements: u.entitlements || {}});
const cookie = (token, secure) => `usam_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge / 1000}${secure ? '; Secure' : ''}`;
const clearCookie = 'usam_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
const sessionToken = req => { const raw = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('usam_session='))?.slice(13); return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null; };

// Resolves the learner session from the request cookie: one indexed session lookup + one user lookup.
async function sessionFromRequest(req, q) {
  const raw = sessionToken(req);
  if (!raw) return null;
  q ??= await getDb();
  const session = await repo.sessions.findValid(q, hash(raw));
  if (!session) return null;
  const user = await repo.users.byId(q, session.userId);
  return user && user.status !== 'suspended' ? {user, session} : null;
}
async function requireUser(req, res, next) {
  try {
    const data = await sessionFromRequest(req);
    if (!data) return res.status(401).json({error: 'سجّل دخولك أولًا.'});
    req.customer = data.user; req.customerSession = data.session;
    next();
  } catch { res.status(503).json({error: 'الخدمة غير متاحة حاليًا.'}); }
}
function active(user, language = 'English', plan = 'essential') { const e = user?.entitlements?.[language]; return !!e && e.expiresAt > Date.now() && (plan !== 'plus' || e.plan === 'plus'); }

// Brute-force protection for auth endpoints (shared across instances when REDIS_URL is set):
//   10 attempts / 15 min per IP, and 20 attempts / 15 min per target email (blocks distributed guessing).
const authLimiter = createRateLimiter();
const AUTH_WINDOW = 900000;
async function throttle(req, res, next) {
  const tooMany = () => res.status(429).json({error: 'محاولات كثيرة. جرب بعد ١٥ دقيقة.'});
  const ipR = await authLimiter.consume(`auth-ip:${req.ip || 'local'}`, Number(process.env.AUTH_IP_LIMIT || 10), AUTH_WINDOW);
  if (!ipR.allowed) return tooMany();
  const email = clean(req.body?.email, 120).toLowerCase();
  if (email) { const eR = await authLimiter.consume(`auth-email:${hash(email)}`, Number(process.env.AUTH_EMAIL_LIMIT || 20), AUTH_WINDOW); if (!eR.allowed) return tooMany(); }
  next();
}

async function createSession(req, res, q, userId) {
  const token = randomBytes(32).toString('hex'), now = Date.now();
  await repo.sessions.create(q, {id: randomUUID(), hash: hash(token), userId, createdAt: now, lastSeen: now, device: clean(req.get('user-agent') || 'Browser', 120), expires: now + maxAge});
  res.setHeader('Set-Cookie', cookie(token, req.secure || process.env.NODE_ENV === 'production'));
}
function validInput(b) {
  const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), phone = clean(b.phone, 25), password = String(b.password || '');
  return {name, email, phone, password, valid: name.length >= 2 && /^\S+@\S+\.\S+$/.test(email) && phone.replace(/\D/g, '').length >= 8 && password.length >= 12 && password.length <= 128};
}
function hmacTransaction(obj) {
  const vals = [obj.amount_cents, obj.created_at, obj.currency, obj.error_occured, obj.has_parent_transaction, obj.id, obj.integration_id, obj.is_3d_secure, obj.is_auth, obj.is_capture, obj.is_refunded, obj.is_standalone_payment, obj.is_voided, obj.order?.id, obj.owner, obj.pending, obj.source_data?.pan, obj.source_data?.sub_type, obj.source_data?.type, obj.success];
  return createHmac('sha512', process.env.PAYMOB_HMAC_SECRET).update(vals.map(x => String(x ?? '')).join('')).digest('hex');
}
const paymentEnabled = () => !!(process.env.PAYMOB_SECRET_KEY && process.env.PAYMOB_PUBLIC_KEY && process.env.PAYMOB_INTEGRATION_IDS && process.env.PAYMOB_HMAC_SECRET && process.env.SITE_ORIGIN?.startsWith('https://'));
// Access enforcement is decoupled from payment configuration (security: fail closed).
// ACCESS_ENFORCEMENT=open -> learning content open to everyone (explicit free/preview deployments only).
// ACCESS_ENFORCEMENT=enforced|auto (default) -> a valid entitlement is required; absence of Paymob keys never opens content.
const accessMode = () => { const v = String(process.env.ACCESS_ENFORCEMENT || 'auto').toLowerCase(); return ['open', 'enforced', 'auto'].includes(v) ? v : 'auto'; };
const enforcementEnabled = () => accessMode() !== 'open';

export function customerRouter() {
  const router = express.Router();
  // Housekeeping: drop expired learner sessions periodically instead of on every login.
  setInterval(async () => { try { await repo.sessions.purgeExpired(await getDb()); } catch {} }, 15 * 60 * 1000).unref();

  router.get('/customer/catalog', (_req, res) => res.json({language: 'English', prices, currency: 'EGP', checkoutAvailable: paymentEnabled(), accessEnforced: enforcementEnabled(), billing: 'one-time paid periods; no automatic renewal'}));

  router.post('/customer/register', throttle, async (req, res) => {
    const v = validInput(req.body || {});
    if (!v.valid) return res.status(400).json({error: 'اكتب اسمًا وبريدًا وهاتفًا صحيحين وكلمة مرور ١٢ حرفًا على الأقل.'});
    try {
      const db = await getDb();
      if (await repo.users.byEmail(db, v.email)) return res.status(409).json({error: 'البريد مسجل بالفعل. جرّب تسجيل الدخول.'});
      const user = {id: randomUUID(), name: v.name, email: v.email, phone: v.phone, password: await passwordHash(v.password), createdAt: new Date().toISOString(), emailVerified: false, preferences: {product: true, learning: true, marketing: false}, entitlements: {}, profile: null};
      await db.tx(async q => { await repo.users.create(q, user); await createSession(req, res, q, user.id); });
      res.status(201).json({user: publicUser(user)});
    } catch (e) {
      if (isUniqueViolation(e)) { res.removeHeader('Set-Cookie'); return res.status(409).json({error: 'البريد مسجل بالفعل.'}); } // concurrent sign-up race
      res.status(503).json({error: 'تعذر إنشاء الحساب الآن.'});
    }
  });

  router.post('/customer/login', throttle, async (req, res) => {
    const email = clean(req.body?.email, 120).toLowerCase(), password = String(req.body?.password || '');
    try {
      const db = await getDb();
      const user = await repo.users.byEmail(db, email);
      if (!user) { await dummyCheck(password); return res.status(401).json({error: 'البريد أو كلمة المرور غير صحيحة.'}); }
      if (!await checkPassword(password, user.password)) return res.status(401).json({error: 'البريد أو كلمة المرور غير صحيحة.'});
      if (user.status === 'suspended') return res.status(403).json({error: 'هذا الحساب موقوف. تواصل مع الدعم.'});
      await createSession(req, res, db, user.id);
      res.json({user: publicUser(user)});
    } catch { res.status(503).json({error: 'تعذر تسجيل الدخول الآن.'}); }
  });

  router.post('/customer/logout', async (req, res) => {
    try { const raw = sessionToken(req); if (raw) await repo.sessions.removeByHash(await getDb(), hash(raw)); } catch {}
    res.setHeader('Set-Cookie', clearCookie);
    res.json({ok: true});
  });

  // The profile returned here merges the learner's own settings (name, goal, minutes, self-reported level) with
  // progress COMPUTED on the server from stored activities, review cards and assessments.
  router.get('/customer/me', requireUser, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const progress = await learning.progress(await getDb(), req.customer);
      res.json({user: publicUser(req.customer), profile: {...(req.customer.profile || {}), ...progress}});
    } catch { res.status(503).json({error: 'الخدمة غير متاحة حاليًا.'}); }
  });

  // ---------------- Learning records ----------------
  // Writing learning records is part of the paid learning experience: same entitlement rule as the practice APIs.
  const requireLearningAccess = (req, res, next) => requireUser(req, res, () => (!enforcementEnabled() || active(req.customer)) ? next() : res.status(402).json({error: 'اشتراك الإنجليزية غير نشط. افتح صفحة حسابك لاختيار باقة.'}));
  const send = (res, fn) => fn().catch(e => res.status(e.status || 503).json({error: e.status ? e.message : 'تعذر حفظ نشاط التعلم الآن.'}));
  router.get('/customer/learning/progress', requireUser, (req, res) => send(res, async () => { res.setHeader('Cache-Control', 'no-store'); res.json({progress: await learning.progress(await getDb(), req.customer)}); }));
  router.post('/customer/learning/activities', requireLearningAccess, (req, res) => send(res, async () => {
    const r = await learning.recordActivity(await getDb(), req.customer, req.body || {});
    res.status(r.duplicate ? 200 : 201).json(r);
  }));
  router.get('/customer/learning/history', requireUser, (req, res) => send(res, async () => {
    const db = await getDb(); await learning.ensureImported(db, req.customer);
    res.json(await repo.learning.history(db, req.customer.id, {page: req.query.page, pageSize: req.query.pageSize}));
  }));
  router.get('/customer/learning/reviews', requireUser, (req, res) => send(res, async () => {
    const db = await getDb(); await learning.ensureImported(db, req.customer);
    res.json({cards: req.query.due === 'true' ? await repo.learning.dueCards(db, req.customer.id) : await repo.learning.cards(db, req.customer.id)});
  }));
  router.post('/customer/learning/reviews', requireLearningAccess, (req, res) => send(res, async () => res.json(await learning.gradeReview(await getDb(), req.customer, req.body))));
  router.get('/customer/learning/assessments', requireUser, (req, res) => send(res, async () => res.json({assessments: await repo.learning.assessments(await getDb(), req.customer.id)})));

  // Full personal-data export (data portability). Everything stored about the learner, minus secrets
  // (password hash, session/token hashes).
  router.get('/customer/export', requireUser, (req, res) => send(res, async () => {
    const db = await getDb(), u = req.customer;
    await learning.ensureImported(db, u);
    const all = [];
    for (let p = 1; ; p++) { const h = await repo.learning.history(db, u.id, {page: p, pageSize: 100}); all.push(...h.items); if (p >= h.pages) break; }
    const body = {
      exportedAt: new Date().toISOString(), format: 'usam-language-export/1',
      account: {...publicUser(u), status: u.status},
      learningSettings: u.profile ? Object.fromEntries(Object.entries(u.profile).filter(([k]) => ['name', 'goal', 'minutes', 'assessmentDone', 'level', 'skills'].includes(k))) : null,
      progress: await learning.progress(db, u),
      activities: all,
      reviewCards: await repo.learning.cards(db, u.id),
      assessments: await repo.learning.assessments(db, u.id),
      orders: await repo.orders.listForUser(db, u.id),
      supportTickets: await repo.tickets.listForUser(db, u.id),
      sessions: (await repo.sessions.listForUser(db, u.id)).map(({id, createdAt, lastSeen, device, expires}) => ({id, createdAt, lastSeen, device, expires})),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="usam-language-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(body);
  }));

  // Edit account identity fields (name, phone). Email changes need re-verification and are not editable here yet.
  router.patch('/customer/account', requireUser, async (req, res) => {
    const name = clean(req.body?.name, 80), phone = clean(req.body?.phone, 25);
    if (name.length < 2 || phone.replace(/\D/g, '').length < 8) return res.status(400).json({error: 'اكتب اسمًا صحيحًا ورقم هاتف صحيحًا.'});
    const db = await getDb();
    await repo.users.update(db, req.customer.id, {name, phone});
    const updated = await repo.users.byId(db, req.customer.id);
    if (!updated) return res.status(404).json({error: 'الحساب غير موجود.'});
    res.json({user: publicUser(updated)});
  });

  // Change password: verify the current one, same policy as registration, end all OTHER sessions.
  router.post('/customer/password/change', requireUser, async (req, res) => {
    const current = String(req.body?.currentPassword || ''), next = String(req.body?.newPassword || '');
    if (!await checkPassword(current, req.customer.password)) return res.status(403).json({error: 'كلمة المرور الحالية غير صحيحة.'});
    if (next.length < 12 || next.length > 128) return res.status(400).json({error: 'كلمة المرور الجديدة يجب أن تكون ١٢ حرفًا على الأقل.'});
    if (safeEq(current, next)) return res.status(400).json({error: 'اختر كلمة مرور مختلفة عن الحالية.'});
    const digest = await passwordHash(next);
    await (await getDb()).tx(async q => { await repo.users.update(q, req.customer.id, {password: digest}); await repo.sessions.removeForUser(q, req.customer.id, req.customerSession.hash); });
    res.json({ok: true, message: 'تم تغيير كلمة المرور. تم إنهاء الجلسات الأخرى.'});
  });

  // Learning-progress sync: a single-row update (no longer rewrites the whole data set).
  router.put('/customer/profile', requireUser, async (req, res) => {
    const p = req.body?.profile;
    if (!p || typeof p !== 'object' || Array.isArray(p) || JSON.stringify(p).length > 80000) return res.status(400).json({error: 'بيانات التقدم غير صالحة.'});
    // Only the learner's own settings are accepted. XP, streak, sessions, evidence, completed and review cards are
    // computed on the server from learning records and are ignored here (they can no longer be set by the browser).
    const allowed = ['name', 'goal', 'minutes', 'assessmentDone', 'level', 'skills'];
    const profile = Object.fromEntries(allowed.filter(k => Object.hasOwn(p, k)).map(k => [k, p[k]]));
    try {
      const db = await getDb();
      await learning.ensureImported(db, req.customer); // convert any legacy blob before it is replaced
      await repo.users.update(db, req.customer.id, {profile});
      res.json({ok: true});
    }
    catch { res.status(503).json({error: 'تعذر حفظ التقدم الآن.'}); }
  });

  router.get('/customer/orders', requireUser, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const list = await repo.orders.listForUser(await getDb(), req.customer.id);
    res.json({orders: list.map(({reference, plan, term, language, amount, status, createdAt, paidAt, expiresAt}) => ({reference, plan, term, language, amount, status, createdAt, paidAt, expiresAt}))});
  });

  router.post('/customer/orders', requireUser, async (req, res) => {
    if (!req.customer.emailVerified && process.env.REQUIRE_VERIFIED_EMAIL === 'true') return res.status(403).json({error: 'أكد بريدك الإلكتروني قبل بدء الدفع.'});
    const plan = clean(req.body?.plan, 20), term = clean(req.body?.term, 20), language = clean(req.body?.language, 20);
    if (language !== 'English' || !prices[plan]?.[term]) return res.status(400).json({error: 'الإنجليزية فقط متاحة الآن؛ اختر باقة ومدة صحيحتين.'});
    const db = await getDb();
    const amount = prices[plan][term], order = {reference: 'USL-' + randomUUID().slice(0, 12).toUpperCase(), userId: req.customer.id, language, plan, term, amount, status: paymentEnabled() ? 'pending_payment' : 'pending_contact', createdAt: new Date().toISOString()};
    await repo.orders.create(db, order);
    if (!paymentEnabled()) return res.status(201).json({reference: order.reference, status: order.status, message: 'طلب الاشتراك اتسجل. لا يوجد تحصيل إلكتروني مفعل؛ تواصل معنا لتأكيد الدفع والتفعيل.'});
    try {
      const origin = process.env.SITE_ORIGIN.replace(/\/$/, '');
      const names = req.customer.name.split(/\s+/), total = amount * 100;
      const body = {amount: total, currency: 'EGP', payment_methods: process.env.PAYMOB_INTEGRATION_IDS.split(',').map(x => Number(x.trim())).filter(Number.isFinite), items: [{name: `USAM Language English ${plan} ${term}`, amount: total, description: 'One language, one paid period', quantity: 1}], billing_data: {first_name: names[0], last_name: names.slice(1).join(' ') || names[0], email: req.customer.email, phone_number: req.customer.phone}, special_reference: order.reference, notification_url: origin + '/api/paymob/webhook', redirection_url: origin + '/#payment-result'};
      if (!body.payment_methods.length) throw Error('Invalid integration');
      const response = await fetch('https://accept.paymob.com/v1/intention/', {method: 'POST', headers: {Authorization: 'Token ' + process.env.PAYMOB_SECRET_KEY, 'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)});
      const data = await response.json();
      if (!response.ok || !data.client_secret || !data.intention_order_id) throw Error('Gateway unavailable');
      await repo.orders.update(db, order.reference, {paymobOrderId: String(data.intention_order_id), intentionId: String(data.id || '')});
      return res.status(201).json({reference: order.reference, status: 'pending_payment', checkoutUrl: `https://accept.paymob.com/unifiedcheckout/?publicKey=${encodeURIComponent(process.env.PAYMOB_PUBLIC_KEY)}&clientSecret=${encodeURIComponent(data.client_secret)}`});
    } catch {
      await repo.orders.update(db, order.reference, {status: 'checkout_error'}).catch(() => {});
      res.status(502).json({error: 'تعذر بدء الدفع الآن. لم يتم خصم أي مبلغ؛ حاول لاحقًا.'});
    }
  });

  // Paymob server-to-server callback. HMAC-verified; amount/currency/integration checked against our order.
  // Order and user rows are locked in one transaction so duplicate/concurrent callbacks cannot double-grant.
  router.post('/paymob/webhook', async (req, res) => {
    if (!process.env.PAYMOB_HMAC_SECRET) return res.sendStatus(503);
    const obj = req.body?.obj, received = String(req.query.hmac || '');
    if (req.body?.type !== 'TRANSACTION' || !obj || !/^[a-f0-9]{128}$/i.test(received) || !safeEq(hmacTransaction(obj), received.toLowerCase())) return res.sendStatus(403);
    const db = await getDb();
    // Everything below runs in ONE transaction: the verified event is stored together with its effect and its outcome.
    // Replay protection is the provider event id ("<transaction id>:<state>") plus the order status checks below; a
    // refund/void reuses the original transaction id and a failed attempt may be followed by a success with the same id,
    // so the transaction id alone is never a reason to skip an event. Only events already APPLIED are replays; events that
    // were rejected, unmatched or ignored are processed again when the provider retries (e.g. the order now has its id).
    // A concurrent twin waits on the locked event row. The DB also enforces one order per provider transaction id
    // (orders_transaction_key); if that is ever violated the event is recorded as 'rejected' and nothing is paid.
    const state = obj.is_refunded ? 'refunded' : obj.is_voided ? 'voided' : obj.success === true && obj.pending === false ? 'success' : obj.pending === false ? 'failed' : 'pending';
    const eventId = `${obj.id}:${state}`, rawBody = req.rawBody ?? JSON.stringify(req.body);
    let outcome;
    try {
      outcome = await db.tx(async q => {
        const order = await repo.orders.byPaymob(q, String(obj.order?.id || ''));
        const matched = order && order.reference === String(obj.order?.merchant_order_id || order.reference) ? order : null;
        const ev = await repo.paymentEvents.claim(q, {provider: 'paymob', eventId, orderRef: matched?.reference || null, rawBody, signatureVerified: true});
        if (ev.replay) {
          if (ev.previousOrderRef && matched && ev.previousOrderRef !== matched.reference) log('warn', 'payment event already applied to another order', {eventId, order: matched.reference, appliedTo: ev.previousOrderRef});
          return {status: 200};
        }
        const done = async (code, result) => { await repo.paymentEvents.setOutcome(q, ev.id, result, matched?.reference || null); return {status: code}; };
        if (!matched) return done(200, 'unmatched');
        const valid = Number(obj.amount_cents) === matched.amount * 100 && obj.currency === (matched.currency || 'EGP') && String(obj.integration_id) && process.env.PAYMOB_INTEGRATION_IDS.split(',').map(x => x.trim()).includes(String(obj.integration_id));
        if (!valid) return done(400, 'rejected');
        const o = await repo.orders.byRef(q, matched.reference, {lock: true});
        const u = o?.userId && await repo.users.lockById(q, o.userId);
        if (!o || !u) return done(200, 'unmatched');
        if (state === 'refunded' || state === 'voided') {
          await repo.orders.update(q, o.reference, {status: 'refunded'});
          await repo.entitlements.removeIfOrder(q, u.id, o.language, o.reference);
          return done(200, 'applied');
        }
        if (state === 'success') {
          if (o.status === 'paid' || o.status === 'refunded') return done(200, 'ignored'); // never pay twice, never pay a refunded order
          const now = Date.now(), prior = u.entitlements[o.language];
          const d = new Date(prior?.expiresAt > now ? prior.expiresAt : now);
          d.setUTCMonth(d.getUTCMonth() + (o.term === 'yearly' ? 12 : 1));
          await repo.orders.update(q, o.reference, {status: 'paid', paidAt: new Date(now).toISOString(), expiresAt: d.getTime(), transactionId: String(obj.id)});
          await repo.entitlements.set(q, u.id, o.language, {plan: o.plan, expiresAt: d.getTime(), orderReference: o.reference, source: 'payment'});
          return done(200, 'applied');
        }
        if (state === 'failed') {
          if (o.status === 'paid' || o.status === 'refunded') return done(200, 'ignored'); // a late failure never downgrades a paid or refunded order
          await repo.orders.update(q, o.reference, {status: 'failed', transactionId: String(obj.id)});
          return done(200, 'applied');
        }
        return done(200, 'ignored'); // pending: nothing to do yet
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // The failed transaction rolled back, including its own event row: record the anomaly separately and pay nothing.
      log('warn', 'payment webhook rejected: provider transaction id already belongs to another order', {eventId, constraint: e.constraint || null});
      await repo.paymentEvents.markRejected(db, {provider: 'paymob', eventId, orderRef: String(obj.order?.merchant_order_id || '') || null, rawBody});
      outcome = {status: 200};
    }
    if (outcome.status !== 200) return res.sendStatus(outcome.status);
    res.json({ok: true});
  });

  router.get('/customer/access', requireUser, (req, res) => res.json({english: active(req.customer), plus: active(req.customer, 'English', 'plus')}));

  // Self-service deletion. Cascades remove sessions, orders, tickets, tokens and entitlements. Chained audit entries
  // hold only the pseudonymous id and are never rewritten (that would break tamper evidence); pre-chain entries
  // have their user id cleared.
  router.delete('/customer/account', requireUser, async (req, res) => {
    if (!await checkPassword(String(req.body?.password || ''), req.customer.password)) return res.status(403).json({error: 'كلمة المرور غير صحيحة.'});
    await (await getDb()).tx(async q => {
      await repo.paymentEvents.removeForUser(q, req.customer.id); // provider payloads hold billing data; must go before the orders do
      await repo.users.remove(q, req.customer.id);
      await q.query("UPDATE audit_log SET legacy = jsonb_set(legacy, '{userId}', 'null') WHERE hash IS NULL AND legacy->>'userId' = $1", [req.customer.id]);
    });
    res.setHeader('Set-Cookie', clearCookie);
    res.json({ok: true});
  });

  return {
    router, throttle, rateLimitStatus: () => authLimiter.status(), requireUser, active, sessionFromRequest, db: getDb, repo, learning,
    publicUser, clean, hash, passwordHash, checkPassword, paymentEnabled, accessMode, enforcementEnabled,
    storageBackend: () => backendName, storageHealth: async () => (await getDb()).health(), storageClose: async () => { if (dbPromise) await (await dbPromise).close(); },
    hasAccess: async req => { if (!enforcementEnabled()) return true; const found = await sessionFromRequest(req); return active(found?.user); },
  };
}
