# Database Schema — Definition & Architecture

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series. See also
> [No ORM — Raw SQL](./no-orm-raw-sql.md) and
> [TimescaleDB & Hypertables](./timescaledb-and-hypertables.md).

## The three-part definition model

There is **no ORM and no schema-generation tool**. The schema is defined in
three coordinated places, with a strict source-of-truth ordering:

```
src/db/migrations/NNN_*.sql   ← SOURCE OF TRUTH (the real schema; what the DB runs)
        │  applied by
        ▼
src/db/migrate.ts             ← runner; records applied files in schema_migrations
        │  hand-mirrored into
        ▼
src/db/schema.ts              ← TypeScript interfaces ("caller promise", not enforced)
```

1. **SQL migrations** (`src/db/migrations/`) are authoritative. They create
   tables, hypertables, indexes, CHECK constraints, the continuous aggregate,
   and seed data.
2. **The migration runner** (`src/db/migrate.ts`) applies pending files and
   records them.
3. **`src/db/schema.ts`** is a hand-written set of TypeScript interfaces — one
   per table — used only to type query results. The `pg` driver does **not**
   verify them at runtime; they are a promise the caller makes (see No-ORM doc).
   Keeping `schema.ts` in lockstep with migrations is a manual discipline.

## How the migration runner works

`runMigrations()` in `src/db/migrate.ts`:

1. **Connect with retry** — exponential back-off (2s/4s/8s) because in Docker
   Compose the app can start before PostgreSQL finishes initialising.
