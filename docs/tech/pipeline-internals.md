# Pipeline Internals — A Detailed Reference

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series. This is
> the deep companion to the higher-level
> [Tick → Trade Pipeline](./tick-to-trade-pipeline.md) walkthrough. Where that
> doc traces the happy path in broad strokes, this one drills into the internals
> of every stage: data structures, algorithms, the concurrency model, ACK
> semantics, and failure handling — all grounded in the source.

## Contents
1. [Topology & Redis stream seams](#1-topology--redis-stream-seams)
2. [Layer 1 — Ingestion](#2-layer-1--ingestion)
3. [Layer 2 — StraddleCalculator internals](#3-layer-2--straddlecalculator-internals)
4. [Layer 3a — Peak detection state machine](#4-layer-3a--peak-detection-state-machine)
5. [Layer 3b — Probability scorer](#5-layer-3b--probability-scorer)
6. [Layer 3c — Personality router](#6-layer-3c--personality-router)
7. [The 5-stage filter, stage by stage](#7-the-5-stage-filter-stage-by-stage)
8. [Layer 4a — Trade execution](#8-layer-4a--trade-execution)
9. [Layer 4b — Position monitor, triggers & management styles](#9-layer-4b--position-monitor-triggers--management-styles)
10. [Layer 4c — EOD retrospection (planned)](#10-layer-4c--eod-retrospection-planned)
11. [Cross-cutting: concurrency & correctness model](#11-cross-cutting-concurrency--correctness-model)
12. [Cross-cutting: failure modes](#12-cross-cutting-failure-modes)
13. [Cross-cutting: the Clock and determinism](#13-cross-cutting-the-clock-and-determinism)

---

## 1. Topology & Redis stream seams

Everything is wired in `src/index.ts`. Three Redis Streams are the seams between
stages, and several components are **independent consumers** of the same stream:

| Stream | Producer | Consumers |
|---|---|---|
| `market.ticks` | broker feed (`feed.onTick` → `xadd`) | StraddleCalculator, VixFeed |
| `straddle.values` | StraddleCalculator | PeakDetectionEngine, PositionMonitor |
| `signals.generated` | PeakDetectionEngine, ScheduledSignalEmitter | PersonalityRouter |

Two different consumption styles are used deliberately:

- **Plain `XREAD`** (StraddleCalculator) — a non-blocking cursor read. The
  calculator is the sole reader of ticks for its purpose; it just needs the
  latest data and its own cursor.
- **Consumer groups via `XREADGROUP`** (PeakDetectionEngine, PersonalityRouter)
  — durable, ACK-based delivery. A message stays *pending* until ACK'd, so a
  crash mid-processing doesn't lose it (it can be reclaimed with `XAUTOCLAIM`).

| Consumer group | Consumer | Stream | Start ID |
|---|---|---|---|
| `peak-detection` | `primary` | `straddle.values` | `$` (new only) |
| `personality-router` | `primary` | `signals.generated` | `$` (new only) |

Both groups are **single-consumer by design**. The router comment
(`personality-router.ts:9`) is explicit: multiple consumers in one group would
*partition* messages (XREADGROUP load-balances across consumers), which would
break the "fan-out to ALL personalities" requirement. Horizontal scaling would
need one group per personality — a Phase 2 concern.

---

## 2. Layer 1 — Ingestion

A `BrokerFeed` (`src/ingestion/brokers/types.ts`) emits `BrokerTick`s. The
simulator and the Fyers adapter both implement it and are interchangeable;
`createBrokerFeed()` picks one from `BROKER` / `SIMULATE`. In `src/index.ts`:

```ts
feed.onTick?.((tick) => {
  void redis.xadd('market.ticks', '*', 'data', JSON.stringify(tick));
});
```

Key properties:
- **Fire-and-forget** (`void`) — ingestion never blocks on Redis or downstream
  work. A tick is one stream entry with a timestamp ID.
- **Connect last** — `feed.connect()` runs *after* all consumers' `start()`
  resolve, so no early ticks are dropped before readers are ready.
- **Token bootstrap (live mode)** — if `BROKER=fyers` and no
  `FYERS_ACCESS_TOKEN` env var, `index.ts` tries `loadStoredToken(pool)` from the
  `broker_tokens` table (written by the dashboard OAuth flow), warning if it's
  expired. (The Fyers token expires daily — a known operational gotcha.)

---

## 3. Layer 2 — StraddleCalculator internals

Source: `src/ingestion/straddle-calc.ts`. Two concurrent activities started by
`start()`: a **poll loop** (consumes ticks) and a **snapshot interval**
(produces straddle snapshots every 15 s). They share an in-memory `priceMap`.

### Poll loop (`pollLoop`)
- Uses **non-blocking** `XREAD COUNT 100` (no `BLOCK`) so the `running` flag is
  checked every iteration → clean shutdown. On an empty read it `sleep(100)`s to
  avoid a tight CPU spin outside market hours.
- Advances `lastId` per entry, extracts the `data` field, `parseTick`s it
  (malformed JSON → warn + skip, never throw), and `processTick` writes
  `priceMap[symbol] = { price, timestamp }`.
- **Never throws**: any error is logged and the loop continues (resilience
  contract).
- Cursor start: `$` in live mode (new messages only); `0` in replay (read from
  the beginning so pre-loop ticks aren't dropped).

### Snapshot compute (`computeAndPublishSnapshot`)
Every `snapshotIntervalMs` (default 15 000):
1. Resolve underlying index symbol (e.g. `NSE:NIFTY50-INDEX`), look up its price
   in `priceMap`. **Skip** if absent.
2. `getAtmStrike(underlying, price)` → ATM strike (never computed inline; NIFTY
   rounds to 50pt). Build CE/PE option symbols via `buildOptionSymbol` +
   `getCurrentExpiry`.
3. Look up CE and PE prices. **Skip** if either leg is missing.
4. `straddleValue = cePrice + pePrice`. Push onto a rolling buffer capped at
   `rocWindowSize` (default 5).
5. `roc = computeRoc(buffer)`, `acceleration = computeAcceleration(buffer)`
   (from `straddle-math.ts`).
6. `XADD` the `StraddleSnapshot` to `straddle.values`; persist to the
   `straddle_snapshots` hypertable.

### Live vs replay split
The live path uses `setInterval(takeSnapshotFireAndForget)` (fire-and-forget,
`void`). The replay path calls `snapshotStep()` which **awaits** the same
compute and returns the stream ID, plus `ticksConsumed(id)` — an **input-side
drain barrier** that resolves once the poll loop's cursor passes a given tick
ID. This guarantees ticks are in the price map *before* a snapshot is computed,
making replay deterministic (it replaced a fragile 10-microtask-yield
heuristic). Live code never calls these.

---

## 4. Layer 3a — Peak detection state machine

Source: `src/signals/peak-detection-engine.ts`. Consumes `straddle.values` via
the `peak-detection` group and maintains **per-underlying** `UnderlyingState`.

### Per-bar processing (`_handleSnapshot`)
1. Parse + validate fields; **skip** malformed messages and placeholder
   snapshots where `straddleValue === 0` (sim warm-up — recording 0 as the open
   reference would produce nonsensical expansion %).
2. Step `ema8` / `ema20` (seeded with the first value → no warm-up gap; alpha =
   `2/(N+1)`).
3. **Lock the open reference**: the first snapshot after **09:15 IST** sets
   `openStraddleValue`. Expansion is always measured from this.
4. Compute `roc = (sv - prevSv)/prevSv` and `acceleration = roc - prevRoc`.
5. Append to bounded history (`MAX_HISTORY = 200`; a session is ~1500 snapshots,
   200 is enough for rolling math while bounding RAM).
6. Update `rocDeclineStreak` (consecutive declines; **any** non-decline resets
   it to 0).

### The four conditions (all must hold simultaneously)
```
expansionMet      = expansionPct >= minExpansionPct        (default 10%)
accelerationMet   = acceleration < accelerationThreshold   (default -0.5)
rocDeclineMet     = rocDeclineStreak >= rocDeclineCandles   (default 3)
confirmationStreak++ while the above three hold; reset to 0 otherwise
allConditionsMet  = the three above AND confirmationStreak >= confirmationCandles (default 2)
```
Each guards a different false positive: ① "is the move big enough to fade?",
② "is momentum *sharply* rolling over, not drifting?", ③ "is the rollover
*sustained*, not one noisy bar?", ④ "has the whole setup *persisted* across
consecutive bars?". Thresholds are env-tunable (`SIGNAL_*`), parsed once at
startup.

### Dedup, scoring, persistence, publish
- **Dedup**: if a signal fired for this underlying within `dedupWindowSecs`
  (default 300 s), skip.
- Compute a **raw, unclamped** exhaustion score from three weighted components
  (expansion / acceleration magnitude / decline streak).
- Fetch supplemental context **fail-soft**: `getMacroContext` errors → all-null
  macro; OI read errors → `null`. Neither crashes the pipeline.
- `scoreProbability(...)` → `adjustedProbability`, `confidenceTier`,
  `adjustmentBreakdown`.
- `INSERT` into `straddle_signals` (fully parameterised) and `XADD` to
  `signals.generated`.

### ACK semantics
In `_consumeLoop`, `XACK` happens **only after** `_handleSnapshot` succeeds. If
it throws, the message stays pending (recoverable via `XAUTOCLAIM`). The
`BLOCK 2000` read keeps stop latency under 2 s.

---

## 5. Layer 3b — Probability scorer

Source: `src/signals/probability-scorer.ts`. A **pure** function (no I/O — all
inputs pre-fetched, so scoring 10 personalities costs zero extra Redis/DB
calls). It layers **9 independent adjustment factors** onto a base probability:

`india_vix, us_vix, sp500, dax, crude_oil, gold, oi_change, time_of_day,
day_of_week`.

- Each factor is individually **magnitude-capped** via `clamp` (e.g. India VIX
  adjustment is bounded to `[-0.10, +0.10]`) so no single factor dominates.
- Factors are additive and independent (no cross-interactions) — a deliberate
  simplicity choice.
- `SCHEDULED` signals are scored at a **fixed 0.60** by policy (they aren't
  exhaustion-based; macro adjustments don't apply).
- The final sum is clamped to a valid probability and mapped to a
  `confidenceTier` (HIGH / MEDIUM / LOW).
- `adjustmentBreakdown` always has all 9 keys (0 when unused) so the stored JSON
  is shape-stable.
- **Caveat carried in code**: scores are *not* empirically calibrated yet —
  treat them as relative rankings, not true probabilities (Brier scores are
  tracked separately).

---

## 6. Layer 3c — Personality router

Source: `src/signals/personality-router.ts`. Consumes `signals.generated` and is
where one signal becomes up-to-10 independent decisions.

### Per-signal handling (`_handleSignal`), in order
1. **Parse** flat stream fields → `IncomingSignal`; malformed → warn, skip (the
   caller still ACKs so it can't permanently block the stream).
2. **VIX staleness tracking**: a signal carrying a real VIX updates
   `_lastVixTimestampMs`.
3. **VIX staleness gate**: if no VIX seen within `VIX_STALE_MS` (default 5 min),
   **block all new opens** and return. (Initialised to `clock.now()` at
   construction so it doesn't false-fire on the first signal.)
4. **Load active personalities** — `phase <= 1 AND is_active`, via a **60 s
   in-memory TTL cache** (the 10-row table changes rarely; this avoids a DB hit
   on every one of ~1 500 signals/day).
5. **Batch daily-state fetch**: `Promise.all(personalities.map(fetchDailyState))`
   — one parallel batch, not N serial round-trips.
6. **Parallel filter fan-out**: `Promise.all(... runPersonalityFilter ...)`.
   Safe because the filter is pure/synchronous. The `IncomingSignal →
   StraddleSignalInput` conversion is done once, not per personality.
7. **Collect passing intents**; log each rejection with its stage + reason.
8. **Serialised opens**: passing personalities open trades **one at a time**
   (a `for…await` loop), *after* all filter results are known.

### Why opens are serial (the key correctness decision)
Parallel opens could let two concurrent INSERTs both observe "0 open positions",
both pass the portfolio risk check, and both commit — breaching the limit.
Serialising the open step makes the check race-free. Filters fan out in
parallel (pure, no shared state); only the DB-mutating step is serialised.

### Trade association
`PaperTradeExecutor.openTrade()` doesn't take `personality_id`/`signal_id`, so
the router does a two-step **INSERT then UPDATE** to associate the row (keeps
the executor focused on its own concern). A failed association is logged, not
thrown — the trade already exists.

---

## 7. The 5-stage filter, stage by stage

Source: `src/signals/personality-filter.ts`. `runPersonalityFilter` is **pure,
synchronous**, and **returns on the first rejection**. `pass:true` ⇒ `stage:6`
("cleared all five"); `pass:false` carries the rejecting stage (1–5) and a
snake_case reason token.

| Stage | Name | Checks | Example rejection reasons |
|---|---|---|---|
| 1 | Hard filters | personality active; signal-type ↔ entry-type compat; IST time window `[ENTRY_START_TIME, ENTRY_CUTOFF_TIME]`; `BLOCKED_DATES` | `PERSONALITY_INACTIVE`, `ENTRY_TYPE_MISMATCH`, `OUTSIDE_TRADING_HOURS`, `BLOCKED_DATE` |
| 2 | State checks | `max_daily_trades`; `max_daily_loss` (vs today's net P&L); `max_open_legs`/2 | `MAX_DAILY_TRADES_REACHED`, `DAILY_LOSS_LIMIT_REACHED`, `MAX_OPEN_POSITIONS_REACHED` |
| 3 | Context | VIX ceiling (`vix_max`) | `VIX_TOO_HIGH` |
| 4 | Signal quality | `adjustedProbability` vs `min_probability` (skipped for `SCHEDULED`) | `PROBABILITY_BELOW_THRESHOLD` |
| 5 | Profit gate (optional) | if `require_profit_gate`, block when today's P&L ≥ `profit_gate_amount` | `PROFIT_GATE_REACHED` |

Important nuances:
- **Stage 3 passes on VIX null**: missing data must never silently disable a
  strategy. The owner opted into a *ceiling*, not a "block when the feed is down"
  rule. Contrast with the router's Stage-4-level staleness *gate* (§6.3) which
  *does* block — that's an account-level safety net, evaluated separately.
- **`nowMs` not `signalTimeMs`** is used for the time-window gate, so a stale
  queued signal can't slip through a window that has since closed.
- **`netPnl` is a NUMERIC-as-string** (see
  [No ORM](./no-orm-raw-sql.md)); stages `parseFloat` it explicitly.
- **Time math is hand-rolled IST** (UTC + 5:30, no DST) to stay dependency-free
  on the hot path.
- `entryType` compatibility: `fixed_time` accepts only `SCHEDULED`;
  `momentum_exhaustion` rejects `SCHEDULED`; `any_signal` accepts all.

### Comparison-integrity guard
`checkComparisonIntegrity()` (same file) enforces the project invariant that
Precision / Adjuster / Reducer `min_probability` values stay within **8
percentage points** (0.08, with a 1e-9 float epsilon). If the spread exceeds it,
the three management styles are no longer entering on comparable signals, so the
comparison is invalid and evolution should pause on the outlier. Only active
`momentum_exhaustion` personalities with a numeric `min_probability` are
considered.

---

## 8. Layer 4a — Trade execution

Source: `src/trading/paper-trade-executor.ts`.

### Short-straddle sign convention
The system **sells** the straddle and collects premium:
```
gross_pnl = (straddle_at_entry − exit_straddle_value) × lots × lot_size
```
Profit when the straddle **falls** (buy it back cheaper); loss when it **rises**.
All money math uses **`decimal.js`**, never JS floats — consistent with the
NUMERIC-as-string decision in the DB layer.

### `openTrade(intent, lotSize?)`
- Default `lotSize = 50` (NIFTY); the straddle is split 50/50 across CE/PE legs
  (a placeholder — real skew is Phase 2).
- `INSERT` into `paper_trades` with `status='open'`,
  `lowest_straddle_value_seen` initialised to entry (seeds the trailing stop).
- Notify Quantiply — wrapped in try/catch and **never re-thrown**: a Quantiply
  outage must not crash the loop or roll back the insert.
- Returns the new trade UUID (the router then associates it; §6.4).

Before this, the router calls `portfolioRiskCheck()` (event-day, VIX age, daily
stop, margin, max legs); a block is logged and the open is skipped.

### `getOpenTrades(db, tradingDate)`
**Always** filters `DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $1` — both to
get the IST calendar day right (sessions are 03:45–10:00 UTC) and to keep the
query off a full-table scan. `todayNetPnl` is returned as `'0'` placeholder; the
trigger engine overwrites it with live-computed P&L before evaluating triggers.

---

## 9. Layer 4b — Position monitor, triggers & management styles

Source: `src/trading/position-monitor.ts`, `trigger-engine.ts`,
`management/{holder,adjuster,reducer}.ts`.

### PositionMonitor
Subscribes to `straddle.values`. Per snapshot it: loads today's open positions,
updates each position's **trailing-stop watermark** (`lowest_straddle_value_seen`),
persists it, evaluates exit triggers, and closes any position whose trigger
fires — dispatching to the `ManagementHandler` matching the personality's
`management_style`. Notable invariants:
- **ACK after write**: the Redis message is ACK'd only after all DB writes
  complete, so a partial failure leaves it recoverable.
- **Config cached at startup** to avoid an N+1 per snapshot; positions with
  `personality_id IS NULL` (pre-M2) default to Holder.
- **Stale-data watchdog** (every 5 s via `clock.tick`): on a stalled feed it
  still evaluates *time-based* exits (EOD, EXIT_WINDOW) off the last known value
  so positions aren't left dangling near close.
- An **in-flight fence** lets `stop()` wait for the current handler to finish,
  preventing half-written state on shutdown.

### Trigger priority (`evaluateTriggers`, a pure function)
Strict order — first match wins:
```
SL > DAILY_LOSS > EOD > EXIT_WINDOW > TSL > TARGET
```
Rationale: hard stop-loss is a loss-limiting emergency (always overrides);
account-level daily loss beats trade-level signals; EOD is the graceful close,
EXIT_WINDOW the hard re-entry boundary; TSL (partial-profit capture on reversal)
beats TARGET (cleanest, lowest-urgency exit). TSL only arms when
`current < entry` (in profit on a short straddle) so it doesn't pre-empt the
hard SL on a losing position. Defaults: `HARD_SL_PCT=0.3`, `TRAILING_SL_PCT=0.15`,
`PROFIT_TARGET_PCT=0.3`, `EOD_EXIT_TIME=15:25`, `MAX_DAILY_LOSS=10000`.

### Three management styles (same `ManagementHandler` contract)
- **Holder** (`hold`) — adds nothing; delegates entirely to `evaluateTriggers`.
  Hold until a trigger fires.
- **Adjuster** (`roll`) — when spot moves > `roll_trigger_points` from entry,
  **close + reopen** at the new ATM inside a **single PostgreSQL transaction**
  (a crash between the two writes can't leave a half-rolled position). Respects
  `max_open_legs`/2; at the cap it behaves like Holder. All non-ROLL exits
  delegate to `evaluateTriggers`.
- **Reducer** (`cut_reenter`) — on an adverse move ≥ `cut_trigger_points`, CUT
  immediately, then mark the personality **re-entry eligible** for the rest of
  the day so the next signal passes a *lower* threshold
  (`reentry_min_probability`, default 0.65 vs 0.70). Eligibility lives in a
  module-level `Map` keyed by personality UUID, naturally reset by a date check
  (single-process assumption). Other exits delegate to `evaluateTriggers`.

---

## 10. Layer 4c — EOD retrospection (planned)

After market close, the (not-yet-wired) **BullMQ** job reads the day's
`paper_trades` + `straddle_snapshots`, computes per-personality metrics
(Beat-Clockwork delta, signal calibration, management effectiveness), tags them
by market regime, and queues rule-based parameter-evolution suggestions behind
the `EVOLUTION_REQUIRE_APPROVAL` gate — honouring Clockwork's `is_frozen`
invariant (`FROZEN_VIOLATION`, never silent skip). See the
[BullMQ deep dive](../tech-stack.md#deep-dive-bullmq--the-eod-retrospection-job)
and [Redis Streams vs BullMQ](./redis-streams-vs-bullmq.md).

---

## 11. Cross-cutting: concurrency & correctness model

| Concern | Mechanism |
|---|---|
| Decouple producers/consumers | Redis Streams as seams; consumers track own cursors/groups |
| Parallel where safe | pure filter fan-out + batch daily-state fetch under `Promise.all` |
| Serial where it matters | trade opens iterate sequentially → race-free portfolio checks |
| Atomic multi-write | Adjuster close+reopen wrapped in `withTransaction` |
| At-least-once delivery | consumer groups + **ACK after successful processing**; unACKed → `XAUTOCLAIM` |
| Idempotent ingestion | `INSERT ... ON CONFLICT DO NOTHING` in the historical backfill writer |
| Clean shutdown | `running`/`_stopped` flags checked each loop; short `BLOCK`/sleep windows; in-flight fences; barrier drains |

## 12. Cross-cutting: failure modes

| Failure | Behaviour | Where |
|---|---|---|
| Malformed tick / snapshot / signal | Warn + skip; never throw | parseTick, `_handleSnapshot`, `_parseSignal` |
| Redis read error in a loop | Log, back off (100–500 ms), continue | all consumer loops |
| Handler throws mid-message | No ACK → message stays pending/recoverable | peak-detection, router |
| Quantiply down | Caught, logged, non-fatal; DB row intact | `openTrade` |
| Macro/OI fetch error | Fall back to null → 0 adjustment | `_handleSnapshot` |
| VIX feed stale | Router blocks new opens after `VIX_STALE_MS` | router gate |
| VIX value null on a signal | Filter Stage 3 **passes** (ceiling, not kill-switch) | `runPersonalityFilter` |
| Feed stalls near EOD | Watchdog still fires time-based exits | PositionMonitor |
| Crash between roll writes | Transaction rolls back; original position preserved | Adjuster |

## 13. Cross-cutting: the Clock and determinism

Every time-sensitive component takes an injected `Clock` (`src/utils/clock.ts`).
`RealClock` in live mode; `VirtualClock` in simulation and tests. In sim,
`index.ts` advances the virtual clock on a `setInterval`
(`SIM_TICK_INTERVAL_MS`). Filters and triggers take `nowMs`/`clock` as a
parameter rather than calling `Date.now()`, so unit tests inject a fixed time
and replay is deterministic. The StraddleCalculator's `snapshotStep()` +
`ticksConsumed()` barriers exist solely to make replay ordering exact under real
Redis latency.

---

## Related code (index)
- Wiring: `src/index.ts`
- Ingestion: `src/ingestion/brokers/`, `straddle-calc.ts`, `straddle-math.ts`, `vix-feed.ts`
- Signals: `src/signals/peak-detection-engine.ts`, `probability-scorer.ts`, `personality-router.ts`, `personality-filter.ts`, `scheduled-signal-emitter.ts`
- Execution: `src/trading/paper-trade-executor.ts`, `position-monitor.ts`, `trigger-engine.ts`, `portfolio-risk.ts`, `management/`
- Time: `src/utils/clock.ts`; Money: `src/utils/pnl.ts` (`decimal.js`)
