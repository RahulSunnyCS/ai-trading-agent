/**
 * eod-retrospection-job.ts — BullMQ EOD retrospection job orchestrator
 *
 * Schedules and processes end-of-day retrospection for all active trading
 * personalities. Fires at 16:00 IST on weekdays (after NSE market close).
 *
 * Design decisions:
 *   - Sequential (not parallel) personality processing: retrospection for one
 *     personality can take a non-trivial amount of time and touches shared
 *     tables (personality_configs via evolution engine). Sequential iteration
 *     avoids concurrent SELECT FOR UPDATE deadlocks inside runEvolutionEngine.
 *   - One regime query per batch (not per personality): the market regime is a
 *     single fact about the trading day — querying it once and reusing the
 *     result avoids redundant DB round-trips and ensures all personalities are
 *     tagged with a consistent regime for the day.
 *   - ON CONFLICT DO NOTHING on INSERT: if the job fires twice on the same day
 *     (e.g. BullMQ repeat job duplicate on restart), the second run is a no-op
 *     for already-written rows. The evolution engine's UPDATE path in the same
 *     re-run will overwrite proposed_adjustments, which is acceptable.
 *   - withTransaction wraps ONLY the INSERT — the upstream compute functions
 *     are read-only queries that do not need transactional protection. The
 *     evolution engine manages its own internal transaction for the UPDATE/audit
 *     writes.
 *   - Per-personality try/catch: a single personality failing (e.g. a corrupt
 *     pnl row) must not abort the entire batch. All other personalities continue.
 */

import { Queue, Worker } from 'bullmq';
import type { Pool } from 'pg';

import { computeDailyMetrics, computeBeatClockworkDelta } from '../retrospection/daily-metrics.js';
import { computeBrierScore } from '../retrospection/brier-score.js';
import { computeManagementEffectiveness } from '../retrospection/management-effectiveness.js';
import { runEvolutionEngine } from '../retrospection/evolution-engine.js';
import { withTransaction } from '../db/client.js';

// ---------------------------------------------------------------------------
// Connection helper
//
// BullMQ requires host/port separately — it does not accept a connection
// string. We parse REDIS_URL with the built-in URL constructor (no external
// library) and fall back to localhost:6379 for development environments that
// omit the variable.
// ---------------------------------------------------------------------------
function buildRedisConnection(): { host: string; port: number } {
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: redisUrl.hostname,
    port: Number(redisUrl.port) || 6379,
  };
}

// ---------------------------------------------------------------------------
// Queue factory
// ---------------------------------------------------------------------------

/**
 * Creates the BullMQ Queue and registers the recurring cron job.
 *
 * The cron pattern '0 16 * * 1-5' fires at 16:00 every weekday in the
 * Asia/Kolkata timezone — 30 minutes after NSE closes at 15:30 IST, giving
 * the paper trade exit writer time to finalise the day's trades before
 * retrospection begins.
 *
 * Calling queue.add() with a repeat pattern is idempotent in BullMQ: if a
 * job with the same name and pattern already exists, it is not duplicated.
 */
export function createEodRetrospectionQueue(): Queue {
  const connection = buildRedisConnection();

  const queue = new Queue('eod-retrospection', { connection });

  // Register the recurring schedule immediately after queue creation.
  // The void cast suppresses the unhandled-promise warning — the caller is a
  // factory function and cannot await the add() call. BullMQ persists the
  // repeat job in Redis so a failure here only means the cron is not registered
  // for this process restart; BullMQ will attempt again on the next run.
  void queue.add('eod-retrospection', {}, {
    repeat: { pattern: '0 16 * * 1-5', tz: 'Asia/Kolkata' },
  });

  return queue;
}

// ---------------------------------------------------------------------------
// Worker factory
// ---------------------------------------------------------------------------

/**
 * Creates the BullMQ Worker that processes EOD retrospection jobs.
 *
 * concurrency: 1 — ensures only one EOD job runs at a time. This prevents
 * the evolution engine's SELECT FOR UPDATE from racing with itself on days
 * when BullMQ retries a failed job while the original run is still in
 * progress (can happen if the worker crashes and the job is requeued).
 *
 * @param pool - Injected pg Pool. The worker captures this reference at
 *               creation time so the job handler can issue DB queries.
 */
export function createEodRetrospectionWorker(pool: Pool): Worker {
  const connection = buildRedisConnection();

  return new Worker(
    'eod-retrospection',
    async (_job) => {
      // -----------------------------------------------------------------------
      // Step 1: compute today's IST date
      //
      // toLocaleDateString with en-CA locale always yields 'YYYY-MM-DD' format.
      // We use IST (Asia/Kolkata) because NSE trade dates are IST calendar dates.
      // A UTC date would produce the wrong date during early-morning UTC hours
      // that are still "yesterday" in India (UTC midnight = 05:30 IST).
      // -----------------------------------------------------------------------
      const tradeDateISO = new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kolkata',
      });

      // -----------------------------------------------------------------------
      // Step 2: holiday / event check
      //
      // RBI policy days, budget days, and F&O expiry mornings are blocked from
      // trading. If today is in event_calendar, no trades were taken so there
      // is nothing to retrospect.
      // -----------------------------------------------------------------------
      const eventCheckResult = await pool.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM event_calendar WHERE event_date = $1',
        [tradeDateISO],
      );

      // COUNT(*) always returns exactly one row. pg returns bigint columns as
      // strings — parseInt converts safely.
      const eventCount = Number.parseInt(eventCheckResult.rows[0]?.count ?? '0', 10);

      if (eventCount > 0) {
        console.log('Skipping EOD retrospection: today is an event/holiday');
        return;
      }

      // -----------------------------------------------------------------------
      // Step 3: fetch all active personalities
      // -----------------------------------------------------------------------
      const personalitiesResult = await pool.query<{
        id: string;
        primary_symbol: string | null;
      }>(
        'SELECT id, primary_symbol FROM personality_configs WHERE is_active = TRUE',
      );

      const personalities = personalitiesResult.rows;

      if (personalities.length === 0) {
        console.log('No active personalities found — nothing to retrospect');
        return;
      }

      // -----------------------------------------------------------------------
      // Step 4: determine today's market regime (one query for the whole batch)
      //
      // Regime defaults to 'RANGING' when no row is found for today. RANGING is
      // the conservative default: it is the most common regime and the least
      // likely to produce misleading comparisons when the tagging job has not
      // yet run (e.g. if the regime tagger fires after the retrospection job
      // on the same day).
      // -----------------------------------------------------------------------
      const regimeResult = await pool.query<{ regime: string }>(
        `SELECT regime FROM daily_regime_tags
          WHERE trade_date = $1
          ORDER BY id DESC
          LIMIT 1`,
        [tradeDateISO],
      );

      const marketRegime: string = regimeResult.rows[0]?.regime ?? 'RANGING';

      // -----------------------------------------------------------------------
      // Step 5: process each personality sequentially
      // -----------------------------------------------------------------------
      for (const personality of personalities) {
        try {
          // --- 5a: compute daily P&L metrics ---------------------------------
          const metrics = await computeDailyMetrics(pool, personality.id, tradeDateISO);

          // Skip personalities with no trades — writing a zero-trade row would
          // pollute retrospection charts and beat-clockwork comparisons with
          // noise. The evolution engine also requires totalTrades >= 20 before
          // any rule fires, so there is no evolution benefit to writing zero rows.
          if (metrics.totalTrades === 0) {
            console.log(
              `EOD retrospection: no trades for personality ${personality.id} on ${tradeDateISO} — skipping`,
            );
            continue;
          }

          // --- 5b: compute Brier score (null when not applicable) ------------
          const brierScore = await computeBrierScore(pool, personality.id, tradeDateISO);

          // --- 5c: compute management effectiveness (null when no data) ------
          const managementEffectiveness = await computeManagementEffectiveness(
            pool,
            personality.id,
            tradeDateISO,
          );

          // --- 5d: compute Beat-Clockwork delta (null when Clockwork had no trades) --
          const beatClockworkDelta = await computeBeatClockworkDelta(
            pool,
            metrics.totalPnlPct,
            tradeDateISO,
            marketRegime,
          );

          // --- 5e: persist retrospection row inside a transaction ------------
          await withTransaction(async (client) => {
            await client.query(
              `INSERT INTO retrospection_results
                 (personality_id, trade_date, market_regime, total_trades, winning_trades,
                  total_pnl_pct, beat_clockwork_delta, signal_brier_score,
                  management_effectiveness, proposed_adjustments, adjustments_applied)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
               ON CONFLICT (personality_id, trade_date) DO NOTHING`,
              [
                personality.id,
                tradeDateISO,
                marketRegime,
                metrics.totalTrades,
                metrics.winningTrades,
                metrics.totalPnlPct,
                beatClockworkDelta,    // number | null
                brierScore,            // number | null
                managementEffectiveness, // number | null
                null,                  // proposed_adjustments — populated by evolution engine (5f)
                false,                 // adjustments_applied
              ],
            );
          });

          // --- 5f: run evolution engine (may propose or apply a param change) --
          // Must run AFTER the INSERT above: the evolution engine's requireApproval branch
          // UPDATEs this row to write proposed_adjustments. Without the row, the UPDATE hits
          // zero rows and silently discards the proposal.
          await runEvolutionEngine(pool, personality.id, tradeDateISO, {
            winRate: metrics.winRate,
            totalTrades: metrics.totalTrades,
            totalPnlPct: metrics.totalPnlPct,
          });
        } catch (err) {
          // Per-personality catch: log and continue to the next personality.
          // A single personality failing (e.g. locked row, corrupt data, a
          // FROZEN_VIOLATION if Clockwork is accidentally in the active set)
          // must not abort the entire batch.
          console.error('EOD retrospection failed for personality', personality.id, err);
        }
      }
    },
    { connection, concurrency: 1 },
  );
}
