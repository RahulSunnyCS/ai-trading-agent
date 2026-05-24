/**
 * Fastify Server — MVP
 *
 * Provides:
 *  - GET  /health                 — Docker/Railway health check
 *  - GET  /api/straddle/latest    — latest StraddleSnapshot stub (wired in T-21)
 *  - GET  /api/trades             — paper trades from DB (graceful fallback)
 *  - GET  /api/positions          — open positions stub
 *  - WS   /ws/ticks               — synthetic tick broadcast (wired in T-21)
 *
 * Design decisions:
 *  - `buildServer` does NOT call listen() so tests can use server.inject()
 *    without occupying a port.
 *  - The pg Pool is created here rather than re-exported from db/client.ts so
 *    that tests can inject a mock pool via the decorator before any route runs.
 *  - CORS origin:true is intentionally permissive for development; production
 *    will lock this down to a specific allowed-origin list.
 *  - The WS synthetic tick interval is stored on the socket object so it is
 *    cleared on socket close, preventing timer leaks during tests.
 *  - process.env keys are accessed via dot notation to satisfy Biome's
 *    useLiteralKeys rule (no bracket notation).
 */

import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { Pool } from 'pg';

import { fyersAuthRoutes } from './routes/fyers-auth.js';
import { paymentRoutes } from './routes/payment';

// ---------------------------------------------------------------------------
// Fastify module augmentation — makes server.db typed as Pool
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a pg Pool from DATABASE_URL env var.
 * Returns a Pool instance regardless of whether DATABASE_URL is set;
 * connection errors are surfaced at query time, not at construction time.
 */
