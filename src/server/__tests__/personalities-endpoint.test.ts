/**
 * Unit tests for GET /api/personalities.
 *
 * Uses Fastify's built-in server.inject() — no real HTTP socket is opened.
 * The pg Pool is replaced with a mock so no live database is required.
 *
 * Coverage:
 *  - Happy path: mock pool returns rows → 200 with data array
 *  - Empty result: mock pool returns [] → 200 with data:[] (no message)
 *  - DB error: mock pool throws → 200 with data:[] and graceful message (not 500)
 *  - include_inactive=true: SQL called without WHERE is_active filter
 *  - Default (no param): SQL called with WHERE is_active = $1 and params [true]
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';

import { buildServer } from '../index';

// ---------------------------------------------------------------------------
// Mock pg.Pool — mirrors the pattern in m3-endpoints.test.ts.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal personality row shape — matches the SELECT columns in the route. */
const samplePersonalityRow = {
  id: 'a1b2c3d4-0000-0000-0000-000000000001',
  name: 'clockwork',
  display_name: 'Clockwork',
  group_type: 'reference',
  entry_type: 'momentum_exhaustion',
  management_style: 'hold',
  is_frozen: true,
  is_active: true,
  phase: 1,
  // pg returns JSONB columns as already-parsed objects; simulate that here.
  params: { min_probability: 0.65 },
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

const sampleLearnerRow = {
  id: 'a1b2c3d4-0000-0000-0000-000000000002',
  name: 'precision',
  display_name: 'Precision',
  group_type: 'learning',
  entry_type: 'momentum_exhaustion',
  management_style: 'hold',
  is_frozen: false,
  is_active: true,
  phase: 1,
  params: { min_probability: 0.68 },
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
};

const inactiveRow = {
  ...sampleLearnerRow,
  id: 'a1b2c3d4-0000-0000-0000-000000000003',
  name: 'dormant',
  display_name: 'Dormant',
  is_active: false,
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
// GET /api/personalities
// ---------------------------------------------------------------------------

describe('GET /api/personalities', () => {
  it('returns 200 with data rows on happy path', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [samplePersonalityRow, sampleLearnerRow] });

    const response = await server.inject({
      method: 'GET',
      url: '/api/personalities',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(2);
    // No message key on a successful non-empty response.
    expect(body.message).toBeUndefined();
  });

  it('returns 200 with empty data array when no personalities exist', async () => {
    // mockQuery already resolves to { rows: [] } by default.
    const response = await server.inject({
      method: 'GET',
      url: '/api/personalities',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(0);
    // Empty rows is a valid DB result, not an error — no message key expected.
    // (The graceful message only fires on a DB exception, not on an empty result.)
  });

  it('returns 200 with empty data and graceful message when DB throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('relation "personality_configs" does not exist'));

    const response = await server.inject({
      method: 'GET',
      url: '/api/personalities',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(0);
    // The graceful fallback message must be present on DB error.
    expect(body.message).toBe('no personalities yet');
  });

  it('calls SQL without WHERE is_active filter when include_inactive=true', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [samplePersonalityRow, sampleLearnerRow, inactiveRow],
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/personalities?include_inactive=true',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect((body.data as unknown[]).length).toBe(3);

    // The "include all" path passes no params array — the mock should have been
    // called with only a SQL string and no second argument (or undefined).
    // We assert the query was NOT called with [true] (the active-filter value).
    const callArgs = mockQuery.mock.calls[mockQuery.mock.calls.length - 1] as unknown[];
    // When includeInactive=true the route calls query(sql) with no second arg.
    expect(callArgs.length).toBe(1);
  });

  it('calls SQL with is_active=$1 and params [true] when include_inactive is not set', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [samplePersonalityRow, sampleLearnerRow] });

    await server.inject({
      method: 'GET',
      url: '/api/personalities',
    });

    // The active-only path passes [true] as the second argument to query().
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('is_active'),
      expect.arrayContaining([true]),
    );
  });

  it('returns rows with params as parsed objects (not strings)', async () => {
    // Simulate what pg returns for a JSONB column — an already-parsed object.
    mockQuery.mockResolvedValueOnce({ rows: [samplePersonalityRow] });

    const response = await server.inject({
      method: 'GET',
      url: '/api/personalities',
    });

    const body = JSON.parse(response.body) as { data: (typeof samplePersonalityRow)[] };
    const row = body.data[0] as typeof samplePersonalityRow;
    // params should come through as an object, not a JSON string.
    expect(typeof row.params).toBe('object');
    expect(row.params).not.toBeNull();
  });
});
