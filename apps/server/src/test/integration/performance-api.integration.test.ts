/**
 * Integration tests for the personalities performance API (T-32).
 *
 * These tests verify two specific behaviours:
 *
 *   1. The performance endpoint excludes pre-M2 NULL personality_id rows from
 *      the aggregation (NULL rows are legacy Sprint 1 trades). The SQL query
 *      uses WHERE personality_id = $1, so NULLs are excluded automatically —
 *      these tests confirm that the SQL is correct and no NULL rows accidentally
 *      inflate the totals.
 *
 *   2. The personalities list returns the correct count of active personalities
 *      (3 active at launch as per seed migration 005) and 10 total when
 *      include_inactive=true is set.
 *
 * Why a real DB?
 * The performance endpoint's WHERE clause must exclude NULL personality_id rows.
 * A mock DB could be made to return any value — only a real query against real
 * rows with real NULLs can confirm that the SQL filter works correctly.
 *
 * Requires Docker services (PostgreSQL with TimescaleDB) to be running.
 * Run with: bun run test:integration
 */

import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { personalitiesRoutes } from '../../api/routes/personalities.js';
import { createTestDb } from './helpers.js';

// ---------------------------------------------------------------------------
// Guard: skip entire suite when DATABASE_URL is not set
// ---------------------------------------------------------------------------

const hasDatabase = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Builds a minimal Fastify app with only the personalitiesRoutes plugin.
 * Mirrors the approach used in personalities-api.integration.test.ts to keep
 * the DB mock surface clean — only the personalities route queries the DB.
 */
async function buildTestServer(db: Pool): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await server.register(personalitiesRoutes, { prefix: '/api', db });
  await server.ready();
  return server;
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let db: Pool;
let server: FastifyInstance;

// UUIDs resolved by name from the seeded personalities.
let precisionId: string;
let adjusterId: string;

// IDs of paper_trades rows inserted by the current test — cleaned up in afterEach.
const insertedTradeIds: string[] = [];

