import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { Clock } from "../utils/clock.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { paperTradesRoutes } from "./routes/paper-trades.js";
import { personalitiesRoutes } from "./routes/personalities.js";
import { statusRoutes } from "./routes/status.js";
import { tradesRoutes } from "./routes/trades.js";
import { registerWebSocket } from "./websocket.js";

/**
 * Options consumed by buildServer. All three are injected so the server is
 * fully testable without real infrastructure — callers pass mocks or in-memory
 * fakes in tests, and src/index.ts passes the real singletons in production.
 */
export interface BuildServerOpts {
  db: Pool;
  redis: Redis;
  clock: Clock;
}

/**
 * Build and configure the Fastify server but do NOT start listening.
 *
 * The "factory" pattern (build, then listen) is used throughout the Fastify
 * ecosystem because it makes the server trivially injectable into tests with
 * server.inject() — no real ports required.
 *
 * src/index.ts (the forbidden file) is responsible for calling server.listen().
 */
export function buildServer(opts: BuildServerOpts): FastifyInstance {
  // ---------------------------------------------------------------------------
  // Core server setup
  // ---------------------------------------------------------------------------

  // logger:true enables Fastify's built-in pino logger. In production this
  // streams structured JSON to stdout. In test environments the caller can
  // override this by passing { logger: false } — but this factory fixes it to
  // true because the task spec requires pino logging and all real callers want it.
  const server = Fastify({ logger: true });

  // Fastify uses AJV for schema validation out of the box; no extra plugins
  // needed for JSON body parsing or schema validation — they are built in.
  // We do not install @fastify/swagger here to keep the server minimal.

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------

  // CORS_ORIGIN allows restricting the dashboard origin in production
  // (e.g. CORS_ORIGIN=https://dashboard.internal.example). Defaults to '*'
  // for development and simulation mode where there is no user authentication
  // to protect. Per project context, this is a single-operator research tool
  // with no public-facing users, so '*' is an acceptable default.
  server.register(fastifyCors, {
    origin: process.env.CORS_ORIGIN ?? "*",
  });

  // ---------------------------------------------------------------------------
  // WebSocket plugin
  // ---------------------------------------------------------------------------

  // fastify.register is a synchronous registration; the plugin resolves during
  // server.ready() / server.listen(). We must register the WebSocket plugin
  // before registering any WebSocket routes.
  server.register(fastifyWebsocket);

  // ---------------------------------------------------------------------------
  // WebSocket endpoint — /ws/ticks (straddle.values broadcast)
  // ---------------------------------------------------------------------------

  // The WebSocket handler is extracted to src/api/websocket.ts for independent
  // testability and readability. See that file for the detailed design rationale
  // (XREAD vs consumer groups — live broadcast pattern).
  registerWebSocket(server, opts.redis);

  // ---------------------------------------------------------------------------
  // REST routes
  // ---------------------------------------------------------------------------

  // statusRoutes mounts /health.
  // tradesRoutes mounts /api/trades and /api/trades/history.
  // dashboardRoutes mounts /dashboard/live and /dashboard/summary.
  // paperTradesRoutes mounts /paper-trades (paginated, date + status filtered).
  // personalitiesRoutes mounts /api/personalities (CRUD + performance queries).
  //
  // Each is a separate Fastify plugin so they can be registered, tested, and
  // reasoned about independently without coupling them to the server factory.
  server.register(statusRoutes, { clock: opts.clock });
  server.register(tradesRoutes, { db: opts.db });
  server.register(dashboardRoutes, { db: opts.db, clock: opts.clock });
  server.register(paperTradesRoutes, { db: opts.db, clock: opts.clock });
  server.register(personalitiesRoutes, { db: opts.db });

  return server;
}
