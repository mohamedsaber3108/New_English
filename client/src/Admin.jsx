// USAM Language — Operations console (admin).
// Individual administrator sign-in, role-aware navigation, and operational screens backed by /api/admin.
// Every action calls the real API; the server enforces permissions — the UI only hides what a role cannot do.
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Activity, BadgeCheck, ClipboardList, FileClock, Inbox, KeyRound, LayoutDashboard, LifeBuoy, LogOut, RefreshCw, Search, ShieldCheck, ShoppingCart, UserCog, Users} from 'lucide-react';
import './admin.css';

class ApiError extends Error { constructor(message, status) { super(message); this.status = status; } }
async function adminApi(path, {method = 'GET', body} = {}) {
  const r = await fetch('/api/admin/' + path, {method, credentials: 'same-origin', headers: body ? {'Content-Type': 'application/json'} : {}, body: body ? JSON.stringify(body) : undefined});
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new ApiError(data.error || 'تعذر إكمال الطلب.', r.status);
  return data;
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
];

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
  return <div className="ad-table-wrap"><table className="ad-table"><thead><tr>{columns.map(c => <th key={c.key} scope="col">{c.label}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={rowKey(r)} className={selected === rowKey(r) ? 'selected' : ''} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined} onKeyDown={onRow ? e => { if (e.key === 'Enter') onRow(r); } : undefined}>{columns.map(c => <td key={c.key} dir={c.ltr ? 'ltr' : undefined}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}</tr>)}</tbody></table></div>;
}
const ListState = ({list}) => list.loading && !list.data ? <div className="ad-empty">جاري التحميل…</div> : list.error ? <Notice kind="error">{list.error}</Notice> : null;

// ---------------------------------------------------------------- sign-in
function SignIn({onSignedIn, expired}) {
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { const d = await adminApi('auth/login', {method: 'POST', body: {email, password}}); setPassword(''); onSignedIn(d); }
    catch (err) { setError(err.status === 429 ? 'محاولات كثيرة. جرّب بعد ١٥ دقيقة.' : err.status === 401 ? 'البريد أو كلمة المرور غير صحيحة.' : err.message); }
    finally { setBusy(false); }
  };
  return <section className="x-page"><div className="x-hero"><span>USAM Language Operations</span><h1>لوحة <em>التشغيل.</em></h1><p>دخول بحساب مشرف شخصي. كل إجراء يُسجل باسم صاحبه في سجل تدقيق محمي من التعديل.</p></div>
    <form className="x-card ad-login" onSubmit={submit}>
      <ShieldCheck size={30} aria-hidden="true"/>
      <h2>تسجيل دخول المشرفين</h2>
      {expired && <Notice kind="info">انتهت جلستك أو تم تسجيل خروجك. سجّل دخولك من جديد.</Notice>}
      <label>البريد الإلكتروني<input type="email" dir="ltr" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required/></label>
      <label>كلمة المرور<input type="password" dir="ltr" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required/></label>
      <button className="m-action" type="submit" disabled={busy}>{busy ? 'جاري الدخول…' : 'دخول آمن'}</button>
      <Notice kind="error">{error}</Notice>
      <small>لا يوجد حساب؟ يُنشئ المالك حسابات المشرفين من «المشرفون والأدوار»، وأول مالك يُنشأ عبر أداة الخادم <code dir="ltr">npm run admin:create</code>.</small>
    </form></section>;
}

