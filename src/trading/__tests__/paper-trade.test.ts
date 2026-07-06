/**
 * Unit tests for paper-trade.ts — T-17
 *
 * All tests mock the pg.Pool — no real DB is needed.
 * The mock client follows the pattern: Pool.connect() returns a client with
 * a query() method that returns controlled shaped results.
 *
 * Because the functions call db.query() directly (not via a client), the mock
 * attaches query() on the Pool object itself.
 *
 * pg type notes replicated from paper-trade.ts:
 *   - NUMERIC columns come back as strings.
 *   - TIMESTAMPTZ comes back as Date.
 *   - DATE comes back as Date (midnight UTC).
 *   - id is a UUID (string) — the paper_trades table uses gen_random_uuid().
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type PaperTradeEntry,
  type PaperTradeExit,
  enterTrade,
  exitTrade,
  getOpenTrades,
  getTodayPnl,
} from '../paper-trade';

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock Pool whose query() method returns the supplied result.
 *
 * The return type is cast to Pool via `unknown` so TypeScript does not complain
 * about the partial implementation — we only exercise the methods the SUT uses.
 */
function makeMockPool(queryFn: (sql: string, params?: unknown[]) => unknown): import('pg').Pool {
  return {
    query: vi.fn(queryFn),
  } as unknown as import('pg').Pool;
}

/**
 * Build a realistic raw DB row for a paper trade.
 *
 * NUMERIC columns are strings (as pg returns them). Timestamps are Dates.
 * The `id` is a UUID string — the paper_trades table uses gen_random_uuid().
 */
function makeRawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    symbol: 'NIFTY',
    // pg returns DATE as a Date object at midnight UTC.
    expiry: new Date('2026-05-22T00:00:00Z'),
    strike: '24500.00',
    entry_straddle_value: '320.00',
    exit_straddle_value: null,
    // pg returns TIMESTAMPTZ as Date.
    entry_time: new Date('2026-05-19T04:05:00Z'), // 09:35 IST
    exit_time: null,
    exit_reason: null,
    pnl_abs: null,
    status: 'open',
    entry_type: 'MOMENTUM_EXHAUSTION',
    personality_id: null,
    ...overrides,
  };
}

/** A valid PaperTradeEntry used across multiple tests. */
const SAMPLE_ENTRY: PaperTradeEntry = {
  underlying: 'NIFTY',
  expiryDate: '2026-05-22',
  atmStrike: 24500,
  entryStraddleValue: 320,
  entryTimestamp: Date.UTC(2026, 4, 19, 4, 5, 0), // 09:35 IST in UTC ms
  entryType: 'MOMENTUM_EXHAUSTION',
};

// ---------------------------------------------------------------------------
// 1. enterTrade — inserts and returns a UUID string id
// ---------------------------------------------------------------------------

describe('enterTrade', () => {
  it('inserts a trade and returns the UUID string id from RETURNING id', async () => {
    const pool = makeMockPool(() => ({ rows: [{ id: 'uuid-42' }] }));

    const id = await enterTrade(pool, SAMPLE_ENTRY);

    expect(id).toBe('uuid-42');
    expect(id).toBeTypeOf('string');
  });

  it('calls db.query with the underlying, expiryDate, atmStrike, entryStraddleValue, entryTimestamp, entryType', async () => {
    const capturedArgs: unknown[][] = [];
    const pool = makeMockPool((_sql: string, params?: unknown[]) => {
      capturedArgs.push(params ?? []);
      return { rows: [{ id: 'uuid-7' }] };
    });

    await enterTrade(pool, SAMPLE_ENTRY);

    // At least one query was issued.
    expect(capturedArgs.length).toBeGreaterThan(0);
    // The first call's params must include the key entry values.
    const params = capturedArgs[0] ?? [];
    expect(params).toContain('NIFTY');
    expect(params).toContain('2026-05-22');
    expect(params).toContain(24500);
  });

  it('throws when the INSERT returns no rows', async () => {
    // Simulates a scenario where the INSERT silently fails and returns nothing.
    const pool = makeMockPool(() => ({ rows: [] }));

    await expect(enterTrade(pool, SAMPLE_ENTRY)).rejects.toThrow(
      /enterTrade: INSERT returned no rows/,
    );
  });

  it('passes personalityId when provided', async () => {
    const capturedArgs: unknown[][] = [];
    const pool = makeMockPool((_sql: string, params?: unknown[]) => {
      capturedArgs.push(params ?? []);
      return { rows: [{ id: 'uuid-trade-3' }] };
    });
    const entryWithPersonality: PaperTradeEntry = {
      ...SAMPLE_ENTRY,
      personalityId: 'uuid-personality-5',
    };

    const id = await enterTrade(pool, entryWithPersonality);

    expect(id).toBe('uuid-trade-3');
    const params = capturedArgs[0] ?? [];
    // personalityId must be in the params list.
    expect(params).toContain('uuid-personality-5');
  });
});

