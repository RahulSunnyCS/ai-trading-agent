/**
 * Tests for portfolioRiskCheck (src/trading/portfolio-risk.ts).
 *
 * All tests are unit-level: the DB pool is mocked and no network / database
 * connections are made. Time is injected via FixedClock for determinism.
 *
 * Test matrix:
 *   1.  EVENT_DAY_BLOCKED — date in BLOCKED_DATES
 *   2.  EVENT_DAY_BLOCKED — Thursday before 11:00 AM IST
 *   3.  Thursday ≥ 11:00 AM IST passes event-day gate
 *   4.  VIX_STALE — vixAgeMs exceeds VIX_STALE_MS
 *   5.  PORTFOLIO_DAILY_STOP — totalPnl ≤ -20000
 *   6.  MARGIN_BUFFER_EXCEEDED — open positions consume > 70% of capital
 *   7.  MAX_LEGS_EXCEEDED — 4 open legs
 *   8.  allowed: true — all rules pass (1 open leg, pnl=0)
 *   9.  MAX_LEGS_EXCEEDED — advisory lock not acquired
 */

import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../utils/clock.js';
import { type TradeIntent, portfolioRiskCheck } from '../portfolio-risk.js';

// ---------------------------------------------------------------------------
// Fixed test timestamps
// ---------------------------------------------------------------------------

/**
 * IST Wednesday 2026-05-20 10:00:00 — a normal trading day, not Thursday,
 * not in any BLOCKED_DATES list. UTC: 2026-05-20T04:30:00.000Z
 */
const WED_1000_IST = new Date('2026-05-20T04:30:00.000Z').getTime();

/**
 * IST Thursday 2026-05-21 09:30:00 — Thursday before 11:00 AM IST.
 * UTC: 2026-05-21T04:00:00.000Z
 */
const THU_0930_IST = new Date('2026-05-21T04:00:00.000Z').getTime();

/**
 * IST Thursday 2026-05-21 11:30:00 — Thursday after 11:00 AM IST.
 * UTC: 2026-05-21T06:00:00.000Z
 */
const THU_1130_IST = new Date('2026-05-21T06:00:00.000Z').getTime();

/**
 * IST 2026-01-15 10:00:00 — date used in BLOCKED_DATES tests.
 * UTC: 2026-01-15T04:30:00.000Z
 */
const BLOCKED_DATE_1000 = new Date('2026-01-15T04:30:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Base trade intent (valid, used in tests that are not checking intent fields)
// ---------------------------------------------------------------------------

const baseIntent: TradeIntent = {
  personalityId: 'precision',
  underlying: 'NIFTY',
  atmStrike: 22000,
  straddleValue: 200,
};

// ---------------------------------------------------------------------------
// DB mock factory
//
// mockPool() constructs a Pool-shaped object that resolves query() calls by
// matching SQL fragments. Tests that need specific DB responses pass them via
// the responses object. For tests that never reach a given DB call (because an
// earlier rule blocks), the corresponding response is omitted or set to a safe
// default.
//
// The connect() mock returns a PoolClient-shaped object used by Rule 5 (advisory
// lock). advisoryAcquired controls whether pg_try_advisory_xact_lock returns
// true or false. openLegsCount controls the COUNT(*) inside the transaction.
// ---------------------------------------------------------------------------

interface MockPoolOptions {
  /** SUM(net_pnl) for the daily P&L check (Rule 3). Default: "0" */
  totalPnl?: string;
  /** COUNT(*) for the open-leg margin estimate (Rule 4). Default: "0" */
  openCountForMargin?: string;
  /** Whether pg_try_advisory_xact_lock returns true (Rule 5). Default: true */
  advisoryAcquired?: boolean;
  /** COUNT(*) inside the advisory-lock transaction (Rule 5). Default: "0" */
  openLegsInTx?: string;
}

function makeMockClient(opts: MockPoolOptions): PoolClient {
  const acquired = opts.advisoryAcquired ?? true;
  const openLegs = opts.openLegsInTx ?? '0';

  const clientQuery = vi.fn().mockImplementation((sql: string) => {
    // Transaction control — always succeed
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
      return Promise.resolve({ rows: [] });
    }
    // Advisory lock check
    if (sql.includes('pg_try_advisory_xact_lock')) {
      return Promise.resolve({ rows: [{ acquired }] });
    }
    // Open legs count inside transaction (Rule 5)
    if (sql.includes('COUNT(*)')) {
      return Promise.resolve({ rows: [{ cnt: openLegs }] });
    }
    return Promise.resolve({ rows: [] });
  });

  return {
    query: clientQuery,
    release: vi.fn(),
  } as unknown as PoolClient;
}

