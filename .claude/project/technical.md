# Technical Context

## Tech Stack

| Area | Choice |
|---|---|
| Language | TypeScript 5.x — strict mode |
| Runtime | Bun (latest) — used for all execution, including migrations and scripts |
| Web Framework | Fastify 4.x — schema-validated routes, ~2ms p99 latency target |
| Primary DB | PostgreSQL 16 + TimescaleDB 2.x extension (required, not optional) |
| ORM / DB Access | Raw SQL via `pg` pool — no ORM. Custom migration runner in `apps/server/src/db/migrate.ts` |
| Message Queue / Event Bus | Redis 7 Streams — topics: `market.ticks`, `straddle.values`, `signals.generated` |
| Background Jobs | BullMQ (Redis-backed) — EOD retrospection batch |
| Cache | Redis 7 — sub-ms reads for price cache and personality state |
| Frontend | React 18 + Vite + Zustand (state) + Tailwind CSS 3.x + Lightweight Charts |
| Testing | Vitest (unit + integration) + Playwright (E2E) |
| Market Data | Fyers WebSocket via `fyers-api-v3` SDK (untyped — TypeScript shim in `apps/server/src/types/`) |
| Paper Trading | Quantiply API (paper trade execution tracking) |
| VIX Data | NSE public API endpoint (polling fallback) + Fyers tick (`NSE:INDIAVIX-INDEX`) |
| Deployment | Docker Compose (dev) → Railway / Fly.io (prod) |
| Options Backtesting | Python 3.12 + `uv`, in `packages/option-backtesting` — Parquet + DuckDB cache, pydantic-validated YAML strategy DSL, bar-by-bar event engine (golden-fixture-verified to the rupee), FastAPI service + MCP server, fronted by a Fastify proxy and a React dashboard tab; walk-forward, parameter sweeps, a CSCV/PBO + deflated-Sharpe overfitting guard, a margin model, regime bucketing, and personality export are all built (M-5) — the epic is feature-complete |

## Package Manager & Runtime

- **Package manager:** Bun — single lockfile (`bun.lock`) at the repo root. Do not use `npm` or `yarn`; they will create a second lockfile and conflict
- **Runtime:** Bun (latest) — `bun run <script>` for everything. Node.js is NOT used directly
- **TypeScript:** Compiled and executed natively by Bun — no `tsc` build step for running. `tsc --noEmit` is used only for type-checking
- **Monorepo:** Bun workspaces (`"workspaces": ["apps/*"]` in the root `package.json`). All root-level scripts fan out to the workspace packages via `bun run --filter <pkg> <script>` or `bun run --workspaces <script>` — run them from the repo root, not from inside a package directory, unless you deliberately want to scope a command to one package

## Essential Commands

All commands below are run from the **repo root** and fan out to the relevant workspace package(s).

```bash
# Install dependencies (single lockfile for the whole monorepo)
bun install

# Start infrastructure (PostgreSQL + Redis via Docker)
docker compose up -d
docker compose ps          # verify both show (healthy)

# Run database migrations (idempotent — safe to re-run)
bun run migrate

# Development — simulation mode (no broker credentials needed)
bun run sim                 # equivalent to SIMULATE=true bun run dev

# Development — live mode (Fyers credentials required)
bun run dev                 # watch mode with auto-reload (apps/server)
bun run start                # production-style start (apps/server)

# Dashboard dev server (Vite, proxies /api to the server on :3000)
bun run --filter @ata/dashboard dev

# Type-check the server (root script is scoped to @ata/server only — the
# dashboard has one pre-existing type error and isn't CI-enforced yet; run
# its own check explicitly if you touch apps/dashboard)
bun run typecheck
bun run --filter @ata/dashboard typecheck

# Tests
bun run test                # unit tests in every workspace package
bun run test:unit           # server unit tests only
bun run test:integration    # server integration tests (requires Docker services running)
bun run test:e2e            # dashboard Playwright suite (start the Vite dev server first)

# option-backtesting (Python) — run from packages/option-backtesting/
cd packages/option-backtesting
uv sync
uv run pytest
uv run obt ingest plan --date YYYY-MM-DD --to YYYY-MM-DD --underlying NIFTY
uv run obt ingest --date YYYY-MM-DD --underlying NIFTY
uv run obt validate strategies/B_pyramid.yaml
uv run obt run strategies/B_pyramid.yaml --from YYYY-MM-DD --to YYYY-MM-DD
uv run obt registry
uv run obt walkforward strategies/B_pyramid.yaml --is-from YYYY-MM-DD --is-to YYYY-MM-DD --oos-from YYYY-MM-DD --oos-to YYYY-MM-DD
uv run obt sweep strategies/B_pyramid.yaml --changes changes.json --from YYYY-MM-DD --to YYYY-MM-DD [--overfit --n-blocks 4]
uv run obt export-personality <run_id>

# option-backtesting FastAPI service (loopback-only, port 8000) — from repo root
bun run py:api               # equivalent to: cd packages/option-backtesting && uv run obt-api
# The Fastify proxy (BACKTEST_API_URL, default http://127.0.0.1:8000) is the only
# public-facing surface in front of it — see apps/server/src/server/routes/backtest.ts.

# option-backtesting MCP server (stdio) — registered in root .mcp.json as "option-backtesting";
# a Claude Code session picks it up automatically, no manual start needed.

# Teardown
docker compose down         # stop services, keep data volumes
docker compose down -v      # stop + destroy data volumes (full reset)
```

