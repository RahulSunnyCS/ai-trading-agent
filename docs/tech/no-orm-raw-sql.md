# No ORM — Raw SQL via the `pg` Pool

> Part of the [Tech Stack Reference](../tech-stack.md) deep-dive series.

The entire database layer is `src/db/client.ts`: a connection `pool`, a generic
`query<T>()`, `queryOne<T>()`, and `withTransaction()`. There is no Prisma, no
TypeORM, no Drizzle. Query results are typed against the hand-written
interfaces in `src/db/schema.ts`.

## What raw SQL buys you

### 1. You see exactly what runs
An ORM can emit a query you didn't expect. With TimescaleDB that's dangerous —
an ORM has no idea your "table" is a hypertable that **must** be time-filtered
(see [TimescaleDB & Hypertables](./timescaledb-and-hypertables.md)). Raw SQL
keeps the time filter visible in your hand, every time. ORMs and hypertables
are a genuinely poor fit.

### 2. No N+1 surprises, no abstraction tax
What you write is what the database gets. For a low-latency pipeline (~2ms p99
target) that predictability matters.

### 3. Financial correctness control
`src/db/client.ts` forces Postgres `NUMERIC` columns to return as **strings**,
not JS floats:

```ts
// NUMERIC (OID 1700) stays a string — a float like 21847.50 -> 21847.5 would
// accumulate rounding error in P&L math, which is unacceptable here.
pg.types.setTypeParser(1700, (val) => val);
```

Many ORMs hide this coercion. Here it's one explicit, deliberate line. Callers
do precision math on the strings (e.g. `decimal.js` or integer paise).

### 4. Full SQL power, no leaky abstraction
`time_bucket`, `first()`/`last()`, continuous aggregates, and
`INSERT ... ON CONFLICT DO NOTHING` (used by the historical backfill writer) are
Timescale/Postgres-specific. ORMs either can't express these or make you drop
to raw SQL anyway — so you'd end up maintaining both.

## What it costs you

### 1. Types are a promise, not a guarantee
`query<StraddleSnapshot>(...)` tells TypeScript "trust me, rows look like this"
— but `pg` does not verify it. If the `SELECT` picks the wrong columns,
TypeScript still believes you. The client comment says exactly this: *"The type
is a caller promise."* An ORM derives types from the schema, so they can't drift.

### 2. No migration or schema generation
Every migration is hand-written (`src/db/migrations/NNN_description.sql`) and
the matching interface in `src/db/schema.ts` is hand-maintained. Two places to
keep in sync — by discipline, in the **same commit**.

### 3. Boilerplate and footguns are yours to own
- **SQL injection safety** depends on always using parameterised queries
  (`$1`, `$2` …) — never string-concatenate values into SQL.
- **Transactions and connection release** are manual. `withTransaction()` wraps
  `BEGIN`/`COMMIT`/`ROLLBACK` and guarantees `client.release()` in a `finally`
  block to prevent pool exhaustion:

```ts
export async function withTransaction<T>(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); }
    catch (rollbackErr) { console.error('ROLLBACK failed:', rollbackErr); }
    throw err;            // never mask the original error
  } finally {
    client.release();     // always — even on success
  }
}
```

## Net assessment

For a time-series-heavy, precision-sensitive trading system on TimescaleDB,
raw SQL is the right call: the things an ORM automates are exactly the things
this system needs manual control over. The price is **discipline** — keep
`schema.ts` in lockstep with migrations, always parameterise, always
time-filter hypertable queries.

## Related code
- `src/db/client.ts` — pool, `query`, `queryOne`, `withTransaction`, the
  NUMERIC type parser.
- `src/db/schema.ts` — hand-written row interfaces (the "caller promise").
- `src/db/migrations/` — sequential hand-written SQL migrations.
