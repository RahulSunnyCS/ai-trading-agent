# Migrations 007 & 008 — Historical Backfill & Regime Tagging

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series. Builds on
> [Database Schema Architecture](./database-schema-architecture.md) and
> [TimescaleDB & Hypertables](./timescaledb-and-hypertables.md).

These two migrations add the **M3a historical/backtesting** infrastructure: 007
makes historical candle ingestion resumable and idempotent; 008 adds
point-in-time market-regime classification. Migration 009 fixes a uniqueness bug
that both depend on. All three are strictly additive and each declares it MUST
NOT edit earlier migration files.

---

## Migration 007 — Historical backfill

Supports the backfill writer (`src/ingestion/historical/backfill.ts`), which
turns Fyers OHLCV candles into hypertable rows.

### 1–2. `resolution` columns (market_ticks, option_ticks)
`ADD COLUMN IF NOT EXISTS resolution TEXT` — nullable, so existing live rows are
untouched and there's **no table rewrite**. Live rows stay NULL; historical rows
carry `'1' | '5' | '15' | 'D'`.

### 3. `source` column on option_ticks
`market_ticks` already had `source`; `option_ticks` didn't. Added as
`NOT NULL DEFAULT 'fyers'` so existing rows get a sensible value automatically
(no separate UPDATE pass) and "unknown source" rows are impossible.

### 4–5. Partial UNIQUE indexes — the disjoint-keyspace trick
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_ticks_hist_uniq
  ON market_ticks (symbol, time)
  WHERE source = 'fyers-historical';
```
This is the cleverest part of 007. The index is **partial** — scoped to
`source = 'fyers-historical'`. Live writers use `source = 'fyers'` or
`'simulator'`, a **disjoint key space**, so the historical uniqueness constraint
*never competes with or constrains live writes*. Four deliberate properties:

- **UNIQUE** is mandatory — `INSERT ... ON CONFLICT DO NOTHING` can only target a
  unique index. This is what makes re-ingestion write zero duplicates.
- **Includes `time`** — TimescaleDB requires every hypertable index to include
  the partition column, or it won't prune per-chunk and is silently useless.
- **Built non-concurrently** — `CREATE INDEX CONCURRENTLY` can't run inside a
  transaction, and the migration runner wraps each file in `BEGIN/COMMIT`. The
  key space is empty at build time, so the brief ShareLock is negligible.
- **INVALID-index cleanup** — a `DO $$` block detects an `indisvalid = false`
  index left by an interrupted prior run and drops it before recreating, so a
  re-run always converges.

### 6. `backfill_ranges` — the resumable state machine
One row per `(symbol, from_ts, to_ts, resolution)` job. Its `status` is a CHECK
enum that *is* the state machine:

```
pending → running → complete          (clean: all candles, no gaps)
                  ↘ gapped             (all candles written, but calendar gaps found)
                  ↘ partial            (interrupted; resume from checkpoint_ts)
                  ↘ error              (non-resumable failure)