## Repository Structure

A Bun-workspaces monorepo: `apps/server` (Fastify/Bun backend), `apps/dashboard` (React/Vite frontend), and `packages/option-backtesting` (a Python/uv sub-package — the options-backtesting research workbench, not a Bun workspace member). Shared config (biome, lefthook, docker-compose, CI) stays at the repo root.

```
ai-trading-agent/
├── package.json                     # workspace root: "workspaces": ["apps/*"]; scripts fan out via --filter/--workspaces
├── bun.lock                         # single lockfile for the whole monorepo
├── tsconfig.base.json               # shared strict compilerOptions, extended by each package's tsconfig.json
├── docker-compose.yml               # TimescaleDB (timescale/timescaledb:latest-pg16) + Redis 7
├── .env.example                     # single shared .env at repo root; both apps read it
├── biome.json · lefthook.yml        # repo-wide lint/format + pre-commit hooks
├── .mcp.json                        # registers the "option-backtesting" MCP server (obt-mcp, stdio)
├── scripts/install-biome.sh         # root-level tooling (downloads the Biome binary), not app code
├── apps/
│   ├── server/                      # @ata/server — the Fastify/Bun backend
│   │   ├── package.json · tsconfig.json · vitest.config.ts · vitest.workspace.ts
│   │   ├── scripts/                 # replay.ts, backtest.ts, backfill-legs.ts, reconstruct.ts
│   │   └── src/
│   │       ├── db/
│   │       │   ├── client.ts               # PostgreSQL pool + query helpers
│   │       │   ├── migrate.ts              # Custom migration runner with retry logic
│   │       │   ├── schema.ts               # TypeScript types for every DB table
│   │       │   └── migrations/             # Sequential SQL migration files (001_*.sql, etc.)
│   │       ├── redis/
│   │       │   └── client.ts               # Redis client + streamPublish / streamRead helpers
│   │       ├── ingestion/
│   │       │   ├── straddle-calc.ts        # ATM strike calculation, 15s snapshots, ROC/acceleration
│   │       │   ├── vix-feed.ts             # VIX poller (NSE public API fallback)
│   │       │   ├── market-data-sim.ts      # Random-walk simulator for dev (no broker needed)
│   │       │   └── brokers/
│   │       │       ├── types.ts            # BrokerFeed interface + BrokerTick type
│   │       │       ├── broker-factory.ts   # createBroker() factory — selects adapter by BROKER / SIMULATE env
│   │       │       ├── fyers.ts            # Fyers fyersDataSocket adapter (socketFactory DI, reconnect circuit breaker, AUTH_FAILURE detection)
│   │       │       ├── angelone.ts         # Angel One (SmartAPI) adapter
│   │       │       └── instrument-registry.ts  # Weekly/monthly symbol builder + expiry helpers
│   │       ├── jobs/
│   │       │   └── token-validity-check.ts # Pre-market Fyers token expiry check + BullMQ scheduler
│   │       ├── state/
│   │       │   └── broker-status.ts        # Runtime broker auth degradation flag (AUTH_FAILURE detection)
│   │       ├── trading/                    # Personalities, signal detection, paper execution
│   │       ├── types/
│   │       │   └── fyers-api-v3.d.ts       # TypeScript declaration shim for untyped Fyers SDK
│   │       └── index.ts                    # Main entry point (branches on SIMULATE env var)
│   └── dashboard/                   # @ata/dashboard — the React/Vite SPA
│       ├── package.json · tsconfig.json · vite.config.ts · vitest.config.ts · playwright.config.ts
│       ├── index.html · tailwind.config.ts · postcss.config.js
│       ├── e2e/                     # Playwright specs
│       └── src/                     # App.tsx, components/, hooks/, lib/, store/, types/
│                                     # components/BacktestView.tsx + hooks/useBacktest{Presets,Runs,Validate}.ts
│                                     # + types/backtest.ts — the options-backtesting research tab (M-4),
│                                     # fed entirely through /api/backtest/* (never the Python service directly)
└── packages/
    └── option-backtesting/          # Python 3.12 / uv — strategy-research workbench over AlgoTest option
                                      # bars, answering "is this strategy worth becoming a personality?"
                                      # (a different question from apps/server's `bun run backtest`, which
                                      # replays the live personalities historically). Not a Bun workspace
                                      # member — has its own pyproject.toml/uv.lock. Feature-complete
                                      # end to end (M-0 through M-5): data layer, strategy DSL, and the
                                      # bar-by-bar engine (golden-fixture-verified to the rupee, M-1/M-2/
                                      # M-3); FastAPI service, MCP server, Fastify proxy, dashboard tab
                                      # (M-4); walk-forward, sweeps, a CSCV/PBO + deflated-Sharpe
                                      # overfitting guard, a margin model, regime bucketing, personality
                                      # export, and a nightly ingest Routine (M-5).
        ├── pyproject.toml · uv.lock · .python-version · DECISIONS.md
        ├── src/option_backtesting/
        │   ├── config.py                 # BACKTEST_DATA_DIR-derived cache/registry path resolution — shared
        │   │                              # by api/app.py and mcp/server.py
        │   ├── presets.py                # preset_names()/STRATEGIES_DIR — the allow-list both the API and
        │   │                              # the MCP server check BEFORE building a filesystem path (no traversal)
        │   ├── data/
        │   │   ├── providers/{base,algotest,dhan}.py   # MarketDataProvider Protocol, canonical Bar/InstrumentKey
        │   │   ├── resolver.py         # ATM/OTMn/ITMn/EXACT -> concrete strike, independent of any vendor
        │   │   ├── reference/          # effective-dated CSVs: expiry_calendar, holidays, lot_sizes, strike_step, margin
        │   │   ├── quality.py          # ingest-time gates: identical_series, bar_gaps, zero_volume, etc.
        │   │   ├── raw.py              # raw AlgoTest JSON manifest read/write (data/raw/algotest/, tracked)
        │   │   ├── ingest.py           # raw JSON -> quality-gated Parquet (data/cache/, gitignored)
        │   │   └── cache.py            # DuckDB façade the engine reads (never a provider directly)
        │   ├── features/                # named, cached, point-in-time feature evaluation (leg_sum, raw, gap,
        │   │   │                         # greek, days_to_expiry, max_runup, session_high/low, rolling_mean/
        │   │   │                         # ewma/rolling_pctile) — registry.py (M-2) is the declarative schema,
        │   │   │                         # the rest (M-3) is the runtime evaluator
        │   │   ├── registry.py · store.py · evaluator.py
        │   │   ├── leg.py · greeks.py · calendar.py · path.py · rolling.py
        │   │   └── regime.py           # M-5, R2: post-hoc regime bucketing only, NOT a DSL condition
        │   │                           # feature — see DECISIONS.md for why
        │   ├── strategy/                 # schema.py (M-2 pydantic AST) · loader.py (line-numbered YAML errors)
        │   │   │                         # · mutate.py (M-5: deep_merge, shared by propose_strategy + sweep)
        │   ├── engine/                   # bar-by-bar event engine (M-3), pinned to reproduce the design
        │   │   │                         # handoff's reference implementation to the rupee — see
        │   │   │                         # engine/loop.py's module docstring before changing any formula
        │   │   ├── loop.py             # SessionContext, build_sessions, simulate_session, run_backtest
        │   │   ├── conditions.py       # Condition/Ref grammar evaluation (all/any/not/feature/time, anchors)
        │   │   ├── fills.py            # trigger_level (default)/bar_close/worst_of_bar/next_open + slippage
        │   │   ├── costs.py            # flat cost = total_lots × 2 legs × per_leg_rt
        │   │   ├── ledger.py · state.py  # Fill/SessionLedger; per-session running-anchor/last-fill state
        │   │   ├── result.py           # SessionResult/AggregateResult, bootstrap_ci (R1a), render_report
        │   │   ├── margin.py           # M-5, R1: classify_strategy_type + return on peak margin
        │   │   └── registry.py         # SQLite run history (data/registry.sqlite, gitignored) — the
        │   │                           # `strategy_yaml` column (M-5) lets export-personality reconstruct
        │   │                           # a run's exact strategy from just its run_id
        │   ├── analytics/                 # M-5: research tools that consume the engine's output, not part
        │   │   │                          # of a single backtest run
        │   │   ├── walkforward.py      # same-strategy in-sample/out-of-sample split (no re-fitting)
        │   │   ├── sweep.py            # run a base strategy against many change-dicts over one window
        │   │   ├── overfit.py          # CSCV/PBO + simplified (Gaussian) Deflated Sharpe over a sweep
        │   │   └── regime_source.py    # reads daily_regime_tags from Postgres, gated on DATABASE_URL,
        │   │                           # lazy psycopg import (optional "regime" extra)
        │   ├── export/
        │   │   └── personality.py        # M-5, R3: StrategySpec -> PersonalityConfigM2 candidate
        │   │                             # ({entryType, managementStyle, params}); unrepresentable DSL
        │   │                             # constructs go under manual_review, never guessed; never writes
        │   │                             # to any database
        │   ├── api/                      # FastAPI service (M-4), loopback-only (127.0.0.1:8000) — the
        │   │   │                         # Fastify proxy is the only public-facing surface in front of it
        │   │   ├── app.py              # create_app() factory + `obt-api` uvicorn entry point
        │   │   ├── routes.py           # validate/runs/presets/coverage/health
        │   │   └── models.py           # pydantic request/response models
        │   ├── mcp/
        │   │   └── server.py             # `obt-mcp` stdio MCP server (M-4/M-5) — mcp 2.x's MCPServer (see
        │   │                             # DECISIONS.md); tools: plan_requests, validate_strategy,
        │   │                             # run_backtest, run_walkforward, run_sweep, check_overfit,
        │   │                             # list_runs, critique_result, export_personality, propose_strategy
        │   └── cli.py                    # `obt` — ingest plan | ingest | validate | run | registry |
        │                                 # walkforward | sweep [--overfit] | export-personality
        └── tests/{golden,parity,unit}/    # tests/golden/test_engine_golden.py is the M-3 exit gate —
                                            # reproduces golden_15_sessions.expected.txt to the rupee for A/B/C/D
```

