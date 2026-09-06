/**
 * Integration tests for schema migration completeness (T-25).
 *
 * These tests verify that the migration runner produces the exact schema that
 * Milestone 2 requires: the right tables, hypertables, columns, and seed rows.
 * They also verify that running migrations twice is a no-op (idempotency).
 *
 * This is the ONLY integration test file that calls runMigrations() directly.
 * All other integration test files assume the schema already exists; they call
 * createTestDb() (which itself calls runMigrations once at the top).
 *
 * Requires Docker services (PostgreSQL with TimescaleDB) to be running.
 * Run with: bun run test:integration
 */

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../db/migrate.js';
import { createTestDb } from './helpers.js';

// ---------------------------------------------------------------------------
// Guard: skip entire suite when DATABASE_URL is not set
// ---------------------------------------------------------------------------

const hasDatabase = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let db: Pool;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasDatabase)('schema migration completeness (T-25)', () => {
  beforeAll(async () => {
    // createTestDb() calls runMigrations() once, which is the first application.
    // We then call runMigrations() a second time in the idempotency test below.
    db = await createTestDb();
  }, 30_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  // -------------------------------------------------------------------------
  // personality_configs seed
  // -------------------------------------------------------------------------

  it('personality_configs table exists and has exactly 10 rows', async () => {
    const result = await db.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM personality_configs',
    );
    expect(Number(result.rows[0]?.count ?? 0)).toBe(10);
  });

  it("Clockwork row has is_frozen = TRUE and entry_type = 'fixed_time'", async () => {
    const result = await db.query<{
      is_frozen: boolean;
      entry_type: string;
    }>("SELECT is_frozen, entry_type FROM personality_configs WHERE name = 'clockwork'");

    expect(result.rows.length).toBe(1);
    const row = result.rows[0];
    expect(row?.is_frozen).toBe(true);
    expect(row?.entry_type).toBe('fixed_time');
  });

  it('Levelhead row has is_active = FALSE and phase = 2', async () => {
    const result = await db.query<{
      is_active: boolean;
      phase: number;
    }>("SELECT is_active, phase FROM personality_configs WHERE name = 'levelhead'");

    expect(result.rows.length).toBe(1);
    const row = result.rows[0];
    expect(row?.is_active).toBe(false);
    expect(row?.phase).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Hypertable assertions (T-06)
  // -------------------------------------------------------------------------

  it('straddle_signals is a TimescaleDB hypertable', async () => {
    // timescaledb_information.hypertables lists every hypertable. Querying it
    // confirms that straddle_signals went through create_hypertable(), not just
    // a plain CREATE TABLE. The WHERE clause uses LOWER() for portability — the
    // schema name may be 'public' or 'PUBLIC' depending on the TSDB version.
    const result = await db.query<{ hypertable_name: string }>(
      `SELECT hypertable_name
       FROM timescaledb_information.hypertables
       WHERE LOWER(hypertable_schema) = 'public'
         AND hypertable_name = 'straddle_signals'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.hypertable_name).toBe('straddle_signals');
  });

  it('exactly 4 hypertables exist: market_ticks, option_ticks, straddle_signals, straddle_snapshots', async () => {
    // The migration chain must produce exactly these 4 TimescaleDB hypertables
    // in the public schema and no others. This assertion would have failed on
    // pre-fix migrations because straddle_signals was not created as a
    // hypertable (create_hypertable() threw TS103 on the non-composite PK).
    //
    // We sort the result so the assertion is order-independent regardless of
    // the order TimescaleDB registers hypertables internally.
    const result = await db.query<{ hypertable_name: string }>(
      `SELECT hypertable_name
       FROM timescaledb_information.hypertables
       WHERE LOWER(hypertable_schema) = 'public'
       ORDER BY hypertable_name`,
    );
    const names = result.rows.map((r) => r.hypertable_name);
    expect(names).toEqual([
      'market_ticks',
      'option_ticks',
      'straddle_signals',
      'straddle_snapshots',
    ]);
  });

  // -------------------------------------------------------------------------
  // straddle_signals PRIMARY KEY assertion (T-06)
  // -------------------------------------------------------------------------

  it('straddle_signals PRIMARY KEY is the composite (id, time)', async () => {
    // pg_constraint holds the definition of every constraint. We query for the
    // PRIMARY KEY (contype = 'p') on the straddle_signals table and inspect the
    // human-readable definition via pg_get_constraintdef().
    //
    // Why pg_get_constraintdef instead of pg_attribute joins?
    // It is the most robust approach: it returns the canonical SQL text of the
    // constraint (e.g. "PRIMARY KEY (id, time)") which we can assert against
    // without joining through multiple catalog tables and handling attribute
    // ordinal positions.
    //
    // This assertion would have failed on pre-fix migrations where
    // straddle_signals had a single-column PRIMARY KEY (id), because
    // TimescaleDB's hypertable create_hypertable() requires the partition
    // column to be part of the primary key.
    const result = await db.query<{ constraint_def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS constraint_def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'p'
         AND t.relname = 'straddle_signals'
         AND LOWER(n.nspname) = 'public'`,
    );
    // There must be exactly one primary key.
    expect(result.rows.length).toBe(1);
    const def = result.rows[0]?.constraint_def ?? '';
    // The definition must mention both id and time. TimescaleDB canonicalises
    // the column order so we check for both names rather than an exact string.
    expect(def).toMatch(/\bid\b/);
    expect(def).toMatch(/\btime\b/);
    // Sanity-check: the definition starts with PRIMARY KEY.
    expect(def.toUpperCase()).toContain('PRIMARY KEY');
  });

  // -------------------------------------------------------------------------
  // paper_trades M2 columns (migration 004)
  // -------------------------------------------------------------------------

  it('paper_trades has a personality_id column', async () => {
    // information_schema.columns is a portable way to check column existence
    // without querying the actual table rows. This works even when the table
    // is empty. We check column_name only (not data_type) because the column
    // type is UUID but pg_catalog may represent it differently across versions.
    const result = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'paper_trades'
         AND column_name = 'personality_id'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('paper_trades has a parent_trade_id column', async () => {
    const result = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'paper_trades'
         AND column_name = 'parent_trade_id'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('paper_trades has a signal_id column', async () => {
    const result = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'paper_trades'
         AND column_name = 'signal_id'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it('paper_trades.signal_id has NO foreign-key constraint (T-06)', async () => {
    // In the pre-fix schema, 001_core_schema.sql and 004_paper_trades_m2.sql
    // both declared `signal_id REFERENCES straddle_signals(id)`. That FK is
    // incompatible with a composite-PK hypertable (Postgres requires that the
    // referenced columns form a unique constraint, but TimescaleDB forbids a
    // UNIQUE index that does not include the partition column `time`). The fix
    // drops the FK entirely — signal_id is a bare UUID column.
    //
    // We query pg_constraint for FOREIGN KEY constraints (contype = 'f') on
    // paper_trades and assert that none of them reference straddle_signals or
    // mention signal_id. An empty result set is the expected (correct) outcome.
    const result = await db.query<{ constraint_name: string; constraint_def: string }>(
      `SELECT c.conname AS constraint_name,
              pg_get_constraintdef(c.oid) AS constraint_def
       FROM pg_constraint c
       JOIN pg_class t    ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE c.contype = 'f'
         AND t.relname = 'paper_trades'
         AND LOWER(n.nspname) = 'public'`,
    );
    // Filter to any FK whose definition mentions signal_id or straddle_signals.
    const signalIdFks = result.rows.filter((r) => {
      const def = (r.constraint_def ?? '').toLowerCase();
      return def.includes('signal_id') || def.includes('straddle_signals');
    });
    expect(signalIdFks).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Migration idempotency
  // -------------------------------------------------------------------------

  it('running migrations twice produces no errors and no duplicate seed rows', async () => {
    // Re-apply all migrations against the test database. Because every migration
    // uses IF NOT EXISTS / ON CONFLICT DO NOTHING the second run must be a no-op.
    // The DATABASE_URL override is needed for the same reason as in createTestDb():
    // runMigrations() reads DATABASE_URL from the environment.
    const connectionString =
      process.env.DATABASE_URL ?? 'postgresql://trading:trading@localhost:5432/trading_test';

    const originalDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = connectionString;
    try {
      // runMigrations() must not throw on the second call.
      await expect(runMigrations()).resolves.toBeUndefined();
    } finally {
      if (originalDbUrl === undefined) {
        process.env.DATABASE_URL = undefined;
      } else {
        process.env.DATABASE_URL = originalDbUrl;
      }
    }

    // After the second run, personality_configs must still have exactly 10 rows.
    // ON CONFLICT DO NOTHING on the seed INSERT guarantees no duplicates.
    const countResult = await db.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM personality_configs',
    );
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(10);
  });

  // -------------------------------------------------------------------------
  // schema_migrations tracking table
  // -------------------------------------------------------------------------

  it('schema_migrations table records exactly 15 applied migration files', async () => {
    // The full migration chain now has 15 files (001 through 011, with some
    // duplicate-prefix files such as 002_seed_clockwork, 003_payment_tables,
    // 004_credit_system, and 005_payment_schema_constraints that sort between
    // the canonical numbered files). The tracking table must have exactly one
    // row per file — no missing entries, no duplicates.
    //
    // The second runMigrations() call above must not add rows for already-applied
    // files, so the count must still equal the total number of migration files.
    const result = await db.query<{ count: string }>(
      'SELECT COUNT(*) AS count FROM schema_migrations',
    );
    expect(Number(result.rows[0]?.count ?? 0)).toBe(15);
  });

  it('schema_migrations filenames match the expected 15 migration files in order', async () => {
    // These filenames are the sorted order in which migrate.ts applies files
    // (alphabetical / lexicographic sort of *.sql in the migrations directory).
    // The list reflects the post-fix chain verified in plan-fresh-install.md.
    const result = await db.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    const filenames = result.rows.map((r) => r.filename);
    expect(filenames).toEqual([
      '001_core_schema.sql',
      '002_paper_trades_indexes.sql',
      '002_seed_clockwork.sql',
      '003_payment_tables.sql',
      '003_personality_signals_schema.sql',
      '004_credit_system.sql',
      '004_paper_trades_m2.sql',
      '005_payment_schema_constraints.sql',
      '005_personality_seed.sql',
      '006_broker_tokens.sql',
      '007_historical_backfill.sql',
      '008_regime_tagging.sql',
      '009_straddle_snapshots_unique.sql',
      '010_retrospection_evolution.sql',
      '011_retrospection_indexes.sql',
    ]);
  });
});
