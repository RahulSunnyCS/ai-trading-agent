/**
 * Historical Backfill Writer (T-55)
 *
 * Consumes OHLCV candles from T-54's fetchHistoricalCandles() and writes them
 * idempotently into the TimescaleDB hypertables (market_ticks / option_ticks).
 *
 * Design contract:
 *   - Each candle is synthesised as one DB row: candle.close → ltp,
 *     candle.timestamp → time, source = 'fyers-historical', resolution = options.resolution.
 *   - INSERT ... ON CONFLICT DO NOTHING against the partial-unique indexes
 *     (idx_market_ticks_hist_uniq / idx_option_ticks_hist_uniq) ensures that
 *     re-running a completed range writes ZERO duplicate rows.
 *   - Symbol routing: Fyers index symbols (NSE:NIFTY50-INDEX, etc.) go to
 *     market_ticks. Option symbols (CE/PE suffix) go to option_ticks.
 *   - Resumable: on FyersAuthError, checkpoint progress in backfill_ranges and
 *     throw BackfillResumeError. A subsequent call with the same options resumes
 *     from the checkpoint, never re-fetching completed data.
 *   - Calendar reconciliation: compare actual candle coverage against expected
 *     NSE trading days; record gaps in backfill_ranges — NEVER mark 'complete'
 *     when gaps are present.
 *   - All hypertable writes/reads are time-range bounded (hypertable discipline).
 *
 * Security notes:
 *   - All DB writes use parameterised queries (no string interpolation of
 *     externally-sourced values).
 *   - No secrets are logged; credential masking is delegated to fyers-historical.ts.
 *   - fetchFn is injectable for tests; no user-supplied URLs are accepted
 *     (SSRF guard is in fyers-historical.ts).
 */

import type { Pool, PoolClient } from 'pg';
import type { BackfillRange, BackfillRangeStatus } from '../../db/schema.js';
import {
  type FetchFn,
  FyersAuthError,
  type FyersCandle,
  type FyersCandleGap,
  type FyersResolution,
  fetchHistoricalCandles,
} from '../brokers/fyers-historical.js';

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/**
 * Options for a single backfill run.
 *
 * The (symbol, from, to, resolution) tuple is the natural key used to find an
 * existing backfill_ranges row for resume purposes.
 */
export interface BackfillOptions {
  /** Fyers-format symbol, e.g. 'NSE:NIFTY50-INDEX' or 'NSE:NIFTY25MAY24000CE'. */
  symbol: string;
  /** Candle resolution. Must match FyersResolution values. */
  resolution: FyersResolution;
  /** Inclusive start of the requested date range. Time component is ignored. */
  from: Date;
  /** Inclusive end of the requested date range. Time component is ignored. */
  to: Date;
  /**
   * Injectable fetch function for testing. Forwarded to fetchHistoricalCandles().
   * Omit in production — the real global fetch is used by default.
   */
  fetchFn?: FetchFn;
  /**
   * Injectable sleep function for testing (avoids real delays). Forwarded to
   * fetchHistoricalCandles(). Omit in production.
   */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Outcome of a runBackfill() call.
 */
export interface BackfillResult {
  /** The final status written to backfill_ranges. */
  status: BackfillRangeStatus;
  /** Total rows written during this run (does not count rows from previous partial runs). */
  rowsWritten: number;
  /** Total rows written across all runs (the cumulative backfill_ranges.rows_written value). */
  totalRowsWritten: number;
  /** Gap records detected during calendar reconciliation (empty when none). */
  gaps: BackfillGapSummary[];
  /** The backfill_ranges.id for this run (useful for debugging / audit). */
  rangeId: number;
}

/**
 * A single calendar-gap summary returned in BackfillResult.gaps.
 */
export interface BackfillGapSummary {
  from: Date;
  to: Date;
  reason: string;
}

// ---------------------------------------------------------------------------
// Resume error
// ---------------------------------------------------------------------------

/**
 * Thrown when a backfill run is interrupted by FyersAuthError and a checkpoint
 * has been saved. The caller must refresh credentials and call runBackfill()
 * again with the same options to resume from the checkpoint.
 */
export class BackfillResumeError extends Error {
  /** ISO timestamp of the last successfully persisted candle, or 'none'. */
  readonly checkpointTs: string;
  /** The backfill_ranges.id that was checkpointed. */
  readonly rangeId: number;

