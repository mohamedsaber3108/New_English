# Deployment guide

This guide takes a fresh Linux server (Ubuntu 22.04/24.04 on EC2 or any VM) to a running USAM Language instance. It supersedes `docs/EC2.md`, which described the old single-JSON-file edition.

Everything in the repository has been built and tested locally (see `docs/PROJECT_LEDGER.md`). Nothing has been deployed to a real server yet. The steps below have not been executed end to end on a production host. Treat the first deployment as a staging rehearsal.

## 1. Architecture

```
Internet ── Nginx (TLS, :443) ── Node app (127.0.0.1:4100, systemd) ── PostgreSQL 16 (RDS or local)
                                        └──────────────────────────── Redis (optional for 1 instance, required for 2+)
```

- One Node process serves the built React app (`dist/`) and the `/api` routes, including the `/api/rooms` WebSocket.
- Schema migrations run automatically at startup under a PostgreSQL advisory lock, so several instances can start at once.
- Without `DATABASE_URL` the app uses embedded PGlite. That mode is for a single process and staging only.

## 2. What you must supply (cannot be done from the repository)

| Item | Needed for | Notes |
|---|---|---|
| Domain name and DNS access | HTTPS, email links, Paymob callbacks | A record → server public IP |
| Server (e.g. EC2 t3.small or larger) with SSH | Running the app | Ports 80/443 open, 22 restricted to your IP |
| PostgreSQL 16 (RDS recommended) | All data | Automated snapshots on; private subnet |
| Redis 7 (ElastiCache or local) | Only with 2+ app instances | |
| Paymob account: secret key, public key, integration IDs, HMAC secret | Online checkout | Without them, checkout is disabled and manual activation (`npm run admin:activate`) is the only path |
| Resend API key and a verified sending domain | Email verification, password recovery | Required when `REQUIRE_VERIFIED_EMAIL=true` |
| OpenAI API key (optional) | Live AI coach / simulation | Without it the app uses its built-in rule-based feedback |
| Legal copy review (terms, privacy, refunds) | Launch | Content is in the client; review is a business task |

## 3. Server preparation (one time)

```bash
sudo apt-get update && sudo apt-get install -y git nginx curl postgresql-client
# Node.js 20 LTS (or 22)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs
node -v   # must be >= 20

# Service user and directories
sudo useradd --system --create-home --home-dir /opt/usam-language --shell /bin/bash usam-language
sudo install -d -o usam-language -g usam-language /opt/usam-language/releases /var/lib/usam-language /var/backups/usam-language
sudo -u usam-language git clone <YOUR_REPO_URL> /opt/usam-language/repo
```

For a private repository, add a read-only deploy key for `usam-language` (`ssh-keygen -t ed25519`, then add the public key in GitHub → Settings → Deploy keys).

Let the service user restart only this service (needed by `scripts/deploy.sh`):

```bash
echo 'usam-language ALL=(root) NOPASSWD: /usr/bin/systemctl restart usam-language' | sudo tee /etc/sudoers.d/usam-language
sudo chmod 440 /etc/sudoers.d/usam-language && sudo visudo -c
```

## 4. Database

RDS: create a PostgreSQL 16 instance in the same VPC, security group allowing 5432 only from the app server. Then:

```bash
psql "postgres://master:...@<rds-host>:5432/postgres" -c "CREATE USER usam WITH PASSWORD '<strong password>';" -c "CREATE DATABASE usam OWNER usam;"
```

Use `DATABASE_URL=postgres://usam:<password>@<rds-host>:5432/usam` and `PGSSL=require`. The app creates its tables on first start.

Sizing rule: (app instances × `PG_POOL_MAX`) must stay below the database's `max_connections`.

## 5. Environment file

```bash
sudo cp /opt/usam-language/repo/.env.example /etc/usam-language.env
sudo chown root:usam-language /etc/usam-language.env && sudo chmod 640 /etc/usam-language.env
sudo nano /etc/usam-language.env
```

Required for a public deployment:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `SITE_ORIGIN` | `https://your-domain` (must be https for Paymob) |
| `DATABASE_URL`, `PGSSL` | from step 4 |
| `ACCESS_ENFORCEMENT` | `enforced` |
| `AUDIT_HMAC_KEY` | 64 hex chars: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `ADMIN_MFA_KEY` | another value generated the same way (different from the audit key) |
| `ADMIN_REQUIRE_MFA` | `true` |
| `METRICS_TOKEN` | 48 hex chars (`randomBytes(24)`), or leave empty to disable `/api/metrics` |
| `RESEND_API_KEY`, `EMAIL_FROM` | from Resend |
| `PAYMOB_*` (all four) | from Paymob; checkout stays off until all four are set |

Optional: `REDIS_URL` (required for 2+ instances), `OPENAI_API_KEY` and `AI_*` limits, `LOG_LEVEL`, rate limits, `BACKUP_*`. Every variable is documented inline in `.env.example`.

Store `AUDIT_HMAC_KEY` and `ADMIN_MFA_KEY` in a password manager as well. Losing `ADMIN_MFA_KEY` forces every admin to re-enroll MFA. Losing `AUDIT_HMAC_KEY` means past audit entries can no longer be verified.

At startup the app prints a configuration report. Errors stop the process; warnings are logged. Check it with `journalctl -u usam-language | grep -i config`.

## 6. Install the services and deploy the first release

