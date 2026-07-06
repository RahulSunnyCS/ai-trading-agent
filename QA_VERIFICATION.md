# QA Verification Guide — Sprint 1 + Broker Integration

## What Was Built

This document covers the two commits on branch `claude/plan-trading-system-phase-vnbiP`:

| Commit | Scope |
|--------|-------|
| `Sprint 1: data ingestion pipeline foundation` | Infrastructure, DB schema, straddle calculator, VIX feed, simulator, main entry point |
| `Add Fyers broker adapter; remove generic WebSocket` | Fyers-specific feed adapter, instrument registry, live ATM re-subscription wiring |

### Files Added / Changed

```
docker-compose.yml                          NEW  Infrastructure: TimescaleDB + Redis
package.json / bun.lock                     NEW  Bun project + dependencies
tsconfig.json                               NEW  TypeScript config
.env.example                                NEW  All required env vars documented
src/db/migrations/001_initial_schema.sql    NEW  Full DB schema (hypertables + tables)
src/db/client.ts                            NEW  PostgreSQL pool helpers
src/db/migrate.ts                           NEW  Migration runner with retry logic
src/db/schema.ts                            NEW  TypeScript types for every table
src/redis/client.ts                         NEW  Redis client + streamPublish/streamRead
src/ingestion/straddle-calc.ts              NEW  ATM strike calc, 15s snapshots, ROC/accel
src/ingestion/vix-feed.ts                   NEW  VIX poller with NSE public API fallback
src/ingestion/market-data-sim.ts            NEW  Random-walk Nifty simulator for dev
src/ingestion/brokers/types.ts              NEW  BrokerFeed interface + BrokerTick type
src/ingestion/brokers/fyers.ts              NEW  Fyers fyersDataSocket adapter
src/ingestion/brokers/instrument-registry.ts NEW Weekly/monthly symbol builder + expiry helpers
src/types/fyers-api-v3.d.ts                 NEW  TypeScript shim for untyped Fyers SDK
src/index.ts                                NEW  Main entry point (simulate or live)
src/ingestion/nse-websocket.ts              DEL  Removed — superseded by Fyers adapter
```

---

## Prerequisites

```bash
# Required tools
bun --version       # >= 1.0
docker --version    # >= 24
docker compose version  # >= 2.0
```

---

## Section 1 — TypeScript Compilation

**What it checks:** All source files type-check with zero errors.

```bash
cd ai-trading-agent
bun install
bun run --bun tsc --noEmit
```

**Expected:** No output, exit code 0.

**Failure signals:**
- Any `error TS` line → compilation broken, do not proceed to runtime checks.

---

## Section 2 — Infrastructure (Docker)

**What it checks:** PostgreSQL + TimescaleDB and Redis start cleanly and pass health checks.

```bash
docker compose up -d
docker compose ps
```

**Expected output:**

```
NAME               STATUS
trading_postgres   Up X seconds (healthy)
trading_redis      Up X seconds (healthy)
```

Both services must show `(healthy)` — not just `Up`. The healthcheck polls every 5s with 10 retries, so allow up to 60 seconds after first start.

**Spot-check PostgreSQL:**
```bash
docker exec trading_postgres psql -U trading -d trading -c "SELECT version();"
```
Expected: PostgreSQL 16.x line, TimescaleDB extension line.

**Spot-check Redis:**
```bash
docker exec trading_redis redis-cli ping
```
Expected: `PONG`

---

## Section 3 — Database Migration

**What it checks:** Migration runner applies schema to a fresh database.

```bash
cp .env.example .env   # uses default localhost credentials
bun run migrate
```

**Expected output:**
```
[migrate] Connecting to database...
[migrate] Applying v1: Initial schema
[migrate] ✓ v1 applied
[migrate] Done. 1 migration(s) applied.
```

**Verify tables and hypertables exist:**
```bash
docker exec trading_postgres psql -U trading -d trading -c "
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;"
```

Expected tables (10 total):

