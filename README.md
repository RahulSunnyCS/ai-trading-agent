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
