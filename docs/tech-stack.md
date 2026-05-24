# Tech Stack Reference

A short description of every tool in the AI Trading Agent stack — what it is,
why it's here, and what we use it for. Grouped by the part of the system it
serves.

## Deep dives

Longer, code-grounded explainers for individual topics live in
[`docs/tech/`](./tech/):

- [Redis Streams vs BullMQ](./tech/redis-streams-vs-bullmq.md) — same Redis,
  opposite-shaped problems; why ticks use Streams and the EOD job will use
  BullMQ.
- [TimescaleDB & Hypertables](./tech/timescaledb-and-hypertables.md) — what a
  hypertable does and why a missing time-range filter destroys performance.
- [No ORM — Raw SQL via the `pg` Pool](./tech/no-orm-raw-sql.md) — what raw SQL
  buys and costs in a precision-sensitive, time-series system.
- [The Tick → Trade Pipeline](./tech/tick-to-trade-pipeline.md) — one market
  tick walked end to end through all four layers, from broker feed to paper
  trade.
- [Pipeline Internals — A Detailed Reference](./tech/pipeline-internals.md) —
  the deep companion to the walkthrough: per-component data structures,
  algorithms, the concurrency/ACK model, and failure handling.
- [Database Schema — Definition & Architecture](./tech/database-schema-architecture.md)
  — the migrations-as-source-of-truth model, the migration runner, table
  taxonomy, type conventions, and the branch-merge drift to watch.
- [Migrations 007 & 008 — Historical Backfill & Regime Tagging](./tech/migrations-007-008-historical-regime.md)
  — resumable/idempotent candle ingestion, the disjoint-keyspace partial index
  trick, and the causal, deterministic regime classifier.
- [The Probability Scorer in Full](./tech/probability-scorer.md) — all 9 macro
  adjustment factors, their caps, the penalty-heavy asymmetry, and how
  confidence tiers are set.
- [The Global Macro Feed](./tech/global-macro-feed.md) — how US VIX / S&P / DAX /
  crude / gold are polled from Yahoo Finance, cached in Redis, and degraded to
  null on failure (TTL-as-staleness).

## Language & Runtime

### TypeScript 5.x (strict mode)
The entire codebase is TypeScript with strict type-checking enabled. Trading
logic, database rows, and broker payloads are all statically typed so bugs
surface at compile time rather than mid-trade. No `default` exports — named
exports throughout.

### Bun (latest)
The JavaScript/TypeScript runtime **and** package manager. Runs everything
(`bun run dev`, migrations, scripts) and executes TypeScript natively with no
separate `tsc` build step (`tsc --noEmit` is used only for type-checking).
Replaces Node.js + npm/yarn. There is a single lockfile (`bun.lock`) — running
`npm install` or `yarn install` would create a conflicting second lockfile.

## Web / API Layer

### Fastify 4.x
The REST API framework (port 3000). Serves signal management, personality CRUD,
paper-trade queries, retrospection triggers, and live dashboard data. Chosen
for schema-validated routes and very low latency (~2ms p99 target). Also hosts
the `/ws/ticks` WebSocket endpoint that streams live ticks to the React
frontend.

## Data Storage

### PostgreSQL 16
The primary database. Stores paper trades, personality configs, retrospection
results, and credit transactions.

### TimescaleDB 2.x (PostgreSQL extension)
Required, not optional. Turns time-series tables (`market_ticks`,
`straddle_snapshots`, `option_ticks`) into hypertables that auto-partition by
time, plus continuous aggregates like `straddle_1min`. Used because the system
ingests high-frequency tick data that vanilla Postgres handles poorly. The
standard `postgres:16-alpine` image does **not** include it — Docker Compose
uses `timescale/timescaledb:latest-pg16`. Queries against hypertables must
always include a time-range filter to avoid full-table scans.

### `pg` (raw SQL pool)
The database access library. Deliberately **no ORM** — all queries are
hand-written SQL, with results typed against the interfaces in
`src/db/schema.ts`. Keeps query behaviour explicit and predictable for
time-series work. Migrations are applied by a custom runner in
`src/db/migrate.ts`.

## Messaging & Background Work

### Redis 7
Serves two roles:
- **Streams** as the event bus — topics `market.ticks`, `straddle.values`, and
  `signals.generated` fan out tick data to the straddle calculator, VIX feed,
  and signal engine.
- **Cache** — sub-millisecond reads for the price cache and per-personality
  state.

Must be Redis 7+; BullMQ relies on Streams features not present in Redis 6.

### BullMQ (Redis-backed)
Background job queue. Runs the **EOD retrospection batch** — the nightly job
that computes per-personality daily metrics, Beat-Clockwork deltas, signal
calibration scores, management effectiveness, and queues rule-based parameter
suggestions (all regime-tagged).

