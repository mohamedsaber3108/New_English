// Learner account operations: email verification, password recovery, preferences, sessions, support, receipts,
// first-party analytics. Admin APIs live in server/admin.js.
import express from 'express';
import {randomBytes, randomUUID} from 'node:crypto';

const token = () => randomBytes(32).toString('hex');
const html = v => String(v).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const nowIso = () => new Date().toISOString();

async function sendEmail({to, subject, body}) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return {sent: false};
  const response = await fetch('https://api.resend.com/emails', {method: 'POST', headers: {Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json'}, body: JSON.stringify({from: process.env.EMAIL_FROM, to: [to], subject, html: `<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#163b32"><h2>USAM Language</h2>${body}<p style="font-size:12px;color:#607b72">لو لم تطلب هذه الرسالة، تجاهلها.</p></div>`}), signal: AbortSignal.timeout(12000)});
  if (!response.ok) throw Error('email_provider');
  return {sent: true};
}

export function operationsRouter(customer) {
  const router = express.Router();
  const {repo} = customer;
  // Learner-side audit events go into the tamper-evident chain (opaque user id only, no PII), inside the same
  // transaction as the change they record.
  const addAudit = (q, event, userId = null, meta = {}) => repo.audit.append(q, {event, actor: userId ? {type: 'user', id: userId} : null, meta});
  const issue = async (user, purpose) => {
    const raw = token(), now = Date.now(), expires = now + (purpose === 'verify' ? 24 * 60 * 60 * 1000 : 30 * 60 * 1000);
    await (await customer.db()).tx(async q => { await repo.tokens.issue(q, {hash: customer.hash(raw), userId: user.id, purpose, expires, now}); await addAudit(q, `${purpose}_token_issued`, user.id); });
    return raw;
  };
  const publicOrigin = () => String(process.env.SITE_ORIGIN || '').replace(/\/$/, '');

  router.post('/customer/email/verification', customer.throttle, customer.requireUser, async (req, res) => {
    if (req.customer.emailVerified) return res.json({ok: true, message: 'البريد مؤكد بالفعل.'});
    if (!publicOrigin()) return res.status(503).json({error: 'رابط الموقع العام غير مضبوط على الخادم.'});
    try {
      const raw = await issue(req.customer, 'verify');
      const url = `${publicOrigin()}/#verify-email/${raw}`;
      const sent = await sendEmail({to: req.customer.email, subject: 'أكد بريدك في USAM Language', body: `<p>اضغط لتأكيد بريدك:</p><p><a href="${html(url)}">تأكيد البريد الإلكتروني</a></p><p>الرابط صالح لمدة ٢٤ ساعة.</p>`});
      if (!sent.sent) return res.status(503).json({error: 'خدمة البريد غير مفعلة بعد. تواصل مع الدعم لتأكيد الحساب.'});
      res.json({ok: true, message: 'أرسلنا رابط التأكيد إلى بريدك.'});
    } catch { res.status(502).json({error: 'تعذر إرسال رسالة التأكيد الآن.'}); }
  });

  router.post('/customer/email/verify', customer.throttle, async (req, res) => {
    const raw = String(req.body?.token || '');
    if (!/^[a-f0-9]{64}$/.test(raw)) return res.status(400).json({error: 'رابط التأكيد غير صالح.'});
    const ok = await (await customer.db()).tx(async q => {
      const userId = await repo.tokens.consume(q, customer.hash(raw), 'verify');
      if (!userId) return false;
      await repo.users.update(q, userId, {emailVerified: true});
      await addAudit(q, 'email_verified', userId);
      return true;
    });
    if (!ok) return res.status(400).json({error: 'رابط التأكيد انتهى أو استُخدم من قبل.'});
    res.json({ok: true, message: 'تم تأكيد البريد بنجاح.'});
  });

  router.post('/customer/password/forgot', customer.throttle, async (req, res) => {
    const email = customer.clean(req.body?.email, 120).toLowerCase();
    const generic = {ok: true, message: 'لو البريد مسجل، ستصلك رسالة استعادة خلال دقائق.'};
    try {
      const user = await repo.users.byEmail(await customer.db(), email);
      if (user && publicOrigin()) {
        const raw = await issue(user, 'reset');
        const url = `${publicOrigin()}/#reset-password/${raw}`;
        await sendEmail({to: user.email, subject: 'استعادة كلمة مرور USAM Language', body: `<p>استخدم الرابط التالي لتعيين كلمة مرور جديدة:</p><p><a href="${html(url)}">استعادة كلمة المرور</a></p><p>الرابط صالح لمدة ٣٠ دقيقة ويُستخدم مرة واحدة.</p>`});
      }
    } catch {}
    res.json(generic); // same answer whether or not the email exists
  });

  router.post('/customer/password/reset', customer.throttle, async (req, res) => {
    const raw = String(req.body?.token || ''), password = String(req.body?.password || '');
    if (!/^[a-f0-9]{64}$/.test(raw) || password.length < 12 || password.length > 128) return res.status(400).json({error: 'الرابط أو كلمة المرور غير صالحين.'});
    const digest = await customer.passwordHash(password);
    const changed = await (await customer.db()).tx(async q => {
      const userId = await repo.tokens.consume(q, customer.hash(raw), 'reset');
      if (!userId) return false;
      await repo.users.update(q, userId, {password: digest});
      await repo.sessions.removeForUser(q, userId);
      await repo.tokens.removeForUser(q, userId);
      await addAudit(q, 'password_reset', userId);
      return true;
    });
    if (!changed) return res.status(400).json({error: 'الرابط انتهى أو استُخدم من قبل.'});
    res.json({ok: true, message: 'تم تغيير كلمة المرور. سجّل دخولك من جديد.'});
  });

  router.get('/customer/preferences', customer.requireUser, (req, res) => res.json({preferences: customer.publicUser(req.customer).preferences}));
  router.put('/customer/preferences', customer.requireUser, async (req, res) => {
    const preferences = {product: req.body?.product !== false, learning: req.body?.learning !== false, marketing: req.body?.marketing === true};
    await (await customer.db()).tx(async q => { await repo.users.update(q, req.customer.id, {preferences}); await addAudit(q, 'preferences_updated', req.customer.id); });
    res.json({ok: true, preferences});
  });

  router.get('/customer/sessions', customer.requireUser, async (req, res) => {
    const list = await repo.sessions.listForUser(await customer.db(), req.customer.id);
    res.json({sessions: list.map(x => ({id: x.id || 'current', createdAt: x.createdAt || null, lastSeen: x.lastSeen || null, device: x.device || 'Browser', current: x.hash === req.customerSession.hash}))});
  });
  router.delete('/customer/sessions/:id', customer.requireUser, async (req, res) => {
    const id = customer.clean(req.params.id, 60);
    await (await customer.db()).tx(async q => { await repo.sessions.removeById(q, req.customer.id, id); await addAudit(q, 'session_revoked', req.customer.id, {sessionId: id}); });
    res.json({ok: true});
  });
  router.delete('/customer/sessions', customer.requireUser, async (req, res) => {
    await (await customer.db()).tx(async q => { await repo.sessions.removeForUser(q, req.customer.id, req.customerSession.hash); await addAudit(q, 'other_sessions_revoked', req.customer.id); });
    res.json({ok: true});
  });

  router.post('/customer/support', customer.requireUser, async (req, res) => {
    const subject = customer.clean(req.body?.subject, 120), message = customer.clean(req.body?.message, 2000), category = customer.clean(req.body?.category, 30);
    if (subject.length < 3 || message.length < 10 || !['account', 'payment', 'learning', 'technical', 'other'].includes(category)) return res.status(400).json({error: 'اكتب عنوانًا ورسالة واضحة واختر نوع الطلب.'});
    const ticket = {reference: 'SUP-' + randomUUID().slice(0, 8).toUpperCase(), userId: req.customer.id, category, subject, message, status: 'open', createdAt: nowIso(), updatedAt: nowIso()};
    await (await customer.db()).tx(async q => { await repo.tickets.create(q, ticket); await addAudit(q, 'support_created', req.customer.id, {reference: ticket.reference}); });
    res.status(201).json({ok: true, reference: ticket.reference, status: ticket.status});
  });
  router.get('/customer/support', customer.requireUser, async (req, res) => {
    const list = await repo.tickets.listForUser(await customer.db(), req.customer.id);
    res.json({tickets: list.map(({reference, category, subject, status, createdAt, updatedAt, resolution}) => ({reference, category, subject, status, createdAt, updatedAt, resolution}))});
  });

  router.get('/customer/receipts/:reference', customer.requireUser, async (req, res) => {
    const o = await repo.orders.byRef(await customer.db(), String(req.params.reference));
    if (!o || o.userId !== req.customer.id) return res.status(404).json({error: 'الطلب غير موجود.'}); // no cross-account access (IDOR)
    if (o.status !== 'paid' && o.status !== 'refunded') return res.status(409).json({error: 'الإيصال يظهر بعد تأكيد الدفع.'});
    res.json({receipt: {reference: o.reference, status: o.status, language: o.language, plan: o.plan, term: o.term, amount: o.amount, currency: 'EGP', paidAt: o.paidAt, expiresAt: o.expiresAt, customer: {name: req.customer.name, email: req.customer.email}}});
  });

  router.post('/events', async (req, res) => {
    const name = customer.clean(req.body?.name, 60), allowed = ['page_view', 'cta', 'lesson_start', 'lesson_complete', 'checkout_start', 'support_open', 'consent'];
    if (!allowed.includes(name)) return res.status(400).json({error: 'Invalid event'});
    try {
      const found = await customer.sessionFromRequest(req);
      const meta = req.body?.meta && typeof req.body.meta === 'object' && !Array.isArray(req.body.meta) && JSON.stringify(req.body.meta).length <= 2000 ? req.body.meta : {};
      await repo.analytics.add(await customer.db(), {id: randomUUID(), name, userId: found?.user?.id || null, path: customer.clean(req.body?.path, 120), meta, at: nowIso()});
    } catch {}
    res.status(202).json({ok: true});
  });

  return router;
}