// ---------------------------------------------------------------------------
// 2 & 3. exitTrade — pnl = entryStraddleValue - exitStraddleValue; status = 'closed'
// ---------------------------------------------------------------------------

describe('exitTrade', () => {
  it('returns pnl = entryStraddleValue - exitStraddleValue for a short straddle', async () => {
    // Entry = 320, exit = 200 → pnl = 120 (profit, premium decayed).
    const rawRow = makeRawRow({
      exit_straddle_value: '200.00',
      exit_time: new Date('2026-05-19T09:30:00Z'), // 15:00 IST
      exit_reason: 'TARGET',
      pnl_abs: '120.00', // 320 - 200
      status: 'closed',
    });

    const pool = makeMockPool(() => ({ rows: [rawRow] }));
    const exit: PaperTradeExit = {
      tradeId: 'uuid-trade-1',
      exitStraddleValue: 200,
      exitTimestamp: Date.UTC(2026, 4, 19, 9, 30, 0),
      exitReason: 'TARGET',
    };

    const record = await exitTrade(pool, exit);

    expect(record.pnl).toBeCloseTo(120, 5);
    expect(record.exitStraddleValue).toBeCloseTo(200, 5);
  });

  it('returns negative pnl when straddle expanded (short straddle loss)', async () => {
    // Entry = 320, exit = 400 → pnl = -80 (loss).
    const rawRow = makeRawRow({
      exit_straddle_value: '400.00',
      exit_time: new Date('2026-05-19T07:45:00Z'), // 13:15 IST
      exit_reason: 'SL',
      pnl_abs: '-80.00',
      status: 'closed',
    });

    const pool = makeMockPool(() => ({ rows: [rawRow] }));
    const exit: PaperTradeExit = {
      tradeId: 'uuid-trade-1',
      exitStraddleValue: 400,
      exitTimestamp: Date.UTC(2026, 4, 19, 7, 45, 0),
      exitReason: 'SL',
    };

    const record = await exitTrade(pool, exit);

    expect(record.pnl).toBeCloseTo(-80, 5);
  });

  it('sets status to closed', async () => {
    const rawRow = makeRawRow({
      exit_straddle_value: '200.00',
      exit_time: new Date('2026-05-19T09:45:00Z'),
      exit_reason: 'EOD',
      pnl_abs: '120.00',
      status: 'closed',
    });

    const pool = makeMockPool(() => ({ rows: [rawRow] }));
    const exit: PaperTradeExit = {
      tradeId: 'uuid-trade-1',
      exitStraddleValue: 200,
      exitTimestamp: Date.UTC(2026, 4, 19, 9, 45, 0),
      exitReason: 'EOD',
    };

    const record = await exitTrade(pool, exit);

    expect(record.status).toBe('closed');
  });

  // 8. exitTrade throws when trade id not found
  it('throws a descriptive error when the UPDATE matches no rows (id not found)', async () => {
    // An empty rows array means no trade was found with the given id.
    const pool = makeMockPool(() => ({ rows: [] }));
    const exit: PaperTradeExit = {
      tradeId: 'uuid-trade-9999',
      exitStraddleValue: 200,
      exitTimestamp: Date.now(),
      exitReason: 'EOD',
    };

    await expect(exitTrade(pool, exit)).rejects.toThrow(/no trade found with id uuid-trade-9999/);
  });

  it('maps expiry DATE to a YYYY-MM-DD string', async () => {
    const rawRow = makeRawRow({
      exit_straddle_value: '180.00',
      exit_time: new Date('2026-05-22T09:45:00Z'),
      exit_reason: 'TARGET',
      pnl_abs: '140.00',
      status: 'closed',
    });

    const pool = makeMockPool(() => ({ rows: [rawRow] }));
    const exit: PaperTradeExit = {
      tradeId: 'uuid-trade-1',
      exitStraddleValue: 180,
      exitTimestamp: Date.now(),
      exitReason: 'TARGET',
    };

    const record = await exitTrade(pool, exit);

    // expiry is 2026-05-22T00:00:00Z → expiryDate should be '2026-05-22'.
    expect(record.expiryDate).toBe('2026-05-22');
  });
});

