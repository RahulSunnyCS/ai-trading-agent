/**
 * token-validity-check.ts — pre-market Fyers token validity checker
 *
 * Provides two exports:
 *
 *   1. checkTokenValidity(token) — pure function, no I/O, returns a
 *      TokenValidityState discriminant. Safe to call in tests without any
 *      infrastructure.
 *
 *   2. registerTokenValiditySchedule(pool) — registers a BullMQ cron job
 *      (matching the repo's existing BullMQ pattern from eod-retrospection-job.ts)
 *      that fires at 08:45 IST on weekdays — 15 minutes before NSE opens,
 *      giving operators time to re-authenticate before the market opens.
 *      This function is OPT-IN and must be called explicitly — importing this
 *      module has NO side effects.
 *
 * Scheduler mechanism chosen: BullMQ (Queue + Worker with a cron repeat pattern).
 * Rationale: BullMQ is already a declared dependency (package.json) and is used
 * by the only other scheduled job in the repo (eod-retrospection-job.ts). Adding
 * node-cron would introduce a new dependency for a pattern already covered.
 * BullMQ jobs are also Redis-backed, meaning the schedule survives process
 * restarts without re-registration (idempotent queue.add() with a repeat pattern).
 *
 * Test/infra safety: the scheduler requires a live Redis connection. When
 * TOKEN_VALIDITY_SCHEDULER_ENABLED is not set to 'true', registerTokenValiditySchedule
 * is a no-op. The check function itself is a pure computation — no Redis, no DB —
 * so it can be unit-tested freely.
 */

import { Queue, Worker } from 'bullmq';
import type { Pool } from 'pg';

import { loadStoredToken } from '../server/services/fyers-auth.js';

// ---------------------------------------------------------------------------
// TokenValidityState — discriminated union
//
// Four states in order of degradedness:
//   missing     — no token row in the DB at all
//   expired     — token exists but expiresAt is in the past
//   near-expiry — token expires within the next 2 hours (warning threshold)
//   valid       — token exists and has > 2 hours remaining
//
// Both "missing" and "expired" map to needsReauth=true on the status endpoint.
// "near-expiry" maps to degraded=true but needsReauth=false (token still works
// for now; warn the operator to re-auth soon).
// ---------------------------------------------------------------------------

export type TokenValidityState = 'missing' | 'expired' | 'near-expiry' | 'valid';

/** 2-hour warning threshold in milliseconds. */
const NEAR_EXPIRY_THRESHOLD_MS = 2 * 60 * 60 * 1000;

/**
 * Pure function: given a token's expiry date (or null/undefined when no token
 * is stored), returns the current validity state.
 *
 * This function does NO I/O — it only inspects the expiresAt date relative to
 * the provided `now` timestamp. Keeping I/O out of the computation makes
 * unit testing trivial and prevents the DB call from being embedded in logic
 * that is tested independently.
 *
 * @param expiresAt - The token's expiry Date, or null if no token is stored.
 * @param now       - Current timestamp in ms (defaults to Date.now()). Injected
 *                    so tests can control the clock without mocking Date.
 */
export function checkTokenValidity(
  expiresAt: Date | null | undefined,
  now: number = Date.now(),
): TokenValidityState {
  if (!expiresAt) return 'missing';

  const msUntilExpiry = expiresAt.getTime() - now;

  if (msUntilExpiry <= 0) return 'expired';
  if (msUntilExpiry <= NEAR_EXPIRY_THRESHOLD_MS) return 'near-expiry';
  return 'valid';
}

/**
 * Derives the dashboard-facing flags from a TokenValidityState.
 *
 * Extracted as a standalone function so both the scheduled job and the
 * /api/auth/fyers/status route can derive identical flags from the same
 * computation without duplicating the mapping logic.
 *
 * degraded    = true when the token is not fully valid (any non-"valid" state)
 * needsReauth = true only when the token is missing or expired (operator must
 *               re-authenticate immediately; near-expiry is a warning, not a
 *               hard blocker)
 */
export function deriveStatusFlags(state: TokenValidityState): {
  degraded: boolean;
  needsReauth: boolean;
} {
  return {
    degraded: state !== 'valid',
    needsReauth: state === 'missing' || state === 'expired',
  };
}

// ---------------------------------------------------------------------------
// BullMQ connection helper
//
// Mirrors the pattern in eod-retrospection-job.ts: parse REDIS_URL with the
// URL constructor and fall back to localhost:6379. BullMQ requires host/port
// separately — it does not accept a connection string.
// ---------------------------------------------------------------------------
function buildRedisConnection(): { host: string; port: number } {
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port) || 6379,
  };
}

// ---------------------------------------------------------------------------
// Scheduled job implementation
// ---------------------------------------------------------------------------

const QUEUE_NAME = 'token-validity-check';

/**
 * Registers the pre-market token-validity check cron job in BullMQ.
 *
 * The cron pattern '45 8 * * 1-5' fires at 08:45 IST on weekdays — 15 minutes
 * before NSE opens at 09:00 IST. This gives the operator enough time to
 * re-authenticate via the dashboard before the market opens.
 *
 * IMPORTANT: This function is OPT-IN. It must be called explicitly at
 * application startup. Importing this module does nothing on its own.
 *
 * Guard: if TOKEN_VALIDITY_SCHEDULER_ENABLED !== 'true', this function returns
 * immediately without touching Redis. This prevents the scheduler from
 * attempting a Redis connection during tests or in environments where Redis is
 * not available (e.g. CI without Docker services).
 *
 * The returned { queue, worker } pair should be used to cleanly shut down the
 * BullMQ connections on process exit (call queue.close() and worker.close()
 * in your shutdown handler). Not closing them causes the process to hang.
 *
 * @param pool - Injected pg Pool used by the job handler to load the stored token.
 */
export function registerTokenValiditySchedule(pool: Pool): { queue: Queue; worker: Worker } | null {
  // Guard: only run when the scheduler is explicitly enabled.
  // This prevents BullMQ from trying to connect to Redis in unit tests or
  // in environments where Redis is not available.
  if (process.env.TOKEN_VALIDITY_SCHEDULER_ENABLED !== 'true') {
    return null;
  }

  const connection = buildRedisConnection();

  const queue = new Queue(QUEUE_NAME, { connection });

  // Register the recurring schedule. Mirrors eod-retrospection-job.ts pattern:
  // queue.add() with a repeat pattern is idempotent in BullMQ — if the job
  // already exists with the same name and pattern, it is not duplicated.
  void queue.add(
    QUEUE_NAME,
    {},
    {
      repeat: { pattern: '45 8 * * 1-5', tz: 'Asia/Kolkata' },
    },
  );

  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // Load the stored token from the DB and compute its validity state.
      const token = await loadStoredToken(pool);
      const state = checkTokenValidity(token?.expiresAt ?? null);
      const { degraded, needsReauth } = deriveStatusFlags(state);

      if (degraded) {
        // Log the degraded state so operators see it in server logs at startup.
        // We intentionally do NOT log the token value or any fragment of it —
        // only the state classification and the expiry timestamp (a date, not
        // a secret) are safe to log.
        console.warn(
          `[token-validity-check] Fyers token is in degraded state: ${state}. needsReauth=${needsReauth}. expiresAt=${token?.expiresAt?.toISOString() ?? 'n/a'}. Re-authenticate via the dashboard before market open.`,
        );
      } else {
        console.log(
          `[token-validity-check] Fyers token is valid. expiresAt=${token?.expiresAt?.toISOString() ?? 'n/a'}`,
        );
      }
    },
    { connection, concurrency: 1 },
  );

  return { queue, worker };
}
