# AI Trading Agent (In Progress)


Paper-trading research platform for weekly index options strategies on Indian markets (NSE/BSE).

## The Approach

Most trading research suffers from a fundamental flaw: you tune a single strategy until it looks good, then discover it was curve-fitted to the regime you happened to study. This platform attacks that problem differently — by running **10 competing trading personalities in parallel**, each with its own risk tolerance, entry thresholds, and trade management style, all trading the same signals at the same time on paper.

The idea is simple: instead of asking "is this strategy good?", we ask "which personality survives across regimes, and why?". Every personality sees the same momentum-exhaustion signals generated from NSE/BSE ATM straddle data. Each one independently decides whether to act — filtering the signal through five stages (hard risk limits → position state → market context → signal quality → optional profit gate). The result is a controlled experiment: identical market exposure, divergent decision logic, measurable outcomes.

A frozen **Clockwork** personality acts as the immutable benchmark. Its parameters never change. Every other personality is measured against it — not against the market, not against itself from last week, but against a stable reference. This makes regime-to-regime comparison honest: if Clockwork bleeds in a trending market and Precision thrives, that's signal, not noise.

At end-of-day, a retrospection engine tags each day's results by market regime (`RANGING`, `TRENDING_STRONG`, `VOLATILE_REVERTING`, `EVENT_DAY`) and computes per-personality metrics: Beat-Clockwork delta, signal calibration score, management effectiveness. Rule-based parameter evolution then proposes adjustments — with human approval gates — so the personalities adapt to evidence rather than intuition.

## Quick Start

### Prerequisites
- Docker and Docker Compose
- [Bun](https://bun.sh) runtime

### 1. Start infrastructure

```bash
docker compose up -d
docker compose ps  # wait until both show (healthy)
```

### 2. Install dependencies

```bash
bun install
```

### 3. Run database migrations

```bash
bun run migrate
```

### 4. Start in simulation mode (no broker credentials needed)

```bash
SIMULATE=true bun run sim
```

The server starts on `http://localhost:3000`.

### 5. View the dashboard

The dashboard lives at the repository root (`index.html` + `src/frontend/`, root `vite.config.ts`). In development, run the Vite dev server alongside the backend:

```bash
bunx vite        # Vite dev server at http://localhost:5173
```

It proxies `/api` and `/ws` to the backend on `http://localhost:3000` (see `vite.config.ts`).

For a production build run `bunx vite build`; the static files are emitted to `dist/`. Point a static server or the Fastify static plugin at that directory.

### Dashboard Wiring

The three main dashboard tabs (Live, Trades, P&L) are now wired to backend endpoints:

- **Live tab** — Polls `GET /api/straddle/latest` (~10 s interval). Currently returns `data: null` (stub). Displays a **synthetic NIFTY index feed** via `WS /ws/ticks` — this is a random-walk dev feed for testing, not real straddle data. The component clearly labels this as synthetic.
- **Trades tab** — Polls `GET /api/trades` (~10 s interval) for the paper trade log.
- **P&L tab** — Uses the same `GET /api/trades` hook to compute realized P&L aggregates and a cumulative P&L line chart.

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Health check |
| `GET /api/trades` | Paper trades (open + closed) |
| `GET /api/straddle/latest` | Latest straddle snapshot — currently stubs `data: null` |
| `GET /api/positions` | Active positions summary |
| `WS /ws/ticks` | Real-time synthetic NIFTY tick stream (dev only) |

### Environment variables

See `.env.example` for the full list. Key variables:

| Variable | Default | Description |
|---|---|---|
| `SIMULATE` | — | Set to `true` for simulation mode |
| `DATABASE_URL` | `postgresql://trading:trading@localhost:5432/trading` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `BROKER` | `sim` | Broker adapter: `sim`, `fyers`, or `angelone` |
| `PORT` | `3000` | Fastify server port |

## Historical data, backfill & replay (M3a)

### Backfill — load historical market data

The backfill writer (`src/ingestion/historical/backfill.ts`) populates the database with historical OHLCV candles from Fyers. Call `runBackfill()` with a date range and symbol; it fetches candles and writes them into market_ticks and option_ticks hypertables.

**Key properties:**
- **Resumable:** if interrupted by auth failure (FyersAuthError), subsequent calls with the same options resume from the last checkpoint saved in backfill_ranges table.
- **Idempotent:** partial unique indexes prevent duplicate re-ingestion; re-running a completed range writes zero duplicates (INSERT ... ON CONFLICT DO NOTHING).
- **Fail-loud:** missing option legs (CE or PE contracts at any step) throw MissingLegError immediately — never interpolated or skipped.
- **Time-bounded:** all hypertable writes respect TimescaleDB's partitioning discipline — queries always include time-range filters.

### Replay — deterministic history simulation

Run the trading pipeline against historical data with a deterministic virtual clock:

```bash
# Against a scratch database (safe, no confirmation needed)
DATABASE_URL=postgresql://user:pass@localhost:5432/test_db \
  bun run replay --from 2024-01-25T03:45:00Z --to 2024-01-25T10:00:00Z --underlying NIFTY

# Against the live database (requires explicit acknowledgement)
bun run replay --from 2024-01-25T03:45:00Z --to 2024-01-25T10:00:00Z --underlying NIFTY --against-live
```

**Safety guard:** `bun run replay` refuses to connect to the live DATABASE_URL unless you pass `--against-live` (or set `REPLAY_CONFIRM_LIVE=true`), because the PositionMonitor can close real open paper trades. Point at a scratch database for normal use — no flag needed in that case.

**Flags:**
- `--from <ISO>`: replay window start (required)
- `--to <ISO>`: replay window end (required)
- `--underlying NIFTY|BANKNIFTY|SENSEX`: index to replay (default: NIFTY)
- `--speed <multiplier>`: virtual-time acceleration for log output (default: 1.0)
- `--verbose`: log each emitted tick (very noisy for long windows)
- `--dry-run`: load ticks without starting the pipeline (no paper-trade writes)
- `--against-live`: explicit opt-in to run against the live database
- `--regenerate-fixture`: developer-only; regenerate golden test fixtures (never in CI)

### Market regime tagging (M3a)

Historical days are automatically tagged with market regimes (RANGING, TRENDING_STRONG, VOLATILE_REVERTING, EVENT_DAY, UNCLASSIFIED) based on intraday straddle behavior and a deterministic event calendar.

**Causal/point-in-time:** regime classification uses only data observable at 14:30 IST — the same cutoff a real trader would use to decide whether to enter a position. No lookahead, no future bars consulted.

**Deterministic:** classification thresholds are compile-time constants (no learned values). Same input data always produces the same regime label.

**Event calendar:** EVENT_DAY dates (RBI policy days, Union Budgets, F&O expiry mornings, NSE holidays) are checked into the `event_calendar` table (seeded in migration 008). Operators can extend the table with new events via migrations; no env var needed for reproducible backtests.

### Database migrations (M3a)

Migrations 007, 008, and 009 support historical backfill and regime tagging:

- **007_historical_backfill.sql** — backfill checkpoint tracking and unique indexes for idempotent candle writes
- **008_regime_tagging.sql** — daily regime tags table, event calendar, and `resolution` column on straddle_snapshots
- **009_straddle_snapshots_unique.sql** — unique index on (time, symbol, strike, expiry) to enforce snapshot uniqueness in reconstruction

Apply all three with `bun run migrate`. 

**Note on 009:** if your straddle_snapshots table has duplicates from dev testing, dedup them before applying the migration (it will fail on duplicate rows). For a fresh dev database, this is not a concern.

