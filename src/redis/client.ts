import { Redis } from 'ioredis';

// Singleton Redis client — created once at module load time.
// REDIS_URL defaults to localhost so simulation mode works without extra config.
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  // lazyConnect: false (the default) causes ioredis to open the TCP connection
  // immediately on construction.  This means a misconfigured REDIS_URL or a
  // missing Redis container surfaces as a startup error rather than a
  // mysterious failure minutes later when the first command fires.
  lazyConnect: false,
});

redis.on('error', (err: Error) => {
  // Log but do not crash — ioredis reconnects automatically after transient
  // blips (container restart, network hiccup).  Throwing here would kill the
  // entire Fastify process for a problem that will self-heal in seconds.
  console.error('[redis] connection error:', err.message);
});

// ── Stream names (object form — for main-branch consumers) ────────────────────

export const STREAMS = {
  MARKET_TICKS: 'market.ticks',
  STRADDLE_VALUES: 'straddle.values',
  SIGNALS_GENERATED: 'signals.generated',
} as const;

export type StreamName = (typeof STREAMS)[keyof typeof STREAMS];

// ── Stream name constants (M2 string form — for M2 consumers) ─────────────────
// Centralised here so callers never hard-code strings.
export const STREAM_TICKS = "market.ticks";
export const STREAM_STRADDLE = "straddle.values";
export const STREAM_SIGNALS = "signals.generated";

// ── Publish a message to a Redis Stream ───────────────────────────────────────

export async function streamPublish(
  stream: string,
  fields: Record<string, string>,
): Promise<string> {
  // Flatten the object into a flat [k, v, k, v, ...] array for ioredis.
  // ioredis accepts (key, id, ...fieldValues) as variadic args.
  const flatFields: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    flatFields.push(k, v);
  }
  // The '*' ID lets Redis assign a monotonically increasing timestamp-based ID.
  const id = await redis.xadd(stream, '*', ...flatFields);
  if (id === null) throw new Error(`XADD to ${stream} returned null`);
  return id;
}

// ── Read messages from a Redis Stream ─────────────────────────────────────────

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export async function streamRead(
  stream: string,
  lastId = '0',
  count = 100,
): Promise<StreamEntry[]> {
  // XREAD COUNT n STREAMS stream lastId
  const results = await redis.xread('COUNT', count, 'STREAMS', stream, lastId);
  if (!results || results.length === 0) return [];

  const streamResult = results[0];
  if (!streamResult) return [];

  // ioredis returns [streamName, [[id, [field, value, ...]], ...]]
  const entries = streamResult[1] as [string, string[]][];

  return entries.map(([id, rawFields]) => {
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < rawFields.length; i += 2) {
      const key = rawFields[i];
      const val = rawFields[i + 1];
      if (key !== undefined && val !== undefined) {
        fields[key] = val;
      }
    }
    return { id, fields };
  });
}

// ── Shutdown flag checked by every active streamConsume loop ──────────────────
// A single boolean is sufficient because Node.js/Bun is single-threaded;
// no lock needed.
let shuttingDown = false;

/**
 * Ensure a consumer group exists for the given stream.
 * Uses XGROUP CREATE ... MKSTREAM so the stream is also created if absent.
 * Swallows the BUSYGROUP error (group already exists) and rethrows everything else.
 */
async function ensureGroup(stream: string, group: string): Promise<void> {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err: unknown) {
    if (err instanceof Error && err.message.startsWith('BUSYGROUP')) {
      return;
    }
    throw err;
  }
}

/**
 * Parse the raw ioredis XREADGROUP response into usable message objects.
 */
function parseXreadgroupResponse(
  raw: unknown,
): Array<{ id: string; fields: Record<string, string> }> {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const streamEntry = raw[0] as [string, Array<[string, string[]]>];
  const messages = streamEntry[1];
  if (!messages || messages.length === 0) {
    return [];
  }
  return messages.map(([id, flatFields]) => {
    const fields: Record<string, string> = {};
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
 */
export function streamConsume(
  stream: string,
  group: string,
  consumer: string,
  handler: (id: string, fields: Record<string, string>) => Promise<void>,
  opts?: { blockMs?: number; count?: number },
): void {
  const blockMs = opts?.blockMs ?? 2000;
  const count = opts?.count ?? 10;

  (async () => {
    await ensureGroup(stream, group);

    while (!shuttingDown) {
      let raw: unknown;
      try {
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
          '>',
        );
      } catch (err: unknown) {
        if (shuttingDown) break;
        console.error(`[redis] streamConsume read error on ${stream}:`, err);
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        continue;
      }

      const messages = parseXreadgroupResponse(raw);

      for (const { id, fields } of messages) {
        if (shuttingDown) break;
        try {
          await handler(id, fields);
          await redis.xack(stream, group, id);
        } catch (err: unknown) {
          console.error(`[redis] handler error for message ${id} on ${stream}:`, err);
        }
      }
    }
  })().catch((err: unknown) => {
    console.error(`[redis] streamConsume fatal error on ${stream}:`, err);
  });
}

/**
 * Recover messages that have been pending for more than 60 seconds using XAUTOCLAIM.
 */
export async function recoverPending(
  stream: string,
  group: string,
  consumer: string,
): Promise<string[]> {
  const result = await (
    redis as unknown as {
      xautoclaim: (
        key: string,
        group: string,
        consumer: string,
        minIdleTime: number,
        start: string,
        countKeyword: string,
        count: number,
      ) => Promise<[string, Array<[string, string[]]>, string[]]>;
    }
  ).xautoclaim(stream, group, consumer, 60000, '0-0', 'COUNT', 100);

  const claimed = result[1] ?? [];
  return claimed.map(([id]) => id);
}

/**
 * Graceful shutdown: set the shutdown flag so all consume loops exit at their
 * next iteration boundary, then disconnect the Redis client cleanly.
 */
export async function closeRedis(): Promise<void> {
  shuttingDown = true;
  await new Promise<void>((resolve) => setTimeout(resolve, 2500));
  await redis.quit();
}
