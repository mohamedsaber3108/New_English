# Admin Operations Runbook

The operations console is at `https://<your-domain>/#admin`. Staff sign in with individual accounts; every action
is permission-checked on the server and recorded in a tamper-evident audit log.

## 1. First-time setup

1. Generate an audit signing key and set it in the service environment (`/etc/usam-language.env`):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   # AUDIT_HMAC_KEY=<value>
   ```
   Keep this key out of the database and out of database backups. Without it the audit chain still detects
   naive edits but cannot resist a deliberate rewrite by someone with database access.
2. Create the first owner (the password is read from the environment or stdin, never from arguments):
   ```bash
   ADMIN_PASSWORD='a-long-unique-password' npm run admin:create -- --email you@your-domain --name "Your Name" --role owner
   ```
   With the JSON store, run this while the service is stopped (or restart it afterwards). With PostgreSQL it takes
   effect immediately.
3. Sign in at `#admin`, open **المشرفون والأدوار**, and create accounts for staff with the least privileged role
   that fits their job. Share temporary passwords over a secure channel; staff change them from the console header.

## 2. Migrating from the shared ADMIN_ACCESS_TOKEN

The shared token is disabled by default. If staff still depend on it while accounts are being created:

1. Set `ADMIN_LEGACY_TOKEN=true` (keeps `ADMIN_ACCESS_TOKEN`) - the token becomes **read-only** and every use is
   written to the audit log as `admin_legacy_token_used`.
2. Create named admin accounts (section 1).
3. Remove `ADMIN_LEGACY_TOKEN` and `ADMIN_ACCESS_TOKEN` and restart.

## 3. Roles

| Role | Can do |
|---|---|
| owner | everything, including creating administrators and granting owner |
| admin | all operations except managing administrator accounts |
| finance | view users/orders, activate manual payments, record refunds, grant/revoke entitlements, read audit |
| support | view users/orders, manage support tickets and leads |
| viewer | read-only users, orders, tickets, leads |

Guards: nobody can change their own role or status; the last active owner cannot be removed; disabling an admin or
changing their role ends their sessions immediately.

## 4. Common procedures

- **Manual payment (bank transfer, cash):** reconcile the amount in the bank/merchant records first. Orders →
  select the `بانتظار تأكيد الدفع` order → *تفعيل بعد التحقق من الدفع* → enter the verified payment reference and a
  reason. A payment reference can only be used once. Never activate based on a screenshot alone.
- **Refund:** issue the refund in the Paymob merchant dashboard (this console does **not** move money), then
  Orders → paid order → *تسجيل استرداد* with a reason. The access the order paid for is removed.
- **Goodwill / support extension:** Users → learner → *منح اشتراك يدوي* (plan, days, reason).
- **Abuse or chargeback:** Users → learner → *إيقاف الحساب*. This ends their sessions and blocks sign-in until
  reactivated.

## 5. Audit log

- Audit → *تحقق من السجل* recomputes the whole chain. A failure names the first broken entry.
- Rotating the key: move the old value to `AUDIT_HMAC_PREVIOUS_KEYS` (comma-separated), set a new
  `AUDIT_HMAC_KEY`, restart. History keeps verifying.
- Retention (default taken, owner may change: Q-12 / OD-27): 12 months in `audit_log`, then archive-then-delete.
  `node scripts/audit-retention.mjs` copies rows older than `AUDIT_RETENTION_DAYS` (default 365, minimum 30) to
  `audit_archive`, deletes them from `audit_log` and moves the chain anchor, so verification still passes. Run it
  monthly with the **retention** database role. `AUDIT_MAX_ENTRIES` (optional, default off) also caps the hot store.
  The newest entry is never removed. Archived rows stay in `audit_archive`; export them before dropping that table.
