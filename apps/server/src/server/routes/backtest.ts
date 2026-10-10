/**
 * Backtest API proxy routes — the only public-facing surface in front of
 * the loopback-only Python FastAPI service (packages/option-backtesting,
 * `obt-api` / `bun run py:api`).
 *
 * Registers:
 *  GET  /api/backtest/health        — pass-through health check (no gate)
 *  GET  /api/backtest/presets       — list example strategies (no gate — browsing is free)
 *  GET  /api/backtest/presets/:name — one preset's YAML content (no gate)
 *  POST /api/backtest/validate      — validate strategy YAML (no gate — free, encourages
 *                                      iterating on a strategy before spending a credit to run it)
 *  GET  /api/backtest/coverage      — cached date-range metadata (no gate)
 *  POST /api/backtest/runs          — RUN a backtest. requireAccess + consumeCredit('backtest_run')
 *  GET  /api/backtest/runs          — list past runs. requireAccess (viewing paid results), no new charge.
 *  GET  /api/backtest/runs/:id      — one past run. requireAccess, no new charge.
 *
 * Leg-wise "Options Lab" (packages/option-backtesting api/legwise_routes.py):
 *  GET  /api/backtest/legwise/strategies        — saved strategies. requireAccess
 *  PUT  /api/backtest/legwise/strategies/:name  — save one (slug-checked here AND in Python). requireAccess
 *  POST /api/backtest/legwise/validate          — validate a strategy (no gate, like /validate)
 *  POST /api/backtest/legwise/backtest          — run one over collected days. requireAccess +
 *                                                 consumeCredit('backtest_run'), same as /runs
 *  GET  /api/backtest/legwise/data              — collected days + Fyers token status. requireAccess
 *  GET  /api/backtest/legwise/results           — saved daily results. requireAccess
 *  GET  /api/backtest/legwise/day               — re-simulate one saved day (MTM curve, markers,
 *                                                  per-leg attribution). requireAccess
 *  GET  /api/backtest/legwise/anatomy           — per-day, per-segment index shape. requireAccess
 *  GET  /api/backtest/legwise/correlation/available — strategies with daily results + picker groups.
 *                                                  requireAccess
 *  GET  /api/backtest/legwise/correlation       — how the chosen strategies' daily P&L move together
 *                                                 (matrices, basket drawdown, drift). requireAccess
 *  GET  /api/backtest/legwise/correlation/pick  — a basket under a correlation cap (in-sample).
 *  GET  /api/backtest/legwise/rotation/overview — the Rotation page: data health, the latest baskets, the lists.
 *  GET  /api/backtest/legwise/rotation/summary  — the 60-day read-out: lists against REF, the base and random baskets.
 *                                                 requireAccess
 *  POST /api/backtest/legwise/daily             — start the evening run (background; Telegram
 *                                                 summary unless telegram:false). requireAccess
 *  GET  /api/backtest/legwise/daily             — that run's state/log. requireAccess
 *
 * Security decisions:
 *
 * 1. HOST ALLOW-LIST (no SSRF) — BACKTEST_API_URL is validated at plugin-
 *    registration time to resolve to loopback or RFC1918 private address
 *    space by hostname literal (no DNS resolution — the intended deployment
 *    is always a sibling process on the same host or in the same private
 *    network). A misconfigured env var pointing this proxy at an arbitrary
 *    public host must fail LOUDLY at startup, matching the safe-default-
 *    throw convention already used for broker selection
 *    (ingestion/brokers/broker-factory.ts) — never silently relay to an
 *    unchecked host.
 *
 * 2. TIMEOUT + BODY CAP — every proxied call uses a 30s timeout
 *    (AbortSignal.timeout) so a hung Python process can never hang this
 *    request indefinitely. POST bodies are capped at 64 KB — a strategy
 *    YAML is a few hundred bytes to a few KB; 64 KB is generous headroom,
 *    not an invitation to accept an arbitrarily large body.
 *
 * 3. CREDIT CONSUMPTION HAPPENS BEFORE THE PYTHON CALL, NOT AFTER — the
 *    original design note for this route ("after a 2xx from Python, consume
 *    a credit; on credit failure return 402 and do not persist") is
 *    unworkable now that the Python service's own POST /runs handler
 *    unconditionally records the run in its own SQLite registry as part of
 *    producing that 2xx (see packages/option-backtesting's
 *    engine/registry.py) — there is no "don't persist" left to fall back to
 *    once Python has already responded. Reserving payment FIRST is also the
 *    structurally safer order for any metered endpoint: the expensive
 *    computation can never be triggered for free by a client that read the
 *    credit-check timing. If consumeCredit fails, the Python service is
 *    never called at all.
 *
 * 4. NO DEFAULT EXPORT (project convention).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';

import { consumeCredit, isPaymentEnabled } from '../../payment/razorpay';
import { requireAccess } from '../middleware/access-gate';

const DEFAULT_BACKTEST_API_URL = 'http://127.0.0.1:8000';
const PROXY_TIMEOUT_MS = 30_000;
const BODY_LIMIT_BYTES = 64 * 1024;

function backtestApiUrl(): string {
  return process.env.BACKTEST_API_URL || DEFAULT_BACKTEST_API_URL;
}

/**
 * Throws if `url` does not resolve to loopback or RFC1918 private address
 * space — called once at plugin-registration time (fail closed at startup,
 * never at request time, so a bad env var can never be reached by a live
 * request).
 */
