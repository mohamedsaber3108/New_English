# Backup & Restore Runbook

Primary data is in PostgreSQL. Backups are `pg_dump` custom-format archives with a SHA-256 checksum.
Verified by `tests/backup-restore.test.mjs` (real scripts on Linux, PostgreSQL 16): backup -> restore into a new
database -> the app on the restored database signs in learners and admins, keeps progress and paid access, and the
audit chain verifies. CI runs this drill on every PR in the `postgres-redis` job (PostgreSQL 16 service, `postgresql-client-16`
tools, `PG_TOOLS_LOCAL=1`); row counts of every table are compared, and the log ends with a line starting
`restore drill proof:`. Locally use `PG_TOOLS_LOCAL=1` (tools on PATH) or `PG_TOOLS_CONTAINER=<container>`.
**Not yet repeated on AWS/RDS or on the live database** - do that during staging setup.

## What is backed up, and what is not

| Item | Where | Backed up by |
|---|---|---|
| All accounts, progress, orders, entitlements, tickets, leads, admins, audit log | PostgreSQL | `scripts/backup.sh` (+ RDS automated snapshots if on RDS) |
| `AUDIT_HMAC_KEY` (+ previous keys), `ADMIN_MFA_KEY`, provider secrets | environment / secret manager | **separately** - without them the audit chain cannot be verified and admin MFA cannot be decrypted |
| Static frontend build | rebuilt from Git | release process |

## Daily backups (EC2)

```bash
sudo install -d -o usam-language -g usam-language -m 700 /var/backups/usam-language
sudo apt-get install -y postgresql-client-16      # pg_dump / pg_restore matching the server major version
sudo cp deploy/usam-language-backup.service deploy/usam-language-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now usam-language-backup.timer
sudo systemctl start usam-language-backup.service && journalctl -u usam-language-backup -n 20   # first run
```

Set `BACKUP_S3_URI=s3://<bucket>/usam-language` in `/etc/usam-language.env` for off-site copies (AWS CLI + an
instance role with `s3:PutObject` on that prefix; enable bucket versioning and a lifecycle rule). Local retention:
`BACKUP_RETENTION_DAYS` (default 30). On RDS, also keep automated snapshots / point-in-time recovery enabled.

## Restore

1. Create a **new, empty** database (never restore over production first).
2. `RESTORE_CONFIRM=yes TARGET_DATABASE_URL=postgres://.../usam_restore scripts/restore.sh /var/backups/usam-language/usam-<stamp>.dump`
   - The checksum is verified first; a mismatch stops the restore.
   - Restore runs in one transaction: an error leaves the target unchanged.
3. Point a staging instance at the restored database (same `AUDIT_HMAC_KEY` / `ADMIN_MFA_KEY`), sign in to `#admin`,
   open **سجل التدقيق** and run *تحقق من السجل*. Sign in as a test learner.
4. To promote: stop the app (`systemctl stop usam-language`), switch `DATABASE_URL`, start it, check `/api/ready`.

## Drill

Run a restore drill at least quarterly and after any schema migration. Record date, archive, duration and result.