2. **TimescaleDB precheck** — queries `pg_extension`; if the extension is
   absent it `process.exit(1)`s with a clear message ("use
   `timescale/timescaledb:latest-pg16`"). This runs *before* any DDL because
   every hypertable creation would otherwise fail with a confusing error.
3. **Tracking table** — `CREATE TABLE IF NOT EXISTS schema_migrations
   (id, filename UNIQUE, applied_at)`.
4. **Load applied filenames** into a `Set` for O(1) lookup.
5. **Discover & sort** — read `src/db/migrations/`, filter to `.sql`, sort
   **lexicographically** (zero-padded `NNN_` prefixes make this match numeric
   order).
6. **Apply each pending file in its own transaction** — `BEGIN` → run the file →
   `INSERT INTO schema_migrations` → `COMMIT`. One transaction *per file* (not
   one giant transaction) so a failure in file N doesn't roll back files 1…N-1,
   and because some TimescaleDB DDL isn't transactional across versions.

Properties: **idempotent** (re-running skips applied files; every migration uses
`IF NOT EXISTS` / guarded `DO $$` blocks), **append-only** (never edit an applied
file — add a new one), **fail-fast** (TimescaleDB and DATABASE_URL checked
upfront). Invoked via `bun run migrate`; `import.meta.main` guards direct-run so
tests can import the function without triggering a migration.

## Table taxonomy

Tables fall into three physical categories:

| Category | Tables | Notes |
|---|---|---|
| **Hypertables** (time-partitioned) | `market_ticks`, `straddle_snapshots`, `option_ticks`, `straddle_signals` | composite PK includes `time`; always query with a time filter |
| **Continuous aggregate** | `straddle_1min` (materialized view) | auto-refreshed 1-min OHLC over `straddle_snapshots` |
| **Regular tables** | `personality_configs`, `paper_trades`, `retrospection_results`, `personality_audit_log`, `daily_regime_tags`, `event_calendar`, `backfill_ranges`, `broker_tokens`, `access_grants`, `credit_transactions`, `processed_webhook_events` | standard B-tree Postgres tables |

By domain:
- **Market data** — `market_ticks`, `option_ticks`, `straddle_snapshots`,
  `straddle_1min` (+ `resolution` columns added by 007/008 for historical rows).
- **Signals & personalities** — `straddle_signals`, `personality_configs`,
  `personality_audit_log`.
- **Trades & analysis** — `paper_trades`, `retrospection_results`.
- **Regime / calendar** — `daily_regime_tags`, `event_calendar` (a checked-in,
  reproducible event table so backtests don't depend on the live `BLOCKED_DATES`
  env var).
- **Historical backfill** — `backfill_ranges` (resumable-download checkpoints).
- **Auth/broker** — `broker_tokens` (daily Fyers token from the dashboard OAuth
  flow).
- **Payments** — `access_grants`, `credit_transactions`,
  `processed_webhook_events`.

## Type & convention mapping (`schema.ts`)

- Interface = PascalCase singular of the table; properties match column names
  exactly (snake_case for the SQL-faithful interfaces).
- `TIMESTAMPTZ` / `DATE` → `Date`; `TEXT` → `string`; `BOOLEAN` → `boolean`;
  `JSONB` → `unknown` (callers narrow); `TIME` → `string` (`"HH:MM:SS"`).
- **`NUMERIC` → `string`** for financial-precision fields, because
  `pg.types.setTypeParser(1700, …)` returns raw strings (see No-ORM doc). Some
  payment-branch interfaces still type NUMERIC as `number` — a known
  precision-loss caveat the file header calls out.
- Nullable columns → `T | null` (strict null checks on). No default exports.

## CHECK constraints instead of ENUM types

Enumerated columns use `CHECK (col IN (...))` rather than Postgres `ENUM` types.
Rationale (stated in `001_core_schema.sql`): adding a new value is a
migration-only change, not an `ENUM` drop/recreate. Examples: `signal_type IN
('MOMENTUM_EXHAUSTION','SCHEDULED','PULLBACK')`, `status IN ('open','closed')`.
The TypeScript union types in `schema.ts` mirror these CHECK lists by hand.

## Invariants enforced at the schema layer

- **Composite PKs on hypertables** — `PRIMARY KEY (id, time)`; the partition key
  must be part of the PK.
- **Continuous-aggregate refresh policy** — `add_continuous_aggregate_policy`
  wrapped in a guarded `DO $$` block (calling it twice errors).
- **Backfill integrity** — a CHECK enforces "if `gaps_detected > 0` then status
  ∈ {partial, gapped}, never complete".
- **Payments** — CHECK constraints on `grant_type`, `status`; a
  `processed_webhook_events` table gives idempotent webhook handling (dedupe by
  `razorpay_event_id`).

## Spotlight: the credit ledger (append-only design)

`credit_transactions` is **append-only** — no `UPDATE`, no `DELETE`. Purchases
are positive `credits_delta`; feature consumption is negative. The current
balance is a **view**:

```sql
CREATE OR REPLACE VIEW credit_balance AS
SELECT COALESCE(SUM(credits_delta), 0) AS balance ...
```

This keeps a complete audit trail and makes the balance always derivable from
history — an event-sourcing-style ledger rather than a mutable counter.

## Architecture risk: branch-merge drift

The schema carries visible artifacts of two development branches (a "payment"
branch and a "milestones-0-1 / M2" branch) being merged:

- **Duplicate migration numbers** — there are two `002_`, `003_`, `004_`, and
  `005_` files. Because the runner sorts lexicographically, ties break by the
  description suffix (e.g. `002_paper_trades_indexes.sql` before
  `002_seed_clockwork.sql`). Ordering is therefore *implicit and fragile* — a
  future file named `002_aaa.sql` would jump ahead of both.
- **Two definitions of `personality_configs`** — `001_core_schema.sql` defines
  it with explicit columns and `management_style IN ('HOLD','ADJUST','REDUCE')`;
  `003_personality_signals_schema.sql` defines it with a `params JSONB` column
  and `management_style IN ('hold','roll','cut_reenter')`. Both use `CREATE
  TABLE IF NOT EXISTS`, so whichever runs first wins and the second is a silent
  no-op. The runtime code (PersonalityRouter, seeds in `005_personality_seed`)
  uses the **JSONB `params` / lowercase** shape.
- **Two type families in `schema.ts`** — `PersonalityConfig` (snake_case,
  explicit columns, uppercase enum) vs `PersonalityConfigM2` (camelCase, `params`
  JSONB, lowercase enum); two `StraddleSignal` variants; `OpenPosition` is even
  declared twice in the same file.

**Recommendation:** reconcile to a single canonical definition per table and
renumber migrations to a strict monotonic sequence. Until then, treat the
JSONB/`M2`/lowercase shapes as the live ones (that is what the trading code
reads), and verify the effective `personality_configs` schema against a freshly
migrated database before relying on the `001` column shape.

## Related code
- `src/db/migrate.ts` — the runner.
- `src/db/migrations/` — the source-of-truth SQL (001–009).
- `src/db/schema.ts` — TypeScript interfaces (the caller promise).
- `src/db/client.ts` — pool, `NUMERIC`-as-string parser, `withTransaction`.
