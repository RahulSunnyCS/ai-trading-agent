# The Tick → Trade Pipeline (End to End)

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series.

This walks a single market tick from the moment it arrives all the way to a
paper trade being opened (and later closed), through the system's four layers.
Everything is wired together in `src/index.ts`.

```
Fyers / Simulator
      │  BrokerTick
      ▼
[market.ticks] ──► StraddleCalculator ──► [straddle.values] ──► PeakDetectionEngine
                       │                          │                     │
                   VixFeed                  PositionMonitor       [signals.generated]
                  (also reads                (exits open trades)         │
                   market.ticks)                                  PersonalityRouter
                                                                         │ fan-out ×10
                                                                  runPersonalityFilter (5 stages)
                                                                         │ passing personalities
                                                                  PaperTradeExecutor.openTrade()
                                                                         │
                                                                   PostgreSQL paper_trades
                                                                         │ (end of day)
                                                                   BullMQ EOD retrospection
```

Two Redis Streams are the seams between stages: `market.ticks`,
`straddle.values`, and `signals.generated` (constants in
`src/redis/client.ts`).

---

## Layer 1 — Data Ingestion: tick → `market.ticks`

A `BrokerFeed` produces ticks. In simulation mode it's the random-walk
simulator; in live mode it's the Fyers WebSocket adapter — both implement the
same `BrokerFeed` interface (`src/ingestion/brokers/types.ts`) and are
interchangeable. `createBrokerFeed()` picks the adapter from the `BROKER` /
`SIMULATE` env vars.

In `src/index.ts`, every tick is serialised and appended to the `market.ticks`
stream:

```ts
feed.onTick?.((tick) => {
  void redis.xadd('market.ticks', '*', 'data', JSON.stringify(tick));
});
```

This is fire-and-forget by design — ingestion never blocks on downstream work.
The tick is now a durable entry in the log with a timestamp ID. The feed is
connected **after** all consumers start, so no early ticks are dropped.

## Layer 2 — Event Processing: fan-out from `market.ticks`

Two independent consumers read `market.ticks`:

- **StraddleCalculator** (`src/ingestion/straddle-calc.ts`) — keeps an in-memory
  price map of option legs. It uses a **non-blocking** `XREAD` poll loop (no
  `BLOCK`) so the `running` flag is checked every iteration and shutdown is
  clean; a small sleep between empty polls avoids a CPU spin outside market
  hours.
- **VixFeed** (`src/ingestion/vix-feed.ts`) — picks the `NSE:INDIAVIX-INDEX`
  tick out of the same stream, with the NSE public API as a polling fallback.

This is the fan-out Redis Streams gives you: one tick, multiple readers, each
tracking its own position. (See
[Redis Streams vs BullMQ](./redis-streams-vs-bullmq.md).)

## Layer 3 — Signal Generation

### 3a. Straddle snapshot → `straddle.values`
Every `snapshotIntervalMs` (default **15 s**), the calculator computes the
current ATM straddle for the underlying:
- ATM strike via `getAtmStrike()` (NIFTY rounds to 50pt — never computed
  inline);
- option symbols via `buildOptionSymbol()` / `getCurrentExpiry()`;
- `straddleValue = cePrice + pePrice`;
- `roc` (rate of change) and `acceleration` (second derivative of ROC) from a
  rolling buffer (`computeRoc` / `computeAcceleration` in `straddle-math.ts`).

The resulting `StraddleSnapshot` is published to `straddle.values` **and**
persisted to the `straddle_snapshots` hypertable.

### 3b. Peak detection → `signals.generated`
The **PeakDetectionEngine** (`src/signals/peak-detection-engine.ts`) reads
`straddle.values` and fires a `MOMENTUM_EXHAUSTION` signal only when **four
conditions hold simultaneously**:
1. `expansionPct >= minExpansionPct` (default 10%) — straddle expanded enough
   from the 9:15 AM open to be worth fading;
2. `acceleration < accelerationThreshold` (default −0.5) — ROC is decelerating
   sharply;
3. ROC has declined for `>= rocDeclineCandles` (default 3) consecutive
   snapshots — sustained, not a single outlier;
4. `>= confirmationCandles` (default 2) bars where all three held — filters out
   a single noisy bar.

