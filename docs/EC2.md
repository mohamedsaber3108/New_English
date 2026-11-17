> **Superseded.** This page describes the old single-JSON-file edition. Use [DEPLOYMENT.md](DEPLOYMENT.md).

# EC2 deployment guide

## Architecture

One EC2 instance can run this React build and the Node API behind Nginx. Nginx terminates HTTPS and forwards HTTP and WebSocket traffic to `127.0.0.1:4100`. Accounts and progress are stored in a private JSON file on the server; the contact API writes leads to a separate private JSONL file. The React app also keeps a local progress copy. Rooms are held in server memory. Run a single Node process for this file-based edition, or migrate accounts and orders to a transactional database before scaling.

## Server preparation

Use a current Ubuntu LTS image, Node.js 20+ from a supported source, Nginx, and a DNS A/AAAA record for your chosen subdomain. Keep ports 4100 and 4173 private. Allow only 80/443 publicly. Put the project at `/opt/usam-language`, owned by a dedicated `usam-language` service user.

```bash
cd /opt/usam-language
npm ci
npm run check
npm run build
sudo cp deploy/usam-language.service /etc/systemd/system/usam-language.service
sudo systemctl daemon-reload
sudo systemctl enable --now usam-language
curl -fsS http://127.0.0.1:4100/api/health
```

Copy `.env.example` to `/etc/usam-language.env`, set `PORT=4100` and optionally the AI and Paymob credentials, then make it readable only to the service account (`chmod 600`). The example systemd unit reads that path. Keep API keys off Git, the browser bundle and Nginx configuration.

Replace `language.example.com` in `deploy/nginx.conf` with the actual DNS name, install it in Nginx, verify with `nginx -t`, enable it, and issue a TLS certificate through your normal certificate workflow. The site's microphone and browser speech features need HTTPS in production. Once TLS is active, use HTTPS-only redirects and appropriate security headers.

## Update

```bash
cd /opt/usam-language
# deliver or pull the reviewed source release
npm ci
npm run check
npm run build
sudo systemctl restart usam-language
curl -fsS http://127.0.0.1:4100/api/health
```

Keep the previous release for rollback. Browser-local profiles are not migrated by an EC2 restart; clearing browser data removes them. Rooms are ephemeral and disconnect during a restart. For a multi-instance setup, move room state to a shared service and add sticky routing or a realtime provider.

## Accounts, payment, and backups

Set `CUSTOMER_DB_FILE=/var/lib/usam-language/customers.json` and `LEADS_FILE=/var/lib/usam-language/leads.jsonl`. Create the directory owned by the service user with mode 700, keep files at mode 600, and arrange encrypted off-instance backups with restore drills. The app creates the customer file at first use. Do not run multiple Node instances against the same JSON file.

Accounts use password scrypt hashing and HTTP-only, SameSite cookies. Learners can view orders, sync progress, export local progress, and delete account data from the app. Set `RESEND_API_KEY`, `EMAIL_FROM`, and `SITE_ORIGIN` to enable verification and one-use password reset. Verify the sending domain and test delivery, expiry, reuse rejection, and session invalidation. Never collect passwords in contact forms.

To enable hosted payment, set all `PAYMOB_*` values and `SITE_ORIGIN=https://your-language-domain`, configure the Paymob integration and callback endpoint `/api/paymob/webhook`, then run a merchant sandbox payment, failure, refund, duplicate callback, and live low-value reconciliation before accepting real payments. The server computes price and grants access only after an HMAC-verified successful transaction. The browser redirect alone does not activate access. This is a one-time paid period, without automatic renewal. Without keys, order creation records a contact request status and never charges a card. For manual payments, staff must independently reconcile the bank or merchant payment and its amount before running `npm run admin:activate -- USL-XXXXXXXXXXXX VERIFIED_PAYMENT_REFERENCE` on the single stopped Node service instance; restart the service afterward because account state is cached in memory. The command activates only a `pending_contact` order, rejects reused payment references, and records the payment reference. Back up the database file first. Never activate based only on a customer's screenshot or message.

Set up process logging, error alerts, domain/TLS renewals, and a staffed lead/receipt queue before public acquisition. Configure AI credentials before advertising Plus's live tutor; otherwise guided practice remains available but the live coach is unavailable.

## Operational gates

- Migrate the single-instance JSON store to a transactional database for scaling, stronger disaster recovery, and a full audit trail. Exercise email verification and self-service password recovery on staging before broad public acquisition.
- Add per-user quotas and abuse monitoring before enabling a paid AI provider for public traffic. Current API has a basic per-IP rate limit only.
- Perform privacy, consent, and content-rights review for speech, minors, external model providers and licensed media.
- Replace the simple text-room WebSocket transport with authenticated, moderated realtime voice infrastructure before offering AI group coaching.

## Contact requests

Set `LEADS_FILE=/var/lib/usam-language/leads.jsonl` in the service environment, create the directory owned by the service user, and restrict it to mode 700. Back it up securely and assign staff to check requests. Each line is one JSON lead with a reference, plan, language, preferred Cairo meeting date/time, and status `new`. Sending a request does not reserve a calendar slot; staff must confirm it manually. Add CRM notifications, privacy retention and access controls before a public launch. Do not put this file inside the static `dist/` directory or a public web root.