## Architecture

The system is a **real-time event-driven pipeline** in four layers:

1. **Data Ingestion:** Fyers WebSocket (or simulator) → raw tick → Redis `market.ticks` stream
2. **Event Processing:** Redis Streams fan-out to straddle calculator and VIX feed
3. **Signal Generation:** Straddle calc → ROC/acceleration engine → peak detection → signal router → personality filter stages → paper trade execution
4. **Execution & Retrospection:** Paper trades stored in PostgreSQL; BullMQ EOD job runs retrospection; rule engine queues parameter suggestions

**Personality routing:** Every signal is broadcast to all active personalities simultaneously. Each personality runs its own 5-stage filter chain independently. There is no shared state between personalities at decision time.

**BrokerFeed interface:** All broker adapters implement a common `BrokerFeed` interface (`src/ingestion/brokers/types.ts`). The simulator and the Fyers adapter are interchangeable. New brokers follow this pattern.

**Hypertables:** `market_ticks`, `straddle_snapshots`, and `option_ticks` are TimescaleDB hypertables (auto-partitioned by time). Queries against these tables must always include a time-range filter — full-table scans on hypertables are extremely slow and should never appear in production code.

**Continuous aggregates:** `straddle_1min` is a TimescaleDB materialized view. Refresh is automatic. Do not manually insert into it.

