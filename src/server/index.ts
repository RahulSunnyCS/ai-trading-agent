/**
 * Fastify Server — MVP
 *
 * Provides:
 *  - GET  /health                 — Docker/Railway health check
 *  - GET  /api/straddle/latest    — latest StraddleSnapshot stub (wired in T-21)
 *  - GET  /api/trades             — paper trades from DB (graceful fallback)
 *  - GET  /api/positions          — open positions stub
 *  - GET  /api/meta               — environment metadata for the frontend banner
 *  - WS   /ws/ticks               — real tick feed from Redis streams
 *
 * Design decisions:
 *  - `buildServer` does NOT call listen() so tests can use server.inject()
 *    without occupying a port.
 *  - The pg Pool is created here rather than re-exported from db/client.ts so
 *    that tests can inject a mock pool via the decorator before any route runs.
 *  - CORS origin:true is intentionally permissive for development; production
 *    will lock this down to a specific allowed-origin list.
 *  - The WS handler uses a per-connection duplicated Redis client for stream
 *    reads so the shared `redis` client (used everywhere else) is never blocked
 *    by long-running XREAD calls. The duplicate is quit()'d on socket close.
 *  - When `redis` is not provided (unit tests), the WS endpoint degrades
 *    gracefully: sends 'connected' and no ticks — no crash.
 *  - process.env keys are accessed via dot notation to satisfy Biome's
 *    useLiteralKeys rule (no bracket notation).
 *  - A single server-level onClose hook (registered once in buildServer) drains
 *    the wsCleanupCallbacks Set. Per-connection cleanup is added to the Set on
 *    open and removed on socket 'close' — no per-connection onClose hooks so
 *    there is no unbounded hook accumulation.
 *  - MAX_WS_CONNECTIONS (default 50, env-configurable) caps concurrent /ws/ticks
 *    connections. A new connection that exceeds the cap receives a JSON error
 *    frame and is closed before any Redis duplicate() is called.
 */

import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import type { Queue } from 'bullmq';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import type { Redis } from 'ioredis';
import { Pool } from 'pg';

import { retrospectionRoutes } from '../api/routes/retrospection.js';
import {
  createEodRetrospectionQueue,
  createEodRetrospectionWorker,
} from '../jobs/eod-retrospection-job.js';
import { isAuthDegraded } from '../state/broker-status.js';
import { fyersAuthRoutes } from './routes/fyers-auth.js';
import { paymentRoutes } from './routes/payment';

// ---------------------------------------------------------------------------
// WebSocket connection tracking — module-scoped to survive per-call scope
// ---------------------------------------------------------------------------

/**
 * Set of cleanup callbacks for currently active /ws/ticks connections.
 *
 * Each connection registers its own cleanup() function here on open and
 * removes it on socket 'close'. A single server-level onClose hook (registered
 * once in buildServer) iterates this Set to drain all active connections when
 * the server shuts down. This replaces the old pattern of calling
 * server.addHook('onClose', ...) inside the per-connection handler, which
 * caused an unbounded accumulation of server hooks — one per historical
 * connection, never removed.
 */
const wsCleanupCallbacks = new Set<() => void>();

/**
 * Count of currently open /ws/ticks connections.
 * Incremented before the connection is fully established; decremented in the
 * socket 'close' handler (which always fires, even after a rejected upgrade).
 */
let wsConnectionCount = 0;

/**
 * Maximum concurrent /ws/ticks connections allowed.
 *
 * Configurable via MAX_WS_CONNECTIONS env var (must be a positive integer).
 * Defaults to 50. When exceeded the new connection receives a JSON error frame
 * and is immediately closed — no Redis duplicate() is opened.
 *
 * The cap is intentionally conservative: each active WS connection holds one
 * duplicated Redis client (TCP connection) and two long-running async loops.
 * 50 is well within normal Redis connection limits (default 10 000) while
 * preventing runaway resource consumption from connection floods.
 */