// ---------------------------------------------------------------------------
// 4 & 5. getOpenTrades — returns empty array; filters by underlying
// ---------------------------------------------------------------------------

describe('getOpenTrades', () => {
  it('returns an empty array when no open trades exist', async () => {
    const pool = makeMockPool(() => ({ rows: [] }));

    const trades = await getOpenTrades(pool);

    expect(trades).toEqual([]);
  });

  it('returns open trades when they exist', async () => {
    const rawRow = makeRawRow(); // status = 'open'
    const pool = makeMockPool(() => ({ rows: [rawRow] }));

    const trades = await getOpenTrades(pool);

    expect(trades).toHaveLength(1);
    expect(trades[0]?.status).toBe('open');
    expect(trades[0]?.underlying).toBe('NIFTY');
  });

  it('filters by underlying when provided', async () => {
    // Pool returns one matching BANKNIFTY row when the filter is applied.
    const bnRow = makeRawRow({ symbol: 'BANKNIFTY' });
    let capturedParams: unknown[] = [];
    const pool = makeMockPool((_sql: string, params?: unknown[]) => {
      capturedParams = params ?? [];
      return { rows: [bnRow] };
    });

    const trades = await getOpenTrades(pool, 'BANKNIFTY');

    // The underlying filter ('BANKNIFTY') must have been passed as a query param.
    expect(capturedParams).toContain('BANKNIFTY');
    expect(trades).toHaveLength(1);
    expect(trades[0]?.underlying).toBe('BANKNIFTY');
  });

  it('does NOT pass a filter param when underlying is not provided', async () => {
    let capturedParams: unknown[] | undefined;
    const pool = makeMockPool((_sql: string, params?: unknown[]) => {
      capturedParams = params;
      return { rows: [] };
    });

    await getOpenTrades(pool);

    // When no filter, query should have no params (or undefined params).
    expect(capturedParams === undefined || (capturedParams as unknown[]).length === 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6 & 7. getTodayPnl — returns 0 when no closed trades; returns correct sum
// ---------------------------------------------------------------------------

describe('getTodayPnl', () => {
  it('returns 0 when no closed trades exist today', async () => {
    // COALESCE(SUM(...), 0) returns '0' as a string from pg.
    const pool = makeMockPool(() => ({ rows: [{ total_pnl: '0' }] }));

    const pnl = await getTodayPnl(pool);

    expect(pnl).toBe(0);
    expect(pnl).toBeTypeOf('number');
  });

  it('returns the correct sum parsed as a float', async () => {
    // Simulate two closed trades with pnl_abs of 120 and -30 → total = 90.
    const pool = makeMockPool(() => ({ rows: [{ total_pnl: '90.00' }] }));

    const pnl = await getTodayPnl(pool);

    expect(pnl).toBeCloseTo(90, 5);
  });

  it('returns a negative sum when the day is a net loss', async () => {
    const pool = makeMockPool(() => ({ rows: [{ total_pnl: '-150.50' }] }));

    const pnl = await getTodayPnl(pool);

    expect(pnl).toBeCloseTo(-150.5, 5);
  });

  it('returns 0 when query yields no rows (defensive fallback)', async () => {
    // In practice COALESCE ensures a row, but the guard in the SUT handles this.
    const pool = makeMockPool(() => ({ rows: [] }));

    const pnl = await getTodayPnl(pool);

    expect(pnl).toBe(0);
  });
});
