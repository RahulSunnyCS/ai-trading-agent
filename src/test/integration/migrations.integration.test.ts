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

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../db/migrate.js";
import { createTestDb } from "./helpers.js";

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

describe.skipIf(!hasDatabase)("schema migration completeness (T-25)", () => {
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

  it("personality_configs table exists and has exactly 10 rows", async () => {
    const result = await db.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM personality_configs",
    );
    expect(Number(result.rows[0]?.count ?? 0)).toBe(10);
  });

  it("Clockwork row has is_frozen = TRUE and entry_type = 'fixed_time'", async () => {
    const result = await db.query<{
      is_frozen: boolean;
      entry_type: string;
    }>(
      "SELECT is_frozen, entry_type FROM personality_configs WHERE name = 'clockwork'",
    );

    expect(result.rows.length).toBe(1);
    const row = result.rows[0];
    expect(row?.is_frozen).toBe(true);
    expect(row?.entry_type).toBe("fixed_time");
  });

  it("Levelhead row has is_active = FALSE and phase = 2", async () => {
    const result = await db.query<{
      is_active: boolean;
      phase: number;
    }>(
      "SELECT is_active, phase FROM personality_configs WHERE name = 'levelhead'",
    );

    expect(result.rows.length).toBe(1);
    const row = result.rows[0];
    expect(row?.is_active).toBe(false);
    expect(row?.phase).toBe(2);
  });

  // -------------------------------------------------------------------------
  // straddle_signals hypertable
  // -------------------------------------------------------------------------

  it("straddle_signals is a TimescaleDB hypertable", async () => {
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
    expect(result.rows[0]?.hypertable_name).toBe("straddle_signals");
  });

  // -------------------------------------------------------------------------
  // paper_trades M2 columns (migration 004)
  // -------------------------------------------------------------------------

  it("paper_trades has a personality_id column", async () => {
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

  it("paper_trades has a parent_trade_id column", async () => {
    const result = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'paper_trades'
         AND column_name = 'parent_trade_id'`,
    );
    expect(result.rows.length).toBe(1);
  });

  it("paper_trades has a signal_id column", async () => {
    const result = await db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'paper_trades'
         AND column_name = 'signal_id'`,
    );
    expect(result.rows.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Migration idempotency
  // -------------------------------------------------------------------------

  it("running migrations twice produces no errors and no duplicate seed rows", async () => {
    // Re-apply all migrations against the test database. Because every migration
    // uses IF NOT EXISTS / ON CONFLICT DO NOTHING the second run must be a no-op.
    // The DATABASE_URL override is needed for the same reason as in createTestDb():
    // runMigrations() reads DATABASE_URL from the environment.
    const connectionString =
      process.env.DATABASE_URL ?? "postgresql://trading:trading@localhost:5432/trading_test";

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
      "SELECT COUNT(*) AS count FROM personality_configs",
    );
    expect(Number(countResult.rows[0]?.count ?? 0)).toBe(10);
  });

  // -------------------------------------------------------------------------
  // schema_migrations tracking table
  // -------------------------------------------------------------------------

  it("schema_migrations table records exactly 5 applied migration files", async () => {
    // There are 5 migration files (001 through 005). The tracking table must
    // have exactly one row per file — no missing entries, no duplicates.
    const result = await db.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM schema_migrations",
    );
    // The second runMigrations() call above should not add rows for already-applied
    // files, so the count must still equal the total number of migration files.
    expect(Number(result.rows[0]?.count ?? 0)).toBe(5);
  });

  it("schema_migrations filenames match the expected migration files in order", async () => {
    const result = await db.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    const filenames = result.rows.map((r) => r.filename);
    expect(filenames).toEqual([
      "001_core_schema.sql",
      "002_paper_trades_indexes.sql",
      "003_personality_signals_schema.sql",
      "004_paper_trades_m2.sql",
      "005_personality_seed.sql",
    ]);
  });
});