**Clockwork immutability:** `personality_configs.is_frozen = TRUE` for the Clockwork row. The evolution engine checks this flag before applying any rule and throws `FROZEN_VIOLATION` (not silently skips) if violated. Never bypass this check.

**Comparison integrity:** Precision, Adjuster, and Reducer all use `entry_type = MOMENTUM_EXHAUSTION`. Their `min_probability` thresholds must stay within 8 percentage points of each other. The `checkComparisonIntegrity()` function enforces this and pauses evolution on the outlier if breached.

## Key Patterns & Conventions

- **No ORM:** All DB access is raw SQL via the `pg` pool. Query results are typed against the interfaces in `apps/server/src/db/schema.ts`
- **Migration files:** Named `NNN_description.sql` in `apps/server/src/db/migrations/`. The runner applies them in order and records applied versions in `schema_migrations`. Always add new migrations as new files — never edit applied ones. Runner identifies migrations by **filename only** (no content checksum): once a file is applied, its name is registered in `schema_migrations` and re-runs are skipped. Editing already-applied migrations affects only fresh installs; existing databases skip them. For schema changes, determine the canonical source: `personality_configs` and `straddle_signals` are canonically defined in `001_core_schema.sql` (params-shape); later migration files that repeat these CREATE TABLEs are no-ops on fresh installs. When editing historical migrations, verify the change applies to the intended phase of deployment (fresh vs. existing DB).
- **Broker symbol format (Fyers):** Weekly options: `NSE:NIFTY{YY}{M}{DD}{STRIKE}{TYPE}` where months Oct–Dec use single letter codes (O, N, D). See `instrument-registry.ts` for the encoder/decoder
- **ATM strike intervals:** NIFTY = 50pt, BankNifty = 100pt, Sensex = 100pt. Always use `getAtmStrike()` — never compute this inline
- **Broker adapter selection:** All brokers (Fyers, Angel One, simulator) implement the common `BrokerFeed` interface. The `createBroker()` factory in `apps/server/src/ingestion/brokers/broker-factory.ts` selects the adapter based on `BROKER` and `SIMULATE` env vars: `BROKER=fyers` → FyersBroker, `BROKER=angelone` → AngelOneBroker, `BROKER=sim` or `SIMULATE=true` → MarketDataSimulator. If `BROKER` is unset/empty AND `SIMULATE !== 'true'`, the factory throws a descriptive error at startup — safe default-throw prevents silent misconfiguration in live environments.
- **Simulation mode:** Controlled by `SIMULATE=true` env var. The simulator generates realistic random-walk NIFTY tick data at configurable interval AND emits synthetic ATM CE/PE option-leg ticks so the straddle pipeline works end-to-end. Everything downstream is identical — simulation is not a test mode, it uses the real pipeline. Hypertable writes are trimmed to ~10000 rows via MAXLEN on all ingestion xadds.
- **Regime tagging:** Every retrospection result must carry a `market_regime` tag. Never compare personality performance across different regimes without filtering. The four tags are: `RANGING`, `TRENDING_STRONG`, `VOLATILE_REVERTING`, `EVENT_DAY`
- **Probability scores:** Not empirically calibrated yet. Treat as relative rankings, not absolute probabilities. Brier scores are tracked in `retrospection_results.signal_brier_score`
- **TypeScript strict mode:** Enabled. `fyers-api-v3` has no official types — the shim at `apps/server/src/types/fyers-api-v3.d.ts` covers the SDK surface we use
- **No default exports:** Use named exports throughout

