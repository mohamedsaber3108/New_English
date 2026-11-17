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
| 2 | Deliverable docs: inventory, engine registry, API inventory, RTM | DONE (TRACEABILITY_MATRIX, DEPLOYMENT, runbooks) |
| 3 | Frontend correctness: 404/error pages, single pricing source | DONE |
| 4 | Learning engine depth: review (SM-2), server-side learning records DONE; placement, writing, recommendation | PARTIAL (heuristic engines) |
| 5 | Persistence: PostgreSQL migration behind existing API contracts | DONE (relational tables) |
| 6 | Scale: Redis sessions/cache, stateless app, WS coordination | DONE (code + local tests); production capacity unmeasured |
| 7 | Admin/operations UI (replace raw JSON viewer) | DONE |
| 8 | Observability: structured logs, metrics, health/readiness | DONE (alerting needs infra) |
| 9 | Test matrix: unit, integration, e2e, load | DONE locally: 403 default / 514 PG+Redis / 46 browser E2E; laptop load baseline |
| 10 | Release gates + go-live report | DONE (docs/DEPLOYMENT.md checklist); go-live BLOCKED on external inputs |

---

## 1. Core platform

| Item | Status | Evidence / Notes |
|---|---|---|
| React (Vite) build | DONE | `npm run build:app` (production) and `npm run build` (static preview, `--mode static`, cross-platform) pass |
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
| Single pricing source of truth | DONE | server catalog is the source; clients render `/api/customer/catalog` |
| Billing/cancel portal | TODO | fixed-period model; no renewal/cancel UI |
| Receipt view | DONE | `GET /customer/receipts/:reference` rendered as a receipt card in Account. Tax invoice format: needs legal/tax review |

## 4. Learning engines

