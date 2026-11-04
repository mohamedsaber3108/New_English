# Data Layer Migration Plan (single document -> relational tables)

Status: IN PROGRESS. Driver: `docs/LOAD_TEST_RESULTS.md` Baseline 1 (document model fails before 50k learners).

## Decision

| Option | Implementations | Dev/test infra | Fidelity |
|---|---|---|---|
| Keep JSON + add SQL | 2 (drift risk) | none | JSON never runs SQL |
| SQL + Docker Postgres everywhere | 1 | Docker for every test run | high |
| **SQL; `pg` in production, embedded PGlite (Postgres-in-WASM) for dev/tests** | **1** | **none** | **real Postgres engine** |

Chosen: the third. PGlite 0.5.15 (Apache-2.0, no runtime deps) probed OK: transactions/rollback, `FOR UPDATE`,
`ON CONFLICT`, JSONB, partial unique indexes, SQLSTATE 23505. Production target is PostgreSQL 16: no 17+ features.

## Layout

```
server/db/
  migrations/001_init.sql   schema (versioned; applied in order, recorded in schema_migrations)
  index.js                  createDb(): {query, tx, close, backend, health}; pg Pool or PGlite; runs migrations
                            (pg_advisory_lock so concurrent instances don't race); PGlite data-dir lock file
  repo.js                   row <-> object mapping + domain queries (users, sessions, entitlements, orders,
                            tickets, tokens, leads, admins, adminSessions, audit, analytics, meta)
  legacy-import.js          one-time import of the old document (JSON file or app_state row), idempotent
```

## Configuration

- `DATABASE_URL` set -> PostgreSQL (`pg`, pool `PG_POOL_MAX`).
- otherwise PGlite at `PGLITE_DATA_DIR`, default derived from `CUSTOMER_DB_FILE` (`<file without .json>-pglite`)
  or `data/pglite`. `memory://` allowed for tests.
- Legacy auto-import on first start: if tables are empty and the old JSON file / `app_state` row exists, import it
  (meta key `legacy_imported`). Existing deployments migrate without manual steps.

## Object shapes

Repo returns the same camelCase objects routes already use (user with `entitlements: {English: {...}}`, ms epoch
numbers for session/entitlement times) so route logic changes are mechanical.

## Audit

Pure chain functions in `audit.js` (`makeEntry`, `verifyEntries`); SQL append locks `audit_chain` row `FOR UPDATE`
inside the caller's transaction. Retention default: keep all (table); `AUDIT_MAX_ENTRIES` > 0 trims with anchor.

## Steps

1. [x] schema + db/index.js + migrations + tests (migration idempotency, concurrency, constraints)
2. [ ] repo.js + unit tests on PGlite
3. [ ] customer.js on repo (auth, sessions, profile, orders, webhook, account deletion)
4. [ ] operations.js on repo (tokens, preferences, sessions, support, receipts, analytics)
5. [ ] admin.js on repo (SQL search/filter/pagination/aggregates)
6. [ ] index.js (leads, WS session lookup, health/ready), scripts
7. [ ] legacy import + test (JSON doc and app_state)
8. [ ] port tests that touched the document directly (tamper test, MFA sealed-secret check, storage tests)
9. [ ] full regression default (PGlite) + PG16 + Redis, E2E, builds
10. [ ] load test Baseline 2, docs, ledger
