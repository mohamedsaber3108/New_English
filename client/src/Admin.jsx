// USAM Language — Operations console (admin).
// Individual administrator sign-in, role-aware navigation, and operational screens backed by /api/admin.
// Every action calls the real API; the server enforces permissions — the UI only hides what a role cannot do.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Activity, BadgeCheck, ClipboardList, FileClock, Inbox, KeyRound, LayoutDashboard, LifeBuoy, LogOut, RefreshCw, Search, ShieldCheck, ShoppingCart, UserCog, Users} from 'lucide-react';
import './admin.css';
import {clearSwCaches} from './swCache.js';

class ApiError extends Error { constructor(message, status, data = {}) { super(message); this.status = status; this.data = data; } }
async function rawApi(path, {method = 'GET', body} = {}) {
  const r = await fetch('/api/admin/' + path, {method, credentials: 'same-origin', headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new ApiError(data.error || 'تعذر إكمال الطلب.', r.status, data);
  return data;
}
// A sensitive action answers 403 {stepUp:true} (password needed) or 400 {needReason:true}. The console then opens the
// step-up dialog (registered by AdminConsole) and repeats the request once with the written reason.
let stepUpOpener = null, lastApiAt = Date.now();
async function adminApi(path, opts = {}, retried = false) {
  try { const d = await rawApi(path, opts); lastApiAt = Date.now(); return d; }
  catch (e) {
    if (retried || !stepUpOpener || !(e.data?.stepUp || e.data?.needReason)) throw e;
    const r = await stepUpOpener({needPassword: !!e.data.stepUp, needReason: String(opts.body?.reason || '').trim().length < 5});
    return adminApi(path, {...opts, body: {...(opts.body || {}), ...(r.reason ? {reason: r.reason} : {})}}, true);
  }
}
const qs = obj => new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== '' && v != null)).toString();
const fmtDate = v => v ? new Date(v).toLocaleString('ar-EG', {dateStyle: 'medium', timeStyle: 'short'}) : '—';
const fmtDay = v => v ? new Date(v).toLocaleDateString('ar-EG') : '—';

const ROLE_LABEL = {owner: 'مالك', admin: 'مسؤول', finance: 'مالية', support: 'دعم', viewer: 'مشاهدة فقط'};
const ORDER_STATUS = {pending_contact: 'بانتظار تأكيد الدفع', pending_payment: 'بانتظار الدفع', paid: 'مدفوع', failed: 'فشل الدفع', checkout_error: 'خطأ في بدء الدفع', refunded: 'مسترد'};
const TICKET_STATUS = {open: 'مفتوحة', in_progress: 'قيد المتابعة', resolved: 'محلولة', closed: 'مغلقة'};
const LEAD_STATUS = {new: 'جديد', contacted: 'تم التواصل', qualified: 'مؤهل', converted: 'تحول لعميل', closed: 'مغلق'};
const CATEGORY = {account: 'الحساب', payment: 'الدفع', learning: 'التعلم', technical: 'تقني', other: 'أخرى'};
const KIND = {subscription: 'اشتراك', meeting: 'اجتماع', language: 'لغة', question: 'سؤال'};

const TABS = [
  {id: 'overview', label: 'نظرة عامة', icon: LayoutDashboard, perm: 'dashboard.read'},
  {id: 'users', label: 'المتعلمون', icon: Users, perm: 'users.read'},
  {id: 'orders', label: 'الطلبات والاشتراكات', icon: ShoppingCart, perm: 'orders.read'},
  {id: 'support', label: 'الدعم', icon: LifeBuoy, perm: 'support.read'},
  {id: 'leads', label: 'طلبات التواصل', icon: Inbox, perm: 'leads.read'},
  {id: 'audit', label: 'سجل التدقيق', icon: FileClock, perm: 'audit.read'},
  {id: 'admins', label: 'المشرفون والأدوار', icon: UserCog, perm: 'admins.read'},
  {id: 'approvals', label: 'طلبات الموافقة', icon: BadgeCheck, perm: ['orders.write', 'admins.write']},
];
const PENDING_TEXT = 'تم حفظ الطلب. يلزم موافقة مشرف آخر قبل التنفيذ (قسم طلبات الموافقة).';
const allowed = (t, perms) => [].concat(t.perm).some(p => perms.includes(p));

// ---------------------------------------------------------------- shared UI
function Notice({kind = 'info', children}) { return children ? <div className={'ad-notice ' + kind} role={kind === 'error' ? 'alert' : 'status'}>{children}</div> : null; }
function Badge({tone = 'neutral', children}) { return <span className={'ad-badge ' + tone}>{children}</span>; }
function Pager({data, onPage}) {
  if (!data || data.pages <= 1) return data ? <div className="ad-pager"><span>{data.total} نتيجة</span></div> : null;
  return <div className="ad-pager"><span>{data.total} نتيجة · صفحة {data.page} من {data.pages}</span><div><button type="button" disabled={data.page <= 1} onClick={() => onPage(data.page - 1)}>السابق</button><button type="button" disabled={data.page >= data.pages} onClick={() => onPage(data.page + 1)}>التالي</button></div></div>;
}
function Toolbar({q, setQ, children, onRefresh}) {
  return <div className="ad-toolbar"><label className="ad-search"><Search size={16} aria-hidden="true"/><span className="ad-sr">بحث</span><input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="ابحث…"/></label>{children}<button type="button" className="ad-icon" onClick={onRefresh} title="تحديث" aria-label="تحديث"><RefreshCw size={16}/></button></div>;
}
function Select({label, value, onChange, options}) {
  return <label className="ad-filter"><span>{label}</span><select value={value} onChange={e => onChange(e.target.value)}><option value="">الكل</option>{Object.entries(options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>;
}

// Paged, searchable list bound to an admin endpoint. Search is debounced; filters reset to page 1.
function useList(path, filters, onAuthLost) {
  const [q, setQ] = useState(''), [page, setPage] = useState(1), [data, setData] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => { setDebounced(q); setPage(1); }, 300); return () => clearTimeout(t); }, [q]);
  const key = JSON.stringify(filters);
  useEffect(() => { setPage(1); }, [key]);
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try { setData(await adminApi(path + '?' + qs({q: debounced, page, pageSize: 20, ...filters}))); }
    catch (e) { if (e.status === 401) onAuthLost(); else setError(e.message); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, debounced, page, key]);
  useEffect(() => { load(); }, [load]);
  return {q, setQ, page, setPage, data, loading, error, reload: load};
}

// Runs an action, reports success/failure, and refreshes. 401 sends the admin back to sign-in.
function useAction(onAuthLost) {
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState({kind: '', text: ''});
  const run = async (fn, success) => {
    setBusy(true); setMsg({kind: '', text: ''});
    try { const r = await fn(); setMsg({kind: 'success', text: typeof success === 'function' ? success(r) : success}); return r; }
    catch (e) { if (e.status === 401) onAuthLost(); else setMsg({kind: 'error', text: e.message}); return null; }
    finally { setBusy(false); }
  };
  return {busy, msg, run, setMsg};
}

