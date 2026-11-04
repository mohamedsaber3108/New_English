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
| 5 | Persistence: PostgreSQL migration behind existing API contracts | DONE (document model) |
| 6 | Scale: Redis sessions/cache, stateless app, WS coordination | TODO |
| 7 | Admin/operations UI (replace raw JSON viewer) | DONE |
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
| Login throttling | DONE | `server/ratelimit.js`: 10/15min per IP + 20/15min per email; Redis-shared across instances (REDIS_URL), memory fallback; fails open if Redis down. Proven by `tests/abuse-limits.mjs` incl. 2 instances sharing one Redis |
| Forgot/reset/verify throttling | DONE | same throttle applied to password/forgot, password/reset, email/verify, email/verification (anti email-bombing / token guessing) |
| Email verification | BLOCKED | code done; needs Resend API key + verified domain |
| Password reset (one-use token) | BLOCKED | code done; needs Resend |
| Account deletion (self-service) | DONE | `DELETE /api/customer/account` with password confirm |
| Account/profile edit (name/phone) | DONE | `PATCH /customer/account` + Account UI; smoke-tested (valid + validation) |
| Change password | DONE | `POST /customer/password/change`; verifies current, revokes other sessions; smoke-tested (wrong/same/valid) |
| Email change (re-verify) | TODO | intentionally deferred; triggers verify flow |
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
| Group rooms | PARTIAL | text rooms now multi-instance + flood-limited + identity-safe (tested). Still missing: voice (needs WebRTC/LiveKit infra), moderation/reporting, session reports |
| Gamification (XP/streak) | DONE | client-side; persisted to profile |
| Progress analytics | PARTIAL | session list + skill estimates; no deep analytics |

## 5. Admin & operations

| Item | Status | Notes |
|---|---|---|
| Admin accounts + sessions | DONE | `server/admin.js`: individual accounts (scrypt), separate HttpOnly/SameSite=Strict cookie scoped to /api/admin, 8h absolute + 30m idle, disabled admins cut off immediately. `tests/admin.test.mjs` |
| RBAC | DONE | 5 roles -> 12 permissions, enforced per route server-side; no self role/status change; last active owner protected; only owners grant owner. 403s are audited |
| Shared admin token | DONE (retired) | off by default; `ADMIN_LEGACY_TOKEN=true` = read-only + audited migration mode |
| Admin MFA (TOTP) | DONE | `server/totp.js` (RFC 6238, verified against RFC test vectors), AES-256-GCM sealed secrets (ADMIN_MFA_KEY), two-step login (challenge grants nothing, 5 attempts, 5 min, new token on success), replay protection, 8 hashed one-time recovery codes, disable needs password+code, owner reset (audited), ADMIN_REQUIRE_MFA enrollment gate. Tests: totp.test (27), admin-mfa.test (40), E2E MFA journey. QR code display: TODO (setup key + otpauth link only) |
| Admin operations UI | DONE | `client/src/Admin.jsx` (lazy chunk): overview + integration status, users, orders, support, leads, audit, admins/roles. Search, filters, pagination, loading/empty/error states, reason-required actions. Browser E2E `tests/e2e/admin.e2e.mjs` (23 checks, Chrome) |
| User operations | DONE | suspend/reactivate (ends sessions, blocks login), revoke sessions, mark email verified, grant/revoke entitlement |
| Order operations | DONE | manual activation (unique payment ref, pending_contact only), refund record + entitlement revoke. Does NOT move money: provider refund is manual in the Paymob dashboard |
| Support ticket management | DONE | filter/search + status/resolution; learner sees update |
| Lead management | DONE | leads moved into primary storage (legacy JSONL imported once); status + notes |
| Tamper-evident audit log | DONE | `server/audit.js`: HMAC chain, per-entry key id + keyring rotation, downgrade detection, trim anchor; verify endpoint + UI. `tests/audit.test.mjs` (17) + tamper test in admin suite. Archive of trimmed entries: TODO |
| Admin CLI | DONE | `npm run admin:create` (password via env/stdin only); `admin:activate` ported to storage adapter + audit |

## 6. Infrastructure & scale (target: 100,000 registered users)

| Item | Status | Notes |
|---|---|---|
| Storage | DONE (document model) | `server/storage.js` adapter: JSON (default) or PostgreSQL via DATABASE_URL. PG uses row-locked txns, pooling, survives restart, shared across instances. Verified by `tests/storage.pg.test.mjs` + full app smoke/access run against real PG 16 (Docker). NEXT: normalized per-entity tables for write-concurrency at the top of the 100k range (contract unchanged). |
| Shared rate limiting (Redis) | DONE | API (120/min/IP), auth, leads all Redis-backed when REDIS_URL set; verified vs real Redis 7 |
| Sessions across instances | DONE (fixed) | sessions live in storage. A stale-cache bug made sessions created on one instance invisible on another; fixed with a version check (commit c0d80f1) and proven by `tests/multi-instance.mjs` |
| WebSocket room coordination across instances | DONE | `server/rooms.js`: Redis hash membership + atomic Lua join (4-cap holds globally), pub/sub fan-out, heartbeats prune crashed-instance ghosts; memory fallback. Proven by `tests/rooms.test.mjs` (2 instances: cross-instance message + global cap) |
| Room safety | DONE | account name overrides spoofable query name; 20 msgs/10s per connection; ping/pong drops dead sockets; 4KB max payload; entitlement enforced on connect |
| Object storage for media | TODO | no uploads today |
| Background workers / queue | TODO | none |
| Load balancer + health/readiness | PARTIAL | `/api/health` exists; no readiness split, no LB config |
| WebSocket shared coordination | TODO | rooms in Node memory (single instance only) |
| Structured logs / metrics / tracing | TODO | console logging only |
| Backup / restore | PARTIAL | `scripts/backup.sh` covers customers.json only |
| Load test + capacity evidence | PARTIAL | `tests/load/run.mjs` harness + `docs/LOAD_TEST_RESULTS.md` (laptop, not production). Baseline proves the single-document model cannot reach the target (PG rejects >~50k learners; writes 0-3/s at 10k). Re-measure after normalized storage; AWS measurement BLOCKED on infrastructure |

## 7. Capacity targets (to be validated by load tests — NOT yet measured)

| Metric | Target (proposed) | Measured |
|---|---|---|
| Registered accounts | 100,000 | single-document model: fails at ~50k (PG 256 MB JSONB limit); see LOAD_TEST_RESULTS.md |
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