function buildPool(): Pool {
  return new Pool({
    connectionString: process.env.DATABASE_URL,
    // Keep pool small for the API server — the ingestion pipeline has its own
    // pool with a larger limit (20) in db/client.ts.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Build and configure the Fastify instance.
 *
 * Does NOT call server.listen() — callers (tests, startServer) are responsible
 * for that.
 *
 * @param opts    Standard Fastify server options (logger, etc.).
 * @param externalPool  When provided, the server uses this pool instead of
 *   creating its own. This allows the main entry point (src/index.ts) to share
 *   one pool between the server and the position monitor, avoiding two separate
 *   connection pools competing for the same PostgreSQL connections. When absent,
 *   buildServer() creates its own pool (used in tests and standalone server
 *   runs where pool sharing is not required).
 */
export async function buildServer(
  opts?: FastifyServerOptions,
  externalPool?: Pool,
): Promise<FastifyInstance> {
  const server = Fastify({
    logger: opts?.logger ?? true,
    ...opts,
  });

  // ── Plugins ───────────────────────────────────────────────────────────────

  // CORS — origin:true mirrors every origin back as allowed.
  // Production note: replace with a specific origin allowlist before deploying
  // to a public-facing environment.
  await server.register(fastifyCors, { origin: true });

  // WebSocket support — required before any route uses { websocket: true }.
  await server.register(fastifyWebsocket);

  // ── DB decorator ──────────────────────────────────────────────────────────

  // Decorate early so all route handlers can access server.db.
  // Tests replace this with a mock Pool before injecting requests.
  //
  // If an external pool is supplied (e.g. from the main entry point), use it
  // directly.  We do NOT close an external pool on server close because the
  // caller that owns the pool is responsible for its lifecycle.
  const pool = externalPool ?? buildPool();
  const ownsPool = externalPool === undefined;
  server.decorate('db', pool);

  // Close the pool on server close ONLY when we created it.  If an external
  // pool was injected, the caller owns it and will close it during shutdown.
  if (ownsPool) {
    server.addHook('onClose', async () => {
      await pool.end();
    });
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  // GET /health — Docker / Railway health probe
  server.get('/health', async (_request, reply) => {
    return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // GET /api/straddle/latest — stub; real wiring in T-21
  server.get('/api/straddle/latest', async (request, reply) => {
    // Optional query param: ?underlying=NIFTY (default NIFTY)
    // We read it from query string but do not use it in the stub yet.
    const query = request.query as Record<string, string | undefined>;
    const underlying = query.underlying ?? 'NIFTY';
    // underlying is accepted for logging/future wiring but not acted upon here.
    void underlying;

    return reply.send({
      data: null,
      message: 'straddle calculator not yet connected',
    });
  });

  // GET /api/trades — query paper_trades; return empty array if DB unavailable
  server.get('/api/trades', async (_request, reply) => {
    try {
      const result = await server.db.query<{ id: string }>(
        'SELECT * FROM paper_trades ORDER BY entry_time DESC LIMIT 100',
      );
      if (result.rows.length === 0) {
        return reply.send({ data: [], message: 'no trades yet' });
      }
      return reply.send({ data: result.rows });
    } catch {
      // DB not connected or paper_trades table does not exist yet — return
      // graceful empty response rather than crashing.
      return reply.send({ data: [], message: 'no trades yet' });
    }
  });

  // GET /api/positions — stub open positions; real wiring in a later task
  server.get('/api/positions', async (_request, reply) => {
    return reply.send({ data: [], message: 'no open positions' });
  });

  // GET /api/regime-tags — daily regime tags from daily_regime_tags table.
  //
  // Query params (all optional):
  //   symbol  — default 'NIFTY'
  //   from    — YYYY-MM-DD start date (inclusive), default: 30 days ago
  //   to      — YYYY-MM-DD end date (inclusive), default: today
  //
  // Range is capped at 366 days to bound the hypertable scan: the
  // daily_regime_tags table is date-partitioned and a 366-day cap keeps
  // the worst-case query to a single calendar year.
  server.get('/api/regime-tags', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const symbol = query.symbol ?? 'NIFTY';

    // Compute default date range: last 30 days ending today.
    const nowMs = Date.now();
    const todayIso = new Date(nowMs).toISOString().slice(0, 10);
    const thirtyDaysAgoIso = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const fromStr = query.from ?? thirtyDaysAgoIso;
    const toStr = query.to ?? todayIso;

    // Validate that the provided date strings parse as actual calendar dates.
    // Date.parse() returns NaN for strings that are not valid ISO dates;
    // we reject rather than silently fall back to the default so callers get
    // immediate feedback on bad inputs.
    const fromMs = Date.parse(fromStr);
    const toMs = Date.parse(toStr);

    if (Number.isNaN(fromMs)) {
      return reply.code(400).send({ error: `Invalid 'from' date: ${fromStr}` });
    }
    if (Number.isNaN(toMs)) {
      return reply.code(400).send({ error: `Invalid 'to' date: ${toStr}` });
    }

    // Cap range at 366 days to prevent full-table scans on the hypertable.
    const diffDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);
    if (diffDays > 366) {
      return reply.code(400).send({
        error: `Date range exceeds 366 days (${Math.ceil(diffDays)} days requested).`,
      });
    }

    try {
      const result = await server.db.query<{
        id: number;
        trade_date: Date;
        symbol: string;
        regime: string;
        regime_confidence: string;
        classified_at: Date;
      }>(
        `SELECT id, trade_date, symbol, regime, regime_confidence, classified_at
         FROM daily_regime_tags
         WHERE symbol = $1
           AND trade_date >= $2
           AND trade_date <= $3
         ORDER BY trade_date DESC`,
        [symbol, fromStr, toStr],
      );

      return reply.send({ data: result.rows });
    } catch {
      // Table does not exist yet or DB is unavailable — return a graceful empty
      // response rather than a 500 so the frontend renders the empty state.
      return reply.send({ data: [], message: 'no regime tags yet' });
    }
  });

  // GET /api/personalities — personality configs from personality_configs table.
  //
  // Query params (optional):
  //   include_inactive — when 'true', return all 10 personalities regardless of
  //                      active state; otherwise return only is_active = TRUE rows.
  //
  // The route uses parameterised SQL only ($1 placeholder). `params` is a JSONB
  // column — pg returns it already parsed as a JS object; no JSON.parse needed.
  // On DB error (table missing, connection down) we return a graceful empty
  // response so the dashboard renders the empty state instead of a 500.
  server.get('/api/personalities', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    // Only activate the "all rows" path when include_inactive is explicitly
    // the string 'true'. Any other value (absent, 'false') returns active-only.
    const includeInactive = query.include_inactive === 'true';

    try {
      // We branch on includeInactive rather than building a dynamic WHERE clause
      // so the SQL remains fully literal — no string interpolation at all.
      let result: { rows: unknown[] };
      if (includeInactive) {
        result = await server.db.query(
          `SELECT id, name, display_name, group_type, entry_type,
                  management_style, is_frozen, is_active, phase, params,
                  created_at, updated_at
           FROM personality_configs
           ORDER BY created_at ASC`,
        );
      } else {
        result = await server.db.query(
          `SELECT id, name, display_name, group_type, entry_type,
                  management_style, is_frozen, is_active, phase, params,
                  created_at, updated_at
           FROM personality_configs
           WHERE is_active = $1
           ORDER BY created_at ASC`,
          [true],
        );
      }

      return reply.send({ data: result.rows });
    } catch {
      // Table does not exist yet or DB is unavailable — return graceful empty
      // response so the frontend renders the empty state, not a 500.
      return reply.send({ data: [], message: 'no personalities yet' });
    }
  });

  // GET /api/backfill — backfill job ranges from backfill_ranges table.
  //
  // Query params (optional):
  //   symbol — if provided, filter rows to that symbol; else return all.
  //
  // Hard LIMIT 200 ORDER BY from_ts DESC keeps the response bounded even
  // without date params (backfill_ranges has one row per job, so 200 rows
  // represents at most 200 backfill runs — a sensible UI ceiling).
  server.get('/api/backfill', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const symbol = query.symbol;

    try {
      // Use a parameterised query that optionally filters by symbol.
      // When symbol is undefined we pass NULL and the IS NULL check falls
      // through so all rows are returned — avoids string interpolation.
      const result = await server.db.query<{
        id: number;
        symbol: string;
        from_ts: Date;
        to_ts: Date;
        resolution: string;
        status: string;
        rows_written: number;
        checkpoint_ts: Date | null;
        gaps_detected: number;
        gaps_json: string | null;
        updated_at: Date;
        created_at: Date;
      }>(
        `SELECT id, symbol, from_ts, to_ts, resolution, status,
                rows_written, checkpoint_ts, gaps_detected, gaps_json,
                updated_at, created_at
         FROM backfill_ranges
         WHERE ($1::text IS NULL OR symbol = $1)
         ORDER BY from_ts DESC
         LIMIT 200`,
        [symbol ?? null],
      );

      return reply.send({ data: result.rows });
    } catch {
      // Table does not exist yet or DB is unavailable.
      return reply.send({ data: [], message: 'no backfill ranges yet' });
    }
  });

  // WS /ws/ticks — synthetic tick broadcast; real wiring in T-21
  server.get('/ws/ticks', { websocket: true }, (socket, _request) => {
    // Send a "connected" confirmation immediately so the dashboard knows the
    // socket is live.
    socket.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));

    // Broadcast synthetic NIFTY ticks every 5 seconds so the dashboard has
    // data to render before the real straddle calculator is wired up (T-21).
    const interval = setInterval(() => {
      if (socket.readyState !== socket.OPEN) {
        clearInterval(interval);
        return;
      }
      // Synthetic random-walk tick — not representative of real market data.
      const syntheticTick = {
        type: 'tick',
        symbol: 'NSE:NIFTY50-INDEX',
        ltp: 22_000 + Math.round(Math.random() * 500),
        timestamp: Date.now(),
      };
      socket.send(JSON.stringify(syntheticTick));
    }, 5_000);

    // Clear interval on client disconnect to prevent timer leaks.
    socket.on('close', () => {
      clearInterval(interval);
    });
  });

  // ── Payment routes ────────────────────────────────────────────────────────

  // Register the payment plugin last so it can access server.db (decorated
  // above) and all other plugins that its handlers depend on.  The plugin is
  // wrapped in fastify-plugin (see payment.ts) so it runs in the parent scope
  // and can access all decorators without re-declaration.
  await server.register(paymentRoutes);
  await server.register(fyersAuthRoutes);

  return server;
}

// ---------------------------------------------------------------------------
// Start — binds to a port (not used in tests)
// ---------------------------------------------------------------------------

/**
 * Build the server and bind to PORT (default 3000) on 0.0.0.0.
 * Registers SIGINT/SIGTERM handlers for graceful shutdown.
 *
 * @param externalPool  Optional shared pool — forwarded to buildServer().
 *   See buildServer() doc for the ownership semantics.
 */
export async function startServer(externalPool?: Pool): Promise<void> {
  const server = await buildServer(undefined, externalPool);

  // Read port from env using dot notation (Biome useLiteralKeys requirement).
  const rawPort = process.env.PORT ?? '3000';
  const port = Number.parseInt(rawPort, 10);

  // Graceful shutdown — close the server before the process exits.
  const shutdown = async (signal: string): Promise<void> => {
    server.log.info(`[server] received ${signal} — shutting down`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.listen({ port, host: '0.0.0.0' });
}
