# Manual QA Checklist — M0 through M3

This checklist is for a human tester to manually verify every significant feature delivered across Milestones 0 through 3. Work through each section top-to-bottom. Mark each item `[x]` when confirmed or `[~]` if partially working (with a note).

---

## Before You Start

```bash
# 1. Start infrastructure
docker compose up -d
docker compose ps          # both must show (healthy)

# 2. Install dependencies and apply migrations
bun install
bun run migrate

# 3. Verify TypeScript is clean
bun run --bun tsc --noEmit  # must produce zero output

# 4. Verify lint passes
bun run lint
```

All four commands must pass before proceeding.

---

## M0 — Scaffolding & Infrastructure

### M0-1: Docker Infrastructure

```bash
docker compose ps
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Both services show `(healthy)` | `trading_postgres Up (healthy)` and `trading_redis Up (healthy)` |
| [ ] | PostgreSQL is PostgreSQL 16 | `docker exec trading_postgres psql -U trading -d trading -c "SELECT version();"` shows `PostgreSQL 16` |
| [ ] | TimescaleDB extension loaded | Same query output includes `TimescaleDB` |
| [ ] | Redis responds to ping | `docker exec trading_redis redis-cli ping` → `PONG` |

### M0-2: Database Migrations

```bash
bun run migrate
```

| # | Check | Command / Expected |
|---|-------|-------------------|
| [ ] | All migrations apply | Output ends with `Migration complete` |
| [ ] | Migration is idempotent | Run `bun run migrate` a second time → `All migrations already applied` (no error, no duplicate rows) |
| [ ] | All expected tables exist | `docker exec trading_postgres psql -U trading -d trading -c "\dt"` — see table list below |
| [ ] | Hypertables created | `SELECT hypertable_name FROM timescaledb_information.hypertables;` → `market_ticks`, `straddle_snapshots`, `option_ticks` |
| [ ] | Continuous aggregate exists | `SELECT view_name FROM timescaledb_information.continuous_aggregates;` → `straddle_1min` |
| [ ] | Schema migrations recorded | `SELECT version, applied_at FROM schema_migrations ORDER BY version;` — all 9 rows present |

**Expected tables:** `market_ticks`, `straddle_snapshots`, `option_ticks`, `paper_trades`, `personality_configs`, `personality_audit_log`, `retrospection_results`, `external_signals`, `schema_migrations`, `backfill_checkpoint`, `replay_runs`, and supporting tables.

### M0-3: Redis Streams

```bash
SIMULATE=true bun run dev &   # start in background
sleep 30
docker exec trading_redis redis-cli XLEN market.ticks
docker exec trading_redis redis-cli XLEN straddle.values
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | `market.ticks` stream receives data | `XLEN market.ticks` > 0 after 30s |
| [ ] | `straddle.values` stream receives data | `XLEN straddle.values` > 0 |
| [ ] | Stream entries have correct fields | `XRANGE straddle.values - + COUNT 1` shows `underlying`, `atm_strike`, `straddle_value`, `roc`, `vix`, `time` fields |

### M0-4: Simulation Mode End-to-End

```bash
SIMULATE=true bun run dev
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | App starts without errors | No stack traces in the first 5 seconds |
| [ ] | Mode is SIMULATION | Log line `Mode: SIMULATION` |
| [ ] | Straddle snapshots print every ~15s | Lines like `[straddle] ATM: 24000, …` appear at 15s cadence |
| [ ] | Snapshots are written to DB | After 60s: `SELECT count(*) FROM straddle_snapshots;` > 0 |
| [ ] | `roc` and `acceleration` populate | After 60s+ (needs ≥2 snapshots): `SELECT roc, acceleration FROM straddle_snapshots ORDER BY time DESC LIMIT 3;` — `roc` is non-null |
| [ ] | Ctrl+C shuts down cleanly | No "process exited with code 1" errors |

### M0-5: Instrument Registry

```bash
bun -e "
import { buildWeeklySymbol } from './src/ingestion/brokers/instrument-registry.ts';
const expiry = new Date(2025, 4, 8, 15, 30, 0);
console.log(buildWeeklySymbol('NIFTY', expiry, 24000, 'CE'));
const oct = new Date(2025, 9, 2, 15, 30, 0);
console.log(buildWeeklySymbol('NIFTY', oct, 25000, 'CE'));
"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | May symbol correct | `NSE:NIFTY255824000CE` |
| [ ] | October uses `O` month code | `NSE:NIFTY25O0225000CE` |
| [ ] | NIFTY ATM rounds to 50pt | `getAtmStrike(24024, 'NIFTY')` → `24000`; `getAtmStrike(24026, 'NIFTY')` → `24050` |
| [ ] | BANKNIFTY ATM rounds to 100pt | `getAtmStrike(52060, 'BANKNIFTY')` → `52100` |
| [ ] | Sensex ATM rounds to 100pt | `getAtmStrike(79950, 'SENSEX')` → `80000` |
| [ ] | Index symbols return null from parser | `parseFyersSymbol('NSE:NIFTY-INDEX')` → `null` |

