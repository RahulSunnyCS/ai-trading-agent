import Redis from 'ioredis';

// Stream topic names — single source of truth
export const STREAMS = {
  MARKET_TICKS:       'market.ticks',
  STRADDLE_VALUES:    'straddle.values',
  SIGNALS_GENERATED:  'signals.generated',
} as const;

export type StreamName = (typeof STREAMS)[keyof typeof STREAMS];

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    redis.on('error', (err) => {
      console.error('[redis] Connection error:', err.message);
    });

    redis.on('connect', () => {
      console.log('[redis] Connected');
    });
  }
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (redis) {
    await redis.quit();
    redis = null;
  }
}

// ── Stream helpers ─────────────────────────────────────────────────────────────

/**
 * Publish a message to a Redis Stream.
 * Returns the message ID assigned by Redis.
 */
export async function streamPublish(
  stream: StreamName,
  fields: Record<string, string>
): Promise<string> {
  const args: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    args.push(k, v);
  }
  // XADD stream * field1 value1 field2 value2 ...
  const id = await getRedis().xadd(stream, '*', ...args);
  return id as string;
}

/**
 * Read new messages from a stream since a given ID.
 * Uses XREAD with COUNT limit; returns raw entries.
 */
export async function streamRead(
  stream: StreamName,
  lastId: string = '0',
  count: number = 100
): Promise<Array<{ id: string; fields: Record<string, string> }>> {
  const results = await getRedis().xread('COUNT', count, 'STREAMS', stream, lastId);
  if (!results) return [];

  const [, entries] = results[0] as [string, Array<[string, string[]]>];
  return entries.map(([id, rawFields]) => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < rawFields.length; i += 2) {
      fields[rawFields[i]] = rawFields[i + 1];
    }
    return { id, fields };
  });
}

/**
 * Trim a stream to prevent unbounded growth.
 * Keeps approximately `maxLen` entries (MAXLEN ~).
 */
export async function streamTrim(stream: StreamName, maxLen: number): Promise<void> {
  await getRedis().xtrim(stream, 'MAXLEN', '~', maxLen);
}