// ---------------------------------------------------------------- overview
function Overview({onAuthLost}) {
  const [d, setD] = useState(null), [err, setErr] = useState('');
  const load = async () => { setErr(''); try { setD(await adminApi('overview')); } catch (e) { if (e.status === 401) onAuthLost(); else setErr(e.message); } };
  useEffect(() => { load(); }, []);
  if (err) return <Notice kind="error">{err}</Notice>;
  if (!d) return <div className="ad-empty">جاري التحميل…</div>;
  const cards = [['المتعلمون', d.users], ['اشتراكات نشطة', d.activeEntitlements], ['بريد مؤكد', d.verified], ['حسابات موقوفة', d.suspended], ['طلبات مدفوعة', d.paidOrders], ['طلبات معلقة', d.pendingOrders], ['طلبات مستردة', d.refundedOrders], ['إيراد مسجل (جنيه)', d.revenuePaidEGP.toLocaleString('ar-EG')], ['تذاكر مفتوحة', d.openTickets], ['طلبات تواصل جديدة', d.newLeads]];
  const tone = v => v === 'configured' || v === 'enforced' || v === true || v === 'postgres' || v === 'redis' ? 'good' : v === 'awaiting credentials' || v === false || v === 'open' ? 'warn' : 'neutral';
  const INTEGRATION = {storage: 'التخزين', payments: 'الدفع (Paymob)', email: 'البريد (Resend)', ai: 'الذكاء الاصطناعي (OpenAI)', rateLimit: 'تحديد معدل الطلبات', rooms: 'الغرف الجماعية', auditKeyed: 'توقيع سجل التدقيق', accessEnforcement: 'فرض الاشتراك'};
  const VALUE = {configured: 'مفعّل', 'awaiting credentials': 'بانتظار بيانات الاعتماد', enforced: 'مفروض', open: 'مفتوح', true: 'مفعّل', false: 'غير مفعّل', json: 'ملف JSON (خادم واحد)', postgres: 'PostgreSQL', memory: 'ذاكرة (خادم واحد)', redis: 'Redis (مشترك)'};
  return <div className="ad-stack">
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
        <p dir="ltr" className="ad-ltr">{u.email} · {u.phone}</p>
        <div className="ad-kv"><span>الحالة</span>{u.status === 'suspended' ? <Badge tone="bad">موقوف</Badge> : <Badge tone="good">نشط</Badge>}<span>البريد</span>{u.emailVerified ? <Badge tone="good">مؤكد</Badge> : <Badge tone="warn">غير مؤكد</Badge>}<span>الاشتراك</span>{u.subscription ? <Badge tone={u.subscription.active ? 'good' : 'warn'}>{u.subscription.plan} · {u.subscription.active ? 'نشط' : 'منتهي'} · {fmtDay(u.subscription.expiresAt)} · {u.subscription.source === 'manual' ? 'منحة يدوية' : 'دفع'}</Badge> : <Badge>لا يوجد</Badge>}<span>جلسات مفتوحة</span><b>{detail.activeSessions}</b><span>التعلم</span><b>{detail.learning.level || '—'} · {detail.learning.xp} XP · {detail.learning.sessions} جلسة · آخر نشاط {detail.learning.lastActive || '—'}</b></div>
        <h3>الطلبات</h3>{detail.orders.length ? detail.orders.map(o => <div className="ad-line" key={o.reference}><span dir="ltr">{o.reference}</span><span>{o.plan} · {o.term}</span><Badge>{ORDER_STATUS[o.status] || o.status}</Badge></div>) : <p>لا توجد طلبات.</p>}
        <h3>تذاكر الدعم</h3>{detail.tickets.length ? detail.tickets.map(t => <div className="ad-line" key={t.reference}><span dir="ltr">{t.reference}</span><span>{t.subject}</span><Badge>{TICKET_STATUS[t.status] || t.status}</Badge></div>) : <p>لا توجد تذاكر.</p>}
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
        {key: 'reference', label: 'المرجع', ltr: true}, {key: 'customer', label: 'العميل', render: r => r.customer?.email || 'حساب محذوف', ltr: true},
        {key: 'plan', label: 'الباقة', render: r => `${r.plan === 'plus' ? 'بلاس' : 'أساسي'} · ${r.term === 'yearly' ? 'سنوي' : 'شهري'}`},
        {key: 'amount', label: 'المبلغ', render: r => `${r.amount} جنيه`}, {key: 'status', label: 'الحالة', render: r => <Badge tone={r.status === 'paid' ? 'good' : r.status === 'refunded' || r.status === 'failed' ? 'bad' : 'warn'}>{ORDER_STATUS[r.status] || r.status}</Badge>},
        {key: 'createdAt', label: 'التاريخ', render: r => fmtDay(r.createdAt)}]}/><Pager data={list.data} onPage={list.setPage}/></>}
    </div>
    <aside className="x-card ad-detail" aria-live="polite">
      {!o ? <p>اختر طلبًا لعرض التفاصيل.</p> : <>
        <h2 dir="ltr" className="ad-ltr">{o.reference}</h2>
        <div className="ad-kv"><span>العميل</span><b dir="ltr">{o.customer?.email || '—'}</b><span>المبلغ</span><b>{o.amount} جنيه</b><span>الحالة</span><Badge>{ORDER_STATUS[o.status] || o.status}</Badge><span>أُنشئ</span><b>{fmtDate(o.createdAt)}</b><span>دُفع</span><b>{fmtDate(o.paidAt)}</b><span>ينتهي</span><b>{fmtDay(o.expiresAt)}</b>{o.manualPaymentReference && <><span>مرجع الدفع اليدوي</span><b dir="ltr">{o.manualPaymentReference}</b></>}{o.paymobOrderId && <><span>طلب Paymob</span><b dir="ltr">{o.paymobOrderId}</b></>}{o.transactionId && <><span>عملية Paymob</span><b dir="ltr">{o.transactionId}</b></>}{o.refundedAt && <><span>استُرد</span><b>{fmtDate(o.refundedAt)}</b></>}</div>
        <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
        {perms.includes('orders.write') && <div className="ad-actions">
          {o.status === 'pending_contact' && <ReasonAction label="تفعيل بعد التحقق من الدفع" busy={act.busy} fields={[{name: 'paymentReference', label: 'مرجع الدفع المُتحقق منه', required: true, min: 6}]} confirmText="تأكد أنك راجعت الدفع في سجلات البنك/التاجر. متابعة؟" onSubmit={b => act.run(() => adminApi(`orders/${o.reference}/activate`, {method: 'POST', body: b}), 'تم تفعيل الطلب والاشتراك.').then(after)}/>}
          {o.status === 'paid' && <ReasonAction label="تسجيل استرداد" tone="danger" confirmText="سيُسحب الاشتراك المرتبط. إعادة المبلغ تتم من لوحة بوابة الدفع. متابعة؟" busy={act.busy} onSubmit={b => act.run(() => adminApi(`orders/${o.reference}/refund`, {method: 'POST', body: b}), r => r.notice).then(after)}/>}
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
        <h2>{t.subject}</h2><p dir="ltr" className="ad-ltr">{t.reference} · {t.customer?.email || 'حساب محذوف'}</p>
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
        <h2>{l.name}</h2><p dir="ltr" className="ad-ltr">{l.email} · {l.phone}</p>
        <div className="ad-kv"><span>المرجع</span><b dir="ltr">{l.reference}</b><span>النوع</span><b>{KIND[l.kind] || l.kind}</b><span>اللغة</span><b>{l.language}</b>{l.company && <><span>الجهة</span><b>{l.company}</b></>}{l.plan && <><span>الباقة</span><b>{l.plan} · {l.term}</b></>}{l.groupSize && <><span>حجم المجموعة</span><b>{l.groupSize}</b></>}{l.preferredDate && <><span>الموعد المفضل</span><b>{l.preferredDate} {l.preferredTime} (القاهرة) — يحتاج تأكيدًا</b></>}<span>وصل</span><b>{fmtDate(l.createdAt)}</b></div>
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
      {verify && <div className={'ad-verify-result ' + (verify.ok ? 'good' : 'bad')}>{verify.ok ? <>سليم · {verify.checked} إدخال موقّع{verify.keyed ? ' بمفتاح سري' : ' (بدون مفتاح سري — اضبط AUDIT_HMAC_KEY)'}{verify.legacy ? ` · ${verify.legacy} إدخال قديم غير مرتبط` : ''}</> : <>خلل عند الإدخال #{verify.brokenAt}: <span dir="ltr">{verify.reason}</span></>}</div>}
      {act.msg.kind === 'error' && <Notice kind="error">{act.msg.text}</Notice>}
    </div>
    <Toolbar q={list.q} setQ={list.setQ} onRefresh={list.reload}><Select label="الحدث" value={event} onChange={setEvent} options={events}/><Select label="المنفّذ" value={actorType} onChange={setActorType} options={{admin: 'مشرف', user: 'متعلم', system: 'النظام', cli: 'أداة الخادم', 'legacy-token': 'الرمز القديم'}}/></Toolbar>
    <ListState list={list}/>
    {list.data && <><Table rowKey={r => r.id} rows={list.data.items} columns={[
      {key: 'seq', label: '#', render: r => r.seq || '—'}, {key: 'at', label: 'الوقت', render: r => fmtDate(r.at)}, {key: 'event', label: 'الحدث', ltr: true},
      {key: 'actor', label: 'المنفّذ', ltr: true, render: r => r.actorLabel}, {key: 'target', label: 'الهدف', ltr: true, render: r => r.target ? `${r.target.type}:${String(r.target.id).slice(0, 14)}` : '—'},
      {key: 'meta', label: 'التفاصيل', render: r => <span className="ad-meta" dir="ltr">{r.meta?.reason ? `reason: ${r.meta.reason}` : Object.entries(r.meta || {}).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || '—'}</span>},
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
      {key: 'role', label: 'الدور', render: r => canWrite && r.id !== me.id ? <select aria-label={'دور ' + r.email} value={r.role} disabled={act.busy} onChange={e => update(r, {role: e.target.value}, 'تم تغيير الدور وإنهاء جلساته.')}>{Object.keys(ROLE_LABEL).filter(k => k !== 'owner' || me.role === 'owner').map(k => <option key={k} value={k}>{ROLE_LABEL[k]}</option>)}</select> : ROLE_LABEL[r.role] || r.role},
      {key: 'status', label: 'الحالة', render: r => r.status === 'active' ? <Badge tone="good">نشط</Badge> : <Badge tone="bad">معطّل</Badge>},
      {key: 'lastLoginAt', label: 'آخر دخول', render: r => fmtDate(r.lastLoginAt)},
      {key: 'actions', label: '', render: r => canWrite && r.id !== me.id ? <button type="button" className={'ad-btn ' + (r.status === 'active' ? 'danger' : '')} disabled={act.busy} onClick={() => { if (r.status !== 'active' || confirm(`تعطيل ${r.email}؟ ستُنهى جلساته فورًا.`)) update(r, {status: r.status === 'active' ? 'disabled' : 'active'}, r.status === 'active' ? 'تم تعطيل المشرف.' : 'تم تفعيل المشرف.'); }}>{r.status === 'active' ? 'تعطيل' : 'تفعيل'}</button> : null}]}/><Pager data={list.data} onPage={list.setPage}/></>}
    {canWrite && <form className="x-card ad-create" onSubmit={async e => { e.preventDefault(); const r = await act.run(() => adminApi('admins', {method: 'POST', body: form}), 'تم إنشاء حساب المشرف. شارك كلمة المرور عبر قناة آمنة واطلب تغييرها.'); if (r) { setForm({email: '', name: '', role: 'support', password: ''}); list.reload(); } }}>
      <h2><KeyRound size={20} aria-hidden="true"/> إضافة مشرف</h2>
      <div className="ad-grid">
        <label>الاسم<input value={form.name} onChange={e => setForm({...form, name: e.target.value})} required minLength={2} maxLength={80}/></label>
        <label>البريد<input type="email" dir="ltr" value={form.email} onChange={e => setForm({...form, email: e.target.value})} required/></label>
        <label>الدور<select value={form.role} onChange={e => setForm({...form, role: e.target.value})}>{Object.keys(ROLE_LABEL).filter(k => k !== 'owner' || me.role === 'owner').map(k => <option key={k} value={k}>{ROLE_LABEL[k]}</option>)}</select></label>
        <label>كلمة مرور مؤقتة (١٢ حرفًا على الأقل)<input type="password" dir="ltr" autoComplete="new-password" value={form.password} onChange={e => setForm({...form, password: e.target.value})} required minLength={12} maxLength={128}/></label>
      </div>
      <button className="ad-btn primary" type="submit" disabled={act.busy}>{act.busy ? 'جاري الإنشاء…' : 'إنشاء الحساب'}</button>
    </form>}
    {roles && <div className="x-card"><h2><ClipboardList size={20} aria-hidden="true"/> مصفوفة الصلاحيات</h2><p>الأدوار محددة في الخادم؛ يُطبق الخادم الصلاحية على كل طلب بغض النظر عن الواجهة.</p>
      <div className="ad-table-wrap"><table className="ad-table ad-matrix"><thead><tr><th scope="col">الصلاحية</th>{Object.keys(roles.roles).map(r => <th key={r} scope="col">{ROLE_LABEL[r] || r}</th>)}</tr></thead>
        <tbody>{Object.entries(roles.permissions).map(([p, desc]) => <tr key={p}><td><b dir="ltr">{p}</b><small>{desc}</small></td>{Object.entries(roles.roles).map(([r, def]) => <td key={r} className="ad-center">{def.permissions.includes(p) ? <span aria-label="مسموح">✓</span> : <span aria-label="غير مسموح" className="ad-dim">—</span>}</td>)}</tr>)}</tbody></table></div></div>}
  </div>;
}

// ---------------------------------------------------------------- password change
function PasswordPanel({onAuthLost, onClose}) {
  const [f, setF] = useState({currentPassword: '', newPassword: ''});
  const act = useAction(onAuthLost);
  return <form className="x-card ad-password" onSubmit={async e => { e.preventDefault(); const r = await act.run(() => adminApi('auth/password', {method: 'POST', body: f}), r => r.message); if (r) setF({currentPassword: '', newPassword: ''}); }}>
    <h2>تغيير كلمة المرور</h2>
    <label>الحالية<input type="password" dir="ltr" autoComplete="current-password" value={f.currentPassword} onChange={e => setF({...f, currentPassword: e.target.value})} required/></label>
    <label>الجديدة (١٢ حرفًا على الأقل)<input type="password" dir="ltr" autoComplete="new-password" value={f.newPassword} onChange={e => setF({...f, newPassword: e.target.value})} required minLength={12}/></label>
    <div className="ad-row"><button className="ad-btn primary" type="submit" disabled={act.busy}>حفظ</button><button type="button" className="ad-btn ghost" onClick={onClose}>إغلاق</button></div>
    <Notice kind={act.msg.kind}>{act.msg.text}</Notice>
  </form>;
}

// ---------------------------------------------------------------- console shell
export default function AdminConsole() {
  const [session, setSession] = useState(undefined), [expired, setExpired] = useState(false), [tab, setTab] = useState('overview'), [pw, setPw] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { adminApi('auth/me').then(setSession).catch(() => setSession(null)); return () => { mounted.current = false; }; }, []);
  const onAuthLost = useCallback(() => { setSession(null); setExpired(true); }, []);
  if (session === undefined) return <section className="x-page"><div className="x-card">جاري التحقق من الجلسة…</div></section>;
  if (!session) return <SignIn expired={expired} onSignedIn={d => { setExpired(false); setSession(d); const first = TABS.find(t => d.permissions.includes(t.perm)); setTab(first?.id || 'overview'); }}/>;
  const perms = session.permissions || [];
  const tabs = TABS.filter(t => perms.includes(t.perm));
  const current = tabs.find(t => t.id === tab) ? tab : tabs[0]?.id;
  const logout = async () => { try { await adminApi('auth/logout', {method: 'POST'}); } catch {} setSession(null); setExpired(false); };
  const props = {perms, onAuthLost, me: session.admin};
  return <section className="x-page ad-page">
    <header className="ad-head">
      <div><span className="ad-kicker">USAM Language Operations</span><h1>لوحة التشغيل</h1></div>
      <div className="ad-who"><span><b>{session.admin.name}</b><small>{ROLE_LABEL[session.admin.role] || session.admin.role}{session.legacy ? ' · رمز قديم (قراءة فقط)' : ''}</small></span>
        {!session.legacy && <button type="button" className="ad-btn ghost" onClick={() => setPw(!pw)}><KeyRound size={15} aria-hidden="true"/> كلمة المرور</button>}
        <button type="button" className="ad-btn ghost" onClick={logout}><LogOut size={15} aria-hidden="true"/> خروج</button></div>
    </header>
    {session.legacy && <Notice kind="info">أنت تستخدم رمز الإدارة القديم المشترك (قراءة فقط). أنشئ حسابات مشرفين شخصية ثم عطّل ADMIN_LEGACY_TOKEN.</Notice>}
    {pw && <PasswordPanel onAuthLost={onAuthLost} onClose={() => setPw(false)}/>}
    <nav className="x-tabs ad-tabs" aria-label="أقسام لوحة التشغيل">{tabs.map(t => <button type="button" key={t.id} className={current === t.id ? 'active' : ''} aria-current={current === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}><t.icon size={16} aria-hidden="true"/> {t.label}</button>)}</nav>
    {!tabs.length ? <Notice kind="info">لا توجد أقسام متاحة لدورك.</Notice>
      : current === 'overview' ? <Overview {...props}/>
      : current === 'users' ? <UsersScreen {...props}/>
      : current === 'orders' ? <OrdersScreen {...props}/>
      : current === 'support' ? <SupportScreen {...props}/>
      : current === 'leads' ? <LeadsScreen {...props}/>
      : current === 'audit' ? <AuditScreen {...props}/>
      : <AdminsScreen {...props}/>}
  </section>;
}