// A fixed entry_time that falls on a known date so the query does not produce
// unexpected date-range side-effects in other tests.
const ENTRY_TIME_UTC = '2026-05-19T06:30:00.000Z';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasDatabase)(
  'performance API — NULL row exclusion and active personality count (T-32)',
  () => {
    beforeAll(async () => {
      db = await createTestDb();
      server = await buildTestServer(db);

      // Resolve personality UUIDs from the seed data.
      const rows = await db.query<{ id: string; name: string }>(
        "SELECT id, name FROM personality_configs WHERE name IN ('precision', 'adjuster')",
      );
      for (const row of rows.rows) {
        if (row.name === 'precision') precisionId = row.id;
        if (row.name === 'adjuster') adjusterId = row.id;
      }

      if (!precisionId || !adjusterId) {
        throw new Error('Seed personalities not found — run migrations first (bun run migrate)');
      }
    }, 30_000);

    afterAll(async () => {
      if (server) await server.close();
      if (db) await db.end();
    });

    afterEach(async () => {
      // Remove all paper_trades rows inserted by the current test.
      if (insertedTradeIds.length > 0) {
        await db.query('DELETE FROM paper_trades WHERE id = ANY($1::uuid[])', [insertedTradeIds]);
        insertedTradeIds.length = 0;
      }
      // Remove audit log entries that PUT tests may have inserted.
      await db.query('DELETE FROM personality_audit_log WHERE personality_id IN ($1, $2)', [
        precisionId,
        adjusterId,
      ]);
    });

    // -------------------------------------------------------------------------
    // Performance endpoint: NULL personality_id rows are excluded
    // -------------------------------------------------------------------------

    it('GET /api/personalities/:id/performance excludes pre-M2 NULL personality_id rows from trade count', async () => {
      // Insert 2 legacy (pre-M2) paper_trades with NULL personality_id.
      // These rows simulate Sprint 1 trades created before the personality engine
      // was deployed. They must NOT appear in precision's total_trades count.
      for (let i = 0; i < 2; i++) {
        const legacyResult = await db.query<{ id: string }>(
          `INSERT INTO paper_trades
           (personality_id, status, net_pnl, gross_pnl, straddle_at_entry, lowest_straddle_value_seen, entry_time)
         VALUES (NULL, 'closed', 500, 500, 200, 200, $1::timestamptz)
         RETURNING id`,
          [ENTRY_TIME_UTC],
        );
        const id = legacyResult.rows[0]?.id;
        if (id) insertedTradeIds.push(id);
      }

      // Insert 1 paper_trade that belongs to precision (the personality under test).
      const precisionResult = await db.query<{ id: string }>(
        `INSERT INTO paper_trades
         (personality_id, status, net_pnl, gross_pnl, straddle_at_entry, lowest_straddle_value_seen, entry_time)
       VALUES ($1, 'closed', 750, 750, 200, 200, $2::timestamptz)
       RETURNING id`,
        [precisionId, ENTRY_TIME_UTC],
      );
      const precisionTradeId = precisionResult.rows[0]?.id;
      if (precisionTradeId) insertedTradeIds.push(precisionTradeId);

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

      // Only the 1 precision-owned trade must be counted — the 2 NULL rows must be excluded.
      expect(body.personalityId).toBe(precisionId);
      expect(body.totalTrades).toBe(1);
      expect(Number(body.totalNetPnl)).toBe(750);
      expect(body.winRate).toBe(1); // 1 winning trade / 1 total = 100%
    });

    it('GET /api/personalities/:id/performance returns zero stats even when many NULL-personality trades exist', async () => {
      // Insert 5 legacy trades with NULL personality_id. Precision itself has no trades.
      for (let i = 0; i < 5; i++) {
        const result = await db.query<{ id: string }>(
          `INSERT INTO paper_trades
           (personality_id, status, net_pnl, gross_pnl, straddle_at_entry, lowest_straddle_value_seen, entry_time)
         VALUES (NULL, 'closed', 1000, 1000, 200, 200, $1::timestamptz)
         RETURNING id`,
          [ENTRY_TIME_UTC],
        );
        const id = result.rows[0]?.id;
        if (id) insertedTradeIds.push(id);
      }

      const response = await server.inject({
        method: 'GET',
        url: `/api/personalities/${precisionId}/performance`,
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        totalTrades: number;
        totalNetPnl: string;
        winRate: number;
        openTrades: number;
      }>();

      // Zero precision-owned trades — the 5 NULL rows must not be counted.
      expect(body.totalTrades).toBe(0);
      expect(Number(body.totalNetPnl)).toBe(0);
      expect(body.winRate).toBe(0);
      expect(body.openTrades).toBe(0);
    });

    it('GET /api/personalities/:id/performance trades from a different personality are not included', async () => {
      // Insert 3 closed trades for adjuster — these must NOT appear in precision's stats.
      for (let i = 0; i < 3; i++) {
        const result = await db.query<{ id: string }>(
          `INSERT INTO paper_trades
           (personality_id, status, net_pnl, gross_pnl, straddle_at_entry, lowest_straddle_value_seen, entry_time)
         VALUES ($1, 'closed', 2000, 2000, 200, 200, $2::timestamptz)
         RETURNING id`,
          [adjusterId, ENTRY_TIME_UTC],
        );
        const id = result.rows[0]?.id;
        if (id) insertedTradeIds.push(id);
      }

      // Insert 1 trade for precision.
      const precResult = await db.query<{ id: string }>(
        `INSERT INTO paper_trades
         (personality_id, status, net_pnl, gross_pnl, straddle_at_entry, lowest_straddle_value_seen, entry_time)
       VALUES ($1, 'closed', -300, -300, 200, 200, $2::timestamptz)
       RETURNING id`,
        [precisionId, ENTRY_TIME_UTC],
      );
      const precId = precResult.rows[0]?.id;
      if (precId) insertedTradeIds.push(precId);

      const response = await server.inject({
        method: 'GET',
        url: `/api/personalities/${precisionId}/performance`,
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        totalTrades: number;
        totalNetPnl: string;
        winRate: number;
      }>();

      // Only precision's 1 trade must appear. Adjuster's 3 trades are excluded.
      expect(body.totalTrades).toBe(1);
      expect(Number(body.totalNetPnl)).toBe(-300);
      expect(body.winRate).toBe(0); // losing trade
    });

    // -------------------------------------------------------------------------
    // Active / total personality count
    // -------------------------------------------------------------------------

    it('GET /api/personalities returns only active personalities (3 active at launch)', async () => {
      // The seed migration activates exactly 3 personalities at launch:
      //   clockwork, precision, adjuster
      // All others (scanner, reducer, blitz, levelhead, learners) are inactive.
      const response = await server.inject({ method: 'GET', url: '/api/personalities' });
      expect(response.statusCode).toBe(200);

      const body = response.json<{ id: string; isActive: boolean; name: string }[]>();
      expect(body.length).toBe(3);
      for (const p of body) {
        expect(p.isActive).toBe(true);
      }
      // The 3 active personalities must be the reference group launched in Sprint 1.
      const names = body.map((p) => p.name).sort();
      expect(names).toEqual(['adjuster', 'clockwork', 'precision']);
    });

    it('GET /api/personalities?include_inactive=true returns all 10 seeded personalities', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/api/personalities?include_inactive=true',
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{ id: string }[]>();
      expect(body.length).toBe(10);
    });

    // -------------------------------------------------------------------------
    // FROZEN_VIOLATION on Clockwork
    // -------------------------------------------------------------------------

    it('PUT /api/personalities/:clockworkId returns 403 FROZEN_VIOLATION', async () => {
      // Resolve Clockwork's UUID — not hardcoded, queried by name.
      const clockworkRows = await db.query<{ id: string }>(
        "SELECT id FROM personality_configs WHERE name = 'clockwork'",
      );
      const clockworkId = clockworkRows.rows[0]?.id;
      if (!clockworkId) throw new Error('Clockwork personality not found in seed data');

      const response = await server.inject({
        method: 'PUT',
        url: `/api/personalities/${clockworkId}`,
        payload: { params: { max_daily_trades: 2 }, reason: 'integration_test_frozen_check' },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json<{ error: string; message: string }>();
      expect(body.error).toBe('FROZEN_VIOLATION');
      // The message must indicate immutability in human-readable terms.
      expect(body.message).toMatch(/immutable/i);
    });

    // -------------------------------------------------------------------------
    // Performance endpoint: open_trades counter
    // -------------------------------------------------------------------------

    it('GET /api/personalities/:id/performance counts open trades separately from closed', async () => {
      // 2 closed trades and 1 open trade for precision.
      for (const netPnl of [1000, -200]) {
        const result = await db.query<{ id: string }>(
          `INSERT INTO paper_trades
           (personality_id, status, net_pnl, gross_pnl, straddle_at_entry, lowest_straddle_value_seen, entry_time)
         VALUES ($1, 'closed', $2, $2, 200, 200, $3::timestamptz)
         RETURNING id`,
          [precisionId, netPnl, ENTRY_TIME_UTC],
        );
        const id = result.rows[0]?.id;
        if (id) insertedTradeIds.push(id);
      }
      const openResult = await db.query<{ id: string }>(
        `INSERT INTO paper_trades
         (personality_id, status, straddle_at_entry, lowest_straddle_value_seen, entry_time)
       VALUES ($1, 'open', 200, 200, $2::timestamptz)
       RETURNING id`,
        [precisionId, ENTRY_TIME_UTC],
      );
      const openId = openResult.rows[0]?.id;
      if (openId) insertedTradeIds.push(openId);

      const response = await server.inject({
        method: 'GET',
        url: `/api/personalities/${precisionId}/performance`,
      });
      expect(response.statusCode).toBe(200);

      const body = response.json<{
        totalTrades: number;
        totalNetPnl: string;
        winRate: number;
        openTrades: number;
      }>();

      // totalTrades counts only closed trades.
      expect(body.totalTrades).toBe(2);
      // Total net P&L of the two closed trades: 1000 + (-200) = 800.
      expect(Number(body.totalNetPnl)).toBe(800);
      // 1 winning trade out of 2 closed = 50% win rate.
      expect(body.winRate).toBe(0.5);
      // The 1 open trade must be reported separately.
      expect(body.openTrades).toBe(1);
    });
  },
);
