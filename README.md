# USAM Language

React (Vite) and Node (Express) application for the USAM Language paid English learning product. Arabic-first acquisition pages, English learner workspace, admin console at `#admin`.

## Develop and verify

```bash
npm ci
npm run check        # dependency declarations + syntax of every server module
npm test             # API, data layer, admin, learning, AI (fake provider), rooms, backup drill
npm run build:app    # production build into dist/
npm run test:e2e     # browser journeys (needs build:app and a local Chrome)
```

`npm run dev` starts a static preview that uses the in-browser preview API. It is never deployed.

Tests run on embedded PGlite by default. Set `DATABASE_URL` (and `REDIS_URL`) to run the same suites against PostgreSQL and Redis.

## Deploy

See `docs/DEPLOYMENT.md`. Configuration is documented in `.env.example`; keep the real file outside the repository (`/etc/usam-language.env`).

## Status

Completion status and evidence: `docs/PROJECT_LEDGER.md`. Route-by-route wiring: `docs/TRACEABILITY_MATRIX.md`. Load-test numbers (laptop only, not production capacity): `docs/LOAD_TEST_RESULTS.md`.

Paymob, Resend and live OpenAI are implemented but untested against the real providers until credentials are supplied. Domain/TLS, production infrastructure, alerting and legal copy review are external.
