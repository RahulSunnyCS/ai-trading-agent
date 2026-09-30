import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Fastify from 'fastify';

import { momentumBacktestRoutes } from '../routes/momentum-backtest';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('momentum backtest proxy routes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.MOMENTUM_API_URL = 'http://127.0.0.1:8765';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('forwards metadata for a requested dataset', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { instruments: [] }));

    const response = await server.inject({ method: 'GET', url: '/api/momentum/meta?dataset=broad' });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ instruments: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/meta?dataset=broad',
      expect.objectContaining({ signal: expect.anything() }),
    );
    await server.close();
  });

  it('forwards a backtest request without reimplementing Python validation', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { kpis: {} }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/backtest',
      payload: { dataset: 'etf', universe: ['Nifty 50'], start: '2017-01-01' },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/backtest',
      expect.objectContaining({ method: 'POST' }),
    );
    await server.close();
  });

  it('fails closed for a public upstream', async () => {
    process.env.MOMENTUM_API_URL = 'https://example.com';
    const server = Fastify();
    await expect(server.register(momentumBacktestRoutes)).rejects.toThrow(/loopback or private/);
    await server.close();
  });
});
