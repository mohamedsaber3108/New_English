// AI usage metering helpers (E-8): cost estimate, per-plan daily cap and the "limit reached" message.
// Nothing here touches message text. All settings are environment NAMES documented in .env.example.

// Estimated cost in millionths of a US dollar (1,000,000 = USD 1). Prices per 1,000 tokens come from
//   AI_PRICE_IN_PER_1K_MICRO  and  AI_PRICE_OUT_PER_1K_MICRO  (default 0 -> cost 0: an estimate is never invented).
export function estimateCostMicro(tokensIn, tokensOut, env = process.env) {
  const pin = Math.max(0, Number(env.AI_PRICE_IN_PER_1K_MICRO) || 0), pout = Math.max(0, Number(env.AI_PRICE_OUT_PER_1K_MICRO) || 0);
  return Math.round((Math.max(0, Number(tokensIn) || 0) * pin + Math.max(0, Number(tokensOut) || 0) * pout) / 1000);
}

// Live-AI requests allowed per learner per Cairo day. Per plan:
//   AI_DAILY_CAP_ESSENTIAL, AI_DAILY_CAP_PLUS; each falls back to AI_DAILY_REQUESTS_PER_USER, then to 150 (the old single value).
// No cap number is chosen for real use until 30 days of data with 30+ paying learners exist (PLAN.md E-8).
export function dailyCap(plan, env = process.env) {
  const pick = v => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };
  const fallback = pick(env.AI_DAILY_REQUESTS_PER_USER) ?? 150;
  return (plan === 'plus' ? pick(env.AI_DAILY_CAP_PLUS) : pick(env.AI_DAILY_CAP_ESSENTIAL)) ?? fallback;
}

// Plain English + Arabic message saying when the cap resets (midnight, Cairo time).
export function capNotice(msLeft, now = Date.now()) {
  const mins = Math.max(1, Math.ceil(msLeft / 60000)), h = Math.floor(mins / 60), m = mins % 60;
  const en = h ? `${h} h ${m} min` : `${m} min`;
  const ar = h ? `${h} ساعة${m ? ` و${m} دقيقة` : ''}` : `${m} دقيقة`;
  return {
    error: `You have reached today's live coach limit. It resets at midnight Cairo time (in about ${en}). Guided practice is still available.`,
    errorAr: `وصلت إلى الحد اليومي للمدرب المباشر. يتجدد عند منتصف الليل بتوقيت القاهرة (بعد حوالي ${ar}). التدريب الموجّه ما زال متاحًا.`,
    notice: `Daily live-AI limit reached. It resets at midnight Cairo time (in about ${en}). The guided scene continued.`,
    noticeAr: `وصلت إلى الحد اليومي للذكاء الاصطناعي المباشر. يتجدد عند منتصف الليل بتوقيت القاهرة (بعد حوالي ${ar}). استمر المشهد الموجّه.`,
    resetsAt: new Date(now + msLeft).toISOString(), resetsInMinutes: mins,
  };
}