const MAX_WS_CONNECTIONS: number = (() => {
  const raw = process.env.MAX_WS_CONNECTIONS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    // Silently ignore non-positive or non-integer values and fall back to 50.
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 50;
})();

// ---------------------------------------------------------------------------
// Fastify module augmentation — makes server.db and server.redis typed
// ---------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
    // Decorated in buildServer() so route plugins can enqueue EOD jobs via
    // the same Queue instance (and Redis connection) without creating their own.
    eodQueue: Queue;
    // Optional Redis client — absent when buildServer is called without one
    // (e.g. unit tests). Routes must check for its presence before use.
    redis: Redis | undefined;
    /**
     * In-process broker reload hook — called by the Fyers OAuth callback after
     * a fresh token is stored. Fires the broker reconnect in the main entry
     * point (src/index.ts) without restarting the process. Null when
     * buildServer is called without the hook (unit tests, standalone server).
     */
    onTokenStored: (() => void | Promise<void>) | null;
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
 * @param externalRedis  When provided, the server decorates itself with this
 *   Redis client and uses it to stream live ticks and straddle values to WS
 *   clients. When absent (unit tests), the WS endpoint degrades gracefully.
 * @param onTokenStored  Optional hook called by the Fyers OAuth callback after
 *   a fresh token is persisted. Wired to the in-process broker reload function
 *   from src/index.ts so a successful dashboard login brings the feed up live
 *   without a process restart. When absent (unit tests / standalone server) the
 *   hook decoration is null and the callback fires nothing.
 */