// Inline form for actions that require a written reason (recorded in the audit log).
function ReasonAction({label, tone = '', fields = [], onSubmit, busy, confirmText}) {
  const [open, setOpen] = useState(false), [values, setValues] = useState({}), [reason, setReason] = useState('');
  if (!open) return <button type="button" className={'ad-btn ' + tone} onClick={() => setOpen(true)}>{label}</button>;
  const valid = reason.trim().length >= 5 && fields.every(f => !f.required || String(values[f.name] ?? f.default ?? '').trim().length >= (f.min || 1));
  return <form className="ad-reason" onSubmit={async e => { e.preventDefault(); if (confirmText && !confirm(confirmText)) return; const ok = await onSubmit({...Object.fromEntries(fields.map(f => [f.name, values[f.name] ?? f.default ?? ''])), reason: reason.trim()}); if (ok) { setOpen(false); setReason(''); setValues({}); } }}>
    <b>{label}</b>
    {fields.map(f => <label key={f.name}><span>{f.label}</span>{f.options ? <select value={values[f.name] ?? f.default ?? ''} onChange={e => setValues({...values, [f.name]: e.target.value})}>{Object.entries(f.options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select> : <input type={f.type || 'text'} value={values[f.name] ?? f.default ?? ''} min={f.minValue} max={f.maxValue} onChange={e => setValues({...values, [f.name]: e.target.value})}/>}</label>)}
    <label><span>السبب (يُسجل في سجل التدقيق)</span><textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} minLength={5} maxLength={500} required/></label>
    <div className="ad-row"><button type="submit" className={'ad-btn primary ' + tone} disabled={busy || !valid}>{busy ? 'جاري التنفيذ…' : 'تأكيد'}</button><button type="button" className="ad-btn ghost" onClick={() => setOpen(false)}>إلغاء</button></div>
  </form>;
}

function Table({columns, rows, onRow, selected, empty = 'لا توجد نتائج.', rowKey}) {
  if (!rows?.length) return <div className="ad-empty">{empty}</div>;
  return <div className="ad-table-wrap"><table className="ad-table"><thead><tr>{columns.map(c => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={rowKey(r)} className={selected === rowKey(r) ? 'selected' : ''} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? e => { if (e.key === 'Enter') onRow(r); } : undefined}>{columns.map(c => <td key={c.key} lang={c.ltr ? 'en' : undefined} dir={c.ltr ? 'ltr' : undefined}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}</tr>)}</tbody></table></div>;
}
const ListState = ({list}) => list.loading && !list.data ? <div className="ad-empty">جاري التحميل…</div> : list.error ? <Notice kind="error">{list.error}</Notice> : null;

// ---------------------------------------------------------------- sign-in
function SignIn({onSignedIn, expired}) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [stage, setStage] = useState('password'), [code, setCode] = useState(''), [useRecovery, setUseRecovery] = useState(false);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const d = await adminApi('auth/login', {method: 'POST', body: {email, password}});
      setPassword('');
      if (d.mfaRequired) { setStage('mfa'); setCode(''); } else onSignedIn(d);
    }
    catch (err) { setError(err.status === 429 ? 'محاولات كثيرة. جرّب بعد ١٥ دقيقة.' : err.status === 401 ? 'البريد أو كلمة المرور غير صحيحة.' : err.message); }
    finally { setBusy(false); }
  };
  const submitCode = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { onSignedIn(await adminApi('auth/mfa', {method: 'POST', body: useRecovery ? {recoveryCode: code} : {code}})); }
    catch (err) {
      if (err.data?.restart || (err.status === 401 && !/Incorrect code/.test(err.message))) { setStage('password'); setError('انتهت محاولة الدخول أو تجاوزت عدد المحاولات. أدخل البريد وكلمة المرور من جديد.'); }
      else setError(err.status === 429 ? 'محاولات كثيرة. جرّب بعد ١٥ دقيقة.' : 'الرمز غير صحيح.');
    }
    finally { setBusy(false); setCode(''); }
  };
  const hero = <div className="x-hero"><span>USAM Language Operations</span><h1>لوحة <em>التشغيل.</em></h1><p>دخول بحساب مشرف شخصي. كل إجراء يُسجل باسم صاحبه في سجل تدقيق محمي من التعديل.</p></div>;
  if (stage === 'mfa') return <section className="x-page">{hero}
    <form className="x-card ad-login" onSubmit={submitCode}>
      <KeyRound size={30} aria-hidden="true"/>
      <h2>التحقق بخطوتين</h2>
      <p>{useRecovery ? 'أدخل أحد رموز الاسترداد التي حفظتها عند تفعيل التحقق بخطوتين. كل رمز يعمل مرة واحدة.' : 'أدخل الرمز المكون من ٦ أرقام من تطبيق المصادقة على هاتفك.'}</p>
      <label>{useRecovery ? 'رمز الاسترداد' : 'رمز التحقق'}<input lang="en" dir="ltr" className="ad-code" value={code} onChange={e => setCode(e.target.value)} autoFocus required {...(useRecovery ? {autoComplete: 'off', placeholder: 'xxxxx-xxxxx'} : {inputMode: 'numeric', autoComplete: 'one-time-code', pattern: '[0-9 ]{6,7}', maxLength: 7, placeholder: '123456'})}/></label>
      <button className="m-action" type="submit" disabled={busy}>{busy ? 'جاري التحقق…' : 'تأكيد'}</button>
      <Notice kind="error">{error}</Notice>
      <div className="ad-row"><button type="button" className="ad-btn ghost" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(''); }}>{useRecovery ? 'استخدام تطبيق المصادقة' : 'فقدت هاتفي — استخدام رمز استرداد'}</button><button type="button" className="ad-btn ghost" onClick={() => { setStage('password'); setError(''); }}>رجوع</button></div>
    </form></section>;
  return <section className="x-page">{hero}
    <form className="x-card ad-login" onSubmit={submit}>
      <ShieldCheck size={30} aria-hidden="true"/>
      <h2>تسجيل دخول المشرفين</h2>
      {expired && <Notice kind="info">انتهت جلستك أو تم تسجيل خروجك. سجّل دخولك من جديد.</Notice>}
      <label>البريد الإلكتروني<input type="email" lang="en" dir="ltr" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required/></label>
      <label>كلمة المرور<input type="password" lang="en" dir="ltr" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/></label>
      <button className="m-action" type="submit" disabled={busy}>{busy ? 'جاري الدخول…' : 'دخول آمن'}</button>
      <Notice kind="error">{error}</Notice>
      <small>لا يوجد حساب؟ يُنشئ المالك حسابات المشرفين من «المشرفون والأدوار»، وأول مالك يُنشأ عبر أداة الخادم <code lang="en" dir="ltr">npm run admin:create</code>.</small>
    </form></section>;
}

// ---------------------------------------------------------------- overview
function Overview({onAuthLost}) {
  const [d, setD] = useState(null), [err, setErr] = useState('');
  const load = async () => { setErr(''); try { setD(await adminApi('overview')); } catch (e) { if (e.status === 401) onAuthLost(); else setErr(e.message); } };
  useEffect(() => { load(); }, []);
  if (err) return <Notice kind="error">{err}</Notice>;
  if (!d) return <div className="ad-empty">جاري التحميل…</div>;
  const cards = [['المتعلمون', d.users], ['اشتراكات نشطة', d.activeEntitlements], ['بريد مؤكد', d.verified], ['حسابات موقوفة', d.suspended], ['طلبات مدفوعة', d.paidOrders], ['طلبات معلقة', d.pendingOrders], ['طلبات مستردة', d.refundedOrders], ['إيراد مسجل (جنيه)', d.revenuePaidEGP.toLocaleString('en-US')], ['تذاكر مفتوحة', d.openTickets], ['طلبات تواصل جديدة', d.newLeads]];
  const tone = v => v === 'configured' || v === 'enforced' || v === true || v === 'postgres' || v === 'redis' ? 'good' : v === 'awaiting credentials' || v === false || v === 'open' ? 'warn' : 'neutral';
  const INTEGRATION = {storage: 'التخزين', payments: 'الدفع (Paymob)', email: 'البريد (Resend)', ai: 'الذكاء الاصطناعي (OpenAI)', rateLimit: 'تحديد معدل الطلبات', rooms: 'الغرف الجماعية', auditKeyed: 'توقيع سجل التدقيق', accessEnforcement: 'فرض الاشتراك'};
  const VALUE = {configured: 'مفعّل', 'awaiting credentials': 'بانتظار بيانات الاعتماد', enforced: 'مفروض', open: 'مفتوح', true: 'مفعّل', false: 'غير مفعّل', json: 'ملف JSON (خادم واحد)', postgres: 'PostgreSQL', memory: 'ذاكرة (خادم واحد)', redis: 'Redis (مشترك)'};
  return <div className="ad-stack">
    {d.configWarnings?.length > 0 && <div className="x-card ad-config"><h2>تنبيهات إعداد الخادم ({d.configWarnings.length})</h2><p>إعدادات بيئة التشغيل التي تحتاج مراجعة قبل الإطلاق. لا تُعرض أي قيم سرية.</p><ul>{d.configWarnings.map(w => <li key={w.key}><code lang="en" dir="ltr">{w.key}</code> <span lang="en" dir="ltr">{w.message}</span></li>)}</ul></div>}
    <div className="ad-metrics">{cards.map(([l, v]) => <div className="ad-metric" key={l}><small>{l}</small><strong>{v}</strong></div>)}</div>
    <div className="x-card"><h2><Activity size={20} aria-hidden="true"/> حالة التكاملات</h2><p>تُعرض حالة الإعداد فقط؛ لا تُعرض أي مفاتيح سرية.</p>
      <div className="ad-integrations">{Object.entries(d.integrations || {}).map(([k, v]) => <div key={k}><span>{INTEGRATION[k] || k}</span><Badge tone={tone(v)}>{VALUE[String(v)] || String(v)}</Badge></div>)}</div></div>
  </div>;
}