---

## M0.5 — Testing & CI Foundation

### M0.5-1: Unit Test Suite

```bash
bun run test:unit
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | All unit tests pass | Exit code 0, no failing tests |
| [ ] | Clock tests run | `utils/__tests__/clock.test.ts` — 21 tests |
| [ ] | Property tests on P&L math | `pnl.property.test.ts` — checks short-position sign convention |
| [ ] | Property tests on triggers | `triggers.property.test.ts` — 33 tests on SL/TSL/target thresholds |
| [ ] | Property tests on ATM rounding | `atm-strike.property.test.ts` — 7 tests |

### M0.5-2: Integration Test Suite

```bash
# Requires Docker services running
bun run test:integration
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Integration tests skip gracefully if DB is down | Setting `DATABASE_URL` to garbage produces a skip, not a crash |
| [ ] | Smoke test passes (when DB is up) | `src/test/integration/smoke.test.ts` — 5 tests |
| [ ] | Migration idempotency confirmed by test | `migrations.integration.test.ts` passes |
| [ ] | API routes integration test passes | `api-routes.integration.test.ts` — 18 tests |

### M0.5-3: Linting & Formatting

```bash
bun run lint
bun run typecheck
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Biome lint passes | Zero errors reported |
| [ ] | TypeScript strict mode passes | `tsc --noEmit` produces zero output |
| [ ] | Pre-commit hook installed | `.lefthook.yml` or `lefthook` config exists; `git commit` runs checks |

---

## M1 — Live Paper-Trading + Dashboard

### M1-1: All 10 Personalities Seeded

```bash
curl http://localhost:3000/personalities?include_inactive=true | jq 'length'
curl http://localhost:3000/personalities | jq 'length'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | 10 total personalities | `include_inactive=true` → 10 |
| [ ] | 9 active personalities | Default (no flag) → 9 |
| [ ] | Levelhead is inactive | `jq '.[] \| select(.name=="Levelhead") \| .isActive'` → `false` |
| [ ] | Clockwork is frozen | `jq '.[] \| select(.name=="Clockwork") \| .isFrozen'` → `true` |

### M1-2: Entry Engine

Start in simulation mode and check the logs:

```bash
SIMULATE=true bun run dev
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | No entries before 09:15 IST | Entries logged only after `09:15` appears in the timestamp |
| [ ] | No entries after 09:45 IST | After 09:45 in logs, no new `[entry]` lines |
| [ ] | VIX gate respected | If VIX > 30 in sim (force it via env), entries are blocked |
| [ ] | One-open limit enforced | If a trade is open, a second entry is not taken by the same personality |

### M1-3: Trigger/Exit Engine

With an open paper trade, verify exits work:

| # | Check | Trigger condition |
|---|-------|------------------|
| [ ] | Hard stop-loss exits at 30% loss | Straddle value ≥ entry × 1.30 |
| [ ] | Trailing stop-loss activates | After straddle drops 15% from peak, then reverses 15% — exit triggered |
| [ ] | Target profit exit at 30% gain | Straddle value ≤ entry × 0.70 |
| [ ] | EOD square-off at 15:25 IST | Any open trade closes at 15:25 regardless of P&L |

```bash
# Check closed trades after running through a simulated session
curl http://localhost:3000/trades | jq '.data | map(select(.status=="closed")) | length'
```

Expected: > 0 trades with `exit_reason` set to one of: `stop_loss`, `target`, `eod_squareoff`, `trailing_stop`.

### M1-4: Paper Trade API

```bash
# Get all trades
curl http://localhost:3000/trades | jq '.data[0]'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | GET /trades returns array | Status 200, `data` is an array |
| [ ] | Each trade has required fields | `id`, `entry_time`, `status`, `straddle_at_entry`, `lots`, `lot_size` present |
| [ ] | Closed trades have `net_pnl` | `exit_time` and `net_pnl` non-null for closed trades |
| [ ] | `exit_reason` is meaningful | One of: `stop_loss`, `target`, `eod_squareoff`, `trailing_stop` |

