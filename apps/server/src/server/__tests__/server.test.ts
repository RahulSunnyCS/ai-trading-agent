/**
 * Unit tests for src/server/index.ts
 *
 * Uses Fastify's built-in server.inject() — no real HTTP socket is opened.
 * The pg Pool is replaced with a mock so no live database is required.
 *
 * Tests:
 *  1. GET /health returns { status: 'ok' } with HTTP 200
 *  2. GET /api/straddle/latest returns HTTP 200 (not 404 or 500)
 *  3. GET /api/trades returns HTTP 200 with a data array
 *  4. GET /api/positions returns HTTP 200 with a data array
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { buildServer } from '../index';

// ---------------------------------------------------------------------------
// Mock pg.Pool
//
// We mock the 'pg' module so that new Pool() inside buildServer returns a
// lightweight stub.  The query stub returns an empty rows array by default,
// which exercises the "no trades yet" fallback path.
// ---------------------------------------------------------------------------

// Minimal Pool stub — only the methods our routes actually call.
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
const mockEnd = vi.fn().mockResolvedValue(undefined);

// Pool mock: the constructor is replaced with a function that returns our stub.
vi.mock('pg', () => {
  const MockPool = vi.fn(() => ({
    query: mockQuery,
    end: mockEnd,
  }));
  return { Pool: MockPool };
});

// The T-41 server wiring imports the EOD job and retrospection routes, which
// pull in db/client.ts (calls pg.types.setTypeParser at module load) and
// bullmq (attempts Redis connection). Stub both modules so these server tests
// remain focused on the original route set without infrastructure side-effects.
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
// Helpers
// ---------------------------------------------------------------------------

/** Build a fresh Fastify instance before each test; close it after. */
let server: FastifyInstance;

beforeEach(async () => {
  // Disable Fastify's built-in logger in tests to keep console output clean.
  server = await buildServer({ logger: false });
  // Replace the decorated db with our mock so route handlers use the stub.
  // Note: the decorator was already set inside buildServer using the mocked
  // Pool constructor, so the stub is already in place — this assertion just
  // confirms the shape.
  const db = server.db as unknown as Pick<Pool, 'query' | 'end'>;
  // Ensure our mock functions are wired (they should be via the vi.mock above).
  expect(db.query).toBeDefined();
});

afterEach(async () => {
  await server.close();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  it('returns HTTP 200 with { status: "ok" }', async () => {
    const response = await server.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    // Parse and assert the response body shape.
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    // Ensure timestamp is a valid ISO string.
    expect(Number.isNaN(Date.parse(body.timestamp as string))).toBe(false);
  });
});

describe('GET /api/straddle/latest', () => {
  it('returns HTTP 200', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/straddle/latest' });
    expect(response.statusCode).toBe(200);
  });

  it('returns HTTP 200 with ?underlying=NIFTY query param', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/api/straddle/latest?underlying=NIFTY',
    });
    expect(response.statusCode).toBe(200);
  });

  it('responds with a data field', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/straddle/latest' });
    const body = JSON.parse(response.body) as Record<string, unknown>;
    // MVP stub always returns data:null; the key must be present.
    expect('data' in body).toBe(true);
  });
});

describe('GET /api/trades', () => {
  it('returns HTTP 200 with a data array (empty DB)', async () => {
    // mockQuery returns { rows: [] } by default — exercises the empty-table path.
    const response = await server.inject({ method: 'GET', url: '/api/trades' });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('returns HTTP 200 even when the DB query throws', async () => {
    // Simulate a DB connection error.
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    const response = await server.inject({ method: 'GET', url: '/api/trades' });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
  });
});

describe('GET /api/positions', () => {
  it('returns HTTP 200 with a data array', async () => {
    const response = await server.inject({ method: 'GET', url: '/api/positions' });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as Record<string, unknown>;
    expect(Array.isArray(body.data)).toBe(true);
  });
});