// ---------------------------------------------------------------- users
function UsersScreen({perms, onAuthLost}) {
  const [status, setStatus] = useState(''), [subscription, setSubscription] = useState(''), [verified, setVerified] = useState('');
  const list = useList('users', {status, subscription, verified}, onAuthLost);
  const [sel, setSel] = useState(null), [detail, setDetail] = useState(null);
  const act = useAction(onAuthLost);
  const loadDetail = async id => { setDetail(null); try { setDetail(await adminApi('users/' + id)); } catch (e) { if (e.status === 401) onAuthLost(); else act.setMsg({kind: 'error', text: e.message}); } };
  const open = u => { setSel(u.id); act.setMsg({kind: '', text: ''}); loadDetail(u.id); };
  const after = async r => { if (r) { await loadDetail(sel); list.reload(); } return !!r; };
  const u = detail?.user;
  return <div className="ad-split">
    <div className="ad-stack">
      <Toolbar q={list.q} setQ={list.setQ} onRefresh={list.reload}>
        <Select label="الحالة" value={status} onChange={setStatus} options={{active: 'نشط', suspended: 'موقوف'}}/>
        <Select label="الاشتراك" value={subscription} onChange={setSubscription} options={{active: 'نشط', none: 'بدون'}}/>
        <Select label="البريد" value={verified} onChange={setVerified} options={{true: 'مؤكد', false: 'غير مؤكد'}}/>
      </Toolbar>
      <ListState list={list}/>
      {list.data && <><Table rowKey={r => r.id} selected={sel} onRow={open} rows={list.data.items} columns={[
        {key: 'name', label: 'الاسم'}, {key: 'email', label: 'البريد', ltr: true},
        {key: 'status', label: 'الحالة', render: r => r.status === 'suspended' ? <Badge tone="bad">موقوف</Badge> : <Badge tone="good">نشط</Badge>},
        {key: 'subscription', label: 'الاشتراك', render: r => r.subscription?.active ? <Badge tone="good">{r.subscription.plan === 'plus' ? 'بلاس' : 'أساسي'} حتى {fmtDay(r.subscription.expiresAt)}</Badge> : <Badge>لا يوجد</Badge>},
        {key: 'createdAt', label: 'تاريخ التسجيل', render: r => fmtDay(r.createdAt)}]}/><Pager data={list.data} onPage={list.setPage}/></>}
    </div>
    <aside className="x-card ad-detail" aria-live="polite">
      {!sel ? <p>اختر متعلمًا لعرض التفاصيل والإجراءات.</p> : !detail ? <p>جاري التحميل…</p> : <>
        <h2>{u.name}</h2>
        <p lang="en" dir="ltr" className="ad-ltr">{u.email} · {u.phone}</p>
        <div className="ad-kv"><span>الحالة</span>{u.status === 'suspended' ? <Badge tone="bad">موقوف</Badge> : <Badge tone="good">نشط</Badge>}<span>البريد</span>{u.emailVerified ? <Badge tone="good">مؤكد</Badge> : <Badge tone="warn">غير مؤكد</Badge>}<span>الاشتراك</span>{u.subscription ? <Badge tone={u.subscription.active ? 'good' : 'warn'}>{u.subscription.plan === 'plus' ? 'بلاس' : 'أساسي'} · {u.subscription.active ? 'نشط' : 'منتهي'} · {fmtDay(u.subscription.expiresAt)} · {u.subscription.source === 'manual' ? 'منحة يدوية' : 'دفع'}</Badge> : <Badge>لا يوجد</Badge>}<span>جلسات مفتوحة</span><b>{detail.activeSessions}</b><span>المستوى</span><b>{detail.learning.level || '—'}</b><span>نقاط التعلم</span><b><bdi>{detail.learning.xp} XP</bdi></b><span>جلسات التعلم</span><b>{detail.learning.sessions}</b><span>آخر نشاط</span><b>{detail.learning.lastActive ? fmtDay(detail.learning.lastActive) : '—'}</b><span>كلمات للمراجعة</span><b>{detail.learning.reviews} ({detail.learning.reviewsDue ?? 0} مستحقة الآن)</b></div>
        <h3>النشاط الأخير</h3>{detail.recentActivity?.length ? detail.recentActivity.map((a, i) => <div className="ad-line" key={i}><span>{a.title}</span><span>{fmtDate(a.date)}</span><Badge tone={a.xp > 0 ? 'good' : 'neutral'}><bdi>+{a.xp} XP</bdi></Badge></div>) : <p>لا يوجد نشاط مسجل بعد.</p>}
        <h3>الطلبات</h3>{detail.orders.length ? detail.orders.map(o => <div className="ad-line" key={o.reference}><span lang="en" dir="ltr">{o.reference}</span><span>{o.plan === 'plus' ? 'بلاس' : 'أساسي'} · {o.term === 'yearly' ? 'سنوي' : 'شهري'}</span><Badge>{ORDER_STATUS[o.status] || o.status}</Badge></div>) : <p>لا توجد طلبات.</p>}
        <h3>تذاكر الدعم</h3>{detail.tickets.length ? detail.tickets.map(t => <div className="ad-line" key={t.reference}><span lang="en" dir="ltr">{t.reference}</span><span>{t.subject}</span><Badge>{TICKET_STATUS[t.status] || t.status}</Badge></div>) : <p>لا توجد تذاكر.</p>}
        <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
        {(perms.includes('users.write') || perms.includes('orders.write')) && <div className="ad-actions">
          {perms.includes('users.write') && <>
            {u.status === 'suspended'
              ? <ReasonAction label="إعادة تفعيل الحساب" busy={act.busy} onSubmit={b => act.run(() => adminApi(`users/${u.id}/status`, {method: 'PATCH', body: {status: 'active', reason: b.reason}}), 'تمت إعادة تفعيل الحساب.').then(after)}/>
              : <ReasonAction label="إيقاف الحساب" tone="danger" confirmText="سيُمنع المتعلم من الدخول وتُنهى جلساته. متابعة؟" busy={act.busy} onSubmit={b => act.run(() => adminApi(`users/${u.id}/status`, {method: 'PATCH', body: {status: 'suspended', reason: b.reason}}), 'تم إيقاف الحساب وإنهاء جلساته.').then(after)}/>}
            <ReasonAction label="إنهاء كل الجلسات" busy={act.busy} onSubmit={b => act.run(() => adminApi(`users/${u.id}/revoke-sessions`, {method: 'POST', body: b}), r => `تم إنهاء ${r.revoked} جلسة.`).then(after)}/>
            {!u.emailVerified && <ReasonAction label="تأكيد البريد يدويًا" busy={act.busy} onSubmit={b => act.run(() => adminApi(`users/${u.id}/verify-email`, {method: 'POST', body: b}), 'تم تأكيد البريد.').then(after)}/>}
          </>}
          {perms.includes('orders.write') && <>
            <ReasonAction label="منح اشتراك يدوي" busy={act.busy} fields={[{name: 'plan', label: 'الباقة', options: {essential: 'أساسي', plus: 'بلاس'}, default: 'essential'}, {name: 'days', label: 'عدد الأيام (١–٤٠٠)', type: 'number', default: '30', minValue: 1, maxValue: 400, required: true}]} onSubmit={b => act.run(() => adminApi(`users/${u.id}/entitlements`, {method: 'POST', body: {...b, days: Number(b.days)}}), 'تم منح الاشتراك.').then(after)}/>
            {u.subscription && <ReasonAction label="سحب الاشتراك" tone="danger" confirmText="سيفقد المتعلم الوصول فورًا. متابعة؟" busy={act.busy} onSubmit={b => act.run(() => adminApi(`users/${u.id}/entitlements/English`, {method: 'DELETE', body: b}), 'تم سحب الاشتراك.').then(after)}/>}
          </>}
        </div>}
      </>}
    </aside>
  </div>;
}

