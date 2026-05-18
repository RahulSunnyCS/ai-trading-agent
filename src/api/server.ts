import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { STREAM_STRADDLE } from "../redis/client.js";
import type { Clock } from "../utils/clock.js";
import { statusRoutes } from "./routes/status.js";
import { tradesRoutes } from "./routes/trades.js";

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
  // WebSocket plugin
  // ---------------------------------------------------------------------------

  // fastify.register is a synchronous registration; the plugin resolves during
  // server.ready() / server.listen(). We must register the WebSocket plugin
  // before registering any WebSocket routes.
  server.register(fastifyWebsocket);

  // ---------------------------------------------------------------------------
  // WebSocket endpoint — /ws/ticks (straddle.values broadcast)
  // ---------------------------------------------------------------------------

  // Why XREAD instead of streamConsume (consumer groups)?
  // Consumer groups are designed for fan-OUT-with-guaranteed-delivery: each
  // message is delivered to exactly one consumer in the group, which is correct
  // for processing pipelines. The WebSocket broadcast is the opposite pattern:
  // every connected client should receive every message. Using consumer groups
  // here would mean each straddle snapshot is delivered to only one WebSocket
  // client, not all of them. XREAD with '$' (latest) is the correct primitive
  // for a live "subscribe to the stream tip" broadcast with no delivery
  // guarantee semantics — if a client is slow or disconnects, it misses
  // messages, which is acceptable for a live dashboard feed.
  server.register(async (wsServer) => {
    wsServer.get("/ws/ticks", { websocket: true }, (socket, _request) => {
      // Each WebSocket connection gets its own XREAD loop.
      // We create a *dedicated* ioredis client per connection because:
      //   1. ioredis in blocking-XREAD mode cannot multiplex with other
      //      commands on the same connection — the connection is consumed
      //      by the blocking call for the duration of the block.
      //   2. A shared blocking client would block the main redis client
      //      from executing other commands (ping, publish, xadd, etc).
      // The cost is one extra Redis TCP connection per WebSocket client.
      // For a dashboard with a handful of simultaneous browser tabs this
      // is negligible.
      const sub = opts.redis.duplicate();

      // Track whether this connection's loop should keep running.
      // Set to false on socket close to break the XREAD loop cleanly.
      let active = true;

      // The XREAD position cursor. '$' means "messages after this moment".
      // We start from '$' (the stream tip at connection time) so a newly
      // connected client does not receive a backlog of historical snapshots.
      // After the first read, we advance the cursor to the last-seen ID so
      // subsequent reads continue from where we left off.
      let cursor = "$";

      // Kick off the async broadcast loop. Errors are logged and cause the
      // socket to close — a reconnecting client will restart its own loop.
      const broadcastLoop = async (): Promise<void> => {
        while (active) {
          let raw: unknown;
          try {
            // XREAD COUNT 10 BLOCK 2000 STREAMS straddle.values <cursor>
            // Blocks for up to 2 000 ms waiting for new messages.
            // COUNT 10 bounds the work per iteration; for a 15-second
            // snapshot interval we will rarely see more than 1 message.
            raw = await sub.xread("COUNT", 10, "BLOCK", 2000, "STREAMS", STREAM_STRADDLE, cursor);
          } catch (err: unknown) {
            if (!active) break; // socket closed mid-block — expected
            server.log.error({ err }, "[ws/ticks] xread error");
            // Back off briefly before retrying to avoid tight error loops
            // on transient Redis disconnects.
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
            continue;
          }

          if (!raw || !Array.isArray(raw) || raw.length === 0) {
            // Timeout (no new messages in blockMs window) — loop again.
            continue;
          }

          // Parse the raw XREAD response.
          // ioredis returns: [[streamName, [[id, [k,v,...]], ...]]]
          // We always read from exactly one stream so we take index 0.
          const streamEntry = raw[0] as [string, Array<[string, string[]]>];
          const messages = streamEntry[1];

          for (const [id, flatFields] of messages) {
            // Advance cursor so the next iteration fetches only newer messages.
            cursor = id;

            // Re-inflate the flat k/v array into a plain object.
            const fields: Record<string, string> = {};
            for (let i = 0; i < flatFields.length - 1; i += 2) {
              const key = flatFields[i] as string;
              const val = flatFields[i + 1] as string;
              fields[key] = val;
            }

            // Only send if the socket is still open (OPEN === 1 in the ws spec).
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ id, fields }));
            }
          }
        }
      };

      // Start the loop — do not await here; the handler returns synchronously
      // and the loop runs in the background for the lifetime of the connection.
      broadcastLoop().catch((err: unknown) => {
        server.log.error({ err }, "[ws/ticks] broadcastLoop fatal error");
        if (socket.readyState === 1) socket.close();
      });

      // When the client disconnects, stop the loop and release the Redis
      // connection. "close" fires for both normal close and error-driven close.
      socket.on("close", () => {
        active = false;
        // disconnect() is immediate (vs quit() which sends QUIT command).
        // We use disconnect() here because:
        //   a) the blocking XREAD command is mid-flight and quit() would
        //      wait for it to complete before disconnecting;
        //   b) this is a duplicated client used only for this connection,
        //      so abrupt disconnect has no impact on other operations.
        sub.disconnect();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // REST routes
  // ---------------------------------------------------------------------------

  // statusRoutes mounts /health.
  // tradesRoutes mounts /api/trades and /api/trades/history.
  // Each is a separate Fastify plugin so they can be registered, tested, and
  // reasoned about independently without coupling them to the server factory.
  server.register(statusRoutes, { clock: opts.clock });
  server.register(tradesRoutes, { db: opts.db });

  return server;
}
