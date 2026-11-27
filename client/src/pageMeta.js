// Page language, direction, <title> and meta description for each route (U-1). One table, one function, called on every route change.
// Pure (no React, no DOM except in applyPageMeta), so tests/page-meta.test.mjs can import it in Node.
//
// Default taken (owner may change, QUESTIONS Q-4 / OD-28c): Arabic, right-to-left on the acquisition pages;
// the English learner workspace is English, left-to-right. The admin console is listed below as Arabic because its screens are
// written in Arabic today (its labels are Arabic). When the owner wants an English admin, translate the screens and change
// ADMIN_LANG here: the page language must match the words on the page, or screen readers read it with the wrong voice.
import {nav} from './data.js';

export const ADMIN_LANG = 'ar';
const SITE = 'USAM Language';

// Arabic pages: marketing, account, trust pages, and the admin console (see ADMIN_LANG).
export const ARABIC_PAGES = ['landing', 'languages', 'method', 'pricing', 'groups', 'contact', 'faq', 'about', 'account', 'support', 'privacy', 'terms', 'resources', 'placement', 'forgot-password', 'reset-password', 'verify-email', 'payment-result', 'refund', 'acceptable', 'accessibility', 'data'];

const AR_TITLES = {landing: `${SITE} | لغة تعيشها`, languages: `اللغات | ${SITE}`, method: `طريقة التعلّم | ${SITE}`, pricing: `الأسعار | ${SITE}`, groups: `المجموعات | ${SITE}`, contact: `تواصل معنا | ${SITE}`, faq: `الأسئلة الشائعة | ${SITE}`, about: `عن المنصة | ${SITE}`, account: `حسابي | ${SITE}`, support: `المساعدة | ${SITE}`, privacy: `الخصوصية | ${SITE}`, terms: `الشروط | ${SITE}`, resources: `مكتبة البداية | ${SITE}`, placement: `تقييم البداية | ${SITE}`, refund: `الإلغاء والاسترداد | ${SITE}`, acceptable: `الاستخدام المقبول | ${SITE}`, accessibility: `إمكانية الوصول | ${SITE}`, data: `حقوق البيانات | ${SITE}`, admin: `التشغيل | ${SITE}`};
const AR_DEFAULT_TITLE = SITE;
const EN_NAV_TITLES = Object.fromEntries(nav.map(([id, label]) => [id, `${label} | ${SITE}`]));
const EN_DEFAULT_TITLE = `Learn English | ${SITE}`;

const AR_DESCRIPTION = 'USAM Language — تعلّم الإنجليزية بالممارسة والمواقف الحقيقية. باقات فردية ومجموعات.';
const EN_DESCRIPTION = 'USAM Language — practise English with guided scenes, stories, writing and spaced review.';

// -> {lang, dir, title, description} for a route name such as 'landing' or 'coach' (the part of the hash before any '/' or '?').
export function pageMeta(page) {
  const name = String(page || 'landing');
  const arabic = ARABIC_PAGES.includes(name) || (name === 'admin' && ADMIN_LANG === 'ar');
  if (arabic) return {lang: 'ar', dir: 'rtl', title: AR_TITLES[name] || AR_DEFAULT_TITLE, description: AR_DESCRIPTION};
  if (name === 'admin') return {lang: 'en', dir: 'ltr', title: `Operations | ${SITE}`, description: EN_DESCRIPTION};
  return {lang: 'en', dir: 'ltr', title: EN_NAV_TITLES[name] || EN_DEFAULT_TITLE, description: EN_DESCRIPTION};
}

// Sets <html lang>, <html dir>, <title> and the meta description together, so they can never disagree.
export function applyPageMeta(page, doc = document) {
  const m = pageMeta(page);
  const root = doc.documentElement;
  root.setAttribute('lang', m.lang);
  root.setAttribute('dir', m.dir);
  doc.title = m.title;
  let tag = doc.querySelector('meta[name="description"]');
  if (!tag && doc.head) { tag = doc.createElement('meta'); tag.setAttribute('name', 'description'); doc.head.appendChild(tag); }
  tag?.setAttribute('content', m.description);
  return m;
}

// The route name from a location hash: '#coach?x=1' and '#reset-password/abc' -> 'coach', 'reset-password'.
export const routeOf = hash => String(hash || '').replace(/^#/, '').split('?')[0].split('/')[0] || 'landing';