## Testing

- **Unit tests (Vitest):** Peak detection algorithm, decision engine filter stages (each stage independently), evolution rule trigger conditions, P&L calculations, parameter clamping, ATM strike rounding, symbol builder correctness
- **Integration tests (Vitest):** Signal → personality → paper trade full flow; Redis Streams message passing; TimescaleDB continuous aggregate correctness. Require Docker services to be running
- **E2E tests (Playwright):** Dashboard renders live data; trade log updates in real-time; retrospection results display
- **No coverage threshold set yet** — will be added when Sprint 2 test suite stabilises
- **Backtesting requirement:** Before any production deployment, run against minimum 6 months of historical tick data with separate training and test periods

## Environment Variables

Critical variables whose misconfiguration causes real pain:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Must point at PostgreSQL 16 with TimescaleDB extension installed. Missing extension → migration fails with `type "timestamptz" does not exist in hypertable` or similar |
| `REDIS_URL` | Must be Redis 7+. BullMQ uses Redis Streams features not in Redis 6 |
| `FYERS_ACCESS_TOKEN` | **Expires daily.** Must be regenerated every morning before live market open. AUTH_FAILURE on stale token is detected and surfaced to the frontend via /api/meta `authDegraded=true` and /api/auth/fyers/status `needsReauth=true` |
| `FYERS_APP_ID` | Format is `XXXXXXXXXXXX-100` (app ID + `-100` suffix). Wrong format → Fyers SDK auth failure |
| `QUANTIPLY_API_KEY` | Required in live mode. Missing → paper trade writes fail silently if error handling isn't tight |
| `BROKER` | Selects the adapter: `fyers` (default), `angelone`, or `sim`. Omitting this AND omitting `SIMULATE=true` → safe default-throw error at startup (no silent fallback) |
| `SIMULATE` | Set to `true` for credential-free development mode. When set, MarketDataSimulator is selected regardless of `BROKER` value |
| `MAX_WS_CONNECTIONS` | Max concurrent /ws/ticks WebSocket connections (default 50). Positive integers only; non-positive values silently fall back to 50 |
| `EVOLUTION_REQUIRE_APPROVAL` | Should be `true` in any environment where the retrospection engine runs. Setting `false` allows the system to autonomously modify personality parameters without human review |
| `TOKEN_VALIDITY_SCHEDULER_ENABLED` | When set to `true`, registers a BullMQ cron job that checks Fyers token expiry at 08:45 IST weekdays. Disabled by default; opt-in via this flag |
| `BACKTEST_API_URL` | Base URL of the loopback-only Python FastAPI service (default `http://127.0.0.1:8000`). The Fastify proxy validates this resolves to loopback/private address space at startup — a public host throws (safe default-throw), the proxy never starts against it |
| `BACKTEST_DATA_DIR` | Optional override for where the FastAPI/MCP service reads its Parquet cache and writes its run registry (`<dir>/cache`, `<dir>/registry.sqlite`). Defaults to `packages/option-backtesting`'s own `data/` when unset |

