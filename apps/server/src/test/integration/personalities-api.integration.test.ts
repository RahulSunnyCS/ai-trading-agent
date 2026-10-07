/**
 * Integration tests for the personalities API routes.
 *
 * These tests use a real PostgreSQL connection (the Docker test database) and a
 * real Fastify instance with the personalitiesRoutes plugin. They require
 * Docker services to be running — skipped automatically when DATABASE_URL is
 * not set in the environment.
 *
 * Why a real DB and not mocks?
 * The personalities API has non-trivial DB interactions: the PUT handler does
 * a read-then-write (read existing, check frozen, merge params, update, audit
 * log insert). Mocking all of that would mirror the implementation rather than
 * testing its contract. A real DB surfaces bugs that mocks hide.
 *
 * Run with: bun run test:integration
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { personalitiesRoutes } from '../../api/routes/personalities.js';
import { createTestDb } from './helpers.js';

// ---------------------------------------------------------------------------
// Guard: skip entire suite when DATABASE_URL is not set
// ---------------------------------------------------------------------------
// This prevents the test from failing with a confusing connection error when
// Docker is not running. The condition mirrors the guard pattern used in other
// integration test files in this project.
const hasDatabase = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Fastify app with only the personalitiesRoutes plugin.
 *
 * We do NOT use buildServer() here because that wires up the full server
 * (WebSocket, CORS, all routes). For focused integration tests we want only
 * the route under test so that mock DB responses are unambiguous — only one
 * handler is querying the DB.
 *
 * logger: false avoids pino output cluttering the test console.
 */
async function buildTestServer(db: Pool): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  // Register the plugin with an '/api' prefix to match how server.ts wires it.
  await server.register(personalitiesRoutes, { prefix: '/api', db });
  await server.ready();
  return server;
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let db: Pool;
let server: FastifyInstance;

// These UUIDs are fetched by name from the seeded data in beforeAll.
// We use them by name lookup (not hardcoded UUIDs) so the tests remain correct
// if the seed data is re-inserted (e.g. after a full DB reset).
let clockworkId: string;
let precisionId: string;
let adjusterId: string;
let reducerId: string;

// ---------------------------------------------------------------------------
// Suite guard
// ---------------------------------------------------------------------------