| Table | Type |
|-------|------|
| `external_signals` | standard |
| `market_ticks` | hypertable |
| `option_ticks` | hypertable |
| `paper_trades` | standard |
| `personality_configs` | standard |
| `retrospection_results` | standard |
| `schema_migrations` | standard |
| `straddle_signals` | standard |
| `straddle_snapshots` | hypertable |

**Verify hypertables:**
```bash
docker exec trading_postgres psql -U trading -d trading -c "
SELECT hypertable_name FROM timescaledb_information.hypertables;"
```
Expected: `market_ticks`, `option_ticks`, `straddle_snapshots`

**Verify continuous aggregate:**
```bash
docker exec trading_postgres psql -U trading -d trading -c "
SELECT view_name FROM timescaledb_information.continuous_aggregates;"
```
Expected: `straddle_1min`

**Verify migration was recorded:**
```bash
docker exec trading_postgres psql -U trading -d trading -c "
SELECT version, description FROM schema_migrations;"
```
Expected: `1 | Initial schema`

**Re-run idempotency check:**
```bash
bun run migrate
```
Expected: `[migrate] All migrations already applied.` — no errors, no duplicate rows.

---

## Section 4 — Simulation Mode (end-to-end pipeline)

**What it checks:** The full pipeline runs without real broker credentials — simulator → price cache → straddle snapshot → TimescaleDB + Redis Streams.

```bash
SIMULATE=true bun run dev
```

**Expected startup sequence:**
```
[main] AI Trading Agent — Data Ingestion (Broker: Fyers)
[main] Mode: SIMULATION
[migrate] All migrations already applied.
[main] Redis ready
[sim] Starting market data simulator — NIFTY @ 24000, VIX 14.5, tick every 1000ms
```

**Every 15 seconds** a snapshot line should appear:
```
[sim] Snapshot — NIFTY spot:24012 ATM:24000 VIX:14.5
```

Allow 30 seconds to run, then Ctrl+C.

**Verify snapshots were persisted:**
```bash
docker exec trading_postgres psql -U trading -d trading -c "
SELECT time, atm_strike, straddle_value, roc, acceleration
FROM straddle_snapshots
ORDER BY time DESC
LIMIT 5;"
```
Expected: rows with non-null `straddle_value`. After 60s of running, `roc` and `acceleration` should also be non-null (they require 2+ snapshots to compute).

**Verify Redis Streams received data:**
```bash
docker exec trading_redis redis-cli XLEN straddle.values
```
Expected: a positive integer matching the number of snapshots taken.

```bash
docker exec trading_redis redis-cli XRANGE straddle.values - + COUNT 1
```
Expected: a Redis stream entry with fields: `underlying`, `atm_strike`, `straddle_value`, `roc`, `vix`, `time`.

---

## Section 5 — Fyers Instrument Registry (logic verification)

**What it checks:** Symbol builder and expiry helpers produce correct Fyers symbol strings.

Run these as one-off Bun scripts:

### 5a. Weekly symbol construction

```bash
bun -e "
import { buildWeeklySymbol } from './src/ingestion/brokers/instrument-registry.ts';
// May 8, 2025 — weekly Thursday expiry
const expiry = new Date(2025, 4, 8, 15, 30, 0);
console.log(buildWeeklySymbol('NIFTY',     expiry, 24000, 'CE')); // NSE:NIFTY255824000CE
console.log(buildWeeklySymbol('NIFTY',     expiry, 24000, 'PE')); // NSE:NIFTY255824000PE
console.log(buildWeeklySymbol('BANKNIFTY', expiry, 52000, 'CE')); // NSE:NIFTYBANK255852000CE
// October expiry — single-letter month code 'O'
const oct = new Date(2025, 9, 2, 15, 30, 0);
console.log(buildWeeklySymbol('NIFTY', oct, 25000, 'CE'));        // NSE:NIFTY25O0225000CE
"
```

### 5b. Monthly vs weekly detection

