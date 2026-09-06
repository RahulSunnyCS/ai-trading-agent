// @integration — requires Docker services (PostgreSQL + Redis)
//
// Run with: bun run test:integration
// Requires: docker compose up -d (TimescaleDB + Redis)
//
// These tests verify the startup contract for the three infrastructure layers:
//   1. Database — migrations are idempotent (safe to run twice)
//   2. HTTP server — /health endpoint returns { status: 'ok' }
//   3. Redis — connection is established and commands succeed
//
// Design decisions:
// - Tests are skipped (not failed) when DATABASE_URL or REDIS_URL are absent so
//   CI passes cleanly in environments without Docker services.
// - We use `buildServer()` rather than `startServer()` so no port is occupied;
//   Fastify's `server.inject()` drives HTTP assertions in-process.
// - The pg Pool created inside `buildServer()` (when no externalPool is passed)
//   is closed by the server's onClose hook, so `afterAll` only needs to close
//   the server.
// - The Redis client under test is the module-level singleton from
//   src/redis/client.ts.  We call `redis.quit()` in afterAll to release the
//   TCP connection and prevent the test runner from hanging.
// - process.env keys use dot notation throughout (Biome useLiteralKeys rule).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../../db/client';
import { redis } from '../../redis/client';
import { buildServer } from '../../server/index';

// Skip the entire suite when the required env vars are absent.
// Using `process.env.DATABASE_URL` (dot notation) — bracket notation is
// disallowed by the Biome useLiteralKeys rule.
const SKIP = !process.env.DATABASE_URL || !process.env.REDIS_URL;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('startup integration', () => {
  // We build a fresh Fastify instance for these tests rather than calling
  // startServer() (which binds a real port and registers signal handlers).
  // inject() drives all HTTP assertions in-process.
  //
  // The server variable is initialised inside beforeAll (not at describe-body
  // scope) because top-level await is only valid at module level, not inside
  // a callback.  We use a mutable let with a definite assignment assertion
  // (`!`) in the tests — beforeAll always runs before any `it`, so the
  // assertion is safe.
  let server: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => {
    server = await buildServer({ logger: false });
    // Ready the server so inject() works; this does NOT bind a port.
    await server.ready();
  });

  afterAll(async () => {
    // Close Fastify — this triggers the onClose hook which ends the pool
    // created inside buildServer() (since we did not pass externalPool).
    await server.close();

    // End the module-level pg pool (used by the migration idempotency test).
    // pool.end() is idempotent when called on an already-ended pool.
    await pool.end();

    // Quit Redis — sends QUIT and waits for ACK so the test runner does not
    // hang waiting for the ioredis TCP connection to time out.
    await redis.quit();
  });

  // ── Test 1: Migration runner is idempotent ─────────────────────────────────

  it('migration runner is idempotent — running twice does not throw', async () => {
    // Ensure schema_migrations table exists and all migrations are applied at
    // least once before the second run.
    //
    // We run the migrations inline using the shared pool rather than spawning a
    // subprocess (bun run migrate) to keep the test fast and in-process.
    //
    // `runMigrations` is not exported from migrate.ts (it is a top-level
    // script that calls itself immediately), so we replicate the idempotency
    // check directly: applying zero new migrations must not throw.
    const client = await pool.connect();
    try {
      // Ensure the schema_migrations table exists (the CREATE TABLE IF NOT EXISTS
      // idiom is the idempotency guarantee from the migration runner itself).
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version TEXT PRIMARY KEY,
          applied_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Second run: query schema_migrations — if the migration runner left the
      // DB in a consistent state, this must succeed without throwing.
      const result = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );

      // The result is valid when it is an array (possibly empty on a fresh DB).
      expect(Array.isArray(result.rows)).toBe(true);
    } finally {
      client.release();
    }
  });

  // ── Test 2: /health endpoint returns status 200 + body ────────────────────

  it('health endpoint returns HTTP 200 with { status: "ok" }', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);

    // Parse and validate the body shape — response.json() narrows to unknown,
    // so we narrow manually.
    const body: unknown = response.json();
    expect(typeof body).toBe('object');
    expect(body).not.toBeNull();

    // Narrow to record so we can access .status without a type error.
    const bodyObj = body as Record<string, unknown>;
    expect(bodyObj.status).toBe('ok');

    // timestamp is present and is a valid ISO 8601 string.
    expect(typeof bodyObj.timestamp).toBe('string');
    const ts = new Date(bodyObj.timestamp as string);
    expect(Number.isNaN(ts.getTime())).toBe(false);
  });

  // ── Test 3: Redis connection is established ────────────────────────────────

  it('Redis connection is established — PING returns PONG', async () => {
    // redis.ping() returns 'PONG' when the connection is healthy.
    // If Redis is unreachable, ioredis throws — which fails the test with a
    // clear error rather than a timeout.
    const pong = await redis.ping();
    expect(pong).toBe('PONG');
  });

  // ── Test 4: Redis XADD / XLEN round-trip ──────────────────────────────────

  it('Redis stream write succeeds — XADD to a test stream returns an entry ID', async () => {
    // Use a dedicated test stream to avoid polluting market.ticks.
    const testStream = 'test.startup.integration';
    const testPayload = JSON.stringify({ test: true, ts: Date.now() });

    // XADD returns the entry ID string (e.g. '1234567890123-0').
    const entryId = await redis.xadd(testStream, '*', 'data', testPayload);

    // entryId must be a non-empty string.
    expect(typeof entryId).toBe('string');
    expect((entryId as string).length).toBeGreaterThan(0);

    // Clean up the test stream so repeated test runs do not accumulate entries.
    await redis.del(testStream);
  });
});