```bash
cd /opt/usam-language/repo
sudo cp deploy/usam-language.service deploy/usam-language-backup.service deploy/usam-language-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable usam-language

# First release: builds into releases/<timestamp>-<sha>, links `current`, restarts, waits for /api/ready
sudo -u usam-language DEPLOY_REF=master /opt/usam-language/repo/scripts/deploy.sh
curl -s http://127.0.0.1:4100/api/ready
```

`DEPLOY_REF` accepts a branch, tag or commit. Tagging releases (`git tag v1.0.0`) is recommended so you can deploy and roll back by name.

## 7. Create the first administrator

```bash
cd /opt/usam-language/current
sudo -u usam-language bash -c 'set -a; . /etc/usam-language.env; set +a; read -rsp "Password: " ADMIN_PASSWORD; export ADMIN_PASSWORD; echo; npm run admin:create -- --email you@your-domain --name "Your Name" --role owner'
```

Sign in at `https://your-domain/#admin`. With `ADMIN_REQUIRE_MFA=true` you are asked to enroll an authenticator app first. Roles and day-to-day procedures are in `docs/ADMIN_OPERATIONS.md`.

## 8. Nginx and TLS

```bash
sudo cp /opt/usam-language/repo/deploy/nginx.conf /etc/nginx/sites-available/usam-language
sudo sed -i 's/language.example.com/your-domain/g' /etc/nginx/sites-available/usam-language
sudo ln -s /etc/nginx/sites-available/usam-language /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
```

The config references the Let's Encrypt certificate, so obtain it first. Comment out the `listen 443` server block, then:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --nginx -d your-domain
# restore the 443 block
sudo nginx -t && sudo systemctl reload nginx
curl -sI https://your-domain/api/health
```

Certbot installs a renewal timer. Check it with `systemctl list-timers | grep certbot`.

DNS: create an A record `your-domain → <server public IP>` (Elastic IP on EC2) before running certbot.

## 9. Payments (Paymob)

In the Paymob dashboard set:

- Transaction processed callback: `https://your-domain/api/paymob/webhook`
- Transaction response callback: `https://your-domain/#payment-result`

The app sends both URLs with every payment intention as well. Webhooks are verified with `PAYMOB_HMAC_SECRET`; unsigned or mismatched callbacks are rejected. Run one real low-value payment and one refund in Paymob test mode before going live. This flow has only been tested against simulated signed webhooks, never against Paymob itself.

## 10. Backups

```bash
sudo systemctl enable --now usam-language-backup.timer
sudo systemctl start usam-language-backup.service && ls -l /var/backups/usam-language
```

Off-site copies: set `BACKUP_S3_URI` and give the instance role `s3:PutObject` on that prefix. RDS automated snapshots should also be enabled. Restore procedure and the drill are in `docs/BACKUP_RESTORE.md`. Perform one restore drill on the real database before launch.

## 11. Monitoring

- Logs: `journalctl -u usam-language -f` (JSON lines; each carries a request id). Ship them with the CloudWatch agent if you use AWS.
- Health: `/api/health` (process up) and `/api/ready` (database reachable). Point an uptime monitor at `https://your-domain/api/ready`.
- Metrics: `GET /api/metrics` with `Authorization: Bearer $METRICS_TOKEN` (Prometheus format). Nginx exposes it publicly, so the token is the only protection. Use a long token or block the path in Nginx and scrape it from inside the VPC.
- No alerting is configured. Set alerts at least for: `/api/ready` failing, 5xx rate, disk space, RDS CPU/storage.

## 12. Routine deploys and rollback

```bash
sudo -u usam-language DEPLOY_REF=v1.0.1 /opt/usam-language/repo/scripts/deploy.sh   # deploy
sudo -u usam-language /opt/usam-language/repo/scripts/deploy.sh rollback             # previous release
```

If the new release fails `/api/ready`, the script switches back to the previous release automatically. The last 5 releases are kept.

Migrations only move forward. Rolling back the code does not undo a schema change. The migrations shipped so far only add tables and columns, so older code keeps working on a newer schema. Take a backup before deploying a release that contains a new migration (`server/db/migrations/`).

If the app runs under a restricted database role (`DB_SKIP_MIGRATIONS=1`, see `docs/ADMIN_OPERATIONS.md` section 5), it does not apply migrations itself. Before restarting onto a release with a new migration, run `DATABASE_URL=<owner role url> npm run db:migrate` (from the new release directory), re-run `docs/audit-roles.sql` if tables were added, then restart. Until then `/api/ready` returns 503 and `scripts/deploy.sh` rolls back.

## 13. Scaling beyond one server

1. Set `REDIS_URL` on every instance. Rate limits and group rooms are then shared.
2. Put the instances behind an AWS ALB with WebSocket support (idle timeout ≥ 75 s). Terminate TLS at the ALB or keep Nginx per instance.
3. Keep instances × `PG_POOL_MAX` below `max_connections`.
4. Run the load test against staging before claiming capacity: `docs/LOAD_TEST_RESULTS.md` holds laptop numbers only. Production capacity has not been measured.

## 14. Pre-launch checklist

- [ ] `journalctl` shows the configuration report with no errors and no warnings you have not accepted
- [ ] `https://your-domain/api/ready` returns `"ready":true`
- [ ] Owner admin created, MFA enrolled, legacy token off
- [ ] A learner can sign up, verify email (real inbox), sign in, and reset a password
- [ ] One Paymob test payment activates a subscription; one failed payment does not
- [ ] Backup timer ran; one restore drill completed on the real database
- [ ] Uptime monitor and alerts in place
- [ ] Legal pages reviewed
- [ ] Load test against staging if you expect high traffic at launch