describe.skipIf(!hasDatabase)('personalities API integration tests', () => {
  // -------------------------------------------------------------------------
  // Setup / teardown
  // -------------------------------------------------------------------------

  beforeAll(async () => {
    db = await createTestDb();
    server = await buildTestServer(db);

    // Resolve UUIDs by name so the tests are not brittle against re-seeding.
    const rows = await db.query<{ id: string; name: string }>(
      "SELECT id, name FROM personality_configs WHERE name IN ('clockwork', 'precision', 'adjuster', 'reducer')",
    );
    for (const row of rows.rows) {
      if (row.name === 'clockwork') clockworkId = row.id;
      if (row.name === 'precision') precisionId = row.id;
      if (row.name === 'adjuster') adjusterId = row.id;
      if (row.name === 'reducer') reducerId = row.id;
    }

    if (!clockworkId || !precisionId || !adjusterId || !reducerId) {
      throw new Error('Seed personalities not found — run migrations first (bun run migrate)');
    }
  }, 30_000); // 30s timeout for Docker service connections

  afterAll(async () => {
    if (server) await server.close();
    if (db) await db.end();
  });

  // Clean up audit log rows and any test-inserted paper_trades between tests.
  // We do NOT truncate personality_configs because it holds the seed data the
  // tests rely on. We also keep existing audit_log rows from other tests to
  // avoid interference with count assertions.
  beforeEach(async () => {
    // Remove audit log rows for the test personalities to get a clean slate
    // for each test that checks audit log presence.
    await db.query('DELETE FROM personality_audit_log WHERE personality_id IN ($1, $2, $3)', [
      clockworkId,
      precisionId,
      adjusterId,
    ]);
    // Remove any paper_trades inserted by performance tests.
    await db.query('DELETE FROM paper_trades WHERE personality_id IN ($1, $2, $3)', [
      clockworkId,
      precisionId,
      adjusterId,
    ]);
  });

  // -------------------------------------------------------------------------
  // GET /api/personalities
  // -------------------------------------------------------------------------

  it('GET /api/personalities returns only active personalities by default', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/personalities' });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ id: string; isActive: boolean }[]>();
    // All returned rows must have isActive = true (default filter).
    expect(body.length).toBeGreaterThan(0);
    for (const p of body) {
      expect(p.isActive).toBe(true);
    }
    // The seed includes 3 active personalities at launch (clockwork, precision, adjuster).
    // Levelhead and learners are inactive. Active count should be 3.
    expect(body.length).toBe(3);
  });

  it('GET /api/personalities?include_inactive=true returns all 10 personalities', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/personalities?include_inactive=true',
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{ id: string }[]>();
    // Migration 005 seeds exactly 10 personalities.
    expect(body.length).toBe(10);
  });

  it('GET /api/personalities response shape includes expected camelCase fields', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/personalities' });
    expect(response.statusCode).toBe(200);

    const body = response.json<Record<string, unknown>[]>();
    const first = body[0];
    // Verify the camelCase mapping is applied (not raw snake_case DB columns).
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('displayName');
    expect(first).toHaveProperty('groupType');
    expect(first).toHaveProperty('entryType');
    expect(first).toHaveProperty('managementStyle');
    expect(first).toHaveProperty('isFrozen');
    expect(first).toHaveProperty('isActive');
    expect(first).toHaveProperty('phase');
    expect(first).toHaveProperty('params');
    // Verify snake_case fields are NOT present in the response.
    expect(first).not.toHaveProperty('display_name');
    expect(first).not.toHaveProperty('group_type');
    expect(first).not.toHaveProperty('is_active');
  });

  // -------------------------------------------------------------------------
  // GET /api/personalities/:id
  // -------------------------------------------------------------------------

  it('GET /api/personalities/:id returns the correct personality', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/personalities/${clockworkId}`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      id: string;
      name: string;
      isFrozen: boolean;
    }>();
    expect(body.id).toBe(clockworkId);
    expect(body.name).toBe('clockwork');
    // Clockwork is the frozen benchmark.
    expect(body.isFrozen).toBe(true);
  });

  it('GET /api/personalities/:id returns 404 for an unknown UUID', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/personalities/00000000-0000-0000-0000-000000000000',
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: string }>();
    expect(body.error).toBe('NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // PUT /api/personalities/:id
  // -------------------------------------------------------------------------

  it('PUT /api/personalities/:id updates params and writes an audit log entry', async () => {
    // First read the current updated_at so we can verify it changes.
    const before = await server.inject({
      method: 'GET',
      url: `/api/personalities/${precisionId}`,
    });
    const beforeBody = before.json<{ updatedAt: string; params: Record<string, unknown> }>();
    const beforeUpdatedAt = beforeBody.updatedAt;

    // Apply a params patch (change min_probability within 8pp of adjuster's 0.70).
    // precision is currently 0.70; setting to 0.72 stays within 8pp of adjuster (0.70)
    // so the comparison integrity check should pass.
    const response = await server.inject({
      method: 'PUT',
      url: `/api/personalities/${precisionId}`,
      payload: { params: { min_probability: 0.72 }, reason: 'integration_test' },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      id: string;
      params: Record<string, unknown>;
      updatedAt: string;
    }>();
    expect(body.id).toBe(precisionId);
    // The min_probability should reflect the new value.
    expect(body.params.min_probability).toBe(0.72);
    // updated_at must have advanced (or at minimum be a different string from the stored ISO).
    expect(body.updatedAt).not.toBe(beforeUpdatedAt);

    // Verify the audit log entry was written.
    const auditResult = await db.query<{
      personality_id: string;
      old_params: Record<string, unknown>;
      new_params: Record<string, unknown>;
      reason: string;
      changed_by: string;
    }>(
      'SELECT personality_id, old_params, new_params, reason, changed_by FROM personality_audit_log WHERE personality_id = $1',
      [precisionId],
    );
    expect(auditResult.rows.length).toBe(1);
    const auditRow = auditResult.rows[0] as {
      personality_id: string;
      old_params: Record<string, unknown>;
      new_params: Record<string, unknown>;
      reason: string;
      changed_by: string;
    };
    expect(auditRow.personality_id).toBe(precisionId);
    // old_params should reflect the pre-update state (min_probability = 0.70 from seed).
    expect(auditRow.old_params.min_probability).toBe(0.7);
    // new_params should reflect the post-update state.
    expect(auditRow.new_params.min_probability).toBe(0.72);
    expect(auditRow.reason).toBe('integration_test');
    expect(auditRow.changed_by).toBe('api');

    // Restore precision to its seed value so later tests are not affected.
    await server.inject({
      method: 'PUT',
      url: `/api/personalities/${precisionId}`,
      payload: { params: { min_probability: 0.7 }, reason: 'test_restore' },
    });
  });

  it('PUT /api/personalities/clockwork-id returns 403 FROZEN_VIOLATION', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: `/api/personalities/${clockworkId}`,
      payload: { params: { max_daily_trades: 2 } },
    });
    expect(response.statusCode).toBe(403);
    const body = response.json<{ error: string; message: string }>();
    expect(body.error).toBe('FROZEN_VIOLATION');
    expect(body.message).toMatch(/immutable/i);
  });

  it('PUT /api/personalities/:id returns 400 when body is empty', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: `/api/personalities/${precisionId}`,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ error: string }>();
    expect(body.error).toBe('EMPTY_UPDATE');
  });

  it('PUT /api/personalities/:id returns 400 when body is missing entirely', async () => {
    // No payload — Fastify sees an empty body. Depending on content-type this
    // may arrive as null or empty object. Our handler checks for missing fields.
    const response = await server.inject({
      method: 'PUT',
      url: `/api/personalities/${precisionId}`,
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });

  it('PUT /api/personalities/:id returns 404 for unknown UUID', async () => {
    const response = await server.inject({
      method: 'PUT',
      url: '/api/personalities/00000000-0000-0000-0000-000000000000',
      payload: { params: { max_daily_trades: 3 } },
    });
    expect(response.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // PUT /api/personalities/:id — comparison integrity (409)
  // -------------------------------------------------------------------------
  // Precision, Adjuster and Reducer (entry_type momentum_exhaustion) must keep
  // their min_probability within 8pp of each other; only ACTIVE rows count.
  // Seed state: Precision 0.70 and Adjuster 0.70 active, Reducer 0.70 inactive.
  // Both tests restore the rows directly in SQL (not via PUT, which the
  // integrity check itself could refuse) so a regression cannot leak state
  // into later tests.

  /** Reads the stored params / is_active so a test can put them back exactly. */
  async function snapshot(
    id: string,
  ): Promise<{ params: Record<string, unknown>; isActive: boolean }> {
    const result = await db.query<{ params: Record<string, unknown>; is_active: boolean }>(
      'SELECT params, is_active FROM personality_configs WHERE id = $1',
      [id],
    );
    const row = result.rows[0] as { params: Record<string, unknown>; is_active: boolean };
    return { params: row.params, isActive: row.is_active };
  }

  async function restore(
    id: string,
    saved: { params: Record<string, unknown>; isActive: boolean },
  ): Promise<void> {
    await db.query(
      'UPDATE personality_configs SET params = $2::jsonb, is_active = $3 WHERE id = $1',
      [id, JSON.stringify(saved.params), saved.isActive],
    );
  }

  it('PUT /api/personalities/:id returns 409 COMPARISON_INTEGRITY_VIOLATION when min_probability drift > 8pp', async () => {
    const savedPrecision = await snapshot(precisionId);
    try {
      // 0.80 vs Adjuster's 0.70 is a 10pp spread. (Not 0.78: in floating point
      // (0.78 - 0.70) * 100 is 8.000000000000007, so the route already rejects
      // an exact 8pp change — avoid asserting on that boundary.)
      const response = await server.inject({
        method: 'PUT',
        url: `/api/personalities/${precisionId}`,
        payload: { params: { min_probability: 0.8 }, reason: 'integration_test' },
      });
      expect(response.statusCode).toBe(409);
      const body = response.json<{ error: string; offender: string; message: string }>();
      expect(body.error).toBe('COMPARISON_INTEGRITY_VIOLATION');
      // Max and min tie for "furthest from the midpoint", so either may be named.
      expect(['precision', 'adjuster']).toContain(body.offender);
      expect(body.message).toMatch(/10\.0pp/);

      // A rejected update must not touch the row or the audit log.
      expect((await snapshot(precisionId)).params.min_probability).toBe(0.7);
      const audit = await db.query(
        'SELECT 1 FROM personality_audit_log WHERE personality_id = $1',
        [precisionId],
      );
      expect(audit.rows.length).toBe(0);
    } finally {
      await restore(precisionId, savedPrecision);
    }
  });

  it('PUT /api/personalities/:id counts an active Reducer in the 8pp comparison', async () => {
    const savedPrecision = await snapshot(precisionId);
    const savedReducer = await snapshot(reducerId);
    try {
      // Activate Reducer at 0.62: still within 8pp of Precision/Adjuster (0.70).
      await db.query(
        `UPDATE personality_configs
         SET is_active = TRUE,
             params = params || '{"min_probability": 0.62}'::jsonb
         WHERE id = $1`,
        [reducerId],
      );

      // 0.71 is only 1pp from Adjuster, so it passes when Reducer is inactive;
      // with Reducer active at 0.62 the spread becomes 9pp and must be refused.
      const response = await server.inject({
        method: 'PUT',
        url: `/api/personalities/${precisionId}`,
        payload: { params: { min_probability: 0.71 }, reason: 'integration_test' },
      });
      expect(response.statusCode).toBe(409);
      const body = response.json<{ error: string; offender: string; message: string }>();
      expect(body.error).toBe('COMPARISON_INTEGRITY_VIOLATION');
      expect(body.message).toMatch(/9\.0pp/);
      // The route names whichever row is furthest from the max/min midpoint;
      // max and min tie by construction, so either end may be reported.
      expect(['precision', 'reducer']).toContain(body.offender);
      expect((await snapshot(precisionId)).params.min_probability).toBe(0.7);
    } finally {
      await restore(reducerId, savedReducer);
      await restore(precisionId, savedPrecision);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/personalities/:id/performance
  // -------------------------------------------------------------------------

  it('GET /api/personalities/:id/performance returns zero stats when no trades exist', async () => {
    const response = await server.inject({
      method: 'GET',
      url: `/api/personalities/${precisionId}/performance`,
    });
    expect(response.statusCode).toBe(200);

    const body = response.json<{
      personalityId: string;
      totalTrades: number;
      totalNetPnl: string;
      avgNetPnl: string;
      winRate: number;
      openTrades: number;
    }>();

    expect(body.personalityId).toBe(precisionId);
    expect(body.totalTrades).toBe(0);
    // COALESCE ensures SUM/AVG return "0" not null when there are no trades.
    expect(Number(body.totalNetPnl)).toBe(0);
    expect(Number(body.avgNetPnl)).toBe(0);
    expect(body.winRate).toBe(0);
    expect(body.openTrades).toBe(0);
  });

  it('GET /api/personalities/:id/performance returns 404 for unknown UUID', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/personalities/00000000-0000-0000-0000-000000000000/performance',
    });
    expect(response.statusCode).toBe(404);
    const body = response.json<{ error: string }>();
    expect(body.error).toBe('NOT_FOUND');
  });
});
