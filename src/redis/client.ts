import Redis from 'ioredis';

// Singleton Redis client — created once at module load time.
// REDIS_URL defaults to localhost so simulation mode works without extra config.
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

// Stream name constants — centralised here so callers never hard-code strings.
export const STREAM_TICKS = 'market.ticks';
export const STREAM_STRADDLE = 'straddle.values';
export const STREAM_SIGNALS = 'signals.generated';

// Shutdown flag checked by every active streamConsume loop.
// A single boolean is sufficient because Node.js/Bun is single-threaded;
// no lock needed.
let shuttingDown = false;

/**
 * Publish a message to a Redis Stream using XADD with auto-generated ID ('*').
 * Returns the generated message ID (e.g. "1700000000000-0").
 *
 * fields is flattened into a key/value list as required by ioredis xadd.
 */
export async function streamPublish(
  stream: string,
  fields: Record<string, string>
): Promise<string> {
  // Flatten the object into a flat [k, v, k, v, ...] array for ioredis.
  // ioredis accepts (key, id, ...fieldValues) as variadic args.
  const flatFields: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    flatFields.push(k, v);
  }
  // The '*' ID lets Redis assign a monotonically increasing timestamp-based ID.
  const id = await redis.xadd(stream, '*', ...flatFields);
  // Redis guarantees xadd with '*' always returns an ID string, never null.
  // Casting is safe here; null would only occur with MAXLEN trimming conditions
  // that we are not using.
  return id as string;
}

/**
 * Ensure a consumer group exists for the given stream.
 * Uses XGROUP CREATE ... MKSTREAM so the stream is also created if absent.
 * Swallows the BUSYGROUP error (group already exists) and rethrows everything else.
 */
async function ensureGroup(stream: string, group: string): Promise<void> {
  try {
    // '$' means the group starts reading from the latest message —
    // historical messages before group creation are not replayed.
    // MKSTREAM creates the stream key if it does not yet exist,
    // avoiding a race condition between stream creation and group creation.
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err: unknown) {
    // ioredis surfaces Redis errors as Error objects whose message starts
    // with the Redis error prefix, e.g. "BUSYGROUP Consumer Group ...".
    if (err instanceof Error && err.message.startsWith('BUSYGROUP')) {
      // Group already exists — this is expected on every restart after the first.
      return;
    }
    throw err;
  }
}

/**
 * Parse the raw ioredis XREADGROUP response into usable message objects.
 *
 * Raw shape from ioredis:
 *   [ [streamName, [ [id, [k, v, k, v, ...]], ... ]] ]
 *
 * We only read from one stream at a time so we take index 0.
 */
function parseXreadgroupResponse(
  raw: unknown
): Array<{ id: string; fields: Record<string, string> }> {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  // Each element in the outer array is [streamName, messages]
  const streamEntry = raw[0] as [string, Array<[string, string[]]>];
  const messages = streamEntry[1];
  if (!messages || messages.length === 0) {
    return [];
  }
  return messages.map(([id, flatFields]) => {
    const fields: Record<string, string> = {};
    // flatFields is [k, v, k, v, ...]; iterate in steps of 2.
    // We use explicit index variable and non-null assertions because TypeScript's
    // strict noUncheckedIndexedAccess would otherwise infer string|undefined here.
    // The length guard (i < flatFields.length - 1) ensures both i and i+1 are
    // within bounds before we access them.
    for (let i = 0; i < flatFields.length - 1; i += 2) {
      const key = flatFields[i] as string;
      const val = flatFields[i + 1] as string;
      fields[key] = val;
    }
    return { id, fields };
  });
}

/**
 * Start a consumer-group read loop on a Redis Stream.
 *
 * - Creates the consumer group (and stream if absent) before the first read.
 * - Uses XREADGROUP with BLOCK for efficient server-side waiting.
 * - ACKs each message AFTER the handler resolves successfully.
 * - If the handler throws, the message is NOT ACKed and remains pending
 *   so that recoverPending() can reclaim it later.
 * - The loop runs until closeRedis() sets the shutdown flag.
 *
 * opts.blockMs  — how long XREADGROUP blocks waiting for new messages (default 2000 ms).
 *                 Shorter = more responsive shutdown; longer = fewer empty round-trips.
 * opts.count    — max messages per read (default 10).
 */
