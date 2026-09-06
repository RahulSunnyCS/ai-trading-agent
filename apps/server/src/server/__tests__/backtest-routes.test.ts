/**
 * Unit tests for src/server/routes/backtest.ts
 *
 * Uses Fastify's built-in server.inject() — no real HTTP socket is opened,
 * and `global.fetch` (the proxy's only way of reaching the Python service)
 * is replaced with a mock so no real network call is ever made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

vi.mock('../../payment/razorpay', () => ({
  isPaymentEnabled: vi.fn(),
  consumeCredit: vi.fn(),
}));

vi.mock('../middleware/access-gate', () => ({
  requireAccess: vi.fn(),
}));

import { consumeCredit, isPaymentEnabled } from '../../payment/razorpay';

import { requireAccess } from '../middleware/access-gate';

// Module under test — imported after mocks are in place.
import { backtestRoutes } from '../routes/backtest';

function makeMockPool(): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function buildTestServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  server.decorate('db', makeMockPool());
  await server.register(backtestRoutes);
  return server;
}

let server: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BACKTEST_API_URL = 'http://127.0.0.1:8000';

  (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (consumeCredit as ReturnType<typeof vi.fn>).mockResolvedValue({
    success: true,
    remainingBalance: 9,
  });
  // Default: pass-through — most tests are not exercising the access gate itself.
  (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
    async (_req: FastifyRequest, _reply: FastifyReply) => undefined,
  );

  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server?.close();
});

// ---------------------------------------------------------------------------
// Host allow-list (SSRF guard)
// ---------------------------------------------------------------------------

describe('BACKTEST_API_URL host allow-list', () => {
  it('registers cleanly against a loopback URL', async () => {
    process.env.BACKTEST_API_URL = 'http://127.0.0.1:8000';
    await expect(buildTestServer()).resolves.toBeDefined();
  });

  it('registers cleanly against a private-range URL', async () => {
    process.env.BACKTEST_API_URL = 'http://192.168.1.50:8000';
    await expect(buildTestServer()).resolves.toBeDefined();
  });

  it('throws at registration time against a public host', async () => {
    process.env.BACKTEST_API_URL = 'http://evil.example.com:8000';
    await expect(buildTestServer()).rejects.toThrow(/does not resolve to a loopback/);
  });
});

// ---------------------------------------------------------------------------
// Simple pass-through routes
// ---------------------------------------------------------------------------

describe('GET /api/backtest/health', () => {
  it('forwards the upstream status and body', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'ok' }));

    const res = await server.inject({ method: 'GET', url: '/api/backtest/health' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/health',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('returns 503 when the Python service is unreachable', async () => {
    server = await buildTestServer();
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = await server.inject({ method: 'GET', url: '/api/backtest/health' });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'backtest_service_unavailable' });
  });
});

describe('GET /api/backtest/presets', () => {
  it('forwards the preset list', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(jsonResponse(200, [{ name: 'A_flat' }]));

    const res = await server.inject({ method: 'GET', url: '/api/backtest/presets' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([{ name: 'A_flat' }]);
  });
});

describe('GET /api/backtest/presets/:name', () => {
  it('forwards a well-formed name', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(jsonResponse(200, { name: 'A_flat', yaml: '...' }));

    const res = await server.inject({ method: 'GET', url: '/api/backtest/presets/A_flat' });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/presets/A_flat',
      expect.anything(),
    );
  });

  it('rejects a path-traversal-shaped name before ever calling fetch', async () => {
    server = await buildTestServer();

    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/presets/..%2F..%2Fetc%2Fpasswd',
    });

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/backtest/coverage', () => {
  it('requires the underlying query param', async () => {
    server = await buildTestServer();
    const res = await server.inject({ method: 'GET', url: '/api/backtest/coverage' });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown underlying value', async () => {
    server = await buildTestServer();
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/coverage?underlying=DOGECOIN',
    });
    expect(res.statusCode).toBe(400);
  });

  it('forwards a valid underlying', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(
      jsonResponse(200, { '15m': { start: '2026-06-08', end: '2026-09-04' } }),
    );
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/coverage?underlying=NIFTY',
    });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/coverage?underlying=NIFTY',
      expect.anything(),
    );
  });
});

describe('POST /api/backtest/validate', () => {
  it('forwards the request body and no access gate applies', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(jsonResponse(200, { valid: true }));

    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/validate',
      payload: { yaml: 'strategy: {}' },
    });

    expect(res.statusCode).toBe(200);
    expect(requireAccess).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ yaml: 'strategy: {}' });
  });

  it('rejects a body missing yaml', async () => {
    server = await buildTestServer();
    const res = await server.inject({ method: 'POST', url: '/api/backtest/validate', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/backtest/runs — the credit-gated route
// ---------------------------------------------------------------------------

describe('POST /api/backtest/runs', () => {
  const validPayload = { yaml: 'strategy: {}', from: '2026-08-17', to: '2026-09-04' };

  it('denied by the access gate never reaches fetch or consumeCredit', async () => {
    server = await buildTestServer();
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: FastifyRequest, reply: FastifyReply) => {
        await reply.status(403).send({ error: 'access_denied', reason: 'no_grant' });
      },
    );

    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/runs',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(403);
    expect(consumeCredit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('payment disabled: never calls consumeCredit, still calls the Python service', async () => {
    server = await buildTestServer();
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
    fetchMock.mockResolvedValue(jsonResponse(200, { run_id: 'abc', net_inr: 100 }));

    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/runs',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(consumeCredit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('payment enabled + insufficient credit: 402, and the Python service is never called', async () => {
    server = await buildTestServer();
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (consumeCredit as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      remainingBalance: 0,
    });

    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/runs',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body)).toEqual({ error: 'insufficient_credits' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('payment enabled + sufficient credit: consumes a credit THEN calls the Python service', async () => {
    server = await buildTestServer();
    (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (consumeCredit as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: true,
      remainingBalance: 4,
    });
    fetchMock.mockResolvedValue(jsonResponse(200, { run_id: 'abc', net_inr: 7568 }));

    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/runs',
      payload: validPayload,
    });

    expect(res.statusCode).toBe(200);
    expect(consumeCredit).toHaveBeenCalledWith(expect.anything(), 'backtest_run');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // consumeCredit must have been awaited (and thus resolved) before fetch
    // fired — verified by call order on a shared mock invocation log.
    const creditCallOrder = (consumeCredit as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const fetchCallOrder = fetchMock.mock.invocationCallOrder[0];
    expect(creditCallOrder).toBeLessThan(fetchCallOrder as number);
  });

  it('rejects a malformed date', async () => {
    server = await buildTestServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/runs',
      payload: { yaml: 'x', from: 'not-a-date', to: '2026-09-04' },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a body over the 64KB cap', async () => {
    server = await buildTestServer();
    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/runs',
      payload: { yaml: 'x'.repeat(70_000), from: '2026-08-17', to: '2026-09-04' },
    });
    expect(res.statusCode).toBe(413);
  });
});

describe('GET /api/backtest/runs', () => {
  it('applies the access gate', async () => {
    server = await buildTestServer();
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: FastifyRequest, reply: FastifyReply) => {
        await reply.status(403).send({ error: 'access_denied', reason: 'no_grant' });
      },
    );

    const res = await server.inject({ method: 'GET', url: '/api/backtest/runs' });
    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards the run list when access is granted', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(jsonResponse(200, []));
    const res = await server.inject({ method: 'GET', url: '/api/backtest/runs' });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/runs?limit=20',
      expect.anything(),
    );
  });
});

describe('GET /api/backtest/runs/:id', () => {
  it('rejects an id with unsafe characters', async () => {
    server = await buildTestServer();
    // `../etc` would be normalized away by the HTTP layer before routing
    // (landing on a genuine 404, not a validation failure) — a single path
    // segment with disallowed characters is what actually exercises the
    // :id AJV pattern.
    const res = await server.inject({ method: 'GET', url: '/api/backtest/runs/abc!def' });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a well-formed id', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(jsonResponse(200, { run_id: 'abc123' }));
    const res = await server.inject({ method: 'GET', url: '/api/backtest/runs/abc123' });
    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8000/runs/abc123', expect.anything());
  });
});