| Engine | Status | Notes |
|---|---|---|
| Placement assessment | PARTIAL | 6 MCQs, no speaking/writing evidence, no calibration |
| Skill-level profile (per-skill) | PARTIAL | per-skill estimates exist; not evidence-weighted over time |
| Adaptive recommendation | PARTIAL | weakest-skill heuristic in `engine.js`/`main.jsx` |
| Curriculum / learning path | PARTIAL | static units in `data.js`, not DB-driven |
| AI coach (text) | BLOCKED | `server/ai.js` adapter: timeout + one retry on 429/5xx, reply-length cap, per-learner daily quota, scenarios taken from the server copy (prompt-injection guard). `tests/ai.test.mjs` against a fake provider only. Live calls need OPENAI_API_KEY (not used) |
| Live simulation (dynamic) | PARTIAL/BLOCKED | guided fallback works; live mode needs OpenAI |
| Writing evaluation | PARTIAL | regex heuristics in `assessText`; no real grammar engine |
| Pronunciation | PARTIAL | browser Web Speech transcript compare; no phoneme scoring |
| Interactive stories | PARTIAL | one 3-step story |
| Spaced repetition / review | DONE | SM-2 engine `server/scheduler.js`, 35 unit tests, shared client+server; FSRS upgrade path documented in module |
| Group rooms | PARTIAL | text rooms now multi-instance + flood-limited + identity-safe (tested). Still missing: voice (needs WebRTC/LiveKit infra), moderation/reporting, session reports |
| Gamification (XP/streak) | DONE | computed server-side from `learning_activities` (migration 002); browser can no longer set XP/streak; daily XP cap (LEARNING_DAILY_XP_ACTIVITIES); streak on the Cairo calendar day. `tests/learning.test.mjs` |
| Progress analytics | PARTIAL | server progress/history/assessments endpoints + data export (`GET /customer/export`); no deep analytics UI |
| Review cards (SM-2) persistence | DONE | `review_cards` table, `GET/POST /customer/learning/reviews` |

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
| Storage | DONE | Relational schema (13 tables, migrations, constraints, indexes) via `server/db`: PostgreSQL in production, embedded PGlite for dev/tests; row-level transactional writes; automatic one-time import of the legacy document; graceful shutdown. Tests: db (22), repo (57), legacy-import (25) on both engines |
| Shared rate limiting (Redis) | DONE | API (120/min/IP), auth, leads all Redis-backed when REDIS_URL set; verified vs real Redis 7 |
| Sessions across instances | DONE (fixed) | sessions live in storage. A stale-cache bug made sessions created on one instance invisible on another; fixed with a version check (commit c0d80f1) and proven by `tests/multi-instance.mjs` |
| WebSocket room coordination across instances | DONE | `server/rooms.js`: Redis hash membership + atomic Lua join (4-cap holds globally), pub/sub fan-out, heartbeats prune crashed-instance ghosts; memory fallback. Proven by `tests/rooms.test.mjs` (2 instances: cross-instance message + global cap) |
| Room safety | DONE | account name overrides spoofable query name; 20 msgs/10s per connection; ping/pong drops dead sockets; 4KB max payload; entitlement enforced on connect |
| Object storage for media | TODO | no uploads today |
| Background workers / queue | TODO | none |
| Health/readiness + proxy config | DONE | `/api/health` (liveness), `/api/ready` (database), `deploy/nginx.conf` incl. WebSocket. Load balancer itself: BLOCKED on infrastructure |
| Structured logs / metrics | DONE (local) | `server/observability.js`: JSON logs with request ids (no query strings/cookies/PII), Prometheus `/api/metrics` behind METRICS_TOKEN (requests by route template, latency histograms, memory, event-loop lag, DB pool saturation, WS clients), JSON error handler, unhandled-rejection logging. `tests/observability.test.mjs` (20). Alerting/dashboards need the monitoring stack: BLOCKED on infrastructure. Distributed tracing: not implemented |
| Backup / restore | DONE (local) | `scripts/backup.sh` (pg_dump + validated archive + SHA-256 + retention + optional S3) and `scripts/restore.sh` (checksum check, confirm flag, single transaction); systemd timer; drill `tests/backup-restore.test.mjs` 15/15 on Linux/PG16 (app works on the restored DB, audit chain verifies). Repeat on AWS/RDS: BLOCKED on infrastructure. Runbook: docs/BACKUP_RESTORE.md |
| Load test + capacity evidence | PARTIAL | Baseline 2 (laptop): 100,000 learners on PostgreSQL, ~2,200 reads/s and ~1,450 writes/s from one process, p99 21-53 ms, 0 failures; throughput independent of data size. Production capacity (multi-instance, RDS, AWS network) BLOCKED on infrastructure |

## 7. Capacity targets (to be validated by load tests — NOT yet measured)

| Metric | Target (proposed) | Measured |
|---|---|---|
| Registered accounts | 100,000 | 100,000 stored and served on PostgreSQL in the laptop load test (not a production measurement) |
| Daily active users | ~15,000 | — |
| Peak concurrent sessions | ~5,000 | — |
| Concurrent AI voice sessions | provider-bound | — |
| Concurrent user voice rooms | TBD | — |
| Requests per second | TBD | — |
| Background job throughput | TBD | — |

---

## 8. Release & deployment
| Item | Status | Notes |
|---|---|---|
| Deployment guide | DONE (not executed on a server) | `docs/DEPLOYMENT.md`: server prep, sudoers rule, RDS, env file, systemd, Nginx/TLS/DNS, Paymob callbacks, backups, monitoring, rollback, pre-launch checklist. Supersedes `docs/EC2.md` |
| Release script + rollback | DONE (bash -n checked, not run on a server) | `scripts/deploy.sh`: release dirs + `current` symlink, readiness wait, automatic restore of the previous release, `rollback`, keeps 5 releases |
| Startup configuration check | DONE | `server/config.js`: fatal findings stop the process, warnings logged. `tests/config.test.mjs` |
| CSP + self-hosted fonts | DONE | strict CSP in `server/index.js`; `@fontsource` fonts (no Google Fonts request) |
| Dependency audit | DONE | production `npm audit` 0; one dev/build-only picomatch advisory remains |
| GitHub remote | BLOCKED | repository has no remote and no credentials on this machine |
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