A 5-minute dedup window prevents repeat signals per underlying. The signal is
probability-scored (`probability-scorer.ts`, adjusted for VIX, OI change, time
of day, macro context), written to the DB, and `XADD`'d to `signals.generated`.
A separate `scheduled-signal-emitter.ts` produces time-based `SCHEDULED`
fallback entries.

### 3c. Fan-out to 10 personalities — `PersonalityRouter`
The **PersonalityRouter** (`src/signals/personality-router.ts`) consumes
`signals.generated` (consumer group `personality-router` / `primary`) and
broadcasts each signal to **all active personalities in parallel**. For each it
runs `runPersonalityFilter()` (`src/signals/personality-filter.ts`) — a **pure,
synchronous** 5-stage chain that returns on the first rejection:

1. **Hard filters** — personality active? within entry time window? market-day
   checks? (rejection `stage 1`)
2. **State checks** — max daily trades, daily loss limit, max open positions
   (`stage 2`)
3. **Context checks** — VIX ceiling; if VIX data is null it does **not** block
   (`stage 3`)
4. **Signal quality** — probability vs the personality's `min_probability`
   threshold; skipped for `SCHEDULED` entries (`stage 4`)
5. **Optional profit gate** — off by default; blocks over-trading a winning day
   (`stage 5`)

Pass = cleared all five (`stage 6`). The filter is pure (no I/O) so all 10 run
under `Promise.all`; daily state is batch-fetched once per personality up front
to avoid N+1 queries.

## Layer 4 — Execution & Retrospection

### 4a. Open the trade
For each personality that passed, the router opens a trade **sequentially**
(not in parallel) via `PaperTradeExecutor.openTrade()`
(`src/trading/paper-trade-executor.ts`). Serialising the opens is deliberate: it
prevents two concurrent INSERTs from both seeing "0 open positions" and both
passing the portfolio risk check before either commits. The executor:
- runs `portfolioRiskCheck()` and a VIX-staleness gate (block opens if VIX is
  older than `VIX_STALE_MS`, default 5 min);
- `INSERT`s the open row into the `paper_trades` table;
- notifies **Quantiply** (paper-trade tracking) — errors are caught and logged,
  **never re-thrown**, so a Quantiply failure can't crash the trading loop or
  orphan the DB row;
- the router then back-fills `personality_id` / `signal_id` on the row.

### 4b. Manage and close the trade
The **PositionMonitor** (`src/trading/position-monitor.ts`) also subscribes to
`straddle.values`. On each snapshot it loads today's open positions, updates the
trailing-stop watermark, and evaluates exit triggers (SL, TSL, TARGET, EOD,
EXIT_WINDOW, DAILY_LOSS). Each position is dispatched to the
`ManagementHandler` matching its personality's `management_style`:
- `hold` → **Holder**, `roll` → **Adjuster**, `cut_reenter` → **Reducer**
  (`src/trading/management/`).

When a trigger fires, the handler closes the position via `closeTrade()`. The
Redis message is **ACK'd only after** all DB writes complete, so a partial
failure leaves the message unACKed and recoverable.

### 4c. End of day → retrospection
After market close, the (planned) **BullMQ** EOD job reads the day's
`paper_trades` and `straddle_snapshots`, computes per-personality metrics
(Beat-Clockwork delta, signal calibration, management effectiveness), tags them
by market regime, and queues rule-based parameter-evolution suggestions behind
the `EVOLUTION_REQUIRE_APPROVAL` gate. See the
[BullMQ deep dive](../tech-stack.md#deep-dive-bullmq--the-eod-retrospection-job).

---

## Why it's shaped this way

- **Streams as seams** decouple producers from consumers — ingestion never
  waits on signal logic, and new consumers attach without touching producers.
- **Pure filter stages** make each of the 5 personality stages independently
  unit-testable with no mocks.
- **Parallel where safe, serial where it matters** — filters fan out under
  `Promise.all`; trade opens are serialised to keep the portfolio risk check
  race-free.
- **Fail-soft at the edges** — Quantiply errors are swallowed, VIX nulls don't
  block, ACK-after-write keeps Redis messages recoverable.

## Related code
- `src/index.ts` — the wiring of every component.
- `src/ingestion/straddle-calc.ts`, `vix-feed.ts`, `brokers/`.
- `src/signals/peak-detection-engine.ts`, `personality-router.ts`,
  `personality-filter.ts`, `probability-scorer.ts`.
- `src/trading/paper-trade-executor.ts`, `position-monitor.ts`, `management/`.
