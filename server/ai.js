// AI provider adapter (OpenAI-compatible Chat Completions API).
//   OPENAI_API_KEY   required for live AI (never sent to the browser)
//   OPENAI_MODEL     default gpt-4o-mini
//   OPENAI_BASE_URL  default https://api.openai.com/v1 (any OpenAI-compatible endpoint, e.g. Azure OpenAI or a gateway)
//   AI_TIMEOUT_MS    per attempt, default 20000
//   AI_MAX_TOKENS    reply length cap, default 300
// One retry on 429/5xx/timeout with a short backoff. Token usage is counted for cost monitoring (metrics).
import {inc, log} from './observability.js';
import {estimateCostMicro} from './aiusage.js';

// E-8: after each successful provider call the numbers (never the text) go to this sink, set once by server/index.js.
let usageSink = null;
export const setUsageSink = fn => { usageSink = fn; };

export const aiConfigured = () => !!process.env.OPENAI_API_KEY;
const base = () => String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

export class AiError extends Error { constructor(message, kind) { super(message); this.kind = kind; } }

export async function chat({messages, temperature = 0.7, feature = 'chat', userId = null}) {
  if (!aiConfigured()) throw new AiError('AI provider not configured', 'not_configured');
  const timeout = Number(process.env.AI_TIMEOUT_MS || 20000), maxTokens = Number(process.env.AI_MAX_TOKENS || 300);
  const body = JSON.stringify({model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature, max_tokens: maxTokens, messages});
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 400));
    const t0 = Date.now();
    try {
      const r = await fetch(base() + '/chat/completions', {method: 'POST', headers: {Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json'}, body, signal: AbortSignal.timeout(timeout)});
      let data = {}; try { data = await r.json(); } catch {}
      if (!r.ok) {
        inc('ai_requests_total', {feature, outcome: 'http_' + r.status});
        last = new AiError('AI provider returned ' + r.status, r.status === 429 ? 'rate_limited' : r.status >= 500 ? 'unavailable' : 'rejected');
        if (r.status === 429 || r.status >= 500) continue;
        throw last;
      }
      const text = data.choices?.[0]?.message?.content?.trim();
      if (!text) { inc('ai_requests_total', {feature, outcome: 'empty'}); throw new AiError('Empty AI response', 'empty'); }
      inc('ai_requests_total', {feature, outcome: 'ok'});
      const tokensIn = Number(data.usage?.prompt_tokens) || 0, tokensOut = Number(data.usage?.completion_tokens) || 0, costMicro = estimateCostMicro(tokensIn, tokensOut);
      inc('ai_calls_total', {feature});
      inc('ai_tokens_total', {feature, direction: 'in'}, tokensIn);
      inc('ai_tokens_total', {feature, direction: 'out'}, tokensOut);
      inc('ai_cost_micro_usd_total', {feature}, costMicro);
      inc('ai_latency_ms_total', {feature}, Date.now() - t0);
      // Metering must never break the learner's reply: a failed write is logged and dropped.
      if (usageSink && userId) { try { await usageSink({userId, route: feature, tokensIn, tokensOut, costMicro}); } catch (e) { log('warn', 'ai usage not recorded', {error: e.message}); } }
      return {text, usage: data.usage || null};
    } catch (e) {
      if (e instanceof AiError && e.kind !== 'unavailable' && e.kind !== 'rate_limited') throw e;
      if (!(e instanceof AiError)) { inc('ai_requests_total', {feature, outcome: e.name === 'TimeoutError' ? 'timeout' : 'network'}); last = new AiError('AI provider unreachable', 'unavailable'); }
      else last = e;
    }
  }
  throw last;
}
