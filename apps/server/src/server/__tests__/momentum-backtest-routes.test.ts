import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

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

  it("forwards one stock's score history, and refuses a symbol that is not an NSE symbol", async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { symbol: 'M&M' }));

    const ok = await server.inject({ method: 'GET', url: '/api/momentum/scores/stock/M%26M' });
    expect(ok.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/momentum-scores/stock/M%26M',
      expect.objectContaining({ signal: expect.anything() }),
    );

    fetchMock.mockClear();
    for (const bad of ['..%2Fmeta', 'A%20B', `${'X'.repeat(33)}`]) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/momentum/scores/stock/${bad}`,
      });
      expect(response.statusCode).toBe(400);
    }
    // Dot-only names are refused too: some clients normalise them away (a 404 here), others send
    // them as they are, and neither may reach the upstream path.
    for (const dots of ['.', '..', '%2e%2e']) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/momentum/scores/stock/${dots}`,
      });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await server.close();
  });

  it("forwards one stock's circuit locks, and refuses a symbol that is not an NSE symbol", async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { symbol: 'M&M', locks: [] }));

    const ok = await server.inject({
      method: 'GET',
      url: '/api/momentum/scores/stock/M%26M/circuits',
    });
    expect(ok.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/momentum-scores/stock/M%26M/circuits',
      expect.objectContaining({ signal: expect.anything() }),
    );

    fetchMock.mockClear();
    for (const bad of ['..%2Fmeta', 'A%20B', `${'X'.repeat(33)}`]) {
      const response = await server.inject({
        method: 'GET',
        url: `/api/momentum/scores/stock/${bad}/circuits`,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('forwards making a group of saved runs', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'g1', group: ['a', 'b'] }));

    const response = await server.inject({
      method: 'POST',
      url: '/api/momentum/saved-runs/groups',
      payload: { name: 'Phase 6 ensemble', members: ['a', 'b'] },
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/saved-runs/groups',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'Phase 6 ensemble', members: ['a', 'b'] }),
      }),
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

  it("forwards This week's view and the live-rules check, and refuses a week that is not a date", async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    expect(
      (await server.inject({ method: 'GET', url: '/api/momentum/week?week=2026-12-04' }))
        .statusCode,
    ).toBe(200);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8765/api/week?week=2026-12-04',
      expect.objectContaining({ signal: expect.anything() }),
    );
    await server.inject({ method: 'GET', url: '/api/momentum/week' });
    expect(fetchMock).toHaveBeenLastCalledWith('http://127.0.0.1:8765/api/week', expect.anything());
    await server.inject({ method: 'GET', url: '/api/momentum/live-rules' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8765/api/live-rules',
      expect.anything(),
    );
    await server.inject({ method: 'POST', url: '/api/momentum/live-rules/run' });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8765/api/live-rules/run',
      expect.objectContaining({ method: 'POST' }),
    );

    fetchMock.mockClear();
    const bad = await server.inject({ method: 'GET', url: '/api/momentum/week?week=../x' });
    expect(bad.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await server.close();
  });

  it('forwards Your orders and the holdings routes, never anything that trades', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const calls: Array<['GET' | 'POST' | 'PUT', string, string]> = [
      [
        'GET',
        '/api/momentum/orders?week=2026-10-09',
        'http://127.0.0.1:8765/api/orders?week=2026-10-09',
      ],
      ['POST', '/api/momentum/orders/run', 'http://127.0.0.1:8765/api/orders/run'],
      ['PUT', '/api/momentum/orders/settings', 'http://127.0.0.1:8765/api/orders/settings'],
      ['POST', '/api/momentum/holdings/sync', 'http://127.0.0.1:8765/api/holdings/sync'],
      ['POST', '/api/momentum/holdings/paste', 'http://127.0.0.1:8765/api/holdings/paste'],
      ['PUT', '/api/momentum/holdings/rules', 'http://127.0.0.1:8765/api/holdings/rules'],
    ];
    for (const [method, url, upstream] of calls) {
      const response = await server.inject(
        method === 'GET' ? { method, url } : { method, url, payload: {} },
      );
      expect(response.statusCode, url).toBe(200);
      expect(fetchMock).toHaveBeenLastCalledWith(
        upstream,
        method === 'GET' ? expect.anything() : expect.objectContaining({ method }),
      );
    }
    expect(
      (await server.inject({ method: 'GET', url: '/api/momentum/orders?week=x' })).statusCode,
    ).toBe(400);
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

  it('forwards one section of a finished job', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { section: 'trades', data: [] }));

    const response = await server.inject({
      method: 'GET',
      url: '/api/momentum/backtest/jobs/ab12/sections/trades',
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/backtest/jobs/ab12/sections/trades',
      expect.anything(),
    );
    await server.close();
  });

  it('only forwards well-formed section names and hex job ids', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);

    for (const url of [
      '/api/momentum/backtest/jobs/ab12/sections/..%2Fsaved-runs',
      '/api/momentum/backtest/jobs/ab12/sections/Trades',
      '/api/momentum/backtest/jobs/ab12/sections/trades-1',
      `/api/momentum/backtest/jobs/ab12/sections/${'a'.repeat(33)}`,
      '/api/momentum/backtest/jobs/..%2Fx/sections/trades',
    ]) {
      const response = await server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await server.close();
  });

  it('leaves it to the service to say which section names exist', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(422, { detail: 'unknown section' }));

    const response = await server.inject({
      method: 'GET',
      url: '/api/momentum/backtest/jobs/ab12/sections/something_new',
    });

    expect(response.statusCode).toBe(422);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/backtest/jobs/ab12/sections/something_new',
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

  it('rejects a saved-run id that is not a plain token', async () => {
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));

    for (const url of [
      '/api/momentum/saved-runs/a.b',
      '/api/momentum/saved-runs/%252E%252E',
      '/api/momentum/saved-runs/a%2Fb',
    ]) {
      const response = await server.inject({ method: 'DELETE', url });
      expect(response.statusCode, url).toBe(400);
    }
    const patch = await server.inject({
      method: 'PATCH',
      url: '/api/momentum/saved-runs/..%2Fjobs',
      payload: { favorite: true },
    });
    expect(patch.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();

    const ok = await server.inject({
      method: 'DELETE',
      url: '/api/momentum/saved-runs/0123456789abcdef0123456789abcdef',
    });
    expect(ok.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:8765/api/saved-runs/0123456789abcdef0123456789abcdef',
      expect.objectContaining({ method: 'DELETE' }),
    );
    await server.close();
  });

  it('rejects an encoded `..` run id over a real socket', async () => {
    // inject() normalises `%2E%2E` away like a browser would; a raw client does not, and the
    // decoded `..` would make the upstream URL /api/saved-runs itself.
    const server = Fastify();
    await server.register(momentumBacktestRoutes);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = server.server.address() as AddressInfo;
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, method: 'DELETE', path: '/api/momentum/saved-runs/%2E%2E' },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await server.close();
  });
});