### M1-5: REST API & WebSocket

```bash
# REST health
curl http://localhost:3000/health

# WebSocket (requires wscat: npm install -g wscat)
wscat -c ws://localhost:3000/ws/ticks
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | GET /health returns 200 | `{"status":"ok"}` or similar |
| [ ] | WebSocket connects | `wscat` shows `Connected` |
| [ ] | Tick messages arrive on WS | JSON messages with `ltp`, `symbol`, `timestamp` every ~1s |
| [ ] | WS disconnects cleanly | Ctrl+C in wscat → no server error |

### M1-6: React Dashboard — Live Tab

```bash
# Start Vite frontend separately
cd ai-trading-agent
bun run dev &   # starts Fastify on 3000 (sim mode)
# Open http://localhost:5173 in browser
```

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | App loads without white screen | Dashboard renders with tab bar |
| [ ] | Default tab is "Live" | Live tab content visible on load |
| [ ] | NIFTY LTP ticks update | Number in "NIFTY Index" card increments/changes over time |
| [ ] | WS status pill is visible | Pill reads "Connected" (green) or "Connecting" / "Disconnected" |
| [ ] | Straddle section shows value or notice | Either a numeric value or "Straddle feed not yet connected" |
| [ ] | Tick chart renders | Chart area draws lines as ticks arrive |

### M1-7: React Dashboard — Trades Tab

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Click "Trades" tab | Table heading "Paper Trades" visible |
| [ ] | Rows appear as trades are taken | Each sim trade appears in the table |
| [ ] | Open badge is green/yellow | Colored "Open" badge per row |
| [ ] | Closed badge renders correctly | "Closed" badge with exit reason |
| [ ] | IST timestamps displayed | Entry time shows e.g. `09:30:00` (not UTC `04:00:00`) |
| [ ] | Net P&L colored correctly | Positive = green, negative = red |
| [ ] | Null P&L shows `—` | Open trades show dash, not NaN |

### M1-8: React Dashboard — P&L Tab

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Click "P&L" tab | "P&L Summary" heading visible |
| [ ] | Realized P&L is the correct sum | Check against DB: `SELECT SUM(net_pnl::numeric) FROM paper_trades WHERE status='closed';` |
| [ ] | Win rate excludes open trades | Win rate denominator = closed trades only |
| [ ] | Open positions count correct | Matches `SELECT count(*) FROM paper_trades WHERE status='open';` |
| [ ] | Empty state shows message | On a fresh DB, shows "No closed trades yet" |
| [ ] | Cumulative chart renders | Line chart appears once ≥1 closed trade exists |

---

## M2 — Momentum Signals + Multi-Personality

### M2-1: Personality CRUD API

```bash
# GET all personalities
curl http://localhost:3000/personalities | jq '.[0] | keys'