export function streamConsume(
  stream: string,
  group: string,
  consumer: string,
  handler: (id: string, fields: Record<string, string>) => Promise<void>,
  opts?: { blockMs?: number; count?: number }
): void {
  const blockMs = opts?.blockMs ?? 2000;
  const count = opts?.count ?? 10;

  // Run the loop asynchronously — errors are logged rather than crashing the
  // process because a single bad message should not kill the entire consumer.
  (async () => {
    await ensureGroup(stream, group);

    while (!shuttingDown) {
      let raw: unknown;
      try {
        // '>' is the special ID meaning "messages not yet delivered to this group".
        // BLOCK causes the server to wait up to blockMs before returning empty.
        raw = await redis.xreadgroup(
          'GROUP',
          group,
          consumer,
          'COUNT',
          count,
          'BLOCK',
          blockMs,
          'STREAMS',
          stream,
          '>'
        );
      } catch (err: unknown) {
        if (shuttingDown) break;
        // Log and back off briefly before retrying to avoid tight error loops.
        console.error(`[redis] streamConsume read error on ${stream}:`, err);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }

      const messages = parseXreadgroupResponse(raw);

      for (const { id, fields } of messages) {
        if (shuttingDown) break;
        try {
          await handler(id, fields);
          // Only ACK after the handler has completed successfully.
          await redis.xack(stream, group, id);
        } catch (err: unknown) {
          // Handler failed — do NOT ACK. Message stays pending and will be
          // reclaimed by recoverPending() after 60 seconds.
          console.error(`[redis] handler error for message ${id} on ${stream}:`, err);
        }
      }
    }
  })().catch((err: unknown) => {
    // Top-level catch for unrecoverable errors (e.g. group creation failure).
    console.error(`[redis] streamConsume fatal error on ${stream}:`, err);
  });
}

/**
 * Recover messages that have been pending for more than 60 seconds using XAUTOCLAIM.
 *
 * XAUTOCLAIM (Redis 7+) atomically transfers ownership of idle pending messages
 * to this consumer so they can be reprocessed. Returns the list of reclaimed
 * message IDs so the caller can replay them if needed.
 *
 * min-idle-time is 60 000 ms (60 seconds) — long enough that a slow-but-alive
 * handler is not wrongly reclaimed, but short enough to recover from a crash
 * within a reasonable window.
 */
export async function recoverPending(
  stream: string,
  group: string,
  consumer: string
): Promise<string[]> {
  // XAUTOCLAIM syntax: XAUTOCLAIM key group consumer min-idle-time start [COUNT count]
  // ioredis exposes this as redis.xautoclaim(key, group, consumer, minIdleTime, start, ...)
  // The response is [nextStartId, [[id, fields], ...], [deletedIds]] in Redis 7.
  const result = await (redis as unknown as {
    xautoclaim: (
      key: string,
      group: string,
      consumer: string,
      minIdleTime: number,
      start: string,
      countKeyword: string,
      count: number
    ) => Promise<[string, Array<[string, string[]]>, string[]]>;
  }).xautoclaim(stream, group, consumer, 60000, '0-0', 'COUNT', 100);

  // result[1] is the array of reclaimed [id, fields] pairs.
  const claimed = result[1] ?? [];
  return claimed.map(([id]) => id);
}

/**
 * Graceful shutdown: set the shutdown flag so all consume loops exit at their
 * next iteration boundary, then disconnect the Redis client cleanly.
 *
 * Waiting for loops to exit naturally avoids abrupt mid-handler disconnects.
 * The loop checks shuttingDown on every iteration so the maximum delay is
 * one blockMs interval.
 */
export async function closeRedis(): Promise<void> {
  shuttingDown = true;
  // Give consume loops one blockMs window to notice the flag and exit.
  // 2500 ms > the default blockMs (2000 ms) so they will see it before
  // we forcibly close the connection.
  await new Promise<void>((resolve) => setTimeout(resolve, 2500));
  await redis.quit();
}
