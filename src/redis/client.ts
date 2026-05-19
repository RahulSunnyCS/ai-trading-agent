import 'dotenv/config';
import { Redis } from 'ioredis';

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

// ── Stream names ──────────────────────────────────────────────────────────────

export const STREAMS = {
  MARKET_TICKS: 'market.ticks',
  STRADDLE_VALUES: 'straddle.values',
  SIGNALS_GENERATED: 'signals.generated',
} as const;

export type StreamName = (typeof STREAMS)[keyof typeof STREAMS];

// ── Publish a message to a Redis Stream ───────────────────────────────────────

export async function streamPublish(
  stream: StreamName,
  fields: Record<string, string>,
): Promise<string> {
  const flatArgs: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    flatArgs.push(key, value);
  }
  // XADD stream * field value [field value ...]
  // The '*' argument tells Redis to auto-generate the entry ID.
  const id = await redis.xadd(stream, '*', ...flatArgs);
  if (id === null) throw new Error(`XADD to ${stream} returned null`);
  return id;
}

// ── Read messages from a Redis Stream ─────────────────────────────────────────

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

export async function streamRead(
  stream: StreamName,
  lastId = '0',
  count = 100,
): Promise<StreamEntry[]> {
  // XREAD COUNT n STREAMS stream lastId
  const results = await redis.xread('COUNT', count, 'STREAMS', stream, lastId);
  if (!results || results.length === 0) return [];

  // results[0] is the first (and only) stream result; guard against undefined
  // because TypeScript's noUncheckedIndexedAccess makes every array element
  // access potentially undefined, even when we know results.length > 0.
  const streamResult = results[0];
  if (!streamResult) return [];

  // ioredis returns [streamName, [[id, [field, value, ...]], ...]]
  const entries = streamResult[1] as [string, string[]][];

  return entries.map(([id, rawFields]) => {
    const fields: Record<string, string> = {};
    for (let i = 0; i + 1 < rawFields.length; i += 2) {
      // noUncheckedIndexedAccess: even though the loop bounds guarantee
      // rawFields[i] and rawFields[i+1] exist, TypeScript widens the type to
      // `string | undefined`.  The explicit undefined checks satisfy the
      // compiler and also guard against malformed data from the wire.
      const key = rawFields[i];
      const val = rawFields[i + 1];
      if (key !== undefined && val !== undefined) {
        fields[key] = val;
      }
    }
    return { id, fields };
  });
}
