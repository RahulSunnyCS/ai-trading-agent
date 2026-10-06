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

  it('forwards the liquidity preview query and rejects out-of-range thresholds', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { eligible: 1 }));

    const ok = await server.inject({
      method: 'GET',
      url: '/api/momentum/liquidity-preview?min_turnover_cr=2&circuit=true&max_circuit_days=8&universe=all_liquid',
    });
    expect(ok.statusCode).toBe(200);
    const forwarded = String(fetchMock.mock.calls[0]?.[0]);
    expect(forwarded.startsWith('http://127.0.0.1:8765/api/liquidity-preview?')).toBe(true);
    for (const part of [
      'min_turnover_cr=2',
      'circuit=true',
      'max_circuit_days=8',
      'universe=all_liquid',
    ]) {
      expect(forwarded).toContain(part);
    }

    const bad = await server.inject({
      method: 'GET',
      url: '/api/momentum/liquidity-preview?min_turnover_cr=-1',
    });
    expect(bad.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('forwards the read-only rebalance preview to Python', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { rows: [] }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/rebalance-preview',
      payload: {
        dataset: 'stock',
        universe: ['C0001'],
        holdings_pct: { C0001: 30 },
        portfolio_value: 100000,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/rebalance-preview',
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

  it('forwards the cross-dataset favourite strategy list', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    const response = await server.inject({
      method: 'GET',
      url: '/api/momentum/favorite-strategies',
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/favorite-strategies',
      expect.objectContaining({ signal: expect.anything() }),
    );
    await server.close();
  });

  it('forwards a manual weekly-signal trigger', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(
      jsonResponse(202, { started: true, job: { id: 'j1', status: 'running' } }),
    );

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/weekly/run',
      payload: { run: 'final', send: false },
    });

    expect(response.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/weekly/run',
      expect.objectContaining({ method: 'POST' }),
    );
    await server.close();
  });

  it.each([
    ['/api/momentum/weekly/jobs/latest', 'http://127.0.0.1:8765/api/weekly/jobs/latest'],
    ['/api/momentum/weekly/status', 'http://127.0.0.1:8765/api/weekly/status'],
    ['/api/momentum/journal', 'http://127.0.0.1:8765/api/journal'],
    ['/api/momentum/journal?week=2026-10-09', 'http://127.0.0.1:8765/api/journal?week=2026-10-09'],
    [
      '/api/momentum/weekly/stock-sync/jobs/latest',
      'http://127.0.0.1:8765/api/weekly/stock-sync/jobs/latest',
    ],
  ])('forwards GET %s', async (url, upstream) => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { job: null }));

    const response = await server.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(upstream, expect.anything());
    await server.close();
  });

  it('rejects a journal week that is not a date, without calling upstream', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);

    const response = await server.inject({ method: 'GET', url: '/api/momentum/journal?week=x' });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await server.close();
  });

  it('forwards starting a background backtest job', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(202, { job: { id: 'ab12', status: 'queued' } }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/backtest/jobs',
      payload: { dataset: 'etf', fresh: true },
    });

    expect(response.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/backtest/jobs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ dataset: 'etf', fresh: true }),
      }),
    );
    await server.close();
  });

  it('forwards polling a backtest job and the job list', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { job: { id: 'ab12' } }));

    await server.inject({ method: 'GET', url: '/api/momentum/backtest/jobs/ab12' });
    await server.inject({ method: 'GET', url: '/api/momentum/backtest/jobs' });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/backtest/jobs/ab12',
      expect.anything(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/backtest/jobs',
      expect.anything(),
    );
    await server.close();
  });

  it('rejects a job id that is not hex before it reaches the upstream path', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);

    const response = await server.inject({
      method: 'GET',
      url: '/api/momentum/backtest/jobs/..%2Fsaved-runs',
    });

    expect(response.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await server.close();
  });

  it('forwards a manual stock-sync trigger', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(202, { started: true, job: { id: 'j2' } }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/weekly/stock-sync',
    });

    expect(response.statusCode).toBe(202);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/weekly/stock-sync',
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
