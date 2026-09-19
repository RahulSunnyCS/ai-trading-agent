import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import { STREAM_STRADDLE } from '../redis/client.js';

/**
 * Registers the WebSocket endpoint /ws/ticks on the given Fastify instance.
 *
 * This function is extracted from server.ts so it can be tested and reasoned
 * about independently from the REST route configuration. server.ts calls this
 * after registering the @fastify/websocket plugin.
 *
 * Design: live broadcast (XREAD, NOT consumer groups)
 * ---------------------------------------------------------
 * Consumer groups (XREADGROUP) deliver each message to exactly ONE consumer in
 * the group. That is wrong for a dashboard broadcast: every connected browser tab
 * should receive every straddle snapshot. XREAD with '$' at connection time is
 * the correct Redis primitive for a multi-subscriber live feed — messages are not
 * "claimed" and all subscribers see them independently.
 *
 * The trade-off: no delivery guarantee. If a client is slow or the connection
 * drops, it misses messages. For a live dashboard showing the current straddle
 * value this is acceptable — the next snapshot arrives within 15 seconds anyway.
 *
 * @param server - A Fastify instance that has already had @fastify/websocket registered.
 * @param redis  - The shared ioredis client; redis.duplicate() creates per-connection sub-clients.
 */
export function registerWebSocket(server: FastifyInstance, redis: Redis): void {
  server.register(async (wsServer) => {
    wsServer.get('/ws/ticks', { websocket: true }, (socket, _request) => {
      // -----------------------------------------------------------------------
      // Dedicated Redis connection per WebSocket client
      // -----------------------------------------------------------------------
      // We duplicate the shared ioredis client for each connection because:
      //   1. ioredis in blocking-XREAD mode cannot multiplex other commands on
      //      the same connection — the connection is consumed by the blocking
      //      call for the duration of the block.
      //   2. Using the shared client for blocking reads would prevent the rest
      //      of the server from issuing other Redis commands (ping, xadd, etc).
      // Cost: one extra TCP connection per active WebSocket client. For a
      // small internal dashboard (a handful of browser tabs) this is negligible.
      const sub = redis.duplicate();

      // Flag used to break the XREAD loop when the socket closes.
      // A simple boolean is safe here because Bun/Node is single-threaded.
      let active = true;

      // Start from '$' (the stream tip at connection time) so newly connected
      // clients do not receive a backlog of historical snapshots. We advance
      // the cursor to the last-seen message ID after each successful read so
      // subsequent XREAD calls pick up only newer messages.
      let cursor = '$';

      // -----------------------------------------------------------------------
      // XREAD broadcast loop
      // -----------------------------------------------------------------------
      const broadcastLoop = async (): Promise<void> => {
        while (active) {
          let raw: unknown;
          try {
            // XREAD COUNT 10 BLOCK 2000 STREAMS straddle.values <cursor>
            // Blocks up to 2 000 ms waiting for new messages. COUNT 10 bounds
            // the work per iteration; at a 15-second snapshot interval we will
            // rarely see more than 1 message per iteration.
            raw = await sub.xread('COUNT', 10, 'BLOCK', 2000, 'STREAMS', STREAM_STRADDLE, cursor);
          } catch (err: unknown) {
            // If active is false the socket closed while we were mid-block —
            // this is an expected race, not an error worth logging.
            if (!active) break;
            server.log.error({ err }, '[ws/ticks] xread error');
            // Brief back-off before retry to avoid a tight loop on transient
            // Redis errors (e.g. network blip, restart).
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
            continue;
          }

          // Null/empty response means the 2 000 ms timeout elapsed with no new
          // messages — loop again. This is normal during market hours between
          // snapshots and always at night / weekends.
          if (!raw || !Array.isArray(raw) || raw.length === 0) {
            // Log WARN only if a client is connected and we have been waiting —
            // the task spec requires WARN (not ERROR) when no clients are
            // connected on a tick. Here we always have a client (we're inside
            // the connection handler), so we log at debug level to avoid
            // flooding logs on normal idle ticks.
            server.log.debug('[ws/ticks] xread timeout — no messages this window');
            continue;
          }

          // ioredis XREAD response shape:
          //   [[streamName, [[id, [k, v, ...]], ...]]]
          // We always read from exactly one stream so we take index 0.
          const streamEntry = raw[0] as [string, Array<[string, string[]]>];
          const messages = streamEntry[1];

          if (!messages || messages.length === 0) continue;

          let clientsNotified = 0;

          for (const [id, flatFields] of messages) {
            // Advance cursor so the next iteration fetches only newer messages.
            cursor = id;

            // Re-inflate the flat [k, v, k, v, ...] array into an object.
            const fields: Record<string, string> = {};
            for (let i = 0; i < flatFields.length - 1; i += 2) {
              const key = flatFields[i] as string;
              const val = flatFields[i + 1] as string;
              fields[key] = val;
            }

            // OPEN === 1 per the WebSocket spec. Only send if the socket is
            // still open — avoids a write to a socket in CLOSING/CLOSED state.
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ id, fields }));
              clientsNotified++;
            }
          }

          // The task spec requires a WARN log when no clients received a tick.
          // In this handler we manage a single socket, so "no clients" means
          // readyState !== 1 (closing/closed but the 'close' event hasn't fired
          // yet). Log at WARN to surface these transient states without treating
          // them as errors.
          if (clientsNotified === 0) {
            server.log.warn(
              '[ws/ticks] tick received but socket not ready (readyState %d) — message dropped',
              socket.readyState,
            );
          }
        }
      };

      // Start the loop in the background — the handler returns synchronously.
      // Errors that escape broadcastLoop (e.g. duplicate() fails) are caught
      // here and cause a clean socket close rather than an unhandled rejection.
      broadcastLoop().catch((err: unknown) => {
        server.log.error({ err }, '[ws/ticks] broadcastLoop fatal error');
        if (socket.readyState === 1) socket.close();
      });

      // -----------------------------------------------------------------------
      // Clean-up on disconnect
      // -----------------------------------------------------------------------
      // 'close' fires for both normal client disconnect and error-driven close.
      // We set active = false to break the XREAD loop, then disconnect() the
      // dedicated sub-client immediately.
      //
      // disconnect() vs quit():
      //   quit() sends the Redis QUIT command and waits for the server to
      //   acknowledge — if a blocking XREAD is in-flight, quit() will block
      //   until that call returns (up to 2 000 ms). disconnect() aborts the
      //   TCP connection immediately, which is correct here because:
      //     a) the sub client is dedicated to this socket and not shared;
      //     b) we set active = false first, so the loop will not retry;
      //     c) any in-flight XREAD will throw, be caught, and exit via !active.
      socket.on('close', () => {
        active = false;
        sub.disconnect();
      });
    });
  });
}
