# USAM Language — Task Ledger & Production Completion Status

This ledger is the single source of truth for completion status. It is updated at the end of every
phase. Status vocabulary:

- **DONE** — implemented, integrated, and covered by an automated test or verified build/run evidence.
- **PARTIAL** — real implementation exists but is shallow (prototype-grade) or missing edge cases/tests.
- **BLOCKED** — cannot be completed without a real external dependency (provider credential, domain, legal sign-off).
- **TODO** — not yet started.

A feature is only **DONE** when it works end-to-end, persists required data, handles errors, and has a test.

---

## Phase status overview

| Phase | Title | Status |
|---|---|---|
| 0 | Baseline + Git + verified build/smoke | DONE |
| 1 | Critical security: access enforcement decoupled from payment | DONE |
| 2 | Deliverable docs: inventory, engine registry, API inventory, RTM | IN PROGRESS |
| 3 | Frontend correctness: 404/error pages, single pricing source | TODO |
| 4 | Learning engine depth: review (SM-2) DONE; placement, writing, recommendation | IN PROGRESS |
| 5 | Persistence: PostgreSQL migration behind existing API contracts | TODO |
| 6 | Scale: Redis sessions/cache, stateless app, WS coordination | TODO |
| 7 | Admin/operations UI (replace raw JSON viewer) | TODO |
| 8 | Observability: structured logs, metrics, health/readiness | TODO |
| 9 | Test matrix: unit, integration, e2e, load | TODO |
| 10 | Release gates + go-live report | TODO |

---

## 1. Core platform

| Item | Status | Evidence / Notes |
|---|---|---|
| React (Vite) build | DONE | `npx vite build` → 1,586 modules, passes |
| Node/Express server syntax | DONE | `npm run check` passes |
| API smoke test | DONE | `tests/api-smoke.mjs` passes |
| Git baseline + checkpoints | DONE | commits `6c6023a`, `588835e` |
| Access enforcement (fail closed) | DONE | `tests/access-enforcement.mjs` 7/7 assertions pass |

## 2. Authentication & accounts

| Item | Status | Notes |
|---|---|---|
| Register (scrypt N=2^17) | DONE | `server/customer.js` |
| Login / logout / sessions | DONE | HttpOnly SameSite cookie, server-side session store |
| Login throttling | PARTIAL | in-memory per-IP; resets on restart (needs shared store at scale) |
| Email verification | BLOCKED | code done; needs Resend API key + verified domain |
| Password reset (one-use token) | BLOCKED | code done; needs Resend |
| Account deletion (self-service) | DONE | `DELETE /api/customer/account` with password confirm |
| Account/profile edit (name/phone/email/password) | TODO | audit §4.3: no edit UI/API yet |
| Session management UI | DONE | list/revoke sessions in Settings |

## 3. Payments & entitlements

| Item | Status | Notes |
|---|---|---|
| Paymob hosted checkout | BLOCKED | code done; needs PAYMOB_* keys + merchant sandbox tests |
| Webhook HMAC verification | DONE (code) | server-side price/HMAC check; needs live reconciliation test |
| Entitlement model + expiry | DONE | `active()`; enforced via `paid()` gate |
| Single pricing source of truth | PARTIAL | prices duplicated in server + Customer.jsx + Pricing copy |
| Billing/cancel portal | TODO | fixed-period model; no renewal/cancel UI |
| Printable receipt/invoice | PARTIAL | API exists; UI only `alert()` |

## 4. Learning engines

| Engine | Status | Notes |
|---|---|---|
| Placement assessment | PARTIAL | 6 MCQs, no speaking/writing evidence, no calibration |
| Skill-level profile (per-skill) | PARTIAL | per-skill estimates exist; not evidence-weighted over time |
| Adaptive recommendation | PARTIAL | weakest-skill heuristic in `engine.js`/`main.jsx` |
| Curriculum / learning path | PARTIAL | static units in `data.js`, not DB-driven |
| AI coach (text) | BLOCKED | OpenAI code done + guided fallback; needs OPENAI_API_KEY |
| Live simulation (dynamic) | PARTIAL/BLOCKED | guided fallback works; live mode needs OpenAI |
| Writing evaluation | PARTIAL | regex heuristics in `assessText`; no real grammar engine |
| Pronunciation | PARTIAL | browser Web Speech transcript compare; no phoneme scoring |
| Interactive stories | PARTIAL | one 3-step story |
| Spaced repetition / review | DONE | SM-2 engine `server/scheduler.js`, 35 unit tests, shared client+server; FSRS upgrade path documented in module |
| Group voice rooms | PARTIAL | in-memory text WebSocket, max 4, no voice/moderation/persistence |
| Gamification (XP/streak) | DONE | client-side; persisted to profile |
| Progress analytics | PARTIAL | session list + skill estimates; no deep analytics |

## 5. Admin & operations

| Item | Status | Notes |
|---|---|---|
| Admin auth (shared bearer) | PARTIAL | single shared token; no identities/RBAC/MFA |
| Admin overview/users/orders/support/audit/leads APIs | DONE (read) | `server/operations.js` |
| Admin operations UI | TODO | currently raw JSON viewer |
| Support ticket update | DONE | `PATCH /api/admin/support/:ref` |
| Lead/meeting management UI | TODO | read-only today |

## 6. Infrastructure & scale (target: 100,000 registered users)

| Item | Status | Notes |
|---|---|---|
| Storage | PARTIAL | single-process JSON file; must migrate to PostgreSQL |
| Shared cache / sessions (Redis) | TODO | required for stateless multi-instance |
| Object storage for media | TODO | no uploads today |
| Background workers / queue | TODO | none |
| Load balancer + health/readiness | PARTIAL | `/api/health` exists; no readiness split, no LB config |
| WebSocket shared coordination | TODO | rooms in Node memory (single instance only) |
| Structured logs / metrics / tracing | TODO | console logging only |
| Backup / restore | PARTIAL | `scripts/backup.sh` covers customers.json only |
| Load test + capacity evidence | TODO | none yet |

## 7. Capacity targets (to be validated by load tests — NOT yet measured)

| Metric | Target (proposed) | Measured |
|---|---|---|
| Registered accounts | 100,000 | — |
| Daily active users | ~15,000 | — |
| Peak concurrent sessions | ~5,000 | — |
| Concurrent AI voice sessions | provider-bound | — |
| Concurrent user voice rooms | TBD | — |
| Requests per second | TBD | — |
| Background job throughput | TBD | — |

---

## External dependencies (BLOCKED until supplied)

| Dependency | Needed for | Owner |
|---|---|---|
| Paymob keys (secret/public/integration/HMAC) + HTTPS origin | Real payments | Business |
| Resend API key + verified sending domain | Email verify/reset | Business |
| OpenAI API key | Live AI coach + dynamic simulation | Business |
| Production domain + TLS | HTTPS, mic/speech, cookies | Business |
| Legal/privacy/refund/tax copy approval | Commercial launch | Legal |
| AWS account + infra provisioning | Deploy, scale, load test | Business/DevOps |

No credential is fabricated. Integrations are built credential-ready and marked BLOCKED until verified.