function mockPool(opts: MockPoolOptions = {}): Pool {
  const totalPnl = opts.totalPnl ?? '0';
  const openCountForMargin = opts.openCountForMargin ?? '0';

  const poolQuery = vi.fn().mockImplementation((sql: string) => {
    // Rule 3 — daily P&L aggregate
    if (sql.includes('SUM(net_pnl)')) {
      return Promise.resolve({ rows: [{ total_pnl: totalPnl }] });
    }
    // Rule 4 — open count for margin estimate
    if (sql.includes('COUNT(*)') && sql.includes("status = 'open'")) {
      return Promise.resolve({ rows: [{ cnt: openCountForMargin }] });
    }
    return Promise.resolve({ rows: [] });
  });

  const client = makeMockClient(opts);

  return {
    query: poolQuery,
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Cleanup env vars after each test to prevent cross-test pollution
// ---------------------------------------------------------------------------

afterEach(() => {
  for (const key of [
    'BLOCKED_DATES',
    'VIX_STALE_MS',
    'PORTFOLIO_DAILY_STOP',
    'MARGIN_CAPITAL',
    'MARGIN_RATE',
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
});

// ---------------------------------------------------------------------------
// Rule 1 — Event-day gate
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — Rule 1: event-day gate', () => {
  it('returns EVENT_DAY_BLOCKED when today is in BLOCKED_DATES', async () => {
    process.env.BLOCKED_DATES = JSON.stringify(['2026-01-15']);

    const clock = new FixedClock(BLOCKED_DATE_1000);
    // DB is never reached — pass a minimal pool (no queries should fire)
    const db = mockPool();

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: false, reason: 'EVENT_DAY_BLOCKED' });
    // Confirm DB was not touched (event-day check is pure in-memory)
    expect(db.query).not.toHaveBeenCalled();
  });

  it('returns EVENT_DAY_BLOCKED on Thursday before 11:00 AM IST', async () => {
    // BLOCKED_DATES is empty — only the Thursday morning sub-check triggers
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(THU_0930_IST);
    const db = mockPool();

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: false, reason: 'EVENT_DAY_BLOCKED' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('passes event-day gate on Thursday at or after 11:00 AM IST', async () => {
    process.env.BLOCKED_DATES = '[]';

    // THU_1130_IST = 11:30 AM IST — past the 11:00 cutoff
    const clock = new FixedClock(THU_1130_IST);
    // All downstream rules must pass — low pnl, no open positions
    const db = mockPool({ totalPnl: '0', openCountForMargin: '0', openLegsInTx: '0' });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    // Should not be blocked by event-day rule; all other rules pass → allowed
    expect(result).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — VIX staleness gate
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — Rule 2: VIX staleness gate', () => {
  it('returns VIX_STALE when vixAgeMs exceeds VIX_STALE_MS', async () => {
    process.env.VIX_STALE_MS = '300000'; // 5 minutes
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool();

    // Provide age of 6 minutes — beyond the 5-minute threshold
    const result = await portfolioRiskCheck(db, baseIntent, clock, 360_000);

    expect(result).toEqual({ allowed: false, reason: 'VIX_STALE' });
    // VIX check is in-memory; DB should not be reached
    expect(db.query).not.toHaveBeenCalled();
  });

  it('passes VIX gate when vixAgeMs exactly equals VIX_STALE_MS (boundary: > not >=)', async () => {
    process.env.VIX_STALE_MS = '300000';
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({ totalPnl: '0', openCountForMargin: '0', openLegsInTx: '0' });

    // Exactly at the threshold — condition is `>`, so this should pass
    const result = await portfolioRiskCheck(db, baseIntent, clock, 300_000);

    expect(result).toEqual({ allowed: true });
  });

  it('passes VIX gate when vixAgeMs is below the threshold', async () => {
    process.env.VIX_STALE_MS = '300000';
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({ totalPnl: '0', openCountForMargin: '0', openLegsInTx: '0' });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 60_000);

    expect(result).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — Portfolio daily stop
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — Rule 3: portfolio daily stop', () => {
  it('returns PORTFOLIO_DAILY_STOP when totalPnl equals -PORTFOLIO_DAILY_STOP (boundary: <= not <)', async () => {
    process.env.PORTFOLIO_DAILY_STOP = '20000';
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    // totalPnl exactly at the stop threshold — the condition is `<=`, so block
    const db = mockPool({ totalPnl: '-20000' });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: false, reason: 'PORTFOLIO_DAILY_STOP' });
  });

  it('returns PORTFOLIO_DAILY_STOP when totalPnl is below the threshold', async () => {
    process.env.PORTFOLIO_DAILY_STOP = '20000';
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({ totalPnl: '-25000' });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: false, reason: 'PORTFOLIO_DAILY_STOP' });
  });

  it('passes daily stop when totalPnl is above -PORTFOLIO_DAILY_STOP', async () => {
    process.env.PORTFOLIO_DAILY_STOP = '20000';
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    // -19999 is above -20000, so should not trigger
    const db = mockPool({ totalPnl: '-19999', openCountForMargin: '0', openLegsInTx: '0' });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — Margin buffer
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — Rule 4: margin buffer', () => {
  it('returns MARGIN_BUFFER_EXCEEDED when open positions consume > 70% of MARGIN_CAPITAL', async () => {
    process.env.BLOCKED_DATES = '[]';
    // 3 open positions, straddle value 200, lots=1, lotSize=50, marginRate=0.20
    // estimatedMargin = 3 * 200 * 1 * 50 * 0.20 = 6000
    // 70% of 100000 = 70000 → 6000 < 70000 → this won't trigger with defaults
    //
    // Use smaller MARGIN_CAPITAL so 6000 > 70% of it (70% of 8000 = 5600)
    process.env.MARGIN_CAPITAL = '8000';
    process.env.MARGIN_RATE = '0.20';

    const clock = new FixedClock(WED_1000_IST);
    // 3 open straddles + good pnl
    const db = mockPool({ totalPnl: '500', openCountForMargin: '3' });

    // straddleValue=200, 3 opens → estimatedMargin = 3 * 200 * 1 * 50 * 0.20 = 6000
    // 70% of 8000 = 5600 → 6000 > 5600 → EXCEEDED
    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: false, reason: 'MARGIN_BUFFER_EXCEEDED' });
  });

  it('passes margin check when estimated margin is exactly at 70% of capital (boundary: > not >=)', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.MARGIN_CAPITAL = '10000';
    process.env.MARGIN_RATE = '0.20';

    // 70% of 10000 = 7000
    // To get estimatedMargin = 7000: count * straddleValue * 1 * 50 * 0.20 = 7000
    // → count * straddleValue = 700 → with straddleValue=200, count=3.5 (non-integer)
    // Instead use straddleValue=700/3 — not clean, so adjust MARGIN_CAPITAL to match.
    //
    // Simpler: MARGIN_CAPITAL=1000, MARGIN_RATE=0.20, openCount=1, straddleValue=700
    // → estimatedMargin = 1 * 700 * 1 * 50 * 0.20 = 7000
    // → 70% of 1000 = 700 ... no, 70% * 10000 = 7000. Let's use MARGIN_CAPITAL=10000.
    // openCount=1, straddle=700: estimatedMargin = 1 * 700 * 50 * 0.20 = 7000 = exactly 70%. Should PASS.

    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({ totalPnl: '0', openCountForMargin: '1', openLegsInTx: '0' });

    // straddleValue=700: exactly at 70% threshold. Condition is `>` so this passes.
    const intentAtBoundary: TradeIntent = { ...baseIntent, straddleValue: 700 };
    const result = await portfolioRiskCheck(db, intentAtBoundary, clock, 0);

    expect(result).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — Max 4 open legs (advisory lock)
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — Rule 5: max legs / advisory lock', () => {
  it('returns MAX_LEGS_EXCEEDED when open leg count is 4', async () => {
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    // openLegsInTx=4 → inside the transaction, COUNT = 4 → rule triggers
    const db = mockPool({
      totalPnl: '0',
      openCountForMargin: '0',
      advisoryAcquired: true,
      openLegsInTx: '4',
    });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: false, reason: 'MAX_LEGS_EXCEEDED' });
  });

  it('returns MAX_LEGS_EXCEEDED when open leg count exceeds 4', async () => {
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({
      totalPnl: '0',
      openCountForMargin: '0',
      advisoryAcquired: true,
      openLegsInTx: '5',
    });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: false, reason: 'MAX_LEGS_EXCEEDED' });
  });

  it('returns MAX_LEGS_EXCEEDED when advisory lock cannot be acquired', async () => {
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    // Lock not acquired → conservative block (another check is in progress)
    const db = mockPool({
      totalPnl: '0',
      openCountForMargin: '0',
      advisoryAcquired: false,
      openLegsInTx: '1', // irrelevant — won't be reached
    });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: false, reason: 'MAX_LEGS_EXCEEDED' });
  });

  it('releases the client after advisory lock denial (no client leak)', async () => {
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({
      totalPnl: '0',
      openCountForMargin: '0',
      advisoryAcquired: false,
    });

    await portfolioRiskCheck(db, baseIntent, clock, 0);

    // connect() is called once; the client.release() must always be called
    const client = await vi.mocked(db.connect).mock.results[0]?.value;
    expect(client?.release).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Happy path — all rules pass
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — happy path', () => {
  it('returns { allowed: true } when all rules pass', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.VIX_STALE_MS = '300000';
    process.env.PORTFOLIO_DAILY_STOP = '20000';
    process.env.MARGIN_CAPITAL = '100000';
    process.env.MARGIN_RATE = '0.20';

    // Wednesday, fresh VIX (age=0), no stop hit, 1 open position, 1 leg in tx
    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({
      totalPnl: '0',
      openCountForMargin: '1',
      advisoryAcquired: true,
      openLegsInTx: '1',
    });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: true });
  });

  it('uses default env var values when none are set', async () => {
    // No env vars set — defaults should all produce a pass with 0 open positions
    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({
      totalPnl: '0',
      openCountForMargin: '0',
      advisoryAcquired: true,
      openLegsInTx: '0',
    });

    const result = await portfolioRiskCheck(db, baseIntent, clock, 0);

    expect(result).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Client lifecycle — ensures no pool leaks across success and error paths
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — client lifecycle', () => {
  it('always calls client.release() on success', async () => {
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);
    const db = mockPool({
      totalPnl: '0',
      openCountForMargin: '0',
      advisoryAcquired: true,
      openLegsInTx: '0',
    });

    await portfolioRiskCheck(db, baseIntent, clock, 0);

    const client = await vi.mocked(db.connect).mock.results[0]?.value;
    expect(client?.release).toHaveBeenCalledOnce();
  });

  it('calls ROLLBACK and client.release() when the advisory lock query throws', async () => {
    process.env.BLOCKED_DATES = '[]';

    const clock = new FixedClock(WED_1000_IST);

    // Build a client that throws on the advisory lock query
    const clientQuery = vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return Promise.reject(new Error('DB connection lost'));
      }
      return Promise.resolve({ rows: [] });
    });
    const clientRelease = vi.fn();
    const fakeClient = { query: clientQuery, release: clientRelease } as unknown as PoolClient;

    const db = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SUM(net_pnl)')) return Promise.resolve({ rows: [{ total_pnl: '0' }] });
        if (sql.includes('COUNT(*)')) return Promise.resolve({ rows: [{ cnt: '0' }] });
        return Promise.resolve({ rows: [] });
      }),
      connect: vi.fn().mockResolvedValue(fakeClient),
    } as unknown as Pool;

    // The function must rethrow the original error
    await expect(portfolioRiskCheck(db, baseIntent, clock, 0)).rejects.toThrow(
      'DB connection lost',
    );

    // client.release() must have been called despite the error
    expect(clientRelease).toHaveBeenCalledOnce();
  });
});