```

Supporting columns: `rows_written`, `checkpoint_ts` (last persisted candle —
NULL ⇒ start from `from_ts`), `gaps_detected`, `gaps_json` (a TEXT-stored JSON
array of `{from, to, reason}` — TEXT not JSONB to avoid needing a JSONB column
here). A DB-level **CHECK invariant** mirrors the writer's rule: *if
`gaps_detected > 0`, status must be `partial` or `gapped`, never `complete`*.
Two indexes: one on `(symbol, from_ts, to_ts, resolution)` for resume lookups,
one on `(status)` for "find all partial rows to resume".

### How the writer uses it (`backfill.ts`)
- **Idempotent**: every candle is `INSERT ... ON CONFLICT DO NOTHING` against the
  partial-unique index → re-running a completed range writes 0 rows.
- **Resumable**: a `FyersAuthError` (the daily-token problem) triggers
  `checkpointRange()` → status `partial`, `checkpoint_ts` saved, and a
  `BackfillResumeError` is thrown. Re-running with the same options resumes from
  the checkpoint, never re-fetching completed data.
- **Fail-loud on missing legs**: a missing CE/PE contract throws
  `MissingLegError` immediately — never interpolated or skipped (data integrity
  over convenience).
- **Calendar reconciliation**: actual candle coverage is compared to expected
  NSE trading days; gaps are recorded and the range is marked `gapped`, never
  silently `complete`.

---

## Migration 008 — Regime tagging

Supports the regime classifier (`src/trading/regime-tagging.ts`), which labels
each historical day so personality performance is only ever compared *within*
the same regime.

### 1. `resolution` on straddle_snapshots
Closes the "T-56 gap": the reconstructor computed a per-snapshot resolution but
had nowhere to persist it, forcing an expensive join back to `option_ticks` to
judge fidelity. Nullable, live rows unaffected.

### 2. `daily_regime_tags`
One row per `(trade_date, symbol)`:
- `regime` — CHECK over `RANGING | TRENDING_STRONG | VOLATILE_REVERTING |
  EVENT_DAY | UNCLASSIFIED`.
- `regime_confidence` — `NUMERIC(5,4)` with `CHECK (>= 0 AND <= 1)`. Meaning
  varies by label: agreement fraction for the three data-driven regimes, always
  `1.0` for EVENT_DAY (deterministic calendar lookup), and the gap fraction for
  UNCLASSIFIED.
- `UNIQUE (trade_date, symbol)` — makes the tagging engine **idempotent**: a
  re-run uses `ON CONFLICT DO UPDATE` to refresh the existing row rather than
  duplicating it.
- `classified_at` — wall-clock write time, to detect stale labels after a data
  reingestion.

### 3. `event_calendar` — reproducibility by design
The single most important design decision in 008. The live engine uses a
`BLOCKED_DATES` **env var** to skip event days, but an env var is **not
reproducible** for historical backtests (it changes per deployment and can't be
reconstructed for past dates). So the event calendar is **checked into the
migration** as data — every environment (dev/CI/prod) classifies history
identically.
- `event_type` is **open-ended TEXT (no CHECK)** so operators can add custom
  types without a schema change. Seed types: `RBI_POLICY`, `UNION_BUDGET`,
  `FNO_EXPIRY`, `STATE_ELECTION`, `HOLIDAY`.
- `UNIQUE (event_date, event_type)` — multiple events per date are allowed (F&O
  expiry + RBI on the same day); the classifier treats any match as EVENT_DAY.
- Seeded 2023–2026 (RBI MPC dates, Union Budgets, NSE holidays) with
  `ON CONFLICT (event_date, event_type) DO NOTHING` so the seed is idempotent
  and extendable via follow-on migrations — never by editing 008.

### How the classifier uses it (`regime-tagging.ts`)
- **Causal / point-in-time guarantee**: day D is classified using only data
  observable by **14:30 IST on D** (`CLASSIFICATION_CUTOFF_IST = '14:30'`) —
  matching the trading system's `ENTRY_CUTOFF_TIME`. No close data, no future
  days. A look-ahead audit test mutates D+1 and asserts D's label is unchanged.
- **Determinism**: no `Date.now()` (injected `Clock` only); thresholds are
  named compile-time constants — e.g. `TRENDING_NET_MOVE_THRESHOLD = 0.006`
  (0.6%), `TRENDING_CONSISTENCY_THRESHOLD = 0.55`,
  `VOLATILE_ACCELERATION_THRESHOLD = 0.15`, `GAP_FRACTION_THRESHOLD = 0.5`. Same
  input ⇒ same label every run.
- **Precedence (deterministic tie-break)**:
  `EVENT_DAY > VOLATILE_REVERTING > TRENDING_STRONG > RANGING`. If a day meets
  both volatile and trending thresholds, volatile wins (a whipsawing market is
  the more dangerous, distinct regime).
- **Fidelity gate → UNCLASSIFIED**: a day is UNCLASSIFIED if `backfill_ranges`
  shows `gapped`/`partial` coverage for it, **or** more than 50% of expected
  intraday snapshots are missing. `regime_confidence` then carries the gap
  fraction. This is how the gap tracking in 007 feeds directly into 008's
  trustworthiness signal.

---

## Migration 009 — the uniqueness bug both depend on

A cautionary tale worth its own note. `straddle_snapshots`' only uniqueness was
its hypertable PK `(id, time)` where `id` is `BIGSERIAL`. Because `id` is
auto-generated, two inserts of the *same logical snapshot* (same `time, symbol,
strike, expiry`) got different `id`s and were **not** treated as conflicts — so
the `ON CONFLICT` clause in `writeSnapshot()` was **dead code**, and re-running
reconstruction **silently duplicated rows**, corrupting the regime classifier's
inputs. 009 adds the business-key unique index (including `time`, per the
hypertable rule) so `ON CONFLICT` finally works:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_straddle_snapshots_unique_snapshot
  ON straddle_snapshots (time, symbol, strike, expiry);
```

(Its migration note warns: dedup any existing duplicates before applying on a
dirty dev DB, or the unique-index build fails.)

---

## Cross-cutting insights

1. **Disjoint-keyspace partial indexes** let historical and live data share the
   same hypertable with zero write contention and independent uniqueness rules —
   a clean way to bolt batch ingestion onto a live table.
2. **Reproducibility is a first-class design goal.** Putting the event calendar
   in a migration (not an env var), forbidding `Date.now()`, and using
   compile-time thresholds all exist so a backtest run today matches one run next
   year. The 14:30 cutoff enforces *causality* so backtests can't cheat with
   future data.
3. **Gap tracking is end-to-end.** 007 records coverage gaps in
   `backfill_ranges`; 008's classifier reads those to downgrade a day to
   UNCLASSIFIED. Data-quality state flows from ingestion through to analysis
   instead of being silently dropped.
4. **`ON CONFLICT` only works with a matching unique index** (the 009 lesson).
   With a `BIGSERIAL` surrogate PK, the *business key* needs its own unique
   index or conflict-based idempotency is silently a no-op.
5. **Additive, NULL-defaulted columns avoid table rewrites** on large
   hypertables — the migrations explicitly lean on this to stay fast and safe.

## Related code
- `src/db/migrations/007_historical_backfill.sql`, `008_regime_tagging.sql`,
  `009_straddle_snapshots_unique.sql`
- `src/ingestion/historical/backfill.ts` — resumable, idempotent writer
- `src/ingestion/brokers/fyers-historical.ts` — candle fetch + `FyersAuthError`
- `src/trading/regime-tagging.ts` — causal, deterministic classifier
- Schema types: `BackfillRange`, `DailyRegimeTag`, `EventCalendarEntry` in
  `src/db/schema.ts`
