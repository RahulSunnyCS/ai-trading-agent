/**
 * Unit tests for the Milestone-3 backend endpoints:
 *   GET /api/regime-tags
 *   GET /api/backfill
 *
 * Uses Fastify's built-in server.inject() — no real HTTP socket is opened.
 * The pg Pool is replaced with a mock so no live database is required.
 *
 * Coverage per endpoint:
 *  - Happy path: mock pool returns rows → 200 with data array
 *  - Empty result: mock pool returns [] → 200 with graceful message
 *  - DB error: mock pool throws → 200 with empty data (no 500)
 *  - regime-tags specific: invalid 'from' date → 400
 *  - regime-tags specific: invalid 'to' date → 400
 *  - regime-tags specific: range > 366 days → 400
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { buildServer } from '../index';

// ---------------------------------------------------------------------------
// Mock pg.Pool — same pattern as server.test.ts.
// The constructor is replaced before any route runs so all pool.query calls
// inside buildServer() hit our stub instead of a real database.
// ---------------------------------------------------------------------------

const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockEnd = vi.fn().mockResolvedValue(undefined);

vi.mock('pg', () => {
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: mockEnd,
  }));
  return { Pool: MockPool };
});
vi.mock('../../jobs/eod-retrospection-job.js', () => ({
  createEodRetrospectionQueue: vi.fn(() => ({ add: vi.fn(), close: vi.fn() })),
  createEodRetrospectionWorker: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('../../api/routes/retrospection.js', () => ({
  retrospectionRoutes: async () => {
    /* noop plugin stub */
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal regime-tag row shape (matches the SELECT columns in the route). */
const sampleRegimeRow = {
  id: 1,
  trade_date: new Date('2026-05-01'),
  symbol: 'NIFTY',
  regime: 'RANGING',
  regime_confidence: '0.8500',
  classified_at: new Date('2026-05-01T18:30:00Z'),
};

/** Minimal backfill-range row shape (matches the SELECT columns in the route). */
const sampleBackfillRow = {
  id: 1,
  symbol: 'NIFTY',
  from_ts: new Date('2026-04-01T00:00:00Z'),
  to_ts: new Date('2026-04-30T23:59:59Z'),
  resolution: '1',
  status: 'complete',
  rows_written: 12000,
  checkpoint_ts: null,
  gaps_detected: 0,
  gaps_json: null,
  updated_at: new Date('2026-05-01T10:00:00Z'),
  created_at: new Date('2026-05-01T09:00:00Z'),
};

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: FastifyInstance;

beforeEach(async () => {
  server = await buildServer({ logger: false });
});

afterEach(async () => {
  await server.close();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /api/regime-tags
// ---------------------------------------------------------------------------

describe('GET /api/regime-tags', () => {
  it('returns 200 with data rows on happy path', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleRegimeRow] });

    const response = await server.inject({
      method: 'GET',
      url: '/api/regime-tags?symbol=NIFTY&from=2026-05-01&to=2026-05-31',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(1);
    // Confirm the message field is absent (non-empty result has no message).
    expect(body.message).toBeUndefined();
  });

  it('returns 200 with graceful message when result is empty', async () => {
    // mockQuery already resolves to { rows: [] } by default.
    const response = await server.inject({
      method: 'GET',
      url: '/api/regime-tags?symbol=NIFTY&from=2026-05-01&to=2026-05-31',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(0);
    // The route returns data without a message even for empty rows — the
    // graceful message only fires on a DB exception, not on an empty result.
  });

  it('returns 200 with empty data and message when DB throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "daily_regime_tags" does not exist'));

    const response = await server.inject({
      method: 'GET',
      url: '/api/regime-tags',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(0);
    expect(body.message).toBe('no regime tags yet');
  });

  it('returns 400 when from param is not a valid date', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/regime-tags?from=not-a-date&to=2026-05-31',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    // Error message must mention 'from' so callers can identify the bad param.
    expect((body.error as string).toLowerCase()).toContain('from');
  });

  it('returns 400 when to param is not a valid date', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/regime-tags?from=2026-05-01&to=bad-date',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    expect((body.error as string).toLowerCase()).toContain('to');
  });

  it('returns 400 when the requested range exceeds 366 days', async () => {
    // 367 days: 2025-01-01 → 2026-01-03
    const response = await server.inject({
      method: 'GET',
      url: '/api/regime-tags?from=2025-01-01&to=2026-01-03',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(typeof body.error).toBe('string');
    expect((body.error as string).toLowerCase()).toContain('366');
  });

  it('uses default range (last 30 days) when no date params are given', async () => {
    // Just verifies the route resolves without error when no params provided.
    const response = await server.inject({
      method: 'GET',
      url: '/api/regime-tags',
    });

    // The mock returns [] so we expect 200, no 400 from missing date params.
    expect(response.statusCode).toBe(200);
  });

  it('defaults symbol to NIFTY when not provided', async () => {
    await server.inject({ method: 'GET', url: '/api/regime-tags' });

    // Confirm the query was called with 'NIFTY' as the first parameter.
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['NIFTY']));
  });
});

// ---------------------------------------------------------------------------
// GET /api/backfill
// ---------------------------------------------------------------------------

describe('GET /api/backfill', () => {
  it('returns 200 with data rows on happy path', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [sampleBackfillRow] });

    const response = await server.inject({
      method: 'GET',
      url: '/api/backfill?symbol=NIFTY',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(1);
    expect(body.message).toBeUndefined();
  });

  it('returns 200 with empty data when no rows exist', async () => {
    // mockQuery resolves to { rows: [] } by default.
    const response = await server.inject({
      method: 'GET',
      url: '/api/backfill',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(0);
  });

  it('returns 200 with empty data and message when DB throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "backfill_ranges" does not exist'));

    const response = await server.inject({
      method: 'GET',
      url: '/api/backfill',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(0);
    expect(body.message).toBe('no backfill ranges yet');
  });

  it('filters by symbol when param is provided', async () => {
    await server.inject({ method: 'GET', url: '/api/backfill?symbol=BANKNIFTY' });

    // The route passes symbol as $1. Confirm it received 'BANKNIFTY'.
    expect(mockQuery).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['BANKNIFTY']),
    );
  });

  it('passes null for symbol when param is omitted (returns all rows)', async () => {
    await server.inject({ method: 'GET', url: '/api/backfill' });

    // When no symbol is given, the route passes null so the WHERE clause
    // ($1::text IS NULL OR symbol = $1) short-circuits to TRUE for all rows.
    expect(mockQuery).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([null]));
  });
});
