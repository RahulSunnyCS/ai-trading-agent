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

    const response = await server.inject({
      method: 'GET',
      url: '/api/momentum/meta?dataset=broad',
    });

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

  it('forwards saved-runs listing for a requested dataset', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    const response = await server.inject({
      method: 'GET',
      url: '/api/momentum/saved-runs?dataset=stock',
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/saved-runs?dataset=stock',
      expect.objectContaining({ signal: expect.anything() }),
    );
    await server.close();
  });

  it('forwards saving a run', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'abc' }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/saved-runs',
      payload: { dataset: 'etf', name: 'Run 1', config: {}, kpis: {}, dates: [], strategy: [] },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/saved-runs',
      expect.objectContaining({ method: 'POST' }),
    );
    await server.close();
  });

  it('forwards renaming/overlay-toggling a saved run', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'abc', name: 'Renamed' }));

    const response = await server.inject({
      method: 'PATCH',
      url: '/api/momentum/saved-runs/abc',
      payload: { name: 'Renamed' },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/saved-runs/abc',
      expect.objectContaining({ method: 'PATCH' }),
    );
    await server.close();
  });

  it('forwards deleting a saved run', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    const response = await server.inject({ method: 'DELETE', url: '/api/momentum/saved-runs/abc' });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/saved-runs/abc',
      expect.objectContaining({ method: 'DELETE' }),
    );
    await server.close();
  });

  it('forwards a manual weekly-signal trigger', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(
      jsonResponse(200, { title: 'Momentum FINAL', body: '', severity: 'info' }),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/weekly/run',
      payload: { run: 'final', send: false },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/weekly/run',
      expect.objectContaining({ method: 'POST' }),
    );
    await server.close();
  });

  it('rejects an invalid run kind for the weekly trigger without forwarding it', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/weekly/run',
      payload: { run: 'bogus' },
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await server.close();
  });

  it('fails closed for a public upstream', async () => {
    process.env.MOMENTUM_API_URL = 'https://example.com';
    const server = Fastify();
    await expect(server.register(momentumBacktestRoutes)).rejects.toThrow(/loopback or private/);
    await server.close();
  });
});
