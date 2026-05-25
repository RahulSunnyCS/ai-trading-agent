# TimescaleDB & Hypertables

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series.

TimescaleDB **is** PostgreSQL — it's an extension, not a separate database. You
write normal SQL and use the `pg` pool normally. What it adds is machinery for
the one thing vanilla Postgres struggles with: **huge, ever-growing time-series
tables.** This project ingests ticks every few hundred ms, forever, so within
months that's hundreds of millions of rows.

## What a hypertable actually does

A hypertable looks like one table but is automatically sharded underneath into
many physical sub-tables ("chunks"), each holding one time window. From
`src/db/migrations/001_core_schema.sql`:

```sql
SELECT create_hypertable('market_ticks', 'time', if_not_exists => TRUE);
```

You keep querying `market_ticks` as if it's one table; TimescaleDB routes reads
and writes to the right chunk by `time`. This is why every hypertable here has
a composite primary key that includes the partition column:

```sql
PRIMARY KEY (id, time)   -- the partition key (time) must be part of the PK
```

The hypertables in this project are `market_ticks`, `straddle_snapshots`, and
`option_ticks` — all created in migration `001_core_schema.sql`
(`straddle_signals` is a *regular* table, not a hypertable).

Why it matters: with a flat table, inserts slow down and indexes bloat as the
table grows. With chunks, inserts always hit the small "current" chunk, and old
chunks can be compressed or dropped independently.

## Why a missing time-range filter destroys performance

This is the project's hardest rule. A query with no time bound:

```sql
SELECT * FROM straddle_snapshots WHERE symbol = 'NIFTY';   -- NO time filter
```

forces the planner to scan **every chunk across the entire history** (a full
hypertable scan), because it cannot exclude any chunk. The whole point of
partitioning is **chunk exclusion** — add a time bound and Timescale touches
only the relevant chunks:

```sql
SELECT * FROM straddle_snapshots
WHERE symbol = 'NIFTY' AND time > NOW() - INTERVAL '1 hour';   -- one or two chunks
```

Drop the filter and you've thrown away the only optimization that makes the
table viable. **Rule: every hypertable query includes a time range.**

## Continuous aggregates (already in use)

`straddle_1min` is a materialized view that auto-rolls raw 15-second snapshots
into 1-minute OHLC candles, refreshed every minute by a policy. From
`001_core_schema.sql`:

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS straddle_1min
  WITH (timescaledb.continuous) AS
  SELECT
    time_bucket('1 minute', time) AS bucket,
    symbol, expiry, strike,
    first(straddle_value, time) AS open,
    max(straddle_value)         AS high,
    min(straddle_value)         AS low,
    last(straddle_value, time)  AS close,
    avg(roc)                    AS avg_roc,
    avg(vix)                    AS avg_vix
  FROM straddle_snapshots
  GROUP BY bucket, symbol, expiry, strike
  WITH NO DATA;
```

- `first()` / `last()` are TimescaleDB aggregates that return the value from the
  earliest / latest row in each bucket — correct open/close even when ticks
  arrive out of order.
- The dashboard charts read this small pre-computed view instead of
  re-aggregating millions of raw rows on every page load.
- Refresh is automatic via `add_continuous_aggregate_policy` — never insert
  into the view by hand.

## Gotcha: TimescaleDB is not optional

The standard `postgres:16-alpine` image does **not** include the extension.
Docker Compose uses `timescale/timescaledb:latest-pg16`. Pointing the app at a
vanilla PostgreSQL instance fails on migration (`create_hypertable` is
undefined).

## Related code
- `src/db/migrations/001_core_schema.sql` — hypertable + continuous-aggregate
  definitions.
- `src/db/migrate.ts` — custom migration runner.
- `docker-compose.yml` — the `timescale/timescaledb:latest-pg16` image.
