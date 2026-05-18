/**
 * Integration test helpers — shared setup and teardown for all integration tests.
 *
 * These helpers create real connections to PostgreSQL and Redis (the Docker
 * services from docker-compose.yml). They must not be imported by unit tests
 * because unit tests run without Docker.
 *
 * All exports are named exports (no default export) per project convention.
 */

import type { Redis } from "ioredis";
import type { Pool } from "pg";

// ioredis's default export is the Redis class constructor. We import it as a
// value so we can call `new RedisClient(url, opts)` inside createTestRedis().
// The `type { Redis }` import above gives us the instance type for the return
// annotation without creating a circular value/type dependency.
import RedisClient from "ioredis";
import pg from "pg";
import { runMigrations } from "../../db/migrate.js";
import { FixedClock } from "../../utils/clock.js";

// ---------------------------------------------------------------------------
// PostgreSQL helpers
// ---------------------------------------------------------------------------

/**
 * Creates a pg Pool pointed at the test database and ensures the schema is
 * current by running the migration runner.
 *
 * Why a dedicated test Pool rather than re-using src/db/client.ts?
 * The shared production pool reads DATABASE_URL which in CI typically points
 * at the primary database. Integration tests must use a separate test database
 * (trading_test) so that flushes and truncates do not corrupt any shared state.
 * Having a factory function also lets each test file manage its own pool
 * lifecycle (connect at beforeAll, end at afterAll).
 *
 * connectionTimeoutMillis = 5000: if Docker is not running the test throws a
 * clear "connection timeout" error within 5 seconds rather than hanging
 * indefinitely. Without this, the default pg behaviour is to wait forever.
 */
export async function createTestDb(): Promise<Pool> {
  const connectionString =
    process.env.DATABASE_URL ?? "postgresql://trading:trading@localhost:5432/trading_test";

  const testPool = new pg.Pool({
    connectionString,
    // Fail fast when Docker is not running; pg's default has no timeout.
    connectionTimeoutMillis: 5000,
    // Small pool for tests — no need for the production default of 10.
    max: 3,
  });

  // The numeric type parser must be set here too (matching src/db/client.ts)
  // so that financial values coming out of test queries are strings, not floats.
  // Without this, assertions on P&L values would silently compare strings to
  // rounded floats and produce subtle test failures.
  pg.types.setTypeParser(1700, (val) => val);

  // runMigrations() reads DATABASE_URL from the environment. We temporarily
  // override it so the migration runner targets the test database regardless of
  // what DATABASE_URL is set to in the caller's environment.
  //
  // We restore the original value in a finally block so the override does not
  // leak to other code that runs after createTestDb() returns.
  const originalDbUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = connectionString;
  try {
    await runMigrations();
  } finally {
    // Restore original value (or unset it if it was never set originally).
    // Using `= undefined` instead of `delete` because Biome's noDelete rule
    // flags delete on performance grounds; both approaches remove the key's
    // effective value from the process environment.
    if (originalDbUrl === undefined) {
      process.env.DATABASE_URL = undefined;
    } else {
      process.env.DATABASE_URL = originalDbUrl;
    }
  }

  return testPool;
}

/**
 * Truncates all data tables between tests to prevent state leakage.
 *
 * RESTART IDENTITY resets auto-increment sequences so that primary key values
 * are predictable across test runs (e.g., the first inserted row always has
 * id=1). CASCADE handles any foreign-key references that might exist between
 * these tables.
 *
 * The tables listed here are the main time-series and trade tables. The
 * schema_migrations table is deliberately excluded — we never want to clear
 * migration tracking, as that would cause runMigrations() to re-apply
 * already-applied files.
 *
 * personality_configs is also excluded because it holds seed data (the 10
 * personalities + Clockwork) that is inserted by migrations. Truncating it
 * would break tests that rely on pre-seeded personalities without needing to
 * re-insert them manually.
 */
export async function cleanTestDb(db: Pool): Promise<void> {
  await db.query(`
    TRUNCATE paper_trades, market_ticks, straddle_snapshots
    RESTART IDENTITY CASCADE
  `);
}

// ---------------------------------------------------------------------------
// Redis helpers
// ---------------------------------------------------------------------------

/**
 * Creates a new ioredis client pointed at the test Redis instance.
 *
 * Why not re-use src/redis/client.ts?
 * The production Redis singleton is created eagerly at module load time and
 * starts consuming streams. Integration tests need a clean, independent
 * connection that they can flush (flushdb) without disrupting the production
 * singleton or its consumer-group state.
 *
 * connectTimeout = 5000: mirrors the pg Pool connectionTimeoutMillis — if
 * Docker is not running the function throws quickly rather than hanging.
 *
 * Consumer groups are intentionally NOT created here. Tests that need a
 * consumer group set one up themselves (e.g. in beforeEach) so each test
 * controls exactly what consumer topology it needs.
 *
 * Note: returns the concrete ioredis Redis instance. The return type is
 * annotated as the imported Redis interface type to keep the call sites clean.
 */
export function createTestRedis(): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";

  // connectTimeout: ioredis-specific option that caps the TCP handshake.
  // lazyConnect: false (default) means the client connects immediately so any
  // Docker-not-running error surfaces at createTestRedis() time, not on the
  // first command. This makes test failures easier to diagnose.
  return new RedisClient(url, {
    connectTimeout: 5000,
    // Disable automatic reconnection in tests: if Redis drops mid-test we want
    // an immediate error, not silent retries that mask the problem.
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
  });
}

/**
 * Flushes all keys in the Redis database between tests.
 *
 * FLUSHDB (not FLUSHALL) clears only the logical database that this client is
 * connected to (db 0 by default). This is safer than FLUSHALL which would
 * wipe every database on the Redis instance — relevant if other processes are
 * sharing the same Redis server.
 *
 * Callers should invoke this in an afterEach hook, not afterAll, so that a
 * failing test does not leave dirty state that corrupts the next test.
 */
export async function cleanTestRedis(redis: Redis): Promise<void> {
  await redis.flushdb();
}

// ---------------------------------------------------------------------------
// Clock helper
// ---------------------------------------------------------------------------

/**
 * Convenience factory that creates a FixedClock frozen at the given ISO-8601
 * datetime string.
 *
 * Usage in tests:
 *   const clock = withTestClock('2026-01-15T09:15:00+05:30');
 *   expect(clock.today()).toBe('2026-01-15');
 *
 * The +05:30 offset is the standard IST offset. Passing it explicitly avoids
 * any ambiguity about the UTC interpretation of the timestamp when the test
 * machine is in a different timezone (e.g. UTC in CI).
 *
 * Why a factory function rather than `new FixedClock(iso)` directly in tests?
 * Naming it withTestClock() makes the intent clearer in test code and groups
 * it with the other helpers so tests have a single import to reach for.
 */
export function withTestClock(isoDatetime: string): FixedClock {
  return new FixedClock(isoDatetime);
}
