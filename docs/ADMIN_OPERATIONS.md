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
- Retention: the newest `AUDIT_MAX_ENTRIES` (default 5000) entries stay in the primary store; older ones are
  trimmed with a verification anchor. Exporting trimmed entries to cold storage is not yet implemented.
- Entries reference people by opaque ids only, so deleting a learner account does not rewrite the log.

## 6. Sessions

Admin sessions last at most 8 hours (`ADMIN_SESSION_MS`) and expire after 30 minutes idle (`ADMIN_IDLE_MS`).
The admin cookie is HttpOnly, SameSite=Strict and scoped to `/api/admin`. Multi-factor authentication is not yet
implemented.
