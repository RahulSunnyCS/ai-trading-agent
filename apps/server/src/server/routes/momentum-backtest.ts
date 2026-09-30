/**
 * Momentum-backtesting API proxy.
 *
 * The Python Momentum service stays loopback/private just like the options
 * backtesting service. This route is its only browser-facing boundary and
 * deliberately preserves the Python API's payloads while the old static UI is
 * migrated into the shared Next dashboard.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

const DEFAULT_MOMENTUM_API_URL = 'http://127.0.0.1:8765';
// A cold Custom Index run builds dozens of inner category backtests and can
// exceed 90 seconds on local research data.
const PROXY_TIMEOUT_MS = 180_000;
const BODY_LIMIT_BYTES = 64 * 1024;

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
          properties: { dataset: { type: 'string', enum: ['etf', 'stock', 'custom_index', 'broad'] } },
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
});