```bash
bun -e "
import { isMonthlyExpiry, nextThursday } from './src/ingestion/brokers/instrument-registry.ts';
// Last Thursday of May 2025 = May 29
const monthly = new Date(2025, 4, 29, 15, 30, 0);
const weekly  = new Date(2025, 4, 8,  15, 30, 0);
console.log('May 29 is monthly:', isMonthlyExpiry(monthly)); // true
console.log('May 8  is weekly:',  isMonthlyExpiry(weekly));  // false
"
```

### 5c. ATM strike intervals

```bash
bun -e "
import { getAtmStrike } from './src/ingestion/straddle-calc.ts';
console.log(getAtmStrike(24024, 'NIFTY'));     // 24000 (50pt interval)
console.log(getAtmStrike(24026, 'NIFTY'));     // 24050 (rounds up at midpoint)
console.log(getAtmStrike(52060, 'BANKNIFTY')); // 52100 (100pt interval)
console.log(getAtmStrike(79950, 'SENSEX'));    // 80000 (100pt interval)
"
```

### 5d. Reverse symbol parser

```bash
bun -e "
import { parseFyersSymbol } from './src/ingestion/brokers/instrument-registry.ts';
const r = parseFyersSymbol('NSE:NIFTY255824000CE');
console.log(r?.underlying);  // NIFTY
console.log(r?.strike);      // 24000
console.log(r?.optionType);  // CE
console.log(parseFyersSymbol('NSE:NIFTY-INDEX')); // null (index, not option)
console.log(parseFyersSymbol('NSE:INDIAVIX-INDEX')); // null (VIX)
"
```

---

## Section 6 — VIX Feed (network-dependent)

**What it checks:** NSE public endpoint fetch returns a number.

```bash
bun -e "
import { fetchVixFromNse } from './src/ingestion/vix-feed.ts';
const vix = await fetchVixFromNse();
console.log('VIX:', vix);
"
```

**Expected:** A number between 8 and 50. Example: `VIX: 14.2`

**Acceptable failure:** `VIX: null` if NSE rate-limits the request or the endpoint is unreachable outside market hours. This is a fallback path — in production, VIX arrives as a Fyers tick (`NSE:INDIAVIX-INDEX`) and this poller is only a backup.

---

## Section 7 — Clean Teardown

```bash
# Stop the process (Ctrl+C in dev terminal, or:)
docker compose down

# Full reset including data volumes (destructive — use only to re-test migration from scratch)
docker compose down -v
```

After `docker compose down -v`, repeating Sections 2–4 should produce identical results.

---

## Known Limitations at This Stage

| Item | Status | Notes |
|------|--------|-------|
| Live Fyers connection | Not testable without credentials | Set `SIMULATE=true` for all current QA |
| Fyers access token daily auth | Manual step | Automation deferred — tackle before first live market day |
| Personality configs seeding | Not yet built | Sprint 2 — Clockwork + other personalities need DB rows |
| Paper trade execution | Not yet built | Sprint 2 |
| EOD retrospection | Not yet built | Sprint 2 |
| BankNifty / Sensex data | Not wired in simulation | Simulation currently runs NIFTY only (set `SIM_UNDERLYING`) |

---

## Quick Checklist

```
[ ] bun install completes with no errors
[ ] tsc --noEmit passes clean
[ ] docker compose ps shows both services healthy
[ ] bun run migrate reports v1 applied (or already applied on re-run)
[ ] All 9 tables present in DB
[ ] 3 hypertables confirmed
[ ] straddle_1min continuous aggregate confirmed
[ ] SIMULATE=true bun run dev prints snapshot lines every 15s
[ ] straddle_snapshots table has rows after 30s of simulation
[ ] straddle.values Redis stream has entries
[ ] Weekly symbol builder produces correct strings for May, October expiries
[ ] isMonthlyExpiry correctly identifies last Thursday of month
[ ] ATM strike rounds correctly for 50pt (NIFTY) and 100pt (BANKNIFTY) intervals
[ ] parseFyersSymbol returns null for index/VIX symbols
```