- Insert-only audit (deploy step, not a migration): run `docs/audit-roles.sql` once as a database administrator
  with the real role names, for example `psql "$ADMIN_URL" -v app_role=usam_app -v retention_role=usam_audit_retention -f docs/audit-roles.sql`.
  The app role then can read and add `audit_log` rows and move the chain head (`audit_chain.seq`, `head`), but cannot
  DELETE from `audit_log` or UPDATE it (except the `legacy` column used by account erasure). Leave `AUDIT_MAX_ENTRIES`
  unset for the app (it would need DELETE); the app logs a warning at start-up if both are set.
  The chain head row must stay updatable by the app, so it is protected by the HMAC chain, not by the grant.
  Try this on a copy first. With restricted roles the app does not run migrations (`DB_SKIP_MIGRATIONS=1`): run
  `npm run db:migrate` as the table-owner role before each restart that ships a new migration, then re-run
  `docs/audit-roles.sql` if the migration added tables. `/api/ready` answers 503 (and the app logs an error) while the
  schema and the migration files differ.
  `tests/audit-retention.test.mjs` checks the grants when `DATABASE_URL` is set (skipped on PGlite).

## 5b. Sensitive actions (step-up and second approver)

- Refund, manual entitlement grant or revoke, administrator create, role or status change and MFA reset need the
  password entered again (Admin console asks; valid 5 minutes) and a written reason of at least 5 characters, stored in
  the audit entry. Without it the API answers 403 `{stepUp:true}`.
- Manual payment activation and learner suspend/reactivate also need step-up (and a reason).
- Refunds and administrator role/status changes also need a **different** administrator with the permission to approve
  (console: *طلبات الموافقة*, or `POST /api/admin/approvals/:id/approve`). Requests expire after 24 hours (an expired
  request no longer blocks a new one). The requester cannot approve. Role changes need a second owner: create one
  first (`npm run admin:create`).
- Single-administrator exception: **disabling** an account (not a role change) is applied at once, with step-up and a
  reason, when no other active administrator holds `admins.write`. The audit entry is marked `singleAdmin: true`.
- Restricted database roles: run migrations once as the owner (`DATABASE_URL=<owner url> npm run db:migrate`), then start
  the app and `npm run audit:retention` with `DB_SKIP_MIGRATIONS=1` (PostgreSQL only; the retention script sets it itself).
  Account erasure updates only `audit_log.legacy`, which is granted as a column privilege in `docs/audit-roles.sql`.
- Not built: admin export of a learner's data (no such admin route exists), bulk grants, price changes, API key rotation.
- Entries reference people by opaque ids only, so deleting a learner account does not rewrite the log.

## 6. Sessions

Admin sessions last at most 8 hours (`ADMIN_SESSION_MS`) and expire after 30 minutes idle (`ADMIN_IDLE_MS`).
The admin cookie is HttpOnly, SameSite=Strict and scoped to `/api/admin`.

## 7. Two-factor authentication (TOTP)

- Set `ADMIN_MFA_KEY` (random, 32+ bytes, kept out of the database) and `ADMIN_REQUIRE_MFA=true` in production.
  With `ADMIN_REQUIRE_MFA=true` an admin without MFA can sign in but can do nothing except enroll.
- Enroll: console header → **الأمان** → *ابدأ الإعداد*. Add the setup key to an authenticator app (Google/Microsoft
  Authenticator, 1Password, …), confirm a 6-digit code, then store the 8 recovery codes shown once.
  A QR code is not displayed yet; use the setup key or the direct `otpauth://` link on the phone.
- Sign-in becomes two steps: password, then code (or a one-time recovery code). A challenge allows 5 attempts and
  expires after 5 minutes; codes cannot be replayed.
- Lost phone: the owner opens **المشرفون والأدوار** → *إعادة ضبط التحقق* on that admin (after verifying their
  identity out of band), with a reason. The admin re-enrolls at next sign-in. The reset is audited.
- Losing `ADMIN_MFA_KEY` makes enrolled secrets unreadable: every MFA admin would need a reset by an owner — and if
  all owners are enrolled, use `npm run admin:create` to create a recovery owner. Back the key up separately.
