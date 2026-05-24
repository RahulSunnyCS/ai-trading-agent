/**
 * Integration tests for fetchDailyState (T-26) — personality filter daily state
 * from a real PostgreSQL database.
 *
 * These tests verify that fetchDailyState returns the correct trade count, net
 * P&L, and open-position count by querying real paper_trades rows. They are the
 * regression suite for the M1 bug where todayNetPnl was hardcoded as '0' in
 * PositionMonitor rather than being computed from closed trades.
 *
 * Why a real DB and not mocks?
 * The bug was caused by the wrong column being summed at the wrong DB layer.
 * A mock would pass regardless of whether the SQL query is correct. Only a real
 * DB with real rows can catch a wrong WHERE clause or a missing SUM() call.
 *
 * Each test is self-contained: it inserts its own rows and cleans up after itself
 * in afterEach so tests never share data.
 *
 * Requires Docker services (PostgreSQL with TimescaleDB) to be running.
 * Run with: bun run test:integration
 */

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fetchDailyState } from '../../signals/personality-filter.js';
import { createTestDb } from './helpers.js';

// ---------------------------------------------------------------------------
// Guard: skip entire suite when DATABASE_URL is not set
// ---------------------------------------------------------------------------

const hasDatabase = Boolean(process.env.DATABASE_URL);

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let db: Pool;

// UUID of the personality we use for filter tests — resolved by name in beforeAll.
let precisionId: string;

// The fixed IST date used for all "today" assertions in this file.
// IST date 2026-05-19 corresponds to any time on that calendar date in IST.
// We anchor all entry_time values to IST noon (06:30 UTC) so they fall on this
// date regardless of the test runner's timezone.
const TODAY_IST = '2026-05-19';
// Noon IST on TODAY_IST expressed as UTC for INSERT timestamps.
const TODAY_IST_NOON_UTC = '2026-05-19T06:30:00.000Z';

// Yesterday's noon UTC — used to insert out-of-window trades that must NOT
// be counted in today's totals.
const YESTERDAY_IST_NOON_UTC = '2026-05-18T06:30:00.000Z';

