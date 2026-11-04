# Load Test Results

Harness: `tests/load/run.mjs` (dependency-free generator `tests/load/loadgen.mjs`). Reproduce:

```bash
DATABASE_URL=postgres://... REDIS_URL=redis://... node tests/load/run.mjs --sizes 1000,10000,50000 --backends json,pg --duration 5000 --connections 30
```

Each run seeds storage directly with realistic learners (~1.5 KB profile/progress each + one session), starts the
real server (rate limits raised), and measures closed-loop traffic. A row counts only if every request returned 2xx.

**Environment (all measurements so far):** Intel i9-12900H, 20 logical cores, 15.7 GB RAM, Windows 11, Node 26.7.
Load generator, app server, PostgreSQL 16 and Redis 7 (Docker) all on one laptop - absolute numbers are a lower bound
for a dedicated deployment. This is **not** a measurement of production capacity; no AWS environment exists yet.

## Baseline 1 — single-document storage (commit after single-flight fix), 2026-11-04

5 s per scenario after 1 s warm-up; 30 connections (20 for write). Scenarios: `health` (no storage), `read`
(`GET /api/customer/me`, every learner page load), `write` (`PUT /api/customer/profile`, progress autosave),
`mixed` (90% read / 10% write).

| Backend | Learners | Document | Scenario | req/s | p50 ms | p99 ms |
|---|---:|---:|---|---:|---:|---:|
| JSON file | 1,000 | 4.2 MB | read | 4,522 | 5.3 | 17.3 |
| JSON file | 1,000 | | write | 67 | 275 | 718 |
| JSON file | 1,000 | | mixed | 494 | 7.7 | 924 |
| JSON file | 10,000 | 42.2 MB | read | 2,076 | 13 | 30 |
| JSON file | 10,000 | | write | 3 | 6,260 | 8,717 |
| JSON file | 10,000 | | mixed | 25 | 3.4 | 10,722 |
| JSON file | 50,000 | 211.4 MB | read | 313 | 89 | 1,315 |
| JSON file | 50,000 | | write | 1 | 21,651 | 35,495 |
| JSON file | 50,000 | | mixed | 2 | 487 | 34,781 |
| PostgreSQL | 1,000 | 4.2 MB | read | 2,486 | 11.7 | 19.7 |
| PostgreSQL | 1,000 | | write | 3 | 6,039 | 6,508 |
| PostgreSQL | 1,000 | | mixed | 16 | 4.2 | 8,465 |
| PostgreSQL | 10,000 | 42.2 MB | read | 995 | 27.8 | 53 |
| PostgreSQL | 10,000 | | write | 0 | 33,637 | 60,254 |
| PostgreSQL | 10,000 | | mixed | 0 | 34,011 | 119,661 |
| PostgreSQL | 50,000 | 211 MB | — | **seed rejected**: `total size of jsonb array elements exceeds the maximum of 268435455 bytes` | | |

`health` stayed at 4,300–6,400 req/s in every run, so the server itself is not the limit; storage is.
Raw data: `tests/load/results/2026-11-04T10-37-06-162Z.json`.

### Findings

1. **Write cost grows with the whole data set, not the record.** Every write re-serializes and rewrites the entire
   application document (JSON: the file; PostgreSQL: one JSONB row). Throughput falls from 67 to 1 write/s between 1k
   and 50k learners on JSON, and to 0 on PostgreSQL at 10k.
2. **Writes block reads.** Serializing a 42–211 MB document blocks the Node event loop, so reads queue behind writes
   (mixed p99 of 10-35 s).
3. **PostgreSQL is a hard stop.** One JSONB value is capped at 256 MB; ~50k learners exceed it. The 100,000-user
   target is impossible on this design regardless of hardware.
4. **Fixed during this test:** a cold-start stampede (concurrent first reads each parsed the whole document; reads at
   10k went 8 → 2,076–3,404 req/s after single-flight loading) - `tests/storage.singleflight.test.mjs`.

### Decision