## Frontend (Dashboard)

### React 18
The dashboard UI framework.

### Vite
Dev server and build tool that serves the React app.

### Zustand
Lightweight client-side state management.

### Tailwind CSS 3.x
Utility-first styling.

### Lightweight Charts
Renders the real-time straddle value, momentum indicators, active signals, and
EOD retrospection charts.

## External Market Data & Trading

### Fyers WebSocket (`fyers-api-v3` SDK)
Live Indian market tick data — **read-only**, market data only, never order
placement. The SDK is untyped, so there is a TypeScript declaration shim at
`src/types/fyers-api-v3.d.ts` covering the surface we use. The access token
expires daily and must be regenerated every morning before market open.

### Quantiply API
Paper-trade execution tracking. Records simulated straddle entries and exits —
no real money is ever traded.

### NSE public API
Polling fallback for the India VIX feed when it is not arriving via a Fyers
tick (`NSE:INDIAVIX-INDEX`).

## Payments / Billing

### Razorpay
Payment processor for the SaaS subscription (India-only: UPI + Indian
debit/credit cards). Uses the one-time Orders API — no recurring mandate or
autopay. Powers the **Monthly Access Pass** (30-day access) and the
**Feature-Token Credits** packs. The app stores only `razorpay_order_id`,
`razorpay_payment_id`, `grant_type`, and credit-transaction records — never raw
card/UPI data (Razorpay holds PCI scope). The whole payment subsystem is
disabled when `RAZORPAY_KEY_ID` is absent (free / self-hosted dev mode).

## Testing

### Vitest
Unit tests (peak detection, decision-engine filter stages, P&L math, parameter
clamping, ATM strike rounding, symbol builder) and integration tests (full
signal → personality → paper-trade flow, Redis Streams messaging, TimescaleDB
continuous-aggregate correctness). Integration tests require the Docker
services to be running.

### Playwright
End-to-end browser tests: dashboard renders live data, the trade log updates in
real time, and retrospection results display correctly.

## Infrastructure / Deployment

### Docker Compose
Spins up dev infrastructure locally — TimescaleDB (`timescale/timescaledb:latest-pg16`)
and Redis 7.

### Railway / Fly.io
Planned production hosting targets.

---

## Deep dive: BullMQ & the EOD retrospection job

> **Current state (Sprint 1):** `bullmq` is declared in `package.json`
> (`^5.13.0`) but is **not yet imported anywhere in `src/`**. The EOD
> retrospection engine is still a planned skeleton — the personality,
> paper-trade, and regime-tagging building blocks it will consume already
> exist under `src/trading/`, but no queue, worker, or scheduler is wired up
> yet. The design below is the intended shape, not shipped code.

### Why a queue at all
End-of-day retrospection is heavy, batch work: for each of the 10
personalities it computes daily metrics, Beat-Clockwork deltas, signal
calibration (Brier) scores, management effectiveness, and then queues
rule-based parameter-evolution suggestions. This should not run inside a
request/response cycle or block the live ingestion pipeline — it runs once,
after market close, and can take time. A Redis-backed job queue gives us
durability (a crash mid-run doesn't lose the job), retries with backoff, and a
clean separation between "trigger the job" and "do the work".

### How it will be wired
BullMQ reuses the same Redis 7 instance already used for Streams and caching:

- **Queue** — a producer (e.g. a `POST /api/retrospection/run` route or a
  cron/scheduled trigger after market close) calls `queue.add(...)` with the
  trading day and underlying as job data.
- **Worker** — a separate process consumes jobs, pulls that day's paper trades
  and straddle snapshots from PostgreSQL/TimescaleDB, computes the metrics, and
  writes regime-tagged rows into `retrospection_results`.
- **Connection** — both point at `REDIS_URL`. BullMQ requires Redis 7+ (it uses
  Streams features absent in Redis 6) — the same constraint the event bus
  already imposes.

### Guardrails it must respect
Two project invariants apply to whatever code lands here:
- **Clockwork immutability** — any parameter-evolution suggestion the job
  queues must honour `personality_configs.is_frozen`; the evolution engine
  throws `FROZEN_VIOLATION` rather than silently skipping a frozen row.
- **Approval gate** — suggestions are proposals only. With
  `EVOLUTION_REQUIRE_APPROVAL=true`, nothing the job produces is applied to
  personality parameters without human review.

### Where to look when it's built
The natural home is a `src/trading/` (or a new `src/jobs/`) module exporting
the queue definition and the worker. The metric inputs already live in
`src/trading/` (`paper-trade.ts`, `regime-tagging.ts`, the `management/`
styles) and `src/db/schema.ts` defines the `retrospection_results` shape the
worker writes to.
