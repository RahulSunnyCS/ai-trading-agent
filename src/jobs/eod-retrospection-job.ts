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

import { withTransaction } from '../db/client.js';
import type { SimulatedTrade } from '../backtesting/backtest-runner.js';
import { computeBrierScore } from '../retrospection/brier-score.js';
import { computeBeatClockworkDelta, computeDailyMetrics } from '../retrospection/daily-metrics.js';
import { runEvolutionEngine } from '../retrospection/evolution-engine.js';
import { computeManagementEffectiveness } from '../retrospection/management-effectiveness.js';
import {
  BACKTEST_LOOKBACK_DAYS,
  BACKTEST_UNDERLYING,
  OPTIMIZER_HOLDOUT_DAYS,
  backtestRunnerFactory,
  runOptimizer,
} from '../retrospection/optimizer.js';

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
  void queue.add(
    'eod-retrospection',
    {},
    {
      repeat: { pattern: '0 16 * * 1-5', tz: 'Asia/Kolkata' },
    },
  );

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
    async (job) => {
      // -----------------------------------------------------------------------
      // Step 1: compute the trade date
      //
      // For scheduled (cron) runs, job.data.trade_date is absent → use today's
      // IST date. For manual trigger runs (POST /retrospection/trigger), the
      // caller supplies trade_date so historical backfill works correctly.
      // toLocaleDateString with en-CA locale always yields 'YYYY-MM-DD' format.
      // -----------------------------------------------------------------------
      const todayIST = new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kolkata',
      });
      const tradeDateISO = (job.data as { trade_date?: string }).trade_date ?? todayIST;

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
      // Step 3: fetch all active personalities (including entry_type for H4 guard)
      //
      // entry_type is fetched here so the EOD loop can pre-filter before
      // calling runEvolutionEngine. The evolution engine's SELECT FOR UPDATE
      // locks ONLY momentum_exhaustion rows — passing an sr_anchored personality
      // to runEvolutionEngine throws "not found in momentum_exhaustion group"
      // every EOD run (a false-alarm error). Pre-filtering here eliminates the
      // false alarm without touching runEvolutionEngine's internal logic.
      // -----------------------------------------------------------------------
      const personalitiesResult = await pool.query<{
        id: string;
        entry_type: string;
      }>('SELECT id, entry_type FROM personality_configs WHERE is_active = TRUE');

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
      // Step 4c: pre-compute the shared backtest once (C2 dedup)
      //
      // All momentum_exhaustion personalities use an identical BacktestConfig
      // (same underlying=NIFTY, same tradeDateISO window, same holdoutDays).
      // Running a separate 365-day backtest per personality (~1095 queries at
      // EOD for 3 personalities) is wasteful when the trade set is identical.
      //
      // We run ONE backtest here and pass the resulting SimulatedTrade[] to
      // runOptimizer via the precomputedTrades option. runOptimizer skips its
      // internal backtest call when precomputedTrades is supplied.
      //
      // Correctness guarantee: we only share trades across personalities whose
      // BacktestConfig is genuinely identical. The BacktestConfig depends on:
      //   - underlying: always BACKTEST_UNDERLYING (NIFTY) for supported personalities
      //   - tradeDateISO: the same for all personalities in one EOD batch
      //   - fromDate: derived from tradeDateISO - BACKTEST_LOOKBACK_DAYS (same)
      //   - holdoutDays: OPTIMIZER_HOLDOUT_DAYS (same constant)
      // Non-NIFTY personalities are rejected by runOptimizer's M1 guard before
      // using precomputedTrades, so sharing NIFTY trades with them is harmless.
      //
      // Note: the M3 kernel_only guard in runOptimizer may skip the backtest
      // entirely (when all candidates ≤ 0.70). In that case precomputedTrades
      // is passed but unused — that is correct and cheap (no extra work).
      //
      // On failure: log and set precomputedTrades = undefined. runOptimizer will
      // either run its own backtest or return 'backtest_failed' / 'kernel_only'.
      // The EOD batch must not abort because of a backtest failure.
      // -----------------------------------------------------------------------
      let sharedBacktestTrades: SimulatedTrade[] | undefined;
      try {
        const toMs = new Date(`${tradeDateISO}T12:00:00Z`).getTime();
        const fromMs = toMs - BACKTEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
        const fromDate = new Date(fromMs).toLocaleDateString('en-CA', { timeZone: 'UTC' });

        const sharedRunner = backtestRunnerFactory.create(pool);
        const sharedResult = await sharedRunner.run({
          underlying: BACKTEST_UNDERLYING,
          fromDate,
          toDate: tradeDateISO,
          holdoutDays: OPTIMIZER_HOLDOUT_DAYS,
          trainFraction: 0.7,
        });
        sharedBacktestTrades = sharedResult.trades;
      } catch (btErr) {
        // Non-fatal: log and continue. runOptimizer will fall back to its own
        // backtest or the kernel_only path.
        console.warn(
          '[eod-retrospection] shared backtest failed for %s — each optimizer will handle independently:',
          tradeDateISO,
          btErr,
        );
        sharedBacktestTrades = undefined;
      }

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
                beatClockworkDelta, // number | null
                brierScore, // number | null
                managementEffectiveness, // number | null
                null, // proposed_adjustments — populated by evolution engine (5f)
                false, // adjustments_applied
              ],
            );
          });

          // --- 5f: run evolution engine (may propose or apply a param change) --
          // Must run AFTER the INSERT above: the evolution engine's requireApproval branch
          // UPDATEs this row to write proposed_adjustments. Without the row, the UPDATE hits
          // zero rows and silently discards the proposal.
          //
          // H4 guard: the evolution engine's SELECT FOR UPDATE is scoped to
          // entry_type='momentum_exhaustion'. Calling it for an sr_anchored or
          // fixed_time personality throws "not found in momentum_exhaustion group"
          // every EOD run (caught by the outer try/catch but logs a false alarm).
          // Pre-filtering here avoids the false-alarm error entirely.
          if (personality.entry_type === 'momentum_exhaustion') {
            await runEvolutionEngine(pool, personality.id, tradeDateISO, {
              winRate: metrics.winRate,
              totalTrades: metrics.totalTrades,
              totalPnlPct: metrics.totalPnlPct,
            });
          }

          // --- 5g: run deterministic 1-D optimizer (off the critical path) ----
          //
          // The optimizer is a secondary signal — it proposes or applies a
          // data-driven min_probability from the training window. It runs AFTER
          // the rule-based engine (5f) and is completely independent of it.
          //
          // Key properties:
          //   - Caught independently: a failure here does not abort the batch or
          //     affect the rule engine result. The catch falls back to the rule
          //     engine implicitly (it has already run in 5f).
          //   - Off the critical path: any failure is logged but the personality's
          //     retrospection row is already written (5e) and the rule engine has
          //     already run (5f). The optimizer is an additional suggestion, not a
          //     replacement.
          //   - sr_anchored personalities and frozen personalities are excluded
          //     inside runOptimizer itself — the catch here handles unexpected
          //     errors (DB timeout, etc.), not expected exclusions.
          try {
            // Pass pre-computed shared backtest trades when available (C2 dedup).
            // When sharedBacktestTrades is undefined (shared backtest failed),
            // pass an empty options object so runOptimizer handles it gracefully
            // (falls back to kernel_only or its own backtest attempt).
            const optimizerOptions =
              sharedBacktestTrades !== undefined
                ? { precomputedTrades: sharedBacktestTrades }
                : {};
            const optimizerResult = await runOptimizer(
              pool,
              personality.id,
              tradeDateISO,
              optimizerOptions,
            );
            if (optimizerResult.action !== 'none' && optimizerResult.action !== 'skipped') {
              console.log(
                '[eod-retrospection] optimizer %s for personality %s on %s: candidate=%s',
                optimizerResult.action,
                personality.id,
                tradeDateISO,
                optimizerResult.candidateValue?.toFixed(4) ?? 'n/a',
              );
            }
          } catch (optimizerErr) {
            // Log and continue — the rule-based engine (5f) has already run.
            // The optimizer failing never crashes the batch or discards the rule
            // engine's result.
            console.error(
              '[eod-retrospection] optimizer failed for personality %s on %s — falling back to rule engine result only:',
              personality.id,
              tradeDateISO,
              optimizerErr,
            );
          }
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
