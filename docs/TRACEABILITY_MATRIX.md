# Frontend ↔ Backend Traceability Matrix

Generated from the actual source: server routes in `server/*.js`, client calls via `api()`/`customerApi()`
in `client/src/*.jsx`. Status reflects verified wiring, not aspiration.

Legend: **Live** = wired + works without external credentials · **Cfg** = wired, needs a provider
credential to function · **Guard** = access-gated by `paid()` (entitlement required).

## System / health

| Backend route | Method | Frontend caller | Purpose | Status |
|---|---|---|---|---|
| `/api/health` | GET | `App` (health check on load) | liveness + feature flags | Live |
| `/api/ready` | GET | load balancer (readiness probe) | storage reachability | Live |

## Marketing / lead capture

| Backend route | Method | Frontend caller | Purpose | Status |
|---|---|---|---|---|
| `/api/leads` | POST | `Marketing` contact/groups/languages forms | capture lead (5/IP/hr) | Live |
| `/api/events` | POST | analytics events (page_view, cta, …) | first-party analytics | Live |

## Auth & account (`customer.js`)

| Backend route | Method | Frontend caller | Purpose | Status |
|---|---|---|---|---|
| `/api/customer/catalog` | GET | `App`, `Account` | prices, checkout + access flags | Live |
| `/api/customer/register` | POST | `Auth` | create account + session | Live |
| `/api/customer/login` | POST | `Auth` | login + session | Live |
| `/api/customer/logout` | POST | `Account` | end session | Live |
| `/api/customer/me` | GET | `App`, `Account` | current user + profile | Live |
| `/api/customer/account` | PATCH | `AccountTools` | edit name/phone | Live |
| `/api/customer/password/change` | POST | `AccountTools` | change password (revokes other sessions) | Live |
| `/api/customer/profile` | PUT | `App` (autosave) | persist learner profile/progress | Live |
| `/api/customer/orders` | GET | `Account` | list orders | Live |
| `/api/customer/orders` | POST | `Account` → `Plans` | create order / start checkout | Cfg (Paymob) |
| `/api/customer/access` | GET | (entitlement check) | english/plus entitlement | Live |
| `/api/customer/account` | DELETE | `Account` | self-service account deletion | Live |
| `/api/paymob/webhook` | POST | Paymob (server-to-server) | HMAC-verified payment events | Cfg (Paymob) |

## Account operations (`operations.js`)