// ---------------------------------------------------------------- orders
function OrdersScreen({perms, onAuthLost}) {
  const [status, setStatus] = useState(''), [plan, setPlan] = useState('');
  const list = useList('orders', {status, plan}, onAuthLost);
  const [sel, setSel] = useState(null);
  const act = useAction(onAuthLost);
  const o = list.data?.items.find(x => x.reference === sel);
  const after = r => { if (r) list.reload(); return !!r; };
  return <div className="ad-split">
    <div className="ad-stack">
      <Toolbar q={list.q} setQ={list.setQ} onRefresh={list.reload}>
        <Select label="الحالة" value={status} onChange={setStatus} options={ORDER_STATUS}/>
        <Select label="الباقة" value={plan} onChange={setPlan} options={{essential: 'أساسي', plus: 'بلاس'}}/>
      </Toolbar>
      <ListState list={list}/>
      {list.data && <><Table rowKey={r => r.reference} selected={sel} onRow={r => { setSel(r.reference); act.setMsg({kind: '', text: ''}); }} rows={list.data.items} columns={[
        {key: 'reference', label: 'المرجع', ltr: true}, {key: 'customer', label: 'العميل', render: r => r.customer?.email || <span lang="ar" dir="rtl">حساب محذوف</span>, ltr: true},
        {key: 'plan', label: 'الباقة', render: r => `${r.plan === 'plus' ? 'بلاس' : 'أساسي'} · ${r.term === 'yearly' ? 'سنوي' : 'شهري'}`},
        {key: 'amount', label: 'المبلغ', render: r => `${r.amount} جنيه`}, {key: 'status', label: 'الحالة', render: r => <Badge tone={r.status === 'paid' ? 'good' : r.status === 'refunded' || r.status === 'failed' ? 'bad' : 'warn'}>{ORDER_STATUS[r.status] || r.status}</Badge>},
        {key: 'createdAt', label: 'التاريخ', render: r => fmtDay(r.createdAt)}]}/><Pager data={list.data} onPage={list.setPage}/></>}
    </div>
    <aside className="x-card ad-detail" aria-live="polite">
      {!o ? <p>اختر طلبًا لعرض التفاصيل.</p> : <>
        <h2 lang="en" dir="ltr" className="ad-ltr">{o.reference}</h2>
        <div className="ad-kv"><span>العميل</span><b lang="en" dir="ltr">{o.customer?.email || '—'}</b><span>المبلغ</span><b>{o.amount} جنيه</b><span>الحالة</span><Badge>{ORDER_STATUS[o.status] || o.status}</Badge><span>أُنشئ</span><b>{fmtDate(o.createdAt)}</b><span>دُفع</span><b>{fmtDate(o.paidAt)}</b><span>ينتهي</span><b>{fmtDay(o.expiresAt)}</b>{o.manualPaymentReference && <><span>مرجع الدفع اليدوي</span><b lang="en" dir="ltr">{o.manualPaymentReference}</b></>}{o.paymobOrderId && <><span>طلب Paymob</span><b lang="en" dir="ltr">{o.paymobOrderId}</b></>}{o.transactionId && <><span>عملية Paymob</span><b lang="en" dir="ltr">{o.transactionId}</b></>}{o.refundedAt && <><span>استُرد</span><b>{fmtDate(o.refundedAt)}</b></>}</div>
        <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
        {perms.includes('orders.write') && <div className="ad-actions">
          {o.status === 'pending_contact' && <ReasonAction label="تفعيل بعد التحقق من الدفع" busy={act.busy} fields={[{name: 'paymentReference', label: 'مرجع الدفع المُتحقق منه', required: true, min: 6}]} confirmText="تأكد أنك راجعت الدفع في سجلات البنك/التاجر. متابعة؟" onSubmit={b => act.run(() => adminApi(`orders/${o.reference}/activate`, {method: 'POST', body: b}), 'تم تفعيل الطلب والاشتراك.').then(after)}/>}
          {o.status === 'paid' && <ReasonAction label="تسجيل استرداد" tone="danger" confirmText="سيُسحب الاشتراك المرتبط. إعادة المبلغ تتم من لوحة بوابة الدفع. متابعة؟" busy={act.busy} onSubmit={b => act.run(() => adminApi(`orders/${o.reference}/refund`, {method: 'POST', body: b}), r => r.pending ? 'تم حفظ طلب الاسترداد. يلزم موافقة مشرف آخر قبل التنفيذ (قسم طلبات الموافقة).' : r.notice).then(after)}/>}
          {!['pending_contact', 'paid'].includes(o.status) && <p>لا توجد إجراءات متاحة لهذه الحالة.</p>}
        </div>}
      </>}
    </aside>
  </div>;
}