// Collected IDs of rows inserted in each test, cleared in afterEach.
const insertedTradeIds: string[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a closed paper_trade with the given net_pnl for the test personality,
 * using the supplied entry_time (ISO string). Returns the inserted row's UUID.
 *
 * The minimal required columns are satisfied (straddle_at_entry,
 * lowest_straddle_value_seen). All nullable columns that are not relevant to
 * fetchDailyState are omitted (DEFAULT NULL).
 */
async function insertClosedTrade(
  netPnl: number,
  entryTimeIso: string = TODAY_IST_NOON_UTC,
): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO paper_trades
       (personality_id, status, net_pnl, gross_pnl, straddle_at_entry, lowest_straddle_value_seen, entry_time)
     VALUES ($1, 'closed', $2, $2, 200, 200, $3::timestamptz)
     RETURNING id`,
    [precisionId, netPnl, entryTimeIso],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertClosedTrade: no id returned');
  insertedTradeIds.push(id);
  return id;
}

/**
 * Inserts an open paper_trade for the test personality. Returns the inserted
 * row's UUID. No net_pnl is set (open trades don't have one yet).
 */
async function insertOpenTrade(entryTimeIso: string = TODAY_IST_NOON_UTC): Promise<string> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO paper_trades
       (personality_id, status, straddle_at_entry, lowest_straddle_value_seen, entry_time)
     VALUES ($1, 'open', 200, 200, $2::timestamptz)
     RETURNING id`,
    [precisionId, entryTimeIso],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('insertOpenTrade: no id returned');
  insertedTradeIds.push(id);
  return id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!hasDatabase)('fetchDailyState integration tests (T-26 regression)', () => {
  beforeAll(async () => {
    db = await createTestDb();

    // Resolve the precision personality UUID from the seed data.
    const rows = await db.query<{ id: string }>(
      "SELECT id FROM personality_configs WHERE name = 'precision'",
    );
    if (rows.rows.length === 0) {
      throw new Error(
        "Seed personality 'precision' not found — run migrations first (bun run migrate)",
      );
    }
    precisionId = rows.rows[0]!.id;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.end();
  });

  afterEach(async () => {
    // Delete every row inserted in the current test to prevent state leakage.
    if (insertedTradeIds.length > 0) {
      await db.query('DELETE FROM paper_trades WHERE id = ANY($1::uuid[])', [insertedTradeIds]);
      insertedTradeIds.length = 0;
    }
  });

  // -------------------------------------------------------------------------
  // Happy path: no trades
  // -------------------------------------------------------------------------

  it("returns zero tradeCount, netPnl='0', and openPositions=0 when no trades exist for today", async () => {
    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    expect(state.tradeCount).toBe(0);
    // COALESCE(SUM(net_pnl), 0) must return '0' when there are no rows.
    // We compare as a number to be resilient to '0', '0.00', etc.
    expect(Number(state.netPnl)).toBe(0);
    expect(state.openPositions).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Stage 2 regression: todayNetPnl was always '0' (M1 bug)
  // -------------------------------------------------------------------------

  it("correctly sums net_pnl from 3 closed trades (regression for M1 todayNetPnl='0' bug)", async () => {
    // Insert 3 closed trades with net_pnl values -3000, -2000, -2500.
    // Expected sum: -7500.
    await insertClosedTrade(-3000);
    await insertClosedTrade(-2000);
    await insertClosedTrade(-2500);

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    expect(state.tradeCount).toBe(3);
    // The precision personality has max_daily_loss = 8000, which means it blocks
    // when netPnl <= -8000. At -7500 Stage 2 should pass.
    // We convert to Number because pg returns NUMERIC as a string.
    expect(Number(state.netPnl)).toBe(-7500);
  });

  it('Stage 2 passes when net_pnl sum is -7500 (below the 8000 max_daily_loss limit)', async () => {
    // This test verifies the filter logic at the boundary: -7500 < -8000 is false,
    // so Stage 2 must pass (the personality has not yet hit its loss limit).
    await insertClosedTrade(-3000);
    await insertClosedTrade(-2000);
    await insertClosedTrade(-2500);

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    const maxDailyLoss = 8000;
    // Stage 2 check from personality-filter.ts:
    //   if (parseFloat(dailyState.netPnl) <= -maxDailyLoss) → reject
    const wouldReject = Number.parseFloat(state.netPnl) <= -maxDailyLoss;
    expect(wouldReject).toBe(false);
  });

  it('Stage 2 blocks when a 4th trade brings net_pnl sum to -8500 (exceeds max_daily_loss=8000)', async () => {
    // After 3 trades at -7500 total, add one more at -1000 → -8500.
    await insertClosedTrade(-3000);
    await insertClosedTrade(-2000);
    await insertClosedTrade(-2500);
    await insertClosedTrade(-1000);

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    expect(state.tradeCount).toBe(4);
    expect(Number(state.netPnl)).toBe(-8500);

    // At -8500, Stage 2's condition (netPnl <= -8000) is true → should block.
    const maxDailyLoss = 8000;
    const wouldReject = Number.parseFloat(state.netPnl) <= -maxDailyLoss;
    expect(wouldReject).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Date filtering: only today's IST trades are counted
  // -------------------------------------------------------------------------

  it("does not count closed trades from yesterday's IST date", async () => {
    // Insert one closed trade from yesterday and one from today.
    await insertClosedTrade(-5000, YESTERDAY_IST_NOON_UTC);
    await insertClosedTrade(-1000, TODAY_IST_NOON_UTC);

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    // Only the trade entered today (IST) must appear.
    expect(state.tradeCount).toBe(1);
    expect(Number(state.netPnl)).toBe(-1000);
  });

  // -------------------------------------------------------------------------
  // Open positions counter
  // -------------------------------------------------------------------------

  it('counts open trades regardless of date (open positions can carry over days)', async () => {
    // One open trade from today, one from yesterday.
    // fetchDailyState Query 2 has no date filter for open positions — by design,
    // a stale open position from a prior day should still be counted.
    await insertOpenTrade(TODAY_IST_NOON_UTC);
    await insertOpenTrade(YESTERDAY_IST_NOON_UTC);

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    // Both open trades must appear in openPositions (no date filter on the open query).
    expect(state.openPositions).toBe(2);
    // No closed trades, so tradeCount and netPnl are zero.
    expect(state.tradeCount).toBe(0);
    expect(Number(state.netPnl)).toBe(0);
  });

  it('does not count open trades in tradeCount or netPnl (only closed trades are summed)', async () => {
    // One closed trade and one open trade — only the closed one must count.
    await insertClosedTrade(-2000);
    await insertOpenTrade();

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    // tradeCount counts only closed trades.
    expect(state.tradeCount).toBe(1);
    expect(Number(state.netPnl)).toBe(-2000);
    // The open trade is counted separately.
    expect(state.openPositions).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Positive P&L (profitable day)
  // -------------------------------------------------------------------------

  it('correctly sums positive net_pnl for a profitable day', async () => {
    await insertClosedTrade(1500);
    await insertClosedTrade(2000);

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    expect(state.tradeCount).toBe(2);
    expect(Number(state.netPnl)).toBe(3500);
  });

  // -------------------------------------------------------------------------
  // Mixed P&L (win + loss)
  // -------------------------------------------------------------------------

  it('correctly sums mixed positive and negative net_pnl', async () => {
    await insertClosedTrade(3000);
    await insertClosedTrade(-1000);

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    expect(state.tradeCount).toBe(2);
    expect(Number(state.netPnl)).toBe(2000);
  });

  // -------------------------------------------------------------------------
  // Isolation: trades for another personality don't bleed in
  // -------------------------------------------------------------------------

  it('only counts trades belonging to the queried personality, not other personalities', async () => {
    // Find a second personality (adjuster) to insert trades for — these must
    // NOT appear in precision's daily state.
    const adjusterRows = await db.query<{ id: string }>(
      "SELECT id FROM personality_configs WHERE name = 'adjuster'",
    );
    const adjusterId = adjusterRows.rows[0]?.id;
    if (!adjusterId) throw new Error('adjuster personality not found');

    // Insert a trade for adjuster (not precision).
    const adjResult = await db.query<{ id: string }>(
      `INSERT INTO paper_trades
         (personality_id, status, net_pnl, gross_pnl, straddle_at_entry, lowest_straddle_value_seen, entry_time)
       VALUES ($1, 'closed', -9000, -9000, 200, 200, $2::timestamptz)
       RETURNING id`,
      [adjusterId, TODAY_IST_NOON_UTC],
    );
    const adjTradeId = adjResult.rows[0]?.id;
    if (adjTradeId) insertedTradeIds.push(adjTradeId);

    // Insert one trade for precision.
    await insertClosedTrade(-500);

    const state = await fetchDailyState(db, precisionId, TODAY_IST);

    // Only precision's trade (-500) must appear — the adjuster's -9000 must be excluded.
    expect(state.tradeCount).toBe(1);
    expect(Number(state.netPnl)).toBe(-500);
  });
});
