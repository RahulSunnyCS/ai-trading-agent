# Technical Context

## Tech Stack

| Area | Choice |
|---|---|
| Language | TypeScript 5.x — strict mode enabled |
| Runtime | Bun (>= 1.0) — native TS execution, no build step needed |
| Web Framework | Fastify 4.x + `@fastify/websocket` for tick streaming |
| Primary DB | PostgreSQL 16 + TimescaleDB 2.x extension |
| Cache / Queue Broker | Redis 7 |
| Message Streaming | Redis Streams (topics: `market.ticks`, `straddle.values`, `signals.generated`) |
| Job Queue | BullMQ 5.x (EOD retrospection jobs) |
| Broker SDK | `fyers-api-v3` (market data WebSocket; NOT order execution) |
| Data Validation | Zod 3.x |
| Frontend | React + Vite + Zustand + Tailwind + Lightweight Charts — **planned, not yet in src/** |

## Package Manager & Runtime

- **Package manager:** Bun — lockfile is `bun.lock` (not `package-lock.json`)
- **Install:** `bun install`
- **No Node.js required** — Bun executes TypeScript directly
- **TypeScript config:** `moduleResolution: "bundler"`, `strict: true`, path alias `@/*` → `src/*`
- **No build step for development** — `bun run` compiles on the fly; `dist/` is for production

## Essential Commands

```bash
# Install dependencies
bun install

# Start infrastructure (PostgreSQL + Redis via Docker Compose)
docker compose up -d

# Run database migrations
bun run migrate

# Development (watch mode — auto-restarts on file change)
bun run dev

# Run in simulation mode (no Fyers credentials needed)
bun run sim

# Run in live mode (requires FYERS_APP_ID + FYERS_ACCESS_TOKEN)
bun start

# Run all tests
bun test

# Unit tests only (excludes integration tests)
bun run test:unit

# Integration tests only (requires running Docker services)
bun run test:integration

# TypeScript type-check (no emit)
bun run --bun tsc --noEmit

# Reset database (destructive — wipes all data)
docker compose down -v && docker compose up -d && bun run migrate
```

There is **no lint script** in `package.json`. TypeScript strict mode is the primary code quality gate.

## Repository Structure

```
src/
├── db/
│   ├── client.ts           # pg Pool singleton
│   ├── migrate.ts          # migration runner
│   ├── schema.ts           # TypeScript types matching DB schema
│   └── migrations/
│       ├── 001_initial_schema.sql   # all hypertables + standard tables
│       └── 002_seed_personalities.sql  # seeds 10 personality rows
├── redis/
│   └── client.ts           # ioredis singleton + stream helpers
├── ingestion/
│   ├── brokers/
│   │   ├── fyers.ts                # Fyers WebSocket adapter → BrokerTick events
│   │   ├── instrument-registry.ts  # symbol construction, expiry calc
│   │   └── types.ts                # BrokerTick interface
│   ├── straddle-calc.ts    # price cache, ATM lookup, snapshot persistence
│   ├── vix-feed.ts         # VIX cache (set from Fyers NSE:INDIAVIX-INDEX tick)
│   └── market-data-sim.ts  # simulation mode tick generator
├── trading/
│   ├── trading-loop.ts     # top-level loop: reads snapshots, fires signal-detector
│   ├── signal-detector.ts  # momentum exhaustion algorithm
│   ├── personality-engine.ts  # 5-stage filter per personality
│   ├── personality-cache.ts   # in-memory personality config cache
│   ├── trade-executor.ts   # paper trade creation + persistence
│   ├── trade-manager.ts    # open position monitoring (SL, TSL, EOD exit)
│   ├── pnl-calc.ts         # P&L computation helpers
│   ├── regime-tagger.ts    # market regime classification
│   ├── retrospection.ts    # EOD analysis engine
│   └── evolution-rules.ts  # rule-based parameter evolution
└── utils/
    └── market-hours.ts     # IST market session checks
```

## Architecture

### Data Flow

```
Fyers WebSocket → routeTick() → price cache (Map) + Redis Streams
                                        ↓ every 15s (market hours only)
                              computeAndSaveSnapshot() → straddle_snapshots
                                        ↓
                              trading-loop → signal-detector → personality-engine
                                        ↓
                              trade-executor → paper_trades table
                                        ↓ EOD (BullMQ)
                              retrospection → retrospection_results + evolution-rules
```

### Key Modules

**`straddle-calc.ts`** — Maintains an in-memory price cache (keyed by Fyers symbol string). Every 15 seconds it computes ATM CE+PE straddle value, ROC, acceleration, and persists a `straddle_snapshots` row.

**`signal-detector.ts`** — Implements the momentum exhaustion algorithm: expansion_pct ≥ threshold AND acceleration < threshold AND ROC has declined for N candles. Outputs a probability-adjusted signal.

**`personality-engine.ts`** — Each personality runs the 5-stage filter independently against every signal. Frozen personalities (`is_frozen = true`) are read-only and must never receive evolution suggestions.

**`evolution-rules.ts`** — Applies `EvolutionRule` objects against retrospection output. Guards: checks `FROZEN_PERSONALITIES` list and `FROZEN_ATTRIBUTES` before any mutation. Comparison integrity check runs before every rule application.

**`instrument-registry.ts`** — Builds Fyers symbol strings (e.g. `NSE:NIFTY25600CE`) without a scripmaster file. Computes current weekly expiry (Thursday).

### Database

- **TimescaleDB hypertables:** `market_ticks`, `straddle_snapshots`, `option_ticks` — partitioned by `time`
- **Standard tables:** `straddle_signals`, `paper_trades`, `personality_configs`, `retrospection_results`, `external_signals`
- **Continuous aggregate:** `straddle_1min` (1-minute OHLC for charting)
- TimescaleDB compression is enabled on `straddle_snapshots` (segmented by `underlying, expiry`)
- No ORM — raw `pg` Pool queries with TypeScript types in `src/db/schema.ts`

## Key Patterns & Conventions

- **No ORM** — all DB access via `pg` Pool. Type safety from `schema.ts` type aliases, not generated types.
- **Singleton clients** — `getRedis()` and `closePool()` from their respective `client.ts` files; never instantiate directly.
- **Strict TypeScript** — no `any`, no non-null assertion without comment, path alias `@/*` for imports within `src/`.
- **Simulation parity** — simulation mode (`SIMULATE=true`) must produce the same data shapes as live mode; `market-data-sim.ts` mirrors Fyers tick format exactly.
- **IST timezone** — all market hours logic uses IST (UTC+5:30). `market-hours.ts` handles offset arithmetic.
- **Personality immutability** — `entry_type` and `management_style` are never updated after seeding. Only tuning parameters evolve. `is_frozen = true` rows (Clockwork) are never touched by evolution rules.
- **Regime-first comparisons** — never compare personalities without a regime tag. The `market_regime` column on `retrospection_results` is NOT NULL.

## Testing

- **Framework:** `bun test` (built-in Bun test runner — similar API to Jest/Vitest)
- **Unit tests:** `src/**/__tests__/*.test.ts` — cover signal-detector, personality-engine, evolution-rules, P&L calc, regime-tagger, trade-executor, trade-manager, retrospection
- **Integration tests:** `src/**/__tests__/*.integration.test.ts` — require live Docker services (PostgreSQL + Redis)
- **E2E tests:** Playwright — planned for dashboard once frontend is implemented
- **No coverage threshold configured** — not enforced in CI
- **Mocking:** Bun's built-in `mock()` for external dependencies; no additional mock library

## Environment Variables

Critical ones whose misconfiguration causes hard-to-debug failures:

| Variable | Why it matters |
|---|---|
| `DATABASE_URL` | Must point at a PostgreSQL 16 instance with TimescaleDB extension loaded; `bun run migrate` will fail silently-ish without it |
| `REDIS_URL` | Both the streaming pipeline and BullMQ depend on this; wrong URL causes Redis ping failure at startup |
| `FYERS_APP_ID` / `FYERS_ACCESS_TOKEN` | Required in live mode; **token expires daily** — stale token causes silent WebSocket disconnection |
| `SIMULATE=true` | Must be set to run without Fyers credentials; the app throws at startup if credentials are absent and this is not set |
| `EVOLUTION_REQUIRE_APPROVAL` | Defaults to `true` — high-impact evolution rules queue for human approval. Setting this to `false` in production allows automatic parameter mutation without review. |
| `NODE_ENV` | Set to `production` in prod; affects logging verbosity |

## Common Tasks

### Add a new evolution rule
1. Define a new `EvolutionRule` object in `src/trading/evolution-rules.ts`
2. Set `applicable_to`, `regime_filter`, `min_sample_size`, `condition`, `adjustment`, `cooldown_days`, `max_applications`, `requires_approval`
3. Add a unit test in `src/trading/__tests__/evolution-rules.test.ts` covering: rule fires when condition met, rule does not fire below min_sample_size, rule does not fire during cooldown, rule is blocked on frozen personality

### Add a new personality
1. Add a new row to `src/db/migrations/002_seed_personalities.sql` with `is_frozen = false`
2. Add the personality to the `FROZEN_PERSONALITIES` check in `evolution-rules.ts` if applicable
3. Re-run `bun run migrate` (or reset DB and migrate fresh)

### Schema change
1. Create `src/db/migrations/003_<description>.sql`
2. Run `bun run migrate`
3. Update type aliases in `src/db/schema.ts` to match

### Run without broker (development)
```bash
SIMULATE=true SIM_UNDERLYING=NIFTY bun run sim
```

## Gotchas

- **Fyers token expires daily.** Live mode (`SIMULATE=false`) will connect successfully but stop receiving ticks when the token expires. Automate refresh with `fyers-api-v3` auth API for any sustained run.
- **TimescaleDB must be enabled.** A plain PostgreSQL 16 instance without the TimescaleDB extension will fail migration at the `create_hypertable()` calls. Docker Compose image `timescale/timescaledb:latest-pg16` includes it.
- **No lint script.** There is no `npm run lint` / `bun run lint`. TypeScript strict mode (`bun run --bun tsc --noEmit`) is the only static check.
- **Integration tests need live infra.** Running `bun test` or `bun run test:integration` against a cold machine without Docker services will fail with connection errors.
- **Comparison integrity check is a pre-condition for all evolution.** If `min_probability` across Precision/Adjuster/Reducer drifts > 8pp, evolution is paused on the outlier until alignment is restored. Seeding them with identical starting values matters.
- **`currentPrices` map key format differs between live and sim.** In live mode the key is a Fyers symbol string (e.g. `NSE:NIFTY25600CE`); in sim mode it must be explicitly synced via `buildFyersSymbol()`. See the simulation loop in `src/index.ts:160-170`.
- **`bun.lock` — not `package-lock.json`.** Do not `npm install`. Use `bun install` exclusively.