export async function buildServer(
  opts?: FastifyServerOptions,
  externalPool?: Pool,
  externalRedis?: Redis,
  onTokenStored?: () => void | Promise<void>,
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

  // Rate limiting — 60 requests per minute per IP globally; mutating POST
  // routes are the primary concern (FOR UPDATE locks + pool contention).
  await server.register(fastifyRateLimit, { max: 60, timeWindow: '1 minute' });

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

  // Decorate with the optional Redis client.  When absent (unit tests or
  // standalone server without Redis), routes and the WS handler guard against
  // undefined before using it — no crashes.
  server.decorate('redis', externalRedis);

  // Decorate with the optional broker reload hook. Routes call
  // server.onTokenStored?.() after storing a fresh token. Null when the
  // server is built without a hook (unit tests / standalone). We store null
  // rather than a no-op function so callers can distinguish "no hook wired"
  // from "hook wired but produced no error" — the OAuth callback logs the
  // fire-and-forget result only when the hook is present.
  server.decorate('onTokenStored', onTokenStored ?? null);

  // Create the BullMQ EOD queue and decorate the server so route plugins can
  // enqueue jobs without importing the queue factory themselves. The queue is
  // always created here (even in test runs) because the Queue constructor only
  // opens a Redis connection lazily — creating it does not force a Redis
  // connection at startup, so tests without Redis do not break.
  const eodQueue = createEodRetrospectionQueue();
  server.decorate('eodQueue', eodQueue);

  // Close the pool on server close ONLY when we created it.  If an external
  // pool was injected, the caller owns it and will close it during shutdown.
  if (ownsPool) {
    server.addHook('onClose', async () => {
      await pool.end();
    });
  }

  // Single server-level onClose hook for WS connection drain.
  //
  // This is registered ONCE here (buildServer scope) rather than once per
  // WebSocket connection. Each active /ws/ticks connection adds its cleanup()
  // to wsCleanupCallbacks on open and removes it on socket 'close'. When the
  // server shuts down, this hook drains whatever connections are still open.
  //
  // Idempotency: cleanup() sets a `cleanupCalled` flag so calling it twice
  // (once from 'close', once from here) is safe.
  server.addHook('onClose', (_instance, done) => {
    for (const cb of wsCleanupCallbacks) {
      cb();
    }
    // The Set is drained by each cb() call (cb removes itself). Clear any
    // stragglers defensively.
    wsCleanupCallbacks.clear();
    done();
  });

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

  // GET /api/meta — environment metadata for the frontend banner.
  // Returns the simulation flag, broker name, and live auth-degraded state so
  // the UI can display a contextual status label ("SIM mode / Fyers" etc.) and
  // a "re-login required" banner when the Fyers WebSocket has failed mid-session.
  //
  // authDegraded is read from the module-private state in broker-status.ts via
  // the pure getter isAuthDegraded(). It never throws — the getter returns false
  // if the module is not yet initialised (i.e. the broker has not disconnected).
  server.get('/api/meta', async (_request, reply) => {
    return reply.send({
      simulate: process.env.SIMULATE === 'true',
      broker: process.env.BROKER ?? '',
      authDegraded: isAuthDegraded(),
    });
  });

  // WS /ws/ticks — real tick feed from Redis streams market.ticks and
  // straddle.values. Each connected socket gets its own duplicated Redis client
  // so that per-connection XREAD calls never block the shared client used by
  // the ingestion pipeline and other routes.
  //
  // Message shapes forwarded to the client:
  //   { type: 'tick', symbol, ltp, timestamp }        — from market.ticks
  //   { type: 'straddle', straddleValue, atmStrike,
  //     cePrice, pePrice, timestamp, roc?, acceleration? } — from straddle.values
  //
  // When redis is not provided (unit tests), the handler sends 'connected' and
  // returns immediately — no crash, no ticks.
  //
  // Connection cap: MAX_WS_CONNECTIONS (default 50, env-configurable).
  // When exceeded, the new socket receives a JSON error frame and is closed
  // immediately before any redis.duplicate() is called. This prevents unbounded
  // resource consumption from connection floods (each active connection holds
  // one duplicated Redis TCP connection and two async poll loops).
  //
  // Lifecycle / cleanup design:
  //   - Each connection's cleanup() is added to wsCleanupCallbacks on open.
  //   - The socket 'close' handler removes it and decrements wsConnectionCount.
  //   - A single server-level onClose hook (registered once below, outside this
  //     per-connection handler) drains the entire Set on server shutdown.
  //   - NO per-connection server.addHook('onClose', ...) is used — the old
  //     pattern accumulated one hook per historical connection, never cleaned up.
  server.get('/ws/ticks', { websocket: true }, (socket, _request) => {
    // ── Connection cap check ──────────────────────────────────────────────────
    // Check BEFORE opening any Redis connection or starting loops.
    if (wsConnectionCount >= MAX_WS_CONNECTIONS) {
      // Send a structured error so the client can surface a meaningful message
      // rather than a bare close frame with no context.
      socket.send(
        JSON.stringify({
          type: 'error',
          code: 'TOO_MANY_CONNECTIONS',
          message: `Server has reached the maximum of ${MAX_WS_CONNECTIONS} concurrent WebSocket connections. Try again later.`,
        }),
      );
      socket.close();
      return;
    }

    // Track this connection. Increment before the async path so the count is
    // accurate even if an error occurs during setup.
    wsConnectionCount++;

    // Always send the 'connected' acknowledgement immediately so the client
    // knows the socket is live regardless of Redis availability.
    socket.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));

    const redis = server.redis;
    if (!redis) {
      // Redis not configured (unit tests / standalone) — degrade gracefully.
      // Decrement the count now; the socket 'close' event will also fire but
      // the cleanup registered below handles deduplication via the Set.
      // We still register the socket 'close' handler to keep the count correct.
      socket.on('close', () => {
        wsConnectionCount--;
      });
      return;
    }

    // Duplicate the shared Redis client for this connection's poll loop.
    // Using duplicate() means this client's connection is independent — an
    // XREAD that yields no results for 100 ms does not hold up any other
    // Redis command in the main client.
    const streamClient = redis.duplicate();

    // A flag owned by this connection's closure. Setting it to false causes
    // the poll loops to exit at their next iteration check.
    let running = true;

    // Helper: small non-blocking sleep (same pattern as straddle-calc.ts).
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    // Resolve a '$' start cursor to the stream's CURRENT last entry ID.
    //
    // '$' only has meaning for a BLOCKING XREAD ("block for anything newer than
    // now"). These poll loops are NON-blocking (so they can re-check `running`
    // each iteration), and a non-blocking XREAD with a literal '$' re-resolves to
    // the live max on every call and therefore never returns an entry — the
    // cursor would stay pinned at '$' forever and NO frame is ever delivered to
    // the client. We resolve '$' once to a concrete last ID here; subsequent
    // non-blocking XREADs with a real ID correctly return everything published
    // after the connection was established. An empty/missing stream yields '0'
    // (deliver from the beginning), which is acceptable because the stream is
    // MAXLEN-trimmed and a brand-new connection has no prior cursor anyway.
    const resolveStartCursor = async (stream: string): Promise<string> => {
      try {
        const info = (await streamClient.xinfo('STREAM', stream)) as unknown[];
        const idx = info.indexOf('last-generated-id');
        const last = idx >= 0 ? (info[idx + 1] as string) : undefined;
        return last && last !== '0-0' ? last : '0';
      } catch {
        return '0';
      }
    };

    // Helper: safely send a JSON frame only when the socket is still open.
    // Swallows the send if the socket has already closed — avoids the "send
    // after close" WebSocket error that would propagate up and crash the loop.
    const safeSend = (payload: unknown): void => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    // Poll loop for market.ticks — forwards { type:'tick', ... } frames.
    // Starts cursor at '$' so we only deliver messages that arrive AFTER this
    // connection is established (historical tick replay is not desirable here).
    const ticksLoop = async (): Promise<void> => {
      // Start from the stream's current last ID (see resolveStartCursor) so we
      // only deliver ticks that arrive AFTER this connection is established, then
      // advance to each real message ID as we read.
      let lastTickId = await resolveStartCursor('market.ticks');

      while (running) {
        try {
          // Non-blocking XREAD — no BLOCK option so we can check `running`
          // on every iteration without waiting for Redis to timeout.
          const results = await streamClient.xread(
            'COUNT',
            100,
            'STREAMS',
            'market.ticks',
            lastTickId,
          );

          if (!results || results.length === 0) {
            await sleep(100);
            continue;
          }

          const streamResult = results[0];
          if (!streamResult) {
            await sleep(100);
            continue;
          }

          // results shape: [ [ streamName, [ [id, [k, v, ...]], ... ] ] ]
          const entries = streamResult[1] as [string, string[]][];

          for (const entry of entries) {
            const id = entry[0];
            const rawFields = entry[1];
            if (!id || !rawFields) continue;

            // Advance the cursor so we never re-deliver this message.
            lastTickId = id;

            // Extract the serialised `data` field written by the ingestion pipeline.
            let rawData: string | undefined;
            for (let i = 0; i + 1 < rawFields.length; i += 2) {
              if (rawFields[i] === 'data') {
                rawData = rawFields[i + 1];
                break;
              }
            }
            if (rawData === undefined) continue;

            let parsed: unknown;
            try {
              parsed = JSON.parse(rawData);
            } catch {
              continue; // Malformed entry — skip silently.
            }

            const tick = parsed as Record<string, unknown>;
            safeSend({
              type: 'tick',
              symbol: tick.symbol,
              ltp: tick.ltp,
              timestamp: tick.timestamp,
            });
          }
        } catch (err) {
          // Transient Redis error — log and resume after a short pause.
          // We intentionally do NOT check `running` in the catch block because
          // the error may have been triggered by quit() during cleanup; in that
          // case the while(!running) guard on the next iteration exits cleanly.
          server.log.error({ err }, '[ws/ticks] market.ticks poll error');
          await sleep(100);
        }
      }
    };

    // Poll loop for straddle.values — forwards { type:'straddle', ... } frames.
    // Mirrors the ticksLoop pattern exactly; kept separate so each stream gets
    // its own cursor and the two loops are independently throttled by Redis.
    const straddleLoop = async (): Promise<void> => {
      let lastStraddleId = await resolveStartCursor('straddle.values');

      while (running) {
        try {
          const results = await streamClient.xread(
            'COUNT',
            100,
            'STREAMS',
            'straddle.values',
            lastStraddleId,
          );

          if (!results || results.length === 0) {
            await sleep(100);
            continue;
          }

          const streamResult = results[0];
          if (!streamResult) {
            await sleep(100);
            continue;
          }

          const entries = streamResult[1] as [string, string[]][];

          for (const entry of entries) {
            const id = entry[0];
            const rawFields = entry[1];
            if (!id || !rawFields) continue;

            lastStraddleId = id;

            // Extract the `data` field containing the serialised straddle snapshot.
            let rawData: string | undefined;
            for (let i = 0; i + 1 < rawFields.length; i += 2) {
              if (rawFields[i] === 'data') {
                rawData = rawFields[i + 1];
                break;
              }
            }
            if (rawData === undefined) continue;

            let parsed: unknown;
            try {
              parsed = JSON.parse(rawData);
            } catch {
              continue;
            }

            const snap = parsed as Record<string, unknown>;
            // Build the straddle WS message. Optional fields (roc, acceleration)
            // are included only when present so the client type can check for them.
            const msg: Record<string, unknown> = {
              type: 'straddle',
              straddleValue: snap.straddleValue,
              atmStrike: snap.atmStrike,
              cePrice: snap.cePrice,
              pePrice: snap.pePrice,
              timestamp: snap.timestamp,
            };
            if (snap.roc !== undefined) msg.roc = snap.roc;
            if (snap.acceleration !== undefined) msg.acceleration = snap.acceleration;

            safeSend(msg);
          }
        } catch (err) {
          server.log.error({ err }, '[ws/ticks] straddle.values poll error');
          await sleep(100);
        }
      }
    };

    // Start both loops concurrently. We attach a top-level catch so an
    // unexpected thrown error (not caught inside the loop) does not become an
    // unhandled rejection — it is logged and the loop simply terminates.
    ticksLoop().catch((err: unknown) => {
      server.log.error({ err }, '[ws/ticks] ticksLoop terminated unexpectedly');
    });
    straddleLoop().catch((err: unknown) => {
      server.log.error({ err }, '[ws/ticks] straddleLoop terminated unexpectedly');
    });

    // Cleanup: stop the poll loops and quit the duplicated client when the
    // WebSocket connection closes. quit() sends a Redis QUIT command which
    // causes the in-flight XREAD in the duplicate client to reject, which is
    // caught by the try/catch inside each loop and terminates gracefully.
    //
    // cleanup() is idempotent: the first call sets running=false and removes
    // itself from wsCleanupCallbacks; subsequent calls (if the server onClose
    // hook fires after the socket 'close' event) are no-ops because running is
    // already false and the Set.delete is idempotent.
    let cleanupCalled = false;
    const cleanup = (): void => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      running = false;
      wsCleanupCallbacks.delete(cleanup);
      wsConnectionCount--;
      // Disconnect the per-connection duplicate client.  We do not await quit()
      // here because the 'close' handler is synchronous — we fire and forget.
      // The duplicate is not shared with anything else, so losing it is safe.
      streamClient.quit().catch(() => {
        // Suppress errors from quit() — the socket is already closed, the
        // connection is being torn down, any error here is unactionable.
      });
    };

    // Register in the server-scoped Set so the single server onClose hook can
    // drain this connection if the server shuts down before the client disconnects.
    wsCleanupCallbacks.add(cleanup);

    // Normal per-socket cleanup path: fires when the client disconnects or the
    // connection drops. This is the common case — cleanup() removes itself from
    // wsCleanupCallbacks so the server onClose hook skips already-cleaned entries.
    socket.on('close', cleanup);

    // NOTE: NO per-connection server.addHook('onClose', ...) here.
    // The server-level drain hook is registered once in buildServer() below.
  });

  // ── Payment routes ────────────────────────────────────────────────────────

  // Register the payment plugin last so it can access server.db (decorated
  // above) and all other plugins that its handlers depend on.  The plugin is
  // wrapped in fastify-plugin (see payment.ts) so it runs in the parent scope
  // and can access all decorators without re-declaration.
  await server.register(paymentRoutes);
  await server.register(fyersAuthRoutes);

  // Register retrospection routes under /api prefix so all four endpoints are
  // reachable at /api/retrospection/*, matching the REST path convention used
  // by the other API routes in this server.
  await server.register(retrospectionRoutes, { db: pool, eodQueue, prefix: '/api' });

  return server;
}