  constructor(checkpointTs: Date | null, rangeId: number, cause: FyersAuthError) {
    const checkpoint = checkpointTs?.toISOString() ?? 'none (no candles written)';
    super(
      `[BackfillResumeError] Fyers auth failure interrupted the backfill. Checkpoint saved at backfill_ranges id=${rangeId}, checkpoint_ts=${checkpoint}. Re-run with the same options after refreshing credentials to resume. Original error: ${cause.message}`,
    );
    this.name = 'BackfillResumeError';
    this.checkpointTs = checkpoint;
    this.rangeId = rangeId;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Symbol routing
// ---------------------------------------------------------------------------

/** Which hypertable to write historical candles into. */
export type SymbolTable = 'market_ticks' | 'option_ticks';

/**
 * Determine whether a Fyers symbol routes to market_ticks (index) or
 * option_ticks (option contract).
 *
 * Routing logic (pure string suffix check — no network calls, no registry decode):
 *   - Index symbols end with '-INDEX'  → market_ticks
 *   - Option symbols end with 'CE'/'PE' → option_ticks
 *   - Anything else → market_ticks with a warning (fail-open, never drop data)
 *
 * We intentionally avoid the full instrument-registry parser here because it can
 * fail for expired strikes that the registry no longer knows about. A suffix check
 * is resilient and sufficient for routing.
 */
export function resolveSymbolTable(symbol: string): SymbolTable {
  if (symbol.endsWith('-INDEX')) return 'market_ticks';
  if (symbol.endsWith('CE') || symbol.endsWith('PE')) return 'option_ticks';

  // Unrecognised pattern — default to market_ticks and warn.
  console.warn(
    `[BackfillWriter] Unrecognised symbol format '${symbol}' — defaulting to market_ticks.`,
  );
  return 'market_ticks';
}

// ---------------------------------------------------------------------------
// Calendar reconciliation
// ---------------------------------------------------------------------------

/**
 * Extract the set of unique calendar dates (YYYY-MM-DD) from candle timestamps.
 *
 * Candle timestamps from Fyers are in IST. We extract the date from the UTC
 * representation of the timestamp. This is correct because:
 *   IST 09:15 = UTC 03:45 → same UTC date as the trading day
 *   IST 15:30 = UTC 10:00 → same UTC date as the trading day
 * Fyers intraday candles never span midnight IST, so UTC date == IST date.
 */
function extractTradingDates(candles: FyersCandle[]): Set<string> {
  const dates = new Set<string>();
  for (const candle of candles) {
    dates.add(candle.timestamp.toISOString().slice(0, 10));
  }
  return dates;
}

/** Returns true for UTC Saturday (6) or Sunday (0) — always NSE-closed days. */
function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Generate all expected weekday trading dates between from and to (inclusive).
 *
 * Public holidays are NOT filtered out here — we do not have the full NSE
 * holiday calendar. Gaps caused by public holidays will appear in the result
 * with an "unverified" reason. This is intentional: we prefer false positives
 * (recording a holiday as an unexpected gap) over false negatives (silently
 * marking a gappy range 'complete').
 */
function generateExpectedTradingDays(from: Date, to: Date): Set<string> {
  const days = new Set<string>();
  const current = new Date(from);
  current.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);

  while (current <= end) {
    if (!isWeekend(current)) {
      days.add(current.toISOString().slice(0, 10));
    }
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

/**
 * Reconcile fetched candle coverage against the expected NSE trading calendar.
 *
 * Returns gap records for any expected weekday that has no candle data. Merges
 * in Fyers-reported chunk-level gaps (empty chunks) as higher-confidence signals.
 *
 * For weekly ('W') and monthly ('M') resolutions, day-level reconciliation is
 * skipped — one weekly candle covers 5 days, so a missing day is expected and
 * not a gap. Only Fyers-reported chunk gaps are recorded for these resolutions.
 */
export function reconcileCalendarGaps(
  candles: FyersCandle[],
  fyersGaps: FyersCandleGap[],
  from: Date,
  to: Date,
  resolution: FyersResolution,
): BackfillGapSummary[] {
  const gaps: BackfillGapSummary[] = [];

  // Day-level reconciliation is meaningful only for intraday and daily candles.
  // Weekly / monthly candles intentionally cover multiple days — a "missing day"
  // within a weekly candle period is not a gap.
  const skipDayReconciliation = resolution === 'W' || resolution === 'M';

  if (!skipDayReconciliation) {
    const covered = extractTradingDates(candles);
    const expected = generateExpectedTradingDays(from, to);

    for (const day of expected) {
      if (!covered.has(day)) {
        const dayDate = new Date(`${day}T00:00:00.000Z`);
        gaps.push({
          from: dayDate,
          to: dayDate,
          reason:
            'Possible NSE holiday or exchange halt (unverified) — ' +
            'no candle data returned by Fyers for this trading day. ' +
            'Verify against the NSE holiday calendar.',
        });
      }
    }
  }

  // Merge Fyers-reported chunk gaps (zero candles for an entire date range).
  // These are more reliable than our calendar inference because Fyers explicitly
  // returned nothing for those ranges.
  for (const fyersGap of fyersGaps) {
    gaps.push({
      from: fyersGap.from,
      to: fyersGap.to,
      reason: `Fyers API returned no candles: ${fyersGap.reason}`,
    });
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// DB helpers (all use parameterised queries)
// ---------------------------------------------------------------------------

/**
 * Find an existing backfill_ranges row by natural key (symbol, from_ts, to_ts, resolution).
 * Returns null if not found.
 */
async function findExistingRange(
  client: PoolClient,
  symbol: string,
  from: Date,
  to: Date,
  resolution: string,
): Promise<BackfillRange | null> {
  const result = await client.query<BackfillRange>(
    `SELECT * FROM backfill_ranges
     WHERE symbol = $1
       AND from_ts = $2
       AND to_ts = $3
       AND resolution = $4
     LIMIT 1`,
    [symbol, from.toISOString(), to.toISOString(), resolution],
  );
  return result.rows[0] ?? null;
}

/**
 * Insert a new backfill_ranges row with status 'running'. Returns the new row's id.
 */
async function insertRangeRow(
  client: PoolClient,
  symbol: string,
  from: Date,
  to: Date,
  resolution: string,
): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO backfill_ranges (symbol, from_ts, to_ts, resolution, status, rows_written, updated_at)
     VALUES ($1, $2, $3, $4, 'running', 0, NOW())
     RETURNING id`,
    [symbol, from.toISOString(), to.toISOString(), resolution],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error('[BackfillWriter] INSERT backfill_ranges returned no id.');
  }
  return row.id;
}

/** Set status = 'running' when resuming a partial or stale run. */
async function markRangeRunning(client: PoolClient, rangeId: number): Promise<void> {
  await client.query(
    `UPDATE backfill_ranges SET status = 'running', updated_at = NOW() WHERE id = $1`,
    [rangeId],
  );
}

/**
 * Checkpoint on FyersAuthError: status → 'partial', record checkpoint_ts.
 * rowsWrittenThisRun is added to the cumulative rows_written counter.
 */
async function checkpointRange(
  client: PoolClient,
  rangeId: number,
  checkpointTs: Date | null,
  rowsWrittenThisRun: number,
): Promise<void> {
  await client.query(
    `UPDATE backfill_ranges
     SET status = 'partial',
         checkpoint_ts = $2,
         rows_written = rows_written + $3,
         updated_at = NOW()
     WHERE id = $1`,
    [rangeId, checkpointTs ? checkpointTs.toISOString() : null, rowsWrittenThisRun],
  );
}

/** Mark status = 'error' on non-resumable failure. */
async function markRangeError(
  client: PoolClient,
  rangeId: number,
  rowsWrittenSoFar: number,
): Promise<void> {
  await client.query(
    `UPDATE backfill_ranges
     SET status = 'error',
         rows_written = rows_written + $2,
         updated_at = NOW()
     WHERE id = $1`,
    [rangeId, rowsWrittenSoFar],
  );
}

/**
 * Finalise on successful completion.
 *
 * Status invariant (enforced here AND by migration 007 CHECK constraint):
 *   gaps.length == 0 → 'complete'
 *   gaps.length > 0  → 'gapped'  (NEVER 'complete' when gaps detected)
 *
 * Returns the final status so the caller can include it in the result.
 */
async function finaliseRange(
  client: PoolClient,
  rangeId: number,
  rowsWrittenThisRun: number,
  gaps: BackfillGapSummary[],
): Promise<BackfillRangeStatus> {
  const status: BackfillRangeStatus = gaps.length > 0 ? 'gapped' : 'complete';

  // Serialise gap records to JSON text for storage.
  const gapsJsonStr =
    gaps.length > 0
      ? JSON.stringify(
          gaps.map((g) => ({
            from: g.from.toISOString(),
            to: g.to.toISOString(),
            reason: g.reason,
          })),
        )
      : null;

  await client.query(
    `UPDATE backfill_ranges
     SET status = $2,
         rows_written = rows_written + $3,
         gaps_detected = $4,
         gaps_json = $5,
         updated_at = NOW()
     WHERE id = $1`,
    [rangeId, status, rowsWrittenThisRun, gaps.length, gapsJsonStr],
  );

  return status;
}

// ---------------------------------------------------------------------------
// Hypertable write helpers
// ---------------------------------------------------------------------------

/**
 * Maximum candles per INSERT batch.
 *
 * 500 candles × 6 params = 3 000 bound parameters — well below PostgreSQL's
 * 65 535 per-query ceiling. At intraday 1-minute resolution this is ~8 hours
 * of candles per transaction, which TimescaleDB handles in <100 ms.
 */
const BATCH_SIZE = 500;

/** Split an array into chunks of at most `size` elements. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Write a batch of candles to market_ticks.
 *
 * Synthesis: candle.close → ltp, candle.timestamp → time.
 * bid / ask / oi are NULL (not available in OHLCV).
 * source = 'fyers-historical' matches the partial-unique index predicate.
 *
 * ON CONFLICT DO NOTHING: re-running a completed range inserts 0 rows.
 * Returns the number of rows actually inserted.
 */
async function writeMarketTicks(
  client: PoolClient,
  symbol: string,
  resolution: string,
  candles: FyersCandle[],
): Promise<number> {
  if (candles.length === 0) return 0;

  // Build a multi-row VALUES clause with sequential $N placeholders.
  // Each candle contributes 6 parameters: symbol, time, ltp, volume, source, resolution.
  const placeholders: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  for (const candle of candles) {
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      symbol,
      candle.timestamp.toISOString(),
      candle.close, // ltp = candle close (standard OHLCV synthesis)
      candle.volume,
      'fyers-historical', // source — matches the partial-unique index predicate
      resolution,
    );
  }

  const sql = `
    INSERT INTO market_ticks (symbol, time, ltp, volume, source, resolution)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT DO NOTHING
  `;

  // ON CONFLICT DO NOTHING without an explicit conflict target uses all unique
  // constraints on the table. The partial-unique index on (symbol, time) WHERE
  // source = 'fyers-historical' is the active constraint for these rows.
  const result = await client.query(sql, params);
  return result.rowCount ?? 0;
}

/**
 * Write a batch of candles to option_ticks.
 *
 * Same synthesis as writeMarketTicks(). delta / iv are NULL for OHLCV candles
 * (greeks are not included in Fyers historical data).
 * Returns the number of rows actually inserted.
 */
async function writeOptionTicks(
  client: PoolClient,
  symbol: string,
  resolution: string,
  candles: FyersCandle[],
): Promise<number> {
  if (candles.length === 0) return 0;

  const placeholders: string[] = [];
  const params: unknown[] = [];
  let p = 1;

  for (const candle of candles) {
    placeholders.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
    params.push(
      candle.timestamp.toISOString(),
      symbol,
      candle.close,
      candle.volume,
      'fyers-historical',
      resolution,
    );
  }

  const sql = `
    INSERT INTO option_ticks (time, symbol, ltp, volume, source, resolution)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT DO NOTHING
  `;

  const result = await client.query(sql, params);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Main public function
// ---------------------------------------------------------------------------

/**
 * Run a historical backfill for the given (symbol, resolution, from, to) range.
 *
 * Flow:
 * 1. Look up backfill_ranges for an existing row with the same natural key.
 *    - 'complete' / 'gapped': return immediately — no re-fetch, no re-write.
 *    - 'partial': resume from checkpoint_ts (already-written rows are skipped
 *      by ON CONFLICT DO NOTHING).
 *    - 'running' / 'error': reset to 'running' and restart.
 *    - not found: create a new row.
 * 2. Fetch candles via fetchHistoricalCandles() starting from effectiveFrom
 *    (= checkpoint_ts for a resumed run, = from for a fresh run).
 *    - FyersAuthError → checkpoint + throw BackfillResumeError (loud, resumable).
 *    - Other errors → mark 'error' + re-throw.
 * 3. Write candles to the appropriate hypertable in BATCH_SIZE batches.
 *    ON CONFLICT DO NOTHING handles any overlap from resumed runs.
 * 4. Reconcile fetched candle timestamps against the NSE trading calendar.
 *    Record any missing expected trading days as gaps.
 * 5. Finalise backfill_ranges: 'complete' (no gaps) or 'gapped' (gaps > 0).
 *    NEVER mark 'complete' when gaps_detected > 0.
 *
 * Throws:
 *   BackfillResumeError       — FyersAuthError mid-fetch; checkpoint saved; re-run to resume
 *   FyersNoCredentialsError   — credentials missing; range stays 'running'
 *   FyersRateLimitError       — rate limit exhausted; range marked 'error'
 *   Error                     — other unrecoverable failures; range marked 'error'
 */
export async function runBackfill(db: Pool, options: BackfillOptions): Promise<BackfillResult> {
  const { symbol, resolution, from, to, fetchFn, sleepFn } = options;

  if (from > to) {
    throw new Error(
      `[BackfillWriter] 'from' (${from.toISOString()}) must not be after ` +
        `'to' (${to.toISOString()})`,
    );
  }

  const targetTable = resolveSymbolTable(symbol);
  const client = await db.connect();

  // Track whether the client has already been released so we never double-release.
  let clientReleased = false;
  const releaseClient = () => {
    if (!clientReleased) {
      clientReleased = true;
      client.release();
    }
  };

  try {
    // ── 1. Find or create the backfill_ranges row ───────────────────────────
    const existing = await findExistingRange(client, symbol, from, to, resolution);

    let rangeId: number;
    let effectiveFrom = from;
    let previousRowsWritten = 0;

    if (existing) {
      rangeId = existing.id;
      previousRowsWritten = existing.rows_written ?? 0;

      // Short-circuit: range already fully processed.
      if (existing.status === 'complete' || existing.status === 'gapped') {
        releaseClient();
        const storedGaps = parseStoredGaps(existing.gaps_json);
        return {
          status: existing.status,
          rowsWritten: 0, // zero new rows written in this invocation
          totalRowsWritten: previousRowsWritten,
          gaps: storedGaps,
          rangeId,
        };
      }

      // Partial run: resume from checkpoint.
      if (existing.status === 'partial' && existing.checkpoint_ts) {
        // checkpoint_ts is the timestamp of the last successfully written candle.
        // We use it as the new from date. Fyers rounds to UTC midnight internally,
        // so chunks that overlap the checkpoint boundary will be handled by
        // ON CONFLICT DO NOTHING for any already-written rows.
        effectiveFrom = existing.checkpoint_ts;
        console.log(
          `[BackfillWriter] Resuming ${symbol} ${resolution} from checkpoint ` +
            `${existing.checkpoint_ts.toISOString()} (rangeId=${rangeId})`,
        );
      }

      // For partial, running, or error statuses: reset to 'running'.
      await markRangeRunning(client, rangeId);
    } else {
      rangeId = await insertRangeRow(client, symbol, from, to, resolution);
    }

    // Re-declare so TypeScript is sure rangeId and effectiveFrom are initialised.
    const resolvedRangeId = rangeId;
    const resolvedEffectiveFrom = effectiveFrom;
    const resolvedPreviousRowsWritten = previousRowsWritten;

    // ── 2. Fetch candles ────────────────────────────────────────────────────
    let candles: FyersCandle[];
    let fyersGaps: FyersCandleGap[];

    try {
      // Build the fetch options, omitting optional fields when they are undefined
      // to satisfy exactOptionalPropertyTypes. We cannot spread undefined values
      // into an object that declares optional fields as T (not T | undefined).
      const fetchOpts = {
        symbol,
        resolution,
        from: resolvedEffectiveFrom,
        to,
        ...(fetchFn !== undefined ? { fetchFn } : {}),
        ...(sleepFn !== undefined ? { sleepFn } : {}),
      };
      const fetchResult = await fetchHistoricalCandles(db, fetchOpts);
      candles = fetchResult.candles;
      fyersGaps = fetchResult.gaps;
    } catch (err) {
      if (err instanceof FyersAuthError) {
        // Resumable: checkpoint the last candle the Fyers client managed to fetch
        // before the auth failure. That cutoff is carried on the error object.
        const checkpointTs = err.lastSuccessfulCutoff;
        try {
          await checkpointRange(client, resolvedRangeId, checkpointTs, 0);
        } catch (dbErr) {
          // Log but don't mask the original FyersAuthError.
          console.error('[BackfillWriter] Failed to write checkpoint on FyersAuthError:', dbErr);
        }
        releaseClient();
        throw new BackfillResumeError(checkpointTs, resolvedRangeId, err);
      }

      // Non-resumable (rate limit, network, malformed response).
      try {
        await markRangeError(client, resolvedRangeId, 0);
      } catch (dbErr) {
        console.error('[BackfillWriter] Failed to mark range as error:', dbErr);
      }
      releaseClient();
      throw err;
    }

    // ── 3. Write candles to the hypertable ──────────────────────────────────
    let rowsWrittenThisRun = 0;
    let lastWrittenCandle: FyersCandle | null = null;

    try {
      const batches = chunkArray(candles, BATCH_SIZE);
      for (const batch of batches) {
        if (targetTable === 'market_ticks') {
          rowsWrittenThisRun += await writeMarketTicks(client, symbol, resolution, batch);
        } else {
          rowsWrittenThisRun += await writeOptionTicks(client, symbol, resolution, batch);
        }
        lastWrittenCandle = batch[batch.length - 1] ?? lastWrittenCandle;
      }
    } catch (err) {
      // Write failure partway through. Checkpoint only the last successfully
      // written batch so a resume re-fetches and retries the failed batch.
      const checkpointTs = lastWrittenCandle?.timestamp ?? null;
      try {
        await checkpointRange(client, resolvedRangeId, checkpointTs, rowsWrittenThisRun);
      } catch (dbErr) {
        console.error('[BackfillWriter] Failed to checkpoint on write error:', dbErr);
      }
      releaseClient();
      throw err;
    }

    // ── 4. Calendar reconciliation ──────────────────────────────────────────
    const calendarGaps = reconcileCalendarGaps(
      candles,
      fyersGaps,
      resolvedEffectiveFrom,
      to,
      resolution,
    );

    if (calendarGaps.length > 0) {
      console.warn(
        `[BackfillWriter] ${calendarGaps.length} gap(s) detected for ${symbol} ${resolution}. Range will be marked 'gapped'. Review gaps_json in backfill_ranges.`,
      );
    }

    // ── 5. Finalise ─────────────────────────────────────────────────────────
    const finalStatus = await finaliseRange(
      client,
      resolvedRangeId,
      rowsWrittenThisRun,
      calendarGaps,
    );

    releaseClient();

    const totalRowsWritten = resolvedPreviousRowsWritten + rowsWrittenThisRun;
    console.log(
      `[BackfillWriter] ${symbol} ${resolution} → ${finalStatus}. ` +
        `Rows this run: ${rowsWrittenThisRun}, total: ${totalRowsWritten}, ` +
        `gaps: ${calendarGaps.length}.`,
    );

    return {
      status: finalStatus,
      rowsWritten: rowsWrittenThisRun,
      totalRowsWritten,
      gaps: calendarGaps,
      rangeId: resolvedRangeId,
    };
  } catch (err) {
    // Ensure the client is released even if an unexpected error bypassed all the
    // individual catch blocks above.
    releaseClient();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

/**
 * Parse gaps_json TEXT from backfill_ranges into BackfillGapSummary[].
 * Returns [] on null or malformed JSON (fail-safe — never crash on stored data).
 */
function parseStoredGaps(gapsJson: string | null): BackfillGapSummary[] {
  if (!gapsJson) return [];
  try {
    const parsed = JSON.parse(gapsJson) as Array<{ from: string; to: string; reason: string }>;
    return parsed.map((g) => ({
      from: new Date(g.from),
      to: new Date(g.to),
      reason: g.reason,
    }));
  } catch {
    console.warn('[BackfillWriter] Could not parse gaps_json — treating as no gaps.');
    return [];
  }
}