The single-document model is retired as the production data architecture (see `docs/DATA_LAYER_PLAN.md`):
per-entity relational tables with indexes and row-level transactional writes, PostgreSQL in production and
embedded PGlite for development/tests.

## Baseline 2 — relational storage (commit 7319c90), 2026-11-04

Same harness, machine, scenarios and settings as Baseline 1 (5 s, 30 connections, 20 for write). Every row below:
0 errors, 0 non-2xx.

| Backend | Learners | Data | Scenario | req/s | p50 ms | p99 ms |
|---|---:|---:|---|---:|---:|---:|
| PostgreSQL 16 | 1,000 | 4.2 MB | read | 2,272 | 12.8 | 20.7 |
| | | | write | 1,529 | 12.7 | 19.6 |
| | | | mixed | 2,274 | 12.3 | 23.7 |
| PostgreSQL 16 | 10,000 | 42.2 MB | read | 2,274 | 12.5 | 24.1 |
| | | | write | 1,204 | 14.3 | 71.1 |
| | | | mixed | 2,300 | 11.9 | 26.6 |
| PostgreSQL 16 | 50,000 | 211 MB | read | 2,196 | 13.1 | 24.8 |
| | | | write | 1,371 | 14.1 | 21.4 |
| | | | mixed | 2,046 | 12.2 | 44.6 |
| **PostgreSQL 16** | **100,000** | **423 MB** | read | 2,179 | 12.8 | 28.6 |
| | | | write | 1,451 | 13.4 | 20.9 |
| | | | mixed | 1,888 | 13.1 | 53.1 |
| PGlite (dev engine) | 1,000 | 4.2 MB | read / write / mixed | 652 / 698 / 990 | 45 / 26 / 29 | 78 / 59 / 59 |
| PGlite (dev engine) | 10,000 | 42.2 MB | read / write / mixed | 833 / 607 / 895 | 35 / 30 / 30 | 64 / 74 / 77 |
| PGlite (dev engine) | 50,000 | 211 MB | read / write / mixed | 343 / 646 / 783 | 56 / 30 / 36 | 1,243 / 56 / 70 |

Raw data: `tests/load/results/2026-11-04T13-38-18-719Z.json` (1k–50k) and `...13-39-19-205Z.json` (100k).

### Before / after (PostgreSQL)

| Learners | Writes/s before → after | Write p50 before → after | Reads/s before → after |
|---:|---|---|---|
| 1,000 | 3 → **1,529** | 6.0 s → **12.7 ms** | 2,486 → 2,272 |
| 10,000 | 0 → **1,204** | 33.6 s → **14.3 ms** | 995 → **2,274** |
| 50,000 | data set rejected → **1,371** | — → **14.1 ms** | — → **2,196** |
| 100,000 | not attempted (impossible) → **1,451** | — → **13.4 ms** | — → **2,179** |

### What this proves — and what it does not

- **Proven (on this laptop):** throughput and latency no longer depend on how many learners are stored. A database
  holding 100,000 learners serves ~2,200 authenticated reads/s and ~1,450 progress writes/s at p99 ≈ 21–53 ms from
  **one** Node process, with zero failed requests. The structural blocker to the 100,000-registered-user target is
  removed.
- **Not proven:** production capacity. This was one app process, one laptop, the load generator competing for the
  same CPU, and PostgreSQL in Docker on the same machine. It does not measure concurrent users (requests/s is not
  users), AI/voice workloads, multiple app instances behind a load balancer, network latency, or managed-database
  limits (RDS connections, IOPS). Those require the AWS environment (BLOCKED: infrastructure not provisioned).
- **PGlite** is the development/test engine (single process, WASM). Its numbers are shown for completeness; it is not
  a production option (the server refuses a second process on the same data directory).
- **Rough sizing, not a measurement:** if an active learner averages one request every 10 s while practising, 2,000
  req/s from a single instance corresponds to ~20,000 learners active at the same moment. Verify on staging before
  relying on this.