## Common Tasks

**Add a new broker adapter:**
1. Implement `BrokerFeed` interface from `apps/server/src/ingestion/brokers/types.ts`
2. Add the adapter file under `apps/server/src/ingestion/brokers/`
3. Update `apps/server/src/index.ts` to select the new adapter based on an env var

**Add a new personality:**
1. Insert a row into `personality_configs` in the seed migration (or via a new migration)
2. Add the personality's evolution rules to the rule engine
3. If Phase 2+, set `phase = 2` so it is gated behind the Phase 2 flag

**Add a database table:**
1. Create a new migration file `apps/server/src/db/migrations/NNN_description.sql`
2. Add TypeScript interface to `apps/server/src/db/schema.ts`
3. Run `bun run migrate` to apply

**Change a signal parameter:**
1. Adjust the env var (e.g., `SIGNAL_MIN_EXPANSION_PCT`) — no code change needed for thresholds in `PeakDetectionConfig`
2. For structural algorithm changes, modify `apps/server/src/ingestion/straddle-calc.ts`

## Gotchas

- **Fyers token expires daily** — there is no automatic refresh yet (deferred to Phase B). The system detects AUTH_FAILURE mid-session and sets the `authDegraded` flag in broker-status state, surfaced to the frontend via /api/meta and /api/auth/fyers/status. A pre-market token-validity check job runs at 08:45 IST on weekdays (opt-in via TOKEN_VALIDITY_SCHEDULER_ENABLED env). Operators must manually regenerate the token before market open when the status endpoint shows `needsReauth=true`
- **TimescaleDB is not optional** — the standard `postgres:16-alpine` image does NOT have TimescaleDB. The Docker Compose uses `timescale/timescaledb:latest-pg16`. Pointing the app at a vanilla PostgreSQL instance will fail on migration
- **Hypertable full-table scans** — a query on `market_ticks` or `straddle_snapshots` without a `WHERE time > ...` filter will scan years of data. Always filter by time range
- **Two test commands** — `bun run test:integration` requires Docker services running. Running it without them produces confusing connection errors, not a test-not-found error
- **Clockwork evolution guard** — the `is_frozen` flag must be checked in the evolution engine before any rule application. If you add a new rule that bypasses this check, Clockwork parameters will silently drift and invalidate months of comparative data
- **Comparison integrity drift** — if Precision, Adjuster, or Reducer `min_probability` thresholds drift more than 8 percentage points apart, the management comparison is invalidated. The `checkComparisonIntegrity()` function must run before any threshold evolution rule is applied
- **Simulation is not a mock** — `SIMULATE=true` runs the full production pipeline with synthetic data. It writes to the real database and Redis. Use `docker compose down -v` to reset state between test runs if needed
- **Port conflicts** — PostgreSQL default port 5432, Redis default 6379. If either is in use locally, edit the port mapping in `docker-compose.yml` and update the corresponding `_URL` env var
- **Bun-only repo** — do not run `npm install` or `yarn install`. They generate a `package-lock.json` or `yarn.lock` that will conflict with `bun.lock`