// ---------------------------------------------------------------------------
// Start — binds to a port (not used in tests)
// ---------------------------------------------------------------------------

/**
 * Build the server and bind to PORT (default 3000) on 0.0.0.0.
 * Registers SIGINT/SIGTERM handlers for graceful shutdown.
 *
 * @param externalPool   Optional shared pool — forwarded to buildServer().
 *   See buildServer() doc for the ownership semantics.
 * @param externalRedis  Optional shared Redis client — forwarded to buildServer()
 *   so the WS handler can stream live ticks and straddle values. When absent
 *   the WS endpoint degrades gracefully (no ticks).
 * @param onTokenStored  Optional broker reload hook — forwarded to buildServer().
 *   Wired from src/index.ts so a successful Fyers OAuth login fires an in-process
 *   broker reconnect without requiring a process restart.
 */
export async function startServer(
  externalPool?: Pool,
  externalRedis?: Redis,
  onTokenStored?: () => void | Promise<void>,
): Promise<void> {
  const server = await buildServer(undefined, externalPool, externalRedis, onTokenStored);

  // Read port from env using dot notation (Biome useLiteralKeys requirement).
  const rawPort = process.env.PORT ?? '3000';
  const port = Number.parseInt(rawPort, 10);

  // Start the EOD retrospection worker unless we are in simulation mode without
  // the explicit opt-in flag. In simulation mode the market data is synthetic
  // and there are no real trades to retrospect, so running the worker would
  // produce zero-trade rows and skip immediately. EOD_WORKER_ENABLED=true lets
  // a developer force the worker on even when SIMULATE=true (e.g. for manual
  // testing of the retrospection pipeline with synthetic data).
  //
  // We use externalPool if provided (same pool the caller shares with ingestion),
  // otherwise fall back to server.db (the pool created inside buildServer).
  // Both point to the same underlying pool in normal startup flows where
  // src/index.ts calls startServer(sharedPool); this guard just makes it
  // explicit which pool the worker owns.
  let eodWorker: import('bullmq').Worker | undefined;
  if (process.env.SIMULATE !== 'true' || process.env.EOD_WORKER_ENABLED === 'true') {
    eodWorker = createEodRetrospectionWorker(externalPool ?? server.db);
  }

  // Graceful shutdown — close the server before the process exits.
  const shutdown = async (signal: string): Promise<void> => {
    server.log.info(`[server] received ${signal} — shutting down`);
    try {
      // Close the EOD worker first so in-flight jobs can finish before the DB
      // pool is torn down by server.close(). Worker.close() waits for the
      // current job to complete before resolving.
      if (eodWorker) {
        await eodWorker.close();
      }
      // Close the queue's Redis connection before closing the server — the
      // queue holds an open connection even when no worker is running.
      await server.eodQueue.close();
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.listen({ port, host: '0.0.0.0' });
}