| Backend route | Method | Frontend caller | Purpose | Status |
|---|---|---|---|---|
| `/api/customer/email/verification` | POST | `AccountTools` | send verify email | Cfg (Resend) |
| `/api/customer/email/verify` | POST | `Recovery` (#verify-email) | confirm email token | Cfg (Resend) |
| `/api/customer/password/forgot` | POST | `Recovery` (#forgot-password) | request reset link | Cfg (Resend) |
| `/api/customer/password/reset` | POST | `Recovery` (#reset-password) | set new password | Live (token path); email delivery Cfg |
| `/api/customer/preferences` | GET/PUT | `AccountTools` | notification preferences | Live |
| `/api/customer/sessions` | GET | `AccountTools` | list active sessions | Live |
| `/api/customer/sessions/:id` | DELETE | `AccountTools` | revoke one session | Live |
| `/api/customer/sessions` | DELETE | `AccountTools` | revoke other sessions | Live |
| `/api/customer/support` | GET/POST | `SupportCenter` | support tickets | Live |
| `/api/customer/receipts/:reference` | GET | `Account` | receipt view | Live (needs a paid order) |

## Learning engines (`index.js` + `engine.js`)

| Backend route | Method | Frontend caller | Purpose | Status |
|---|---|---|---|---|
| `/api/assessment` | GET | `Onboarding` | placement questions | Live |
| `/api/assessment` | POST | `Onboarding` | grade placement | Live |
| `/api/feedback` | POST | `Writing` | writing feedback | Live · Guard |
| `/api/recommendation` | POST | dashboard next-step | weakest-skill recommendation | Live · Guard |
| `/api/simulation` | POST | `World` | simulation turn (guided fallback + live) | Live (guided) / Cfg (OpenAI) · Guard |
| `/api/report` | POST | `World` | session report | Live · Guard |
| `/api/coach` | POST | `Coach` | live AI tutor | Cfg (OpenAI) · Guard (plus) |
| `/api/rooms` (WS) | WebSocket | `Group` | group text room (≤4) | Live · Guard |

## Admin (`admin.js`, individual accounts + RBAC; UI `Admin.jsx`)

All routes require an admin session cookie (`usam_admin`, Path=/api/admin) and the listed permission. Every write is
recorded in the tamper-evident audit chain. Tests: `tests/admin.test.mjs` (API), `tests/e2e/admin.e2e.mjs` (browser).

| Backend route | Method | Permission | Frontend caller | Status |
|---|---|---|---|---|
| `/api/admin/auth/login` | POST | — (throttled) | `SignIn` | Live |
| `/api/admin/auth/logout` | POST | session | console header | Live |
| `/api/admin/auth/me` | GET | session | `AdminConsole` (session check) | Live |
| `/api/admin/auth/password` | POST | session | `PasswordPanel` | Live |
| `/api/admin/auth/mfa` | POST | MFA challenge (throttled) | `SignIn` code step | Live |
| `/api/admin/mfa/setup` | POST | session (allowed before enrollment) | `MfaPanel` | Live |
| `/api/admin/mfa/enable` | POST | session (allowed before enrollment) | `MfaPanel` | Live |
| `/api/admin/mfa/disable` | POST | session + password + code | `MfaPanel` | Live |
| `/api/admin/admins/:id/mfa/reset` | POST | admins.write | `AdminsScreen` | Live |
| `/api/admin/overview` | GET | dashboard.read | `Overview` (KPIs + integration status) | Live |
| `/api/admin/users` | GET | users.read | `UsersScreen` (q, status, subscription, verified, page) | Live |
| `/api/admin/users/:id` | GET | users.read | `UsersScreen` detail | Live |
| `/api/admin/users/:id/status` | PATCH | users.write | suspend / reactivate | Live |
| `/api/admin/users/:id/revoke-sessions` | POST | users.write | end all sessions | Live |
| `/api/admin/users/:id/verify-email` | POST | users.write | mark email verified | Live |
| `/api/admin/users/:id/entitlements` | POST | orders.write | grant manual entitlement | Live |
| `/api/admin/users/:id/entitlements/English` | DELETE | orders.write | revoke entitlement | Live |
| `/api/admin/orders` | GET | orders.read | `OrdersScreen` (q, status, plan, page) | Live |
| `/api/admin/orders/:reference/activate` | POST | orders.write | manual payment activation | Live |
| `/api/admin/orders/:reference/refund` | POST | orders.write | record refund (no money movement) | Live |
| `/api/admin/support` | GET | support.read | `SupportScreen` (q, status, category, page) | Live |
| `/api/admin/support/:reference` | PATCH | support.write | status + resolution | Live |
| `/api/admin/leads` | GET | leads.read | `LeadsScreen` (q, status, kind, page) | Live |
| `/api/admin/leads/:reference` | PATCH | leads.write | status + note | Live |
| `/api/admin/audit` | GET | audit.read | `AuditScreen` (q, event, actorType, page) | Live |
| `/api/admin/audit/verify` | GET | audit.read | "verify chain" button | Live |
| `/api/admin/roles` | GET | admins.read | permission matrix | Live |
| `/api/admin/admins` | GET/POST | admins.read / admins.write | `AdminsScreen` list + create | Live |
| `/api/admin/admins/:id` | PATCH | admins.write | change role / disable | Live |

## Gaps identified (tracked in PROJECT_LEDGER.md)

- Account/profile **edit** (name/phone) and **change password**: DONE. Email change (re-verify) deferred.
- Receipt/invoice **printable** page: API exists; UI is an `alert()` (PARTIAL).
- Admin operations UI, RBAC, lead management, admin MFA (TOTP): DONE. QR code for MFA setup: TODO.
- Calendar booking for meeting leads: TODO (leads record a preferred time; staff confirm manually).
- Rate limiting and rooms are Redis-shared when `REDIS_URL` is set (DONE).
- Core data is still a single document per deployment (JSON file or one PostgreSQL row) - normalized tables needed for write throughput at the 100k target (TODO, highest backend priority).