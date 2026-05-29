/**
 * BullMQ queue + worker for on-demand historical backfill runs.
 *
 * The POST /api/backfill route enqueues a job and returns immediately.
 * The worker calls runBackfill() in the background; callers poll
 * GET /api/backfill?symbol=... to watch the backfill_ranges status row.
 *
 * Concurrency is 1: backfill runs are already chunked sequentially inside
 * runBackfill() to stay within Fyers rate limits. Running two backfills in
 * parallel would just compete for the same rate-limit budget.
 *
 * On FyersAuthError mid-run (token expires daily):
 *   runBackfill() saves a checkpoint in backfill_ranges (status='partial').
 *   The worker resolves the job (does NOT rethrow) so BullMQ does not
 *   auto-retry with the same stale token. The user refreshes credentials
 *   and POSTs again — runBackfill() resumes from the checkpoint.
 */

import { Queue, Worker } from 'bullmq';
import type { Pool } from 'pg';

import type { FyersResolution } from '../ingestion/brokers/fyers-historical.js';
import { BackfillResumeError, runBackfill } from '../ingestion/historical/backfill.js';

// ---------------------------------------------------------------------------
// Job data shape
// ---------------------------------------------------------------------------

export interface BackfillJobData {
  symbol: string;
  /** FyersResolution string — serialised as plain string for JSON transport. */
  resolution: FyersResolution;
  /** ISO date string (inclusive from). */
  from: string;
  /** ISO date string (inclusive to). */
  to: string;
}

// ---------------------------------------------------------------------------
// Redis connection helper (same pattern as eod-retrospection-job)
// ---------------------------------------------------------------------------

function buildRedisConnection(): { host: string; port: number } {
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return { host: redisUrl.hostname, port: Number(redisUrl.port) || 6379 };
}

// ---------------------------------------------------------------------------
// Queue factory
// ---------------------------------------------------------------------------

/** Creates the BullMQ Queue for backfill jobs (no cron — on-demand only). */
export function createBackfillQueue(): Queue {
  return new Queue('backfill', { connection: buildRedisConnection() });
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Creates the BullMQ Worker that processes backfill jobs.
 *
 * @param pool - Injected pg Pool shared with the rest of the server.
 */
export function createBackfillWorker(pool: Pool): Worker {
  const connection = buildRedisConnection();

  return new Worker(
    'backfill',
    async (job) => {
      const { symbol, resolution, from, to } = job.data as BackfillJobData;

      try {
        const result = await runBackfill(pool, {
          symbol,
          resolution,
          from: new Date(from),
          to: new Date(to),
        });

        await job.log(
          `[BackfillWorker] ${symbol} ${resolution}: ${result.status} — ` +
            `rows=${result.rowsWritten}, total=${result.totalRowsWritten}, gaps=${result.gaps.length}`,
        );

        return result;
      } catch (err) {
        if (err instanceof BackfillResumeError) {
          // Token expired mid-fetch. backfill_ranges row is already checkpointed
          // with status='partial'. Resolve (don't rethrow) so BullMQ does not
          // auto-retry with a stale token. User re-triggers after refreshing.
          await job.log(
            `[BackfillWorker] Auth expired — checkpoint at ${err.checkpointTs}. Refresh FYERS_ACCESS_TOKEN and POST /api/backfill again to resume.`,
          );
          return { status: 'partial', checkpointTs: err.checkpointTs, rangeId: err.rangeId };
        }
        // Non-resumable (rate limit exhausted, network error, etc.) — let BullMQ
        // mark the job as failed with a clear error message.
        throw err;
      }
    },
    { connection, concurrency: 1 },
  );
}
