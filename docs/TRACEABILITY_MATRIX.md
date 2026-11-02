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

## Admin (`operations.js`, bearer-gated)

| Backend route | Method | Frontend caller | Purpose | Status |
|---|---|---|---|---|
| `/api/admin/overview` | GET | `AdminPortal` | KPIs | Live |
| `/api/admin/users` | GET | `AdminPortal` | user list | Live |
| `/api/admin/orders` | GET | `AdminPortal` | order list | Live |
| `/api/admin/support` | GET | `AdminPortal` | ticket list | Live |
| `/api/admin/support/:reference` | PATCH | `AdminPortal` | update ticket | Live |
| `/api/admin/audit` | GET | `AdminPortal` | audit log | Live |
| `/api/admin/leads` | GET | `AdminPortal` | lead list | Live |

## Gaps identified (tracked in PROJECT_LEDGER.md)

- Account/profile **edit** (name/phone) and **change password**: DONE. Email change (re-verify) deferred.
- Receipt/invoice **printable** page: API exists; UI is an `alert()` (PARTIAL).
- Admin **operations UI**: currently a raw JSON viewer, not an operational dashboard (TODO).
- Admin **RBAC/MFA**: single shared bearer token (PARTIAL — security).
- Lead/meeting **management** actions (status update, calendar): read-only today (TODO).
- Rate limiters and WS rooms are **in-memory** (single-instance only) — need shared coordination for scale (TODO).
