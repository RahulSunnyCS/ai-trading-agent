/**
 * Momentum-backtesting API proxy.
 *
 * The Python Momentum service stays loopback/private just like the options
 * backtesting service. This route is its only browser-facing boundary and
 * deliberately preserves the Python API's payloads for the shared dashboard.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

const DEFAULT_MOMENTUM_API_URL = 'http://127.0.0.1:8765';
// A cold Custom Index run builds dozens of inner category backtests and can
// exceed 90 seconds on local research data.
const PROXY_TIMEOUT_MS = 180_000;
const BODY_LIMIT_BYTES = 64 * 1024;
/** The parts of a finished backtest fetched on their own (the Python service's `BacktestSection`). */
const BACKTEST_SECTIONS = [
  'trades',
  'instruments',
  'timeline',
  'latest',
  'circuit_exposure',
] as const;

function momentumApiUrl(): string {
  return process.env.MOMENTUM_API_URL || DEFAULT_MOMENTUM_API_URL;
}

function assertSafeMomentumHost(url: string): void {
  const host = new URL(url).hostname;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const isPrivate =
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!isLoopback && !isPrivate) {
    throw new Error(
      `MOMENTUM_API_URL (${url}) does not resolve to a loopback or private host — refusing to expose a public upstream.`,
    );
  }
}