function assertSafeBacktestHost(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const isPrivate =
    /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (!isLoopback && !isPrivate) {
    throw new Error(
      `BACKTEST_API_URL (${url}) does not resolve to a loopback or private host — refusing to start the backtest proxy against a public host.`,
    );
  }
}

async function proxyFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${backtestApiUrl()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
  });
}

/**
 * Forward the upstream response's status and JSON body to the client.
 * Network failures (Python service down, DNS error, timeout) become a
 * clear 503 rather than an uncaught fetch rejection turning into an opaque
 * 500 via Fastify's default error handler.
 */
async function forwardToBacktestApi(
  reply: FastifyReply,
  path: string,
  init?: RequestInit,
): Promise<void> {
  let upstream: Response;
  try {
    upstream = await proxyFetch(path, init);
  } catch {
    await reply.status(503).send({ error: 'backtest_service_unavailable' });
    return;
  }
  const body = await upstream.json().catch(() => ({ error: 'invalid_upstream_response' }));
  await reply.status(upstream.status).send(body);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

export const backtestRoutes = fp(async (fastify: FastifyInstance, _opts: unknown) => {
  assertSafeBacktestHost(backtestApiUrl());

  // ── GET /api/backtest/health ───────────────────────────────────────────────

  fastify.get('/api/backtest/health', async (_request, reply) => {
    await forwardToBacktestApi(reply, '/health');
  });

  // ── GET /api/backtest/presets ──────────────────────────────────────────────

  fastify.get('/api/backtest/presets', async (_request, reply) => {
    await forwardToBacktestApi(reply, '/presets');
  });

  // ── GET /api/backtest/presets/:name ────────────────────────────────────────

  fastify.get(
    '/api/backtest/presets/:name',
    {
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' } },
          required: ['name'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      await forwardToBacktestApi(reply, `/presets/${encodeURIComponent(name)}`);
    },
  );

  // ── POST /api/backtest/validate ────────────────────────────────────────────

  fastify.post(
    '/api/backtest/validate',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: 'object',
          properties: { yaml: { type: 'string', maxLength: BODY_LIMIT_BYTES } },
          required: ['yaml'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await forwardToBacktestApi(reply, '/validate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(request.body),
      });
    },
  );

  // ── GET /api/backtest/coverage ─────────────────────────────────────────────

  fastify.get(
    '/api/backtest/coverage',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            underlying: { type: 'string', enum: ['NIFTY', 'BANKNIFTY', 'SENSEX'] },
          },
          required: ['underlying'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { underlying } = request.query as { underlying: string };
      await forwardToBacktestApi(reply, `/coverage?underlying=${encodeURIComponent(underlying)}`);
    },
  );

  // ── POST /api/backtest/runs ────────────────────────────────────────────────

  fastify.post(
    '/api/backtest/runs',
    {
      preHandler: requireAccess,
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: 'object',
          properties: {
            yaml: { type: 'string', maxLength: BODY_LIMIT_BYTES },
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            bootstrap: { type: 'boolean' },
            bootstrap_resamples: { type: 'integer', minimum: 1, maximum: 20000 },
            seed: { type: 'integer' },
          },
          required: ['yaml', 'from', 'to'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (isPaymentEnabled()) {
        const { success } = await consumeCredit(request.server.db, 'backtest_run');
        if (!success) {
          await reply.status(402).send({ error: 'insufficient_credits' });
          return;
        }
      }

      await forwardToBacktestApi(reply, '/runs', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(request.body),
      });
    },
  );

  // ── GET /api/backtest/runs ─────────────────────────────────────────────────

  fastify.get(
    '/api/backtest/runs',
    {
      preHandler: requireAccess,
      schema: {
        querystring: {
          type: 'object',
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { limit } = request.query as { limit?: number };
      const qs = limit !== undefined ? `?limit=${limit}` : '';
      await forwardToBacktestApi(reply, `/runs${qs}`);
    },
  );

  // ── GET /api/backtest/runs/:id ─────────────────────────────────────────────

  fastify.get(
    '/api/backtest/runs/:id',
    {
      preHandler: requireAccess,
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: '^[A-Za-z0-9]+$' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await forwardToBacktestApi(reply, `/runs/${encodeURIComponent(id)}`);
    },
  );
  // ── Leg-wise "Options Lab" ─────────────────────────────────────────────────
  // The strategy body is an opaque object here: the Python side validates it
  // field by field (pydantic, extra="forbid"), so duplicating that schema in
  // two languages would only let them drift. The body cap still applies.

  const strategyBody = {
    type: 'object',
    properties: { strategy: { type: 'object' } },
    required: ['strategy'],
    additionalProperties: false,
  } as const;

  fastify.get(
    '/api/backtest/legwise/strategies',
    { preHandler: requireAccess },
    async (_req, reply) => {
      await forwardToBacktestApi(reply, '/legwise/strategies');
    },
  );

  fastify.put(
    '/api/backtest/legwise/strategies/:name',
    {
      preHandler: requireAccess,
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: {
          type: 'object',
          properties: { name: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' } },
          required: ['name'],
          additionalProperties: false,
        },
        body: strategyBody,
      },
    },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      await forwardToBacktestApi(reply, `/legwise/strategies/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify(request.body),
      });
    },
  );

  fastify.post(
    '/api/backtest/legwise/validate',
    { bodyLimit: BODY_LIMIT_BYTES, schema: { body: strategyBody } },
    async (request, reply) => {
      await forwardToBacktestApi(reply, '/legwise/validate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(request.body),
      });
    },
  );

  fastify.post(
    '/api/backtest/legwise/backtest',
    {
      preHandler: requireAccess,
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        body: {
          type: 'object',
          properties: {
            strategy: { type: 'object' },
            from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          },
          required: ['strategy'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (isPaymentEnabled()) {
        const { success } = await consumeCredit(request.server.db, 'backtest_run');
        if (!success) {
          await reply.status(402).send({ error: 'insufficient_credits' });
          return;
        }
      }
      await forwardToBacktestApi(reply, '/legwise/backtest', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(request.body),
      });
    },
  );

  fastify.get('/api/backtest/legwise/data', { preHandler: requireAccess }, async (_req, reply) => {
    await forwardToBacktestApi(reply, '/legwise/data');
  });

  fastify.get(
    '/api/backtest/legwise/results',
    { preHandler: requireAccess },
    async (_req, reply) => {
      await forwardToBacktestApi(reply, '/legwise/results');
    },
  );

  // The query strings below are schema-validated field by field and the upstream
  // query is REBUILT from those fields — the raw client string is never forwarded.
  const DATE_RE = '^\\d{4}-\\d{2}-\\d{2}$';
  const CUTS_RE = '^\\d{2}:\\d{2}(,\\d{2}:\\d{2}){0,3}$';

  function upstreamQuery(query: Record<string, unknown>, keys: string[]): string {
    const params = new URLSearchParams();
    for (const key of keys) {
      const value = query[key];
      if (typeof value === 'string' && value !== '') params.set(key, value);
    }
    const text = params.toString();
    return text ? `?${text}` : '';
  }

  fastify.get(
    '/api/backtest/legwise/day',
    {
      preHandler: requireAccess,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            strategy: { type: 'string', pattern: '^[a-z0-9_]{1,64}$' },
            day: { type: 'string', pattern: DATE_RE },
            sha: { type: 'string', pattern: '^[0-9a-f]{1,64}$' },
            cuts: { type: 'string', pattern: CUTS_RE },
          },
          required: ['strategy', 'day'],
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      await forwardToBacktestApi(
        reply,
        `/legwise/day${upstreamQuery(q, ['strategy', 'day', 'sha', 'cuts'])}`,
      );
    },
  );

  fastify.get(
    '/api/backtest/legwise/anatomy',
    {
      preHandler: requireAccess,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            underlying: { type: 'string', pattern: '^[A-Z]{3,12}$' },
            from: { type: 'string', pattern: DATE_RE },
            to: { type: 'string', pattern: DATE_RE },
            cuts: { type: 'string', pattern: CUTS_RE },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      await forwardToBacktestApi(
        reply,
        `/legwise/anatomy${upstreamQuery(q, ['underlying', 'from', 'to', 'cuts'])}`,
      );
    },
  );

  // Correlation (BL-090). Selectors are comma-separated tokens; the Python side matches them only
  // against enumerated strategy names. Numbers stay strings here so upstreamQuery forwards them
  // as given; Python validates the ranges.
  const SELECTORS_RE = '^[A-Za-z0-9_:*?.+,\\[\\]-]{1,400}$';
  const CORRELATION_QUERY = {
    selectors: { type: 'string', pattern: SELECTORS_RE },
    from: { type: 'string', pattern: DATE_RE },
    to: { type: 'string', pattern: DATE_RE },
    include_stale: { type: 'string', enum: ['true', 'false'] },
  } as const;

  fastify.get(
    '/api/backtest/legwise/correlation/available',
    { preHandler: requireAccess },
    async (_req, reply) => {
      await forwardToBacktestApi(reply, '/legwise/correlation/available');
    },
  );

  fastify.get(
    '/api/backtest/legwise/correlation',
    {
      preHandler: requireAccess,
      schema: {
        querystring: {
          type: 'object',
          properties: { ...CORRELATION_QUERY, window: { type: 'string', pattern: '^\\d{1,3}$' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      await forwardToBacktestApi(
        reply,
        `/legwise/correlation${upstreamQuery(q, ['selectors', 'from', 'to', 'window', 'include_stale'])}`,
      );
    },
  );

  fastify.get(
    '/api/backtest/legwise/correlation/pick',
    {
      preHandler: requireAccess,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            ...CORRELATION_QUERY,
            k: { type: 'string', pattern: '^\\d{1,2}$' },
            max_corr: { type: 'string', pattern: '^-?\\d(\\.\\d{1,3})?$' },
            measure: { type: 'string', enum: ['pearson', 'spearman', 'loss'] },
            require: { type: 'string', pattern: '^[A-Za-z0-9_.,-]{1,400}$' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      await forwardToBacktestApi(
        reply,
        `/legwise/correlation/pick${upstreamQuery(q, [
          'selectors',
          'from',
          'to',
          'include_stale',
          'k',
          'max_corr',
          'measure',
          'require',
        ])}`,
      );
    },
  );

  // --- rotation: the Rotation page's read layer (BL-058 Phase 4) ---
  fastify.get(
    '/api/backtest/legwise/rotation/overview',
    {
      preHandler: requireAccess,
      schema: {
        querystring: {
          type: 'object',
          properties: { day: { type: 'string', pattern: DATE_RE } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      await forwardToBacktestApi(reply, `/legwise/rotation/overview${upstreamQuery(q, ['day'])}`);
    },
  );

  fastify.get(
    '/api/backtest/legwise/rotation/summary',
    {
      preHandler: requireAccess,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: DATE_RE },
            to: { type: 'string', pattern: DATE_RE },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      await forwardToBacktestApi(
        reply,
        `/legwise/rotation/summary${upstreamQuery(q, ['from', 'to'])}`,
      );
    },
  );
  // --- end rotation ---

  // --- rotation shadow --- the Shadow scoreboard (rotation/shadow.py, read-only). Only the two
  // optional dates are forwarded; the Python side raises a `from` before the forward window.
  fastify.get(
    '/api/backtest/legwise/rotation/shadow',
    {
      preHandler: requireAccess,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', pattern: DATE_RE },
            to: { type: 'string', pattern: DATE_RE },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      await forwardToBacktestApi(
        reply,
        `/legwise/rotation/shadow${upstreamQuery(q, ['from', 'to'])}`,
      );
    },
  );
  // --- end rotation shadow ---

  fastify.post(
    '/api/backtest/legwise/daily',
    {
      preHandler: requireAccess,
      schema: {
        body: {
          type: 'object',
          properties: {
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            fetch: { type: 'boolean' },
            telegram: { type: 'boolean' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      await forwardToBacktestApi(reply, '/legwise/daily', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(request.body ?? {}),
      });
    },
  );

  fastify.get('/api/backtest/legwise/daily', { preHandler: requireAccess }, async (_req, reply) => {
    await forwardToBacktestApi(reply, '/legwise/daily');
  });
});