// ---------------------------------------------------------------- support
function SupportScreen({perms, onAuthLost}) {
  const [status, setStatus] = useState(''), [category, setCategory] = useState('');
  const list = useList('support', {status, category}, onAuthLost);
  const [sel, setSel] = useState(null), [edit, setEdit] = useState({status: '', resolution: ''});
  const act = useAction(onAuthLost);
  const t = list.data?.items.find(x => x.reference === sel);
  useEffect(() => { if (t) setEdit({status: t.status, resolution: t.resolution || ''}); }, [sel]);
  return <div className="ad-split">
    <div className="ad-stack">
      <Toolbar q={list.q} setQ={list.setQ} onRefresh={list.reload}><Select label="الحالة" value={status} onChange={setStatus} options={TICKET_STATUS}/><Select label="النوع" value={category} onChange={setCategory} options={CATEGORY}/></Toolbar>
      <ListState list={list}/>
      {list.data && <><Table rowKey={r => r.reference} selected={sel} onRow={r => { setSel(r.reference); act.setMsg({kind: '', text: ''}); }} rows={list.data.items} columns={[
        {key: 'reference', label: 'المرجع', ltr: true}, {key: 'subject', label: 'العنوان'}, {key: 'category', label: 'النوع', render: r => CATEGORY[r.category] || r.category},
        {key: 'status', label: 'الحالة', render: r => <Badge tone={r.status === 'open' ? 'warn' : r.status === 'resolved' || r.status === 'closed' ? 'good' : 'neutral'}>{TICKET_STATUS[r.status] || r.status}</Badge>}, {key: 'createdAt', label: 'التاريخ', render: r => fmtDay(r.createdAt)}]}/><Pager data={list.data} onPage={list.setPage}/></>}
    </div>
    <aside className="x-card ad-detail" aria-live="polite">
      {!t ? <p>اختر تذكرة لعرضها.</p> : <>
        <h2>{t.subject}</h2><p lang="en" dir="ltr" className="ad-ltr">{t.reference} · {t.customer?.email || <span lang="ar" dir="rtl">حساب محذوف</span>}</p>
        <div className="ad-message">{t.message}</div>
        <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
        {perms.includes('support.write') ? <form className="ad-reason" onSubmit={async e => { e.preventDefault(); const r = await act.run(() => adminApi('support/' + t.reference, {method: 'PATCH', body: edit}), 'تم تحديث التذكرة. يراها العميل في مركز المساعدة.'); if (r) list.reload(); }}>
          <label><span>الحالة</span><select value={edit.status} onChange={e => setEdit({...edit, status: e.target.value})}>{Object.entries(TICKET_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label><span>الرد / الحل (يظهر للعميل)</span><textarea rows={4} maxLength={800} value={edit.resolution} onChange={e => setEdit({...edit, resolution: e.target.value})}/></label>
          <button className="ad-btn primary" type="submit" disabled={act.busy}>{act.busy ? 'جاري الحفظ…' : 'حفظ'}</button>
        </form> : t.resolution && <p><b>الحل:</b> {t.resolution}</p>}
      </>}
    </aside>
  </div>;
}

// ---------------------------------------------------------------- leads
function LeadsScreen({perms, onAuthLost}) {
  const [status, setStatus] = useState(''), [kind, setKind] = useState('');
  const list = useList('leads', {status, kind}, onAuthLost);
  const [sel, setSel] = useState(null), [edit, setEdit] = useState({status: 'new', note: ''});
  const act = useAction(onAuthLost);
  const l = list.data?.items.find(x => x.reference === sel);
  useEffect(() => { if (l) setEdit({status: l.status || 'new', note: ''}); }, [sel]);
  return <div className="ad-split">
    <div className="ad-stack">
      <Toolbar q={list.q} setQ={list.setQ} onRefresh={list.reload}><Select label="الحالة" value={status} onChange={setStatus} options={LEAD_STATUS}/><Select label="النوع" value={kind} onChange={setKind} options={KIND}/></Toolbar>
      <ListState list={list}/>
      {list.data && <><Table rowKey={r => r.reference} selected={sel} onRow={r => { setSel(r.reference); act.setMsg({kind: '', text: ''}); }} rows={list.data.items} columns={[
        {key: 'name', label: 'الاسم'}, {key: 'email', label: 'البريد', ltr: true}, {key: 'kind', label: 'النوع', render: r => KIND[r.kind] || r.kind}, {key: 'language', label: 'اللغة'},
        {key: 'status', label: 'الحالة', render: r => <Badge tone={r.status === 'new' ? 'warn' : r.status === 'converted' ? 'good' : 'neutral'}>{LEAD_STATUS[r.status] || r.status}</Badge>}, {key: 'createdAt', label: 'التاريخ', render: r => fmtDay(r.createdAt)}]}/><Pager data={list.data} onPage={list.setPage}/></>}
    </div>
    <aside className="x-card ad-detail" aria-live="polite">
      {!l ? <p>اختر طلب تواصل لعرضه.</p> : <>
        <h2>{l.name}</h2><p lang="en" dir="ltr" className="ad-ltr">{l.email} · {l.phone}</p>
        <div className="ad-kv"><span>المرجع</span><b lang="en" dir="ltr">{l.reference}</b><span>النوع</span><b>{KIND[l.kind] || l.kind}</b><span>اللغة</span><b>{l.language}</b>{l.company && <><span>الجهة</span><b>{l.company}</b></>}{l.plan && <><span>الباقة</span><b>{l.plan} · {l.term}</b></>}{l.groupSize && <><span>حجم المجموعة</span><b>{l.groupSize}</b></>}{l.preferredDate && <><span>الموعد المفضل</span><b>{l.preferredDate} {l.preferredTime} (القاهرة) — يحتاج تأكيدًا</b></>}<span>وصل</span><b>{fmtDate(l.createdAt)}</b></div>
        {l.message && <div className="ad-message">{l.message}</div>}
        {l.notes?.length > 0 && <><h3>ملاحظات الفريق</h3>{l.notes.map((n, i) => <div className="ad-line" key={i}><span>{fmtDate(n.at)}</span><span>{n.text}</span></div>)}</>}
        <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
        {perms.includes('leads.write') && <form className="ad-reason" onSubmit={async e => { e.preventDefault(); const r = await act.run(() => adminApi('leads/' + l.reference, {method: 'PATCH', body: edit}), 'تم تحديث طلب التواصل.'); if (r) { setEdit({...edit, note: ''}); list.reload(); } }}>
          <label><span>الحالة</span><select value={edit.status} onChange={e => setEdit({...edit, status: e.target.value})}>{Object.entries(LEAD_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label><span>ملاحظة (اختيارية)</span><textarea rows={3} maxLength={1000} value={edit.note} onChange={e => setEdit({...edit, note: e.target.value})}/></label>
          <button className="ad-btn primary" type="submit" disabled={act.busy}>{act.busy ? 'جاري الحفظ…' : 'حفظ'}</button>
        </form>}
      </>}
    </aside>
  </div>;
}

// ---------------------------------------------------------------- audit
function AuditScreen({onAuthLost}) {
  const [event, setEvent] = useState(''), [actorType, setActorType] = useState('');
  const list = useList('audit', {event, actorType}, onAuthLost);
  const act = useAction(onAuthLost);
  const [verify, setVerify] = useState(null);
  const events = Object.fromEntries((list.data?.events || []).map(e => [e, e]));
  return <div className="ad-stack">
    <div className="x-card ad-verify"><div><h2><BadgeCheck size={20} aria-hidden="true"/> سلامة السجل</h2><p>كل إدخال مرتبط بتوقيع ما قبله. أي تعديل أو حذف أو إعادة ترتيب يكسر التحقق من موضعه.</p></div>
      <button type="button" className="ad-btn primary" disabled={act.busy} onClick={async () => setVerify(await act.run(() => adminApi('audit/verify'), r => r.ok ? 'السجل سليم.' : 'تم اكتشاف خلل في السجل.'))}>{act.busy ? 'جاري التحقق…' : 'تحقق من السجل'}</button>
      {verify && <div className={'ad-verify-result ' + (verify.ok ? 'good' : 'bad')}>{verify.ok ? <>سليم · {verify.checked} إدخال موقّع{verify.keyed ? ' بمفتاح سري' : ' (بدون مفتاح سري — اضبط AUDIT_HMAC_KEY)'}{verify.legacy ? ` · ${verify.legacy} إدخال قديم غير مرتبط` : ''}</> : <>خلل عند الإدخال #{verify.brokenAt}: <span lang="en" dir="ltr">{verify.reason}</span></>}</div>}
      {act.msg.kind === 'error' && <Notice kind="error">{act.msg.text}</Notice>}
    </div>
    <Toolbar q={list.q} setQ={list.setQ} onRefresh={list.reload}><Select label="الحدث" value={event} onChange={setEvent} options={events}/><Select label="المنفّذ" value={actorType} onChange={setActorType} options={{admin: 'مشرف', user: 'متعلم', system: 'النظام', cli: 'أداة الخادم', 'legacy-token': 'الرمز القديم'}}/></Toolbar>
    <ListState list={list}/>
    {list.data && <><Table rowKey={r => r.id} rows={list.data.items} columns={[
      {key: 'seq', label: '#', render: r => r.seq || '—'}, {key: 'at', label: 'الوقت', render: r => fmtDate(r.at)}, {key: 'event', label: 'الحدث', ltr: true},
      {key: 'actor', label: 'المنفّذ', ltr: true, render: r => r.actorLabel}, {key: 'target', label: 'الهدف', ltr: true, render: r => r.target ? `${r.target.type}:${String(r.target.id).slice(0, 14)}` : '—'},
      {key: 'meta', label: 'التفاصيل', render: r => <span className="ad-meta" lang="en" dir="ltr">{r.meta?.reason ? `reason: ${r.meta.reason}` : Object.entries(r.meta || {}).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || '—'}</span>},
      {key: 'chained', label: 'مرتبط', render: r => r.chained ? <Badge tone="good">نعم</Badge> : <Badge>قديم</Badge>}]}/><Pager data={list.data} onPage={list.setPage}/></>}
  </div>;
}

// ---------------------------------------------------------------- admins & roles
function AdminsScreen({me, perms, onAuthLost}) {
  const list = useList('admins', {}, onAuthLost);
  const [roles, setRoles] = useState(null);
  const act = useAction(onAuthLost);
  const [form, setForm] = useState({email: '', name: '', role: 'support', password: ''});
  useEffect(() => { adminApi('roles').then(setRoles).catch(e => { if (e.status === 401) onAuthLost(); }); }, []);
  const canWrite = perms.includes('admins.write');
  const update = (a, body, text) => act.run(() => adminApi('admins/' + a.id, {method: 'PATCH', body}), text).then(r => { if (r) list.reload(); });
  return <div className="ad-stack">
    <Toolbar q={list.q} setQ={list.setQ} onRefresh={list.reload}/>
    <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
    <ListState list={list}/>
    {list.data && <><Table rowKey={r => r.id} rows={list.data.items} columns={[
      {key: 'name', label: 'الاسم', render: r => <>{r.name}{r.id === me.id && <Badge>أنت</Badge>}</>}, {key: 'email', label: 'البريد', ltr: true},
      {key: 'role', label: 'الدور', render: r => canWrite && r.id !== me.id ? <select aria-label={'دور ' + r.email} value={r.role} disabled={act.busy} onChange={e => update(r, {role: e.target.value}, PENDING_TEXT)}>{Object.keys(ROLE_LABEL).filter(k => k !== 'owner' || me.role === 'owner').map(k => <option key={k} value={k}>{ROLE_LABEL[k]}</option>)}</select> : ROLE_LABEL[r.role] || r.role},
      {key: 'status', label: 'الحالة', render: r => r.status === 'active' ? <Badge tone="good">نشط</Badge> : <Badge tone="bad">معطّل</Badge>},
      {key: 'mfa', label: 'التحقق بخطوتين', render: r => r.mfaEnabled ? <Badge tone="good">مفعّل</Badge> : <Badge tone="warn">غير مفعّل</Badge>},
      {key: 'lastLoginAt', label: 'آخر دخول', render: r => fmtDate(r.lastLoginAt)},
      {key: 'mfaReset', label: '', render: r => canWrite && r.id !== me.id && r.mfaEnabled ? <ReasonAction label="إعادة ضبط التحقق" tone="danger" confirmText={`سيُطلب من ${r.email} إعداد التحقق بخطوتين من جديد وتُنهى جلساته. تأكد من هويته أولًا. متابعة؟`} busy={act.busy} onSubmit={b => act.run(() => adminApi(`admins/${r.id}/mfa/reset`, {method: 'POST', body: b}), 'تمت إعادة ضبط التحقق بخطوتين.').then(x => { if (x) list.reload(); return !!x; })}/> : null},
      {key: 'actions', label: '', render: r => canWrite && r.id !== me.id ? <button type="button" className={'ad-btn ' + (r.status === 'active' ? 'danger' : '')} disabled={act.busy} onClick={() => { if (r.status !== 'active' || confirm(`تعطيل ${r.email}؟ ستُنهى جلساته فورًا.`)) update(r, {status: r.status === 'active' ? 'disabled' : 'active'}, PENDING_TEXT); }}>{r.status === 'active' ? 'تعطيل' : 'تفعيل'}</button> : null}]}/><Pager data={list.data} onPage={list.setPage}/></>}
    {canWrite && <form className="x-card ad-create" onSubmit={async e => { e.preventDefault(); const r = await act.run(() => adminApi('admins', {method: 'POST', body: form}), 'تم إنشاء حساب المشرف. شارك كلمة المرور عبر قناة آمنة واطلب تغييرها.'); if (r) { setForm({email: '', name: '', role: 'support', password: ''}); list.reload(); } }}>
      <h2><KeyRound size={20} aria-hidden="true"/> إضافة مشرف</h2>
      <div className="ad-grid">
        <label>الاسم<input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required minLength={2} maxLength={80}/></label>
        <label>البريد<input type="email" lang="en" dir="ltr" value={form.email} onChange={e => setForm({...form, email: e.target.value})} required/></label>
        <label>الدور<select value={form.role} onChange={e => setForm({...form, role: e.target.value})}>{Object.keys(ROLE_LABEL).filter(k => k !== 'owner' || me.role === 'owner').map(k => <option key={k} value={k}>{ROLE_LABEL[k]}</option>)}</select></label>
        <label>كلمة مرور مؤقتة (١٢ حرفًا على الأقل)<input type="password" lang="en" dir="ltr" autoComplete="new-password" value={form.password} onChange={e => setForm({...form, password: e.target.value})} required minLength={12} maxLength={128}/></label>
      </div>
      <button className="ad-btn primary" type="submit" disabled={act.busy}>{act.busy ? 'جاري الإنشاء…' : 'إنشاء الحساب'}</button>
    </form>}
    {roles && <div className="x-card"><h2><ClipboardList size={20} aria-hidden="true"/> مصفوفة الصلاحيات</h2><p>الأدوار محددة في الخادم؛ يُطبق الخادم الصلاحية على كل طلب بغض النظر عن الواجهة.</p>
      <div className="ad-table-wrap"><table className="ad-table ad-matrix"><thead><tr><th scope="col">الصلاحية</th>{Object.keys(roles.roles).map(r => <th key={r} scope="col">{ROLE_LABEL[r] || r}</th>)}</tr></thead>
        <tbody>{Object.entries(roles.permissions).map(([p, desc]) => <tr key={p}><td><b lang="en" dir="ltr">{p}</b><small>{desc}</small></td>{Object.entries(roles.roles).map(([r, def]) => <td key={r} className="ad-center">{def.permissions.includes(p) ? <span aria-label="مسموح">✓</span> : <span aria-label="غير مسموح" className="ad-dim">—</span>}</td>)}</tr>)}</tbody></table></div></div>}
  </div>;
}

// ---------------------------------------------------------------- password change
function PasswordPanel({onAuthLost}) {
  const [f, setF] = useState({currentPassword: '', newPassword: ''});
  const act = useAction(onAuthLost);
  return <form className="x-card ad-password" onSubmit={async e => { e.preventDefault(); const r = await act.run(() => adminApi('auth/password', {method: 'POST', body: f}), r => r.message); if (r) setF({currentPassword: '', newPassword: ''}); }}>
    <h2>تغيير كلمة المرور</h2>
    <label>الحالية<input type="password" lang="en" dir="ltr" autoComplete="current-password" value={f.currentPassword} onChange={e => setF({...f, currentPassword: e.target.value})} required/></label>
    <label>الجديدة (١٢ حرفًا على الأقل)<input type="password" lang="en" dir="ltr" autoComplete="new-password" value={f.newPassword} onChange={e => setF({...f, newPassword: e.target.value})} required minLength={12}/></label>
    <div className="ad-row"><button className="ad-btn primary" type="submit" disabled={act.busy}>حفظ</button></div>
    <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
  </form>;
}

// Two-factor authentication: enroll (setup key -> confirm code -> recovery codes shown once) or disable.
function MfaPanel({session, onAuthLost, onChanged}) {
  const act = useAction(onAuthLost);
  const [setup, setSetup] = useState(null), [code, setCode] = useState(''), [codes, setCodes] = useState(null), [dis, setDis] = useState({password: '', code: ''});
  const enabled = session.admin.mfaEnabled;
  if (codes) return <div className="x-card ad-mfa">
    <h2><ShieldCheck size={20} aria-hidden="true"/> التحقق بخطوتين مفعّل</h2>
    <Notice kind="info">احفظ رموز الاسترداد هذه في مكان آمن (مدير كلمات مرور أو ورقة في مكان مغلق). كل رمز يعمل مرة واحدة إذا فقدت هاتفك، ولن تظهر مرة أخرى.</Notice>
    <ol className="ad-codes" lang="en" dir="ltr">{codes.map(c => <li key={c}><code>{c}</code></li>)}</ol>
    <div className="ad-row"><button type="button" className="ad-btn" onClick={() => navigator.clipboard?.writeText(codes.join('\n'))}>نسخ الرموز</button><button type="button" className="ad-btn primary" onClick={() => { setCodes(null); onChanged(); }}>حفظتها، متابعة</button></div>
  </div>;
  if (enabled) return <form className="x-card ad-mfa" onSubmit={async e => { e.preventDefault(); if (!confirm('سيصبح الدخول بكلمة المرور فقط. متابعة؟')) return; const r = await act.run(() => adminApi('mfa/disable', {method: 'POST', body: dis}), 'تم إيقاف التحقق بخطوتين.'); if (r) { setDis({password: '', code: ''}); onChanged(); } }}>
    <h2><ShieldCheck size={20} aria-hidden="true"/> التحقق بخطوتين</h2>
    <p><Badge tone="good">مفعّل</Badge> {session.recoveryCodesLeft != null && <>· متبقٍ {session.recoveryCodesLeft} من رموز الاسترداد{session.recoveryCodesLeft <= 2 && ' — اطلب من المالك إعادة الضبط لإصدار رموز جديدة'}</>}</p>
    <h3>إيقاف التحقق بخطوتين</h3>
    <label>كلمة المرور<input type="password" lang="en" dir="ltr" autoComplete="current-password" value={dis.password} onChange={e => setDis({...dis, password: e.target.value})} required/></label>
    <label>رمز التطبيق الحالي<input lang="en" dir="ltr" className="ad-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={dis.code} onChange={e => setDis({...dis, code: e.target.value})} required/></label>
    <div className="ad-row"><button className="ad-btn danger" type="submit" disabled={act.busy}>إيقاف</button></div>
    <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
  </form>;
  return <div className="x-card ad-mfa">
    <h2><ShieldCheck size={20} aria-hidden="true"/> تفعيل التحقق بخطوتين</h2>
    {session.mfaAvailable === false ? <Notice kind="error">التحقق بخطوتين غير مهيأ على هذا الخادم. يجب ضبط ADMIN_MFA_KEY أولًا.</Notice> : !setup ? <>
      <p>يحمي حسابك حتى لو تسربت كلمة المرور. ستحتاج تطبيق مصادقة مثل Google Authenticator أو Microsoft Authenticator أو 1Password.</p>
      <div className="ad-row"><button type="button" className="ad-btn primary" disabled={act.busy} onClick={async () => { const r = await act.run(() => adminApi('mfa/setup', {method: 'POST'}), ''); if (r) setSetup(r); }}>ابدأ الإعداد</button></div>
    </> : <form className="ad-stack" onSubmit={async e => { e.preventDefault(); const r = await act.run(() => adminApi('mfa/enable', {method: 'POST', body: {code}}), r => r.message); if (r) { setCodes(r.recoveryCodes); setSetup(null); setCode(''); } }}>
      <ol className="ad-steps">
        <li>افتح تطبيق المصادقة واختر «إضافة حساب» ثم «إدخال مفتاح الإعداد».</li>
        <li>أدخل هذا المفتاح (نوع: حسب الوقت):<div className="ad-secret" lang="en" dir="ltr">{setup.secret.match(/.{1,4}/g).join(' ')}</div><small>على الهاتف يمكنك فتح <a href={setup.otpauthUri} lang="en" dir="ltr">رابط الإضافة المباشر</a>.</small></li>
        <li>أدخل الرمز المكون من ٦ أرقام الذي يظهر في التطبيق.</li>
      </ol>
      <label>رمز التحقق<input lang="en" dir="ltr" className="ad-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={e => setCode(e.target.value)} required autoFocus/></label>
      <div className="ad-row"><button className="ad-btn primary" type="submit" disabled={act.busy}>{act.busy ? 'جاري التحقق…' : 'تفعيل'}</button><button type="button" className="ad-btn ghost" onClick={() => setSetup(null)}>إلغاء</button></div>
    </form>}
    {act.msg.text && act.msg.kind === 'error' && <Notice kind="error">{act.msg.text}</Notice>}
  </div>;
}

// ---------------------------------------------------------------- step-up dialog
// Asks for the password again (and a written reason when the action did not carry one). Paste is allowed, focus
// stays inside the dialog, Esc cancels, and the previously focused control gets focus back.
function StepUpDialog({request, onDone}) {
  const {needPassword, needReason} = request;
  const [password, setPassword] = useState(''), [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const box = useRef(null), first = useRef(null);
  useEffect(() => {
    const before = document.activeElement;
    first.current?.focus();
    return () => before?.focus?.();
  }, []);
  const cancel = () => onDone(null, new ApiError('تم إلغاء الإجراء.', 0));
  const onKey = e => {
    if (e.key === 'Escape') { e.stopPropagation(); cancel(); return; }
    if (e.key !== 'Tab') return;
    const items = [...box.current.querySelectorAll('input, textarea, button:not([disabled])')];
    if (!items.length) return;
    const a = items[0], z = items[items.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  };
  const valid = (!needPassword || password) && (!needReason || reason.trim().length >= 5);
  const submit = async e => {
    e.preventDefault(); if (!valid) return;
    setBusy(true); setError('');
    try {
      if (needPassword) await rawApi('auth/step-up', {method: 'POST', body: {password}});
      onDone({reason: needReason ? reason.trim() : ''});
    } catch (err) {
      if (err.status === 401) onDone(null, err);
      else { setError(err.status === 403 ? 'كلمة المرور غير صحيحة.' : err.message); setPassword(''); setBusy(false); first.current?.focus(); }
    }
  };
  return <div className="ad-modal-back" onKeyDown={onKey}>
    <form ref={box} className="x-card ad-modal" role="dialog" aria-modal="true" aria-labelledby="ad-su-title" aria-describedby="ad-su-help" onSubmit={submit}>
      <h2 id="ad-su-title"><ShieldCheck size={20} aria-hidden="true"/> تأكيد إجراء حساس</h2>
      <p id="ad-su-help">{needPassword ? 'أعد إدخال كلمة المرور لمتابعة هذا الإجراء. يبقى التأكيد صالحًا ٥ دقائق.' : 'اكتب سبب هذا الإجراء. يُسجل في سجل التدقيق.'}</p>
      {needPassword && <label>كلمة المرور<input ref={first} type="password" lang="en" dir="ltr" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/></label>}
      {needReason && <label><span>السبب (٥ أحرف على الأقل، يُسجل في سجل التدقيق)</span><textarea ref={needPassword ? undefined : first} rows={3} minLength={5} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} required/></label>}
      <Notice kind="error">{error}</Notice>
      <div className="ad-row"><button type="submit" className="ad-btn primary" disabled={busy || !valid}>{busy ? 'جاري التأكيد…' : 'تأكيد'}</button><button type="button" className="ad-btn ghost" onClick={cancel}>إلغاء</button></div>
    </form>
  </div>;
}

// ---------------------------------------------------------------- approvals (second approver)
const APPROVAL_KIND = {refund: 'استرداد طلب', admin_update: 'تغيير مشرف'};
function ApprovalsScreen({onAuthLost}) {
  const [items, setItems] = useState(null), [error, setError] = useState('');
  const act = useAction(onAuthLost);
  const load = useCallback(async () => { setError(''); try { setItems((await adminApi('approvals')).items); } catch (e) { if (e.status === 401) onAuthLost(); else setError(e.message); } }, [onAuthLost]);
  useEffect(() => { load(); }, [load]);
  const detail = i => i.kind === 'refund' ? <span lang="en" dir="ltr">{i.target}</span> : <span lang="en" dir="ltr">{[i.payload.role && `role: ${i.payload.role}`, i.payload.status && `status: ${i.payload.status}`].filter(Boolean).join(' · ')}</span>;
  const decide = async (i, what, reason) => { const r = await act.run(() => adminApi(`approvals/${i.id}/${what}`, {method: 'POST', body: {reason}}), what === 'approve' ? 'تمت الموافقة وتنفيذ الإجراء.' : 'تم رفض الطلب.'); if (r) load(); return !!r; };
  return <div className="ad-stack">
    <div className="x-card"><h2><BadgeCheck size={20} aria-hidden="true"/> طلبات بانتظار الموافقة</h2><p>الاسترداد وتغيير أدوار المشرفين لا يُنفذان إلا بعد موافقة مشرف آخر. لا يمكنك الموافقة على طلبك.</p></div>
    <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
    {error && <Notice kind="error">{error}</Notice>}
    {!items ? <div className="ad-empty">جاري التحميل…</div> : !items.length ? <div className="ad-empty">لا توجد طلبات معلقة.</div> :
      <div className="ad-stack">{items.map(i => <div className="x-card ad-approval" key={i.id}>
        <div className="ad-line"><b>{APPROVAL_KIND[i.kind] || i.kind}</b>{detail(i)}<span>{fmtDate(i.requestedAt)}</span></div>
        <p>طلبه: <bdi lang="en" dir="ltr">{i.requestedByLabel}</bdi>{i.mine && <Badge>طلبك</Badge>}</p>
        <p>السبب: {i.reason}</p>
        {i.mine ? <div className="ad-row"><span>بانتظار موافقة مشرف آخر.</span><button type="button" className="ad-btn ghost" disabled={act.busy} onClick={() => decide(i, 'reject', 'تم سحب الطلب')}>سحب الطلب</button></div>
          : <div className="ad-actions"><ReasonAction label="موافقة وتنفيذ" busy={act.busy} confirmText="سيُنفذ الإجراء الآن. متابعة؟" onSubmit={b => decide(i, 'approve', b.reason)}/><ReasonAction label="رفض" tone="danger" busy={act.busy} onSubmit={b => decide(i, 'reject', b.reason)}/></div>}
      </div>)}</div>}
  </div>;
}

// ---------------------------------------------------------------- console shell
export default function AdminConsole() {
  const [session, setSession] = useState(undefined), [expired, setExpired] = useState(false), [tab, setTab] = useState('overview'), [pw, setPw] = useState(false);
  const mounted = useRef(true);
  const [suReq, setSuReq] = useState(null), [idleWarn, setIdleWarn] = useState(false);
  useEffect(() => { adminApi('auth/me').then(setSession).catch(() => setSession(null)); return () => { mounted.current = false; }; }, []);
  const onAuthLost = useCallback(() => { clearSwCaches(); setSession(null); setExpired(true); setIdleWarn(false); }, []);
  useEffect(() => {
    stepUpOpener = req => new Promise((resolve, reject) => setSuReq({req, resolve, reject}));
    return () => { stepUpOpener = null; };
  }, []);
  // Warn 2 minutes before the idle timeout (the server ends the session after ADMIN_IDLE_MS without requests).
  const idleMs = session?.idleTimeoutMs, hasSession = !!session && !session.legacy;
  useEffect(() => {
    if (!hasSession) return undefined;
    const idle = idleMs || 30 * 60 * 1000;
    lastApiAt = Date.now();
    const t = setInterval(() => { const left = idle - (Date.now() - lastApiAt); setIdleWarn(left <= 120000 && left > 0); if (left <= 0) onAuthLost(); }, 5000);
    return () => clearInterval(t);
  }, [hasSession, idleMs, onAuthLost]);
  const extend = async () => { try { await adminApi('auth/me'); setIdleWarn(false); } catch { onAuthLost(); } };
  const overlay = suReq && <StepUpDialog request={suReq.req} onDone={(r, err) => { const q = suReq; setSuReq(null); if (err) q.reject(err); else q.resolve(r); }}/>;
  const idleBanner = idleWarn && <div className="ad-notice info ad-idle" role="alert"><span>ستنتهي جلستك قريبًا بسبب عدم النشاط (أقل من دقيقتين).</span> <button type="button" className="ad-btn primary" onClick={extend}>تمديد الجلسة</button></div>;
  if (session === undefined) return <section className="x-page"><div className="x-card">جاري التحقق من الجلسة…</div></section>;
  if (!session) return <SignIn expired={expired} onSignedIn={d => { setExpired(false); setSession(d); const first = TABS.find(t => allowed(t, d.permissions)); setTab(first?.id || 'overview'); adminApi('auth/me').then(setSession).catch(() => {}); }}/>;
  const perms = session.permissions || [];
  const tabs = TABS.filter(t => allowed(t, perms));
  const current = tabs.find(t => t.id === tab) ? tab : tabs[0]?.id;
  const logout = async () => { try { await adminApi('auth/logout', {method: 'POST'}); } catch {} clearSwCaches(); setSession(null); setExpired(false); };
  const refresh = () => adminApi('auth/me').then(setSession).catch(onAuthLost);
  const props = {perms, onAuthLost, me: session.admin};
  const security = <><MfaPanel session={session} onAuthLost={onAuthLost} onChanged={refresh}/><PasswordPanel onAuthLost={onAuthLost}/></>;
  // ADMIN_REQUIRE_MFA: nothing but enrollment until two-factor authentication is on.
  if (session.mfaEnrollmentRequired) return <section className="x-page ad-page">
    <header className="ad-head"><div><span className="ad-kicker">USAM Language Operations</span><h1>لوحة التشغيل</h1></div><div className="ad-who"><span><b>{session.admin.name}</b><small>{ROLE_LABEL[session.admin.role]}</small></span><button type="button" className="ad-btn ghost" onClick={logout}><LogOut size={15} aria-hidden="true"/> خروج</button></div></header>
    <Notice kind="info">يتطلب هذا الخادم التحقق بخطوتين لكل المشرفين. فعّله للمتابعة.</Notice>
    {security}
    {overlay}
  </section>;
  return <section className="x-page ad-page">
    <header className="ad-head">
      <div><span className="ad-kicker">USAM Language Operations</span><h1>لوحة التشغيل</h1></div>
      <div className="ad-who"><span><b>{session.admin.name}</b><small>{ROLE_LABEL[session.admin.role] || session.admin.role}{session.legacy ? ' · رمز قديم (قراءة فقط)' : ''}</small></span>
        {!session.legacy && <button type="button" className="ad-btn ghost" aria-expanded={pw} onClick={() => setPw(!pw)}><KeyRound size={15} aria-hidden="true"/> الأمان{session.admin.mfaEnabled ? '' : ' ⚠'}</button>}
        <button type="button" className="ad-btn ghost" onClick={logout}><LogOut size={15} aria-hidden="true"/> خروج</button></div>
    </header>
    {session.legacy && <Notice kind="info">أنت تستخدم رمز الإدارة القديم المشترك (قراءة فقط). أنشئ حسابات مشرفين شخصية ثم عطّل ADMIN_LEGACY_TOKEN.</Notice>}
    {pw && <div className="ad-security">{security}</div>}
    <nav className="x-tabs ad-tabs" aria-label="أقسام لوحة التشغيل">{tabs.map(t => <button type="button" key={t.id} className={current === t.id ? 'active' : ''} aria-current={current === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}><t.icon size={16} aria-hidden="true"/> {t.label}</button>)}</nav>
    {!tabs.length ? <Notice kind="info">لا توجد أقسام متاحة لدورك.</Notice>
      : current === 'overview' ? <Overview {...props}/>
      : current === 'users' ? <UsersScreen {...props}/>
      : current === 'orders' ? <OrdersScreen {...props}/>
      : current === 'support' ? <SupportScreen {...props}/>
      : current === 'leads' ? <LeadsScreen {...props}/>
      : current === 'audit' ? <AuditScreen {...props}/>
      : current === 'approvals' ? <ApprovalsScreen {...props}/>
      : <AdminsScreen {...props}/>}
    {idleBanner}
    {overlay}
  </section>;
}