async function forward(reply: FastifyReply, path: string, init?: RequestInit): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${momentumApiUrl()}${path}`, {
      ...init,
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch {
    await reply.status(503).send({ error: 'momentum_backtest_service_unavailable' });
    return;
  }
  const body = await response.json().catch(() => ({ error: 'invalid_upstream_response' }));
  await reply.status(response.status).send(body);
}

/** Browser API for the Next dashboard's Momentum Backtesting section. */
export const momentumBacktestRoutes = fp(async (fastify: FastifyInstance) => {
  assertSafeMomentumHost(momentumApiUrl());

  fastify.get(
    '/api/momentum/meta',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            dataset: { type: 'string', enum: ['etf', 'stock', 'custom_index', 'broad'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { dataset = 'etf' } = request.query as { dataset?: string };
      await forward(reply, `/api/meta?dataset=${encodeURIComponent(dataset)}`);
    },
  );

  fastify.get('/api/momentum/scores', async (_request, reply) => {
    await forward(reply, '/api/momentum-scores');
  });

  // Live tradability preview for Broad Momentum's liquidity gate: how many stocks pass the given
  // thresholds today and why each rejected one failed. Python re-validates every bound.
  fastify.get(
    '/api/momentum/liquidity-preview',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            min_turnover_cr: { type: 'number', exclusiveMinimum: 0, maximum: 1000 },
            floor_ratio: { type: 'number', minimum: 0, maximum: 1 },
            min_price: { type: 'number', minimum: 0, maximum: 100000 },
            circuit: { type: 'boolean' },
            circuit_run: { type: 'integer', minimum: 2, maximum: 20 },
            max_circuit_days: { type: 'integer', minimum: 0, maximum: 60 },
            universe: { type: 'string', enum: ['total_market', 'all_liquid'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const query = new URLSearchParams(
        Object.entries(request.query as Record<string, string | number | boolean>).map(
          ([key, value]): [string, string] => [key, String(value)],
        ),
      );
      await forward(reply, `/api/liquidity-preview?${query.toString()}`);
    },
  );

  // Python owns the complete Pydantic schema for this body. Duplicating its
  // dozens of research knobs here would drift, so Fastify limits the payload
  // and lets the authoritative service validate field-by-field.
  fastify.post(
    '/api/momentum/backtest',
    { bodyLimit: BODY_LIMIT_BYTES, schema: { body: { type: 'object' } } },
    async (request, reply) => {
      await forward(reply, '/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    },
  );

  // Background backtest jobs: start returns at once, the browser polls, so leaving the page
  // (or running several backtests side by side) loses nothing.
  fastify.post(
    '/api/momentum/backtest/jobs',
    { bodyLimit: BODY_LIMIT_BYTES, schema: { body: { type: 'object' } } },
    async (request, reply) => {
      await forward(reply, '/api/backtest/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    },
  );

  fastify.get('/api/momentum/backtest/jobs', async (_request, reply) => {
    await forward(reply, '/api/backtest/jobs');
  });

  fastify.get(
    '/api/momentum/backtest/jobs/:id',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^[0-9a-f]{1,32}$' } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await forward(reply, `/api/backtest/jobs/${id}`);
    },
  );

  // One heavy part of a finished job's result (trades, instruments, …), fetched when its card or
  // tab opens: the job's own result carries the core only (BL-005).
  fastify.get(
    '/api/momentum/backtest/jobs/:id/sections/:section',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', pattern: '^[0-9a-f]{1,32}$' },
            section: { type: 'string', enum: [...BACKTEST_SECTIONS] },
          },
          required: ['id', 'section'],
        },
      },
    },
    async (request, reply) => {
      const { id, section } = request.params as { id: string; section: string };
      await forward(reply, `/api/backtest/jobs/${id}/sections/${section}`);
    },
  );

  // Saved runs (P4): previously kept only in the browser's localStorage, now
  // persisted server-side in the shared trading-data catalog — see
  // packages/momentum-backtesting/src/momentum_backtesting/runs_store.py.
  fastify.get(
    '/api/momentum/saved-runs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            dataset: { type: 'string', enum: ['etf', 'stock', 'custom_index', 'broad'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { dataset = 'etf' } = request.query as { dataset?: string };
      await forward(reply, `/api/saved-runs?dataset=${encodeURIComponent(dataset)}`);
    },
  );

  fastify.post(
    '/api/momentum/saved-runs',
    { bodyLimit: BODY_LIMIT_BYTES, schema: { body: { type: 'object' } } },
    async (request, reply) => {
      await forward(reply, '/api/saved-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    },
  );

  fastify.patch(
    '/api/momentum/saved-runs/:runId',
    { bodyLimit: BODY_LIMIT_BYTES, schema: { body: { type: 'object' } } },
    async (request, reply) => {
      const { runId } = request.params as { runId: string };
      await forward(reply, `/api/saved-runs/${encodeURIComponent(runId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    },
  );

  fastify.delete('/api/momentum/saved-runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    await forward(reply, `/api/saved-runs/${encodeURIComponent(runId)}`, { method: 'DELETE' });
  });

  // Favourites are intentionally not scoped to the currently selected dataset:
  // the weekly scheduler evaluates the complete set and has one global active
  // strategy whose result may be sent to Telegram.
  fastify.get('/api/momentum/favorite-strategies', async (_request, reply) => {
    await forward(reply, '/api/favorite-strategies');
  });

  // Manual trigger for the Friday weekly signal (TODO.md 3.11.5) — the same code path the
  // launchd-scheduled `mbt weekly` CLI runs. Returns 202 at once with a background job; the
  // browser polls /weekly/jobs/latest, so leaving the page does not lose the run. A real
  // trigger (send=true, the default) posts to the same Telegram chat the schedule does.
  fastify.post(
    '/api/momentum/weekly/run',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: 'object',
          required: ['run'],
          properties: {
            run: { type: 'string', enum: ['preview', 'final'] },
            send: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await forward(reply, '/api/weekly/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    },
  );

  fastify.get('/api/momentum/weekly/jobs/latest', async (_request, reply) => {
    await forward(reply, '/api/weekly/jobs/latest');
  });

  // B4: manual "Refresh stock data" trigger (bhavcopy fetch + shared-DB migrate) for the
  // dashboard's Data panel — same background-job pattern as /weekly/run above.
  fastify.post('/api/momentum/weekly/stock-sync', async (_request, reply) => {
    await forward(reply, '/api/weekly/stock-sync', { method: 'POST' });
  });

  fastify.get('/api/momentum/weekly/stock-sync/jobs/latest', async (_request, reply) => {
    await forward(reply, '/api/weekly/stock-sync/jobs/latest');
  });

  fastify.get('/api/momentum/stock-actions', async (_request, reply) => {
    await forward(reply, '/api/stock-actions');
  });

  fastify.post(
    '/api/momentum/stock-actions/review',
    { schema: { body: { type: 'object' } } },
    async (request, reply) => {
      await forward(reply, '/api/stock-actions/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    },
  );

  // How far each weekly input has been ingested, the last saved signals, and the
  // scheduled jobs' last runs.
  fastify.get('/api/momentum/weekly/status', async (_request, reply) => {
    await forward(reply, '/api/weekly/status');
  });

  fastify.get(
    '/api/momentum/journal',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { week: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { week } = request.query as { week?: string };
      await forward(reply, week ? `/api/journal?week=${encodeURIComponent(week)}` : '/api/journal');
    },
  );

  fastify.post(
    '/api/momentum/rebalance-preview',
    { bodyLimit: BODY_LIMIT_BYTES, schema: { body: { type: 'object' } } },
    async (request, reply) => {
      await forward(reply, '/api/rebalance-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request.body),
      });
    },
  );
});