# GET single personality
PERSONALITY_ID=$(curl -s http://localhost:3000/personalities | jq -r '.[0].id')
curl http://localhost:3000/personalities/$PERSONALITY_ID | jq '.'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | GET /personalities returns 9 active | Array length 9, all `isActive:true` |
| [ ] | GET with `include_inactive=true` returns 10 | All 10 personalities including Levelhead |
| [ ] | GET /:id returns 404 for unknown UUID | `curl .../personalities/00000000-0000-0000-0000-000000000000` → 404 with `"error":"NOT_FOUND"` |
| [ ] | Each personality has `params` object | `min_probability`, `max_daily_trades`, `management_style`, etc. |

### M2-2: Clockwork Immutability (FROZEN_VIOLATION)

```bash
CLOCKWORK_ID=$(curl -s "http://localhost:3000/personalities?include_inactive=true" | jq -r '.[] | select(.isFrozen==true) | .id')
curl -X PUT http://localhost:3000/personalities/$CLOCKWORK_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"max_daily_trades":2}}'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | PUT to Clockwork returns 403 | HTTP status code 403 |
| [ ] | Error code is FROZEN_VIOLATION | `{"error":"FROZEN_VIOLATION","message":"...immutable..."}` |
| [ ] | Clockwork params unchanged | GET /personalities/$CLOCKWORK_ID → params identical to before |

### M2-3: Comparison Integrity (8pp Rule)

```bash
# Get a momentum_exhaustion personality
MUTABLE_ID=$(curl -s http://localhost:3000/personalities | jq -r '[.[] | select(.entryType=="momentum_exhaustion" and .isFrozen==false)][0].id')

# Try to push min_probability more than 8pp away from others (e.g., 0.85 when others are at 0.70)
curl -X PUT http://localhost:3000/personalities/$MUTABLE_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"min_probability":0.90}}'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Wide drift returns 409 | HTTP status 409 if the change would put spread > 8pp |
| [ ] | Error code correct | `{"error":"COMPARISON_INTEGRITY_VIOLATION"}` |
| [ ] | Small change accepted | Changing by 0.01 within bounds returns 200 |

### M2-4: Param Range Validation

```bash
# Above ceiling (0.95 > max 0.90)
curl -X PUT http://localhost:3000/personalities/$MUTABLE_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"min_probability":0.95}}'
# Expected: 400

# Below floor (0.30 < min 0.40)
curl -X PUT http://localhost:3000/personalities/$MUTABLE_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"min_probability":0.30}}'
# Expected: 400
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Value above ceiling → 400 | HTTP 400 |
| [ ] | Value below floor → 400 | HTTP 400 |
| [ ] | Boundary value accepted | `0.90` (ceiling) or `0.40` (floor) returns 200 |

### M2-5: Audit Log Written on Param Change

```bash
# Make a valid change
curl -X PUT http://localhost:3000/personalities/$MUTABLE_ID \
  -H 'Content-Type: application/json' \
  -d '{"params":{"min_probability":0.71},"reason":"manual_qa_test"}'

# Verify audit log (direct DB)
docker exec trading_postgres psql -U trading -d trading -c \
  "SELECT personality_id, changed_fields, reason, created_at FROM personality_audit_log ORDER BY created_at DESC LIMIT 3;"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | PUT returns 200 with updated params | `params.min_probability` in response = `0.71` |
| [ ] | Audit log row created | At least one row with `reason='manual_qa_test'` |
| [ ] | `changed_fields` records what changed | Contains `min_probability` key |

### M2-6: Personality Performance API

```bash
curl http://localhost:3000/personalities/$MUTABLE_ID/performance | jq '.'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Returns 200 with stats | `personalityId`, `totalTrades`, `winRate`, `openTrades` all present |
| [ ] | `winRate` in [0, 1] | Never negative, never > 1 |
| [ ] | NULL-row isolation | `totalTrades` is 0 for a personality with no linked trades (not counting pre-M2 NULL rows) |
| [ ] | Personality scoping correct | Two different personality IDs return different `personalityId` in response |

### M2-7: Signal Generation

Run in sim mode and watch for signal events:

```bash
SIMULATE=true bun run dev 2>&1 | grep -E "\[signal\]|\[peak\]|\[prob\]|\[filter\]"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Peak detection fires | Log lines showing peak detected when momentum conditions met |
| [ ] | Probability score logged | Score value between 0.0 and 1.0 |
| [ ] | Fallback scheduled signal at 10:00 IST | After 10:00 IST in logs, `SCHEDULED` signal entry if no MOMENTUM signal earlier |
| [ ] | Signals fan out to all personalities | Multiple `[filter]` lines (one per personality) for each signal |

### M2-8: Management Styles Observed

After several trades close, verify management style is reflected:

```bash
docker exec trading_postgres psql -U trading -d trading -c "
SELECT p.name, p.management_style, t.exit_reason, count(*) 
FROM paper_trades t 
JOIN personality_configs p ON t.personality_id = p.id
WHERE t.status = 'closed'
GROUP BY p.name, p.management_style, t.exit_reason;"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Holder trades exit at EOD or SL | Holder personality's closed trades show `eod_squareoff` or `stop_loss` (not roll exits) |
| [ ] | Adjuster shows roll events | Adjuster personality logs `[roll]` events in console |
| [ ] | Reducer shows cut/re-entry | Reducer personality logs `[cut]` and `[reenter]` events |

### M2-9: Portfolio Risk Rules

| # | Check | Verification |
|---|-------|-------------|
| [ ] | Max 4 open legs enforced | Trigger 5 simultaneous entries; 5th is blocked and logged |
| [ ] | Daily stop respected | After daily loss cap hit, further entries blocked for that day |
| [ ] | Event-day gate (RBI/Budget) | Set `today` to a known blocked date in test; verify entries blocked |
| [ ] | VIX staleness gate | If VIX hasn't updated in >30 min, new entries blocked |

---

## M3 — Historical Data, Replay & Backtesting

### M3-1: Historical Backfill (Fyers)

> Requires valid `FYERS_ACCESS_TOKEN` in `.env`. Skip to M3-2 if running credentials-free.

```bash
# Trigger backfill via API (adjust dates to a recent past week)
curl -X POST http://localhost:3000/backfill \
  -H 'Content-Type: application/json' \
  -d '{"from":"2026-05-01","to":"2026-05-07","underlying":"NIFTY"}'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Backfill job starts | HTTP 202 Accepted |
| [ ] | Straddle snapshots appear in DB | `SELECT count(*) FROM straddle_snapshots WHERE time > '2026-05-01';` increases |
| [ ] | Backfill is resumable | Stop mid-way (Ctrl+C), restart → picks up from checkpoint, no duplicates |
| [ ] | Idempotent on re-run | Run same backfill twice → same row count (unique index prevents duplicates) |
| [ ] | Holidays/gaps marked | Days with no NSE data show gap markers, not missing entries |

### M3-2: Replay Harness (Simulation Mode)

```bash
# Run a deterministic replay against already-backfilled data (or fixture data)
bun run replay -- --from 2026-05-01 --to 2026-05-03 --underlying NIFTY --dry-run
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | Replay completes without error | Exit code 0 |
| [ ] | Events processed in order | Log lines show monotonically increasing timestamps |
| [ ] | VirtualClock drives time | `[clock]` lines show simulated IST time advancing (not wall time) |
| [ ] | Replay is deterministic | Run twice with same inputs → identical trade log (same entries, exits, P&L) |

### M3-3: Regime Tagging

```bash
# Check regime tags on straddle snapshots (after replay or live data)
docker exec trading_postgres psql -U trading -d trading -c "
SELECT market_regime, count(*) 
FROM straddle_snapshots 
WHERE market_regime IS NOT NULL 
GROUP BY market_regime;"
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | All four regime tags exist | `RANGING`, `TRENDING_STRONG`, `VOLATILE_REVERTING`, `EVENT_DAY` all appear |
| [ ] | No look-ahead contamination | Regime determined using only data up to 14:30 IST cutoff |
| [ ] | Regime tag on every replay row | After replay: `SELECT count(*) FROM straddle_snapshots WHERE market_regime IS NULL AND time < NOW();` → 0 |
| [ ] | Regime API returns data | `curl http://localhost:3000/regimes` → 200 with regime-tagged data |

### M3-4: Regime API Endpoint

```bash
curl http://localhost:3000/regimes | jq '.'
curl "http://localhost:3000/regimes?date=2026-05-01" | jq '.'
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | GET /regimes returns 200 | Array of days with regime tag |
| [ ] | Each entry has `date` and `regime` | Fields present and typed correctly |
| [ ] | Date filter works | `?date=2026-05-01` returns only that day's regime |

### M3-5: Dashboard — Backfill Tab

Open `http://localhost:5173` → click "Backfill" tab:

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Backfill tab is visible and clickable | Tab renders |
| [ ] | Date range picker present | From/To date inputs visible |
| [ ] | Submit triggers API call | Network tab shows POST to `/backfill` on form submit |
| [ ] | Progress or status shown | Status updates as backfill runs |

### M3-6: Dashboard — Replay Tab

Click "Replay" tab:

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Replay tab is visible | Tab renders |
| [ ] | Date range inputs visible | From/To fields present |
| [ ] | Replay starts on submit | POST to `/replay` API triggered |
| [ ] | Replay results show on completion | Personality P&L comparison visible after replay |

### M3-7: Dashboard — Regimes Tab

Click "Regimes" tab:

| # | Check | Expected in Browser |
|---|-------|---------------------|
| [ ] | Regimes tab is visible | Tab renders |
| [ ] | Regime distribution chart renders | Chart or table with `RANGING/TRENDING_STRONG/VOLATILE_REVERTING/EVENT_DAY` |
| [ ] | Historical data needed | Shows empty state gracefully if no backfill data available |

---

## Cross-Milestone Checks

### Error Handling

| # | Check | How to Verify |
|---|-------|--------------|
| [ ] | 500 errors surface in UI | Kill the backend while Trades tab is open → error alert appears, no white screen |
| [ ] | Offline backend shows error states | Disable Docker, open dashboard → all tabs show error alerts, not blank/zeroed data |
| [ ] | WebSocket disconnection handled | Stop Fastify → WS pill transitions to "Disconnected", no console errors |

### Data Integrity

| # | Check | How to Verify |
|---|-------|--------------|
| [ ] | Clockwork is never modified | After a full sim session: `SELECT params FROM personality_configs WHERE is_frozen=TRUE;` — unchanged from seed |
| [ ] | Comparison integrity maintained | Precision/Adjuster/Reducer `min_probability` differ by ≤ 8pp at all times |
| [ ] | No NaN in P&L calculations | `SELECT * FROM paper_trades WHERE net_pnl = 'NaN';` → 0 rows |
| [ ] | Decimal precision correct | All `net_pnl` values in DB have exactly 2 decimal places |

### Teardown & Reset

```bash
# Clean shutdown
docker compose down

# Full reset (destroys all data — use to re-run QA from scratch)
docker compose down -v
bun run migrate   # re-apply schema after volume destruction
```

| # | Check | Expected |
|---|-------|----------|
| [ ] | `down` stops services | `docker compose ps` shows no running containers |
| [ ] | `down -v` destroys data | After `down -v` then `docker compose up -d` + `migrate`, DB is empty again |
| [ ] | Re-running QA from scratch gives identical results | All checks above pass on a clean slate |

---

## Quick Summary Checklist

Copy this block into a ticket or Notion page to track completion:

```
M0 — Infrastructure
[ ] Docker services healthy (TimescaleDB + Redis)
[ ] All migrations applied and idempotent
[ ] 3 hypertables + straddle_1min aggregate confirmed
[ ] Redis Streams receive data in simulation mode
[ ] Instrument registry symbol builder correct for May, Oct expiries

M0.5 — Testing & CI
[ ] Unit tests pass (bun run test:unit)
[ ] Integration tests pass (bun run test:integration, needs Docker)
[ ] Lint and typecheck clean
[ ] Pre-commit hooks installed (lefthook)

M1 — Paper Trading + Dashboard
[ ] 10 personalities seeded (9 active, 1 inactive Levelhead, Clockwork frozen)
[ ] Entry engine respects 09:15–09:45 window
[ ] Trigger engine fires SL, TSL, target, EOD exits correctly
[ ] GET /trades returns correct shape including IST timestamps
[ ] Dashboard Live tab: LTP ticks, WS pill, straddle section
[ ] Dashboard Trades tab: IST times, colored P&L, em-dash for open trades
[ ] Dashboard P&L tab: correct sum, win rate excludes open trades, cumulative chart

M2 — Momentum Signals + Multi-Personality
[ ] GET /personalities returns 9 active; include_inactive=true returns 10
[ ] PUT Clockwork → 403 FROZEN_VIOLATION
[ ] PUT with >8pp drift → 409 COMPARISON_INTEGRITY_VIOLATION
[ ] PUT with out-of-range param → 400
[ ] PUT success → audit log row written
[ ] GET /:id/performance → scoped stats, no NULL-row leakage
[ ] Peak detection signals fire in logs
[ ] Scheduled fallback signal at 10:00 IST
[ ] Holder/Adjuster/Reducer management styles observed in exits

M3 — Historical Data, Replay & Backtesting
[ ] Backfill job triggered via API (requires Fyers token)
[ ] Backfill is idempotent and resumable
[ ] Replay runs deterministically (same output on two runs)
[ ] All 4 regime tags assigned to historical data
[ ] GET /regimes returns regime-tagged days
[ ] Dashboard Backfill tab: date picker, triggers API
[ ] Dashboard Replay tab: runs replay, shows results
[ ] Dashboard Regimes tab: displays regime distribution
```
