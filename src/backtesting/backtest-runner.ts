/**
 * backtest-runner.ts — In-memory historical backtest simulation.
 *
 * Reads straddle snapshots from PostgreSQL and simulates the signal detection +
 * personality filter pipeline entirely in memory (no Redis, no live side effects).
 * This is the correct approach for a research tool: using the live Redis pipeline
 * for backtesting would be non-deterministic and impractical at scale.
 *
 * Design decisions:
 *   - One MOMENTUM_EXHAUSTION signal and one SCHEDULED signal are considered per
 *     day per underlying. More signals per day are not useful for a daily research
 *     tool and would cause double-counting in per-day metrics.
 *   - Regime lookup uses a preloaded Map (one DB query for the entire date range)
 *     rather than per-day queries to minimise round-trips.
 *   - All SQL queries are parameterised. No string interpolation.
 *   - The backtest never writes to the DB; all results are returned in memory.
 *   - `crypto.randomUUID()` is used for OpenPosition IDs (Bun provides this globally).
 */

import type { Pool } from 'pg';
import { FixedClock } from '../utils/clock.js';
import { evaluateTriggers, updateTrailingStop } from '../trading/trigger-engine.js';
import type { TriggerConfig } from '../trading/trigger-engine.js';
import { runPersonalityFilter } from '../signals/personality-filter.js';
import type { StraddleSignalInput, DailyState } from '../signals/personality-filter.js';
import type { PersonalityConfigM2 } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface BacktestSplit {
  train: { from: string; to: string; days: number };
  test: { from: string; to: string; days: number };
  holdout: { from: string; to: string; days: number };
}

export interface BacktestConfig {
  underlying: string;
  fromDate: string;
  toDate: string;
  holdoutDays?: number;
  trainFraction?: number;
  hardSlPct?: number;
  trailingSlPct?: number;
  profitTargetPct?: number;
  eodExitTimeIST?: string;
  minExpansionPct?: number;
  accelerationThreshold?: number;
  rocDeclineCandles?: number;
  confirmationCandles?: number;
}

export interface SimulatedTrade {
  personalityId: string;
  personalityName: string;
  date: string;
  regime: string;
  signalType: 'MOMENTUM_EXHAUSTION' | 'SCHEDULED' | 'PULLBACK';
  adjustedProbability: number;
  entryStraddleValue: number;
  exitStraddleValue: number;
  exitReason: string;
  pnlPct: number;
  pnlAbs: number;
  entryTimeMs: number;
  exitTimeMs: number;
  split: 'train' | 'test' | 'holdout';
}

export interface BacktestPersonality {
  id: string;
  name: string;
  entryType: string;
  managementStyle: string;
  isFrozen: boolean;
}

export interface BacktestResult {
  config: BacktestConfig;
  split: BacktestSplit;
  trades: SimulatedTrade[];
  personalities: BacktestPersonality[];
  tradingDays: number;
  skippedDates: string[];
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SnapshotRow {
  time: Date;
  call_ltp: string | number;
  put_ltp: string | number;
  straddle_value: string | number;
  roc: string | number | null;
  roc_acceleration: string | number | null;
  vix: string | number | null;
  strike: string | number;
}

interface InMemorySnapshot {
  timeMs: number;
  straddleValue: number;
  roc: number | null;
  rocAcceleration: number | null;
  vix: number | null;
  strike: number;
}

// ---------------------------------------------------------------------------
// IST helpers (defined locally to keep this module dependency-free from utils)
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toISTHHMM(epochMs: number): string {
  const d = new Date(epochMs + IST_OFFSET_MS);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function toISTDate(epochMs: number): string {
  const d = new Date(epochMs + IST_OFFSET_MS);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Parses numeric columns that pg may return as string (NUMERIC columns) or number. */
function toNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Date range helpers
// ---------------------------------------------------------------------------

/**
 * Returns all calendar day ISO strings in [fromDate, toDate] inclusive.
 * fromDate and toDate must be 'YYYY-MM-DD'.
 */
function calendarDaysBetween(fromDate: string, toDate: string): string[] {
  const days: string[] = [];
  // Parse at noon UTC to avoid DST / timezone edge cases
  const from = new Date(`${fromDate}T12:00:00Z`);
  const to = new Date(`${toDate}T12:00:00Z`);
  const cur = new Date(from);
  while (cur <= to) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    days.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Split computation
// ---------------------------------------------------------------------------

function computeSplit(
  allDays: string[],
  holdoutDays: number,
  trainFraction: number,
): BacktestSplit {
  const holdoutCount = Math.min(holdoutDays, allDays.length);
  const nonHoldout = allDays.slice(0, allDays.length - holdoutCount);
  const holdoutSlice = allDays.slice(allDays.length - holdoutCount);

  const trainCount = Math.floor(nonHoldout.length * trainFraction);
  const trainSlice = nonHoldout.slice(0, trainCount);
  const testSlice = nonHoldout.slice(trainCount);

  const firstOrEmpty = (arr: string[]) => arr[0] ?? '';
  const lastOrEmpty = (arr: string[]) => arr[arr.length - 1] ?? '';

  return {
    train: {
      from: firstOrEmpty(trainSlice),
      to: lastOrEmpty(trainSlice),
      days: trainSlice.length,
    },
    test: {
      from: firstOrEmpty(testSlice),
      to: lastOrEmpty(testSlice),
      days: testSlice.length,
    },
    holdout: {
      from: firstOrEmpty(holdoutSlice),
      to: lastOrEmpty(holdoutSlice),
      days: holdoutSlice.length,
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory peak detection
// ---------------------------------------------------------------------------

interface PeakDetectionState {
  openStraddleValue: number | null;
  rocDeclineStreak: number;
  confirmationStreak: number;
  prevRoc: number | null;
}

/**
 * Checks the four peak-detection conditions against a single snapshot.
 * Returns whether all four conditions fire simultaneously.
 * Mutates `state` in place (this is intentional — the caller owns the state).
 */
function updatePeakState(
  snap: InMemorySnapshot,
  state: PeakDetectionState,
  config: Required<Pick<BacktestConfig, 'minExpansionPct' | 'accelerationThreshold' | 'rocDeclineCandles' | 'confirmationCandles'>>,
): boolean {
  // Lock the open straddle value at the first non-zero snapshot after 09:15 IST
  if (state.openStraddleValue === null) {
    const hhmm = toISTHHMM(snap.timeMs);
    if (hhmm >= '09:15' && snap.straddleValue > 0) {
      state.openStraddleValue = snap.straddleValue;
    }
    return false;
  }

  const expansionPct =
    ((snap.straddleValue - state.openStraddleValue) / state.openStraddleValue) * 100;
  const expansionMet = expansionPct >= config.minExpansionPct;

  const accelerationMet =
    snap.rocAcceleration !== null && snap.rocAcceleration < config.accelerationThreshold;

  // ROC decline streak: current roc < previous roc
  if (snap.roc !== null && state.prevRoc !== null) {
    if (snap.roc < state.prevRoc) {
      state.rocDeclineStreak++;
    } else {
      state.rocDeclineStreak = 0;
    }
  } else {
    state.rocDeclineStreak = 0;
  }
  state.prevRoc = snap.roc;

  const rocDeclineMet = state.rocDeclineStreak >= config.rocDeclineCandles;

  if (expansionMet && accelerationMet && rocDeclineMet) {
    state.confirmationStreak++;
  } else {
    state.confirmationStreak = 0;
  }

  return (
    expansionMet &&
    accelerationMet &&
    rocDeclineMet &&
    state.confirmationStreak >= config.confirmationCandles
  );
}

// ---------------------------------------------------------------------------
// DB queries
// ---------------------------------------------------------------------------

/** Loads active phase-1 personalities and maps them to PersonalityConfigM2. */
async function loadPersonalities(pool: Pool): Promise<PersonalityConfigM2[]> {
  const result = await pool.query<{
    id: string;
    name: string;
    display_name: string;
    group_type: string;
    entry_type: string;
    management_style: string;
    is_frozen: boolean;
    is_active: boolean;
    phase: number;
    params: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, name, display_name, group_type, entry_type, management_style,
            is_frozen, is_active, phase, params, created_at, updated_at
     FROM personality_configs
     WHERE is_active = TRUE AND phase = 1
     ORDER BY name`,
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    displayName: row.display_name,
    groupType: row.group_type as PersonalityConfigM2['groupType'],
    entryType: row.entry_type as PersonalityConfigM2['entryType'],
    managementStyle: row.management_style as PersonalityConfigM2['managementStyle'],
    isFrozen: row.is_frozen,
    isActive: row.is_active,
    phase: row.phase,
    params: row.params,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Loads regime tags for a symbol over a date range into a Map<dateISO, regime>. */
async function loadRegimeTags(
  pool: Pool,
  symbol: string,
  fromDate: string,
  toDate: string,
): Promise<Map<string, string>> {
  const result = await pool.query<{ trade_date: string; regime: string }>(
    `SELECT TO_CHAR(trade_date, 'YYYY-MM-DD') AS trade_date, regime
     FROM daily_regime_tags
     WHERE symbol = $1
       AND trade_date >= $2::date
       AND trade_date <= $3::date`,
    [symbol, fromDate, toDate],
  );
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.trade_date, row.regime);
  }
  return map;
}

/** Loads intraday straddle snapshots for a single day (UTC midnight to midnight). */
async function loadDaySnapshots(
  pool: Pool,
  symbol: string,
  dateISO: string,
): Promise<InMemorySnapshot[]> {
  // UTC bounds: midnight to 23:59:59.999 of that calendar date.
  // We use UTC bounds because the hypertable is partitioned by `time` (timestamptz stored as UTC).
  // All IST trading hours (09:15–15:30) fall well within a single UTC calendar day.
  const dayStart = `${dateISO}T00:00:00.000Z`;
  const dayEnd = `${dateISO}T23:59:59.999Z`;

  const result = await pool.query<SnapshotRow>(
    `SELECT time, call_ltp, put_ltp, straddle_value, roc, roc_acceleration, vix, strike
     FROM straddle_snapshots
     WHERE symbol = $1
       AND time >= $2
       AND time < $3
     ORDER BY time ASC`,
    [symbol, dayStart, dayEnd],
  );

  return result.rows.map((row) => ({
    timeMs: new Date(row.time).getTime(),
    straddleValue: toNum(row.straddle_value) ?? 0,
    roc: toNum(row.roc),
    rocAcceleration: toNum(row.roc_acceleration),
    vix: toNum(row.vix),
    strike: toNum(row.strike) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Trade simulation helpers
// ---------------------------------------------------------------------------

/**
 * Simulates one trade: walks forward from the entry snapshot to either an
 * exit trigger or the last snapshot of the day.
 */
function simulateTrade(
  snapshots: InMemorySnapshot[],
  entryIdx: number,
  triggerConfig: TriggerConfig,
  entryTimeMs: number,
): { exitStraddleValue: number; exitReason: string; exitTimeMs: number } {
  const entrySV = snapshots[entryIdx]?.straddleValue ?? 0;
  const entryStr = String(entrySV);

  let lowestSeen = entryStr;

  for (let i = entryIdx + 1; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (snap === undefined) continue;

    const sv = String(snap.straddleValue);
    const clock = new FixedClock(snap.timeMs);
    const position = {
      id: crypto.randomUUID(),
      entryStraddleValue: entryStr,
      lowestStraddleValueSeen: lowestSeen,
      entryTimeMs,
      todayNetPnl: '0',
    };

    const decision = evaluateTriggers(position, sv, clock, triggerConfig);

    // Update trailing stop before checking exit so we record the true lowest
    lowestSeen = updateTrailingStop(position, sv);

    if (decision.shouldExit) {
      return {
        exitStraddleValue: snap.straddleValue,
        exitReason: decision.reason,
        exitTimeMs: snap.timeMs,
      };
    }
  }

  // No trigger fired — force EOD exit at the last snapshot of the day
  const lastSnap = snapshots[snapshots.length - 1];
  return {
    exitStraddleValue: lastSnap?.straddleValue ?? entrySV,
    exitReason: 'EOD',
    exitTimeMs: lastSnap?.timeMs ?? entryTimeMs,
  };
}

// ---------------------------------------------------------------------------
// Factory + runner
// ---------------------------------------------------------------------------

export function createBacktestRunner(pool: Pool) {
  return {
    async run(config: BacktestConfig): Promise<BacktestResult> {
      // --- 1. Validate config ---
      const fromMs = new Date(`${config.fromDate}T12:00:00Z`).getTime();
      const toMs = new Date(`${config.toDate}T12:00:00Z`).getTime();
      if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
        throw new Error('Invalid fromDate or toDate — must be YYYY-MM-DD');
      }
      if (fromMs > toMs) {
        throw new Error('fromDate must be <= toDate');
      }

      const holdoutDays = config.holdoutDays ?? 20;
      const trainFraction = config.trainFraction ?? 0.7;

      if (holdoutDays < 0) {
        throw new Error('holdoutDays must be >= 0');
      }
      if (trainFraction <= 0 || trainFraction >= 1) {
        throw new Error('trainFraction must be in (0, 1)');
      }

      // Signal detection overrides (fall back to production defaults)
      const detectionConfig = {
        minExpansionPct: config.minExpansionPct ?? 10,
        accelerationThreshold: config.accelerationThreshold ?? -0.5,
        rocDeclineCandles: config.rocDeclineCandles ?? 3,
        confirmationCandles: config.confirmationCandles ?? 2,
      };

      // Trigger config (fall back to production defaults)
      const triggerConfig: TriggerConfig = {
        hardSlPct: config.hardSlPct ?? 0.30,
        trailingSlPct: config.trailingSlPct ?? 0.15,
        profitTargetPct: config.profitTargetPct ?? 0.30,
        eodExitTime: config.eodExitTimeIST ?? '15:25',
        // exitCutoffTime is used as a safety net; set 5 min after EOD
        exitCutoffTime: '15:30',
        maxDailyLoss: '10000',
      };

      // --- 2. Compute split ---
      const allDays = calendarDaysBetween(config.fromDate, config.toDate);
      const split = computeSplit(allDays, holdoutDays, trainFraction);

      // Build a fast lookup: date → split label
      const trainSet = new Set(
        calendarDaysBetween(split.train.from, split.train.to),
      );
      const testSet = new Set(
        calendarDaysBetween(split.test.from, split.test.to),
      );
      const holdoutSet = new Set(
        calendarDaysBetween(split.holdout.from, split.holdout.to),
      );

      function getSplitLabel(date: string): 'train' | 'test' | 'holdout' {
        if (holdoutSet.has(date)) return 'holdout';
        if (testSet.has(date)) return 'test';
        return 'train';
      }

      // --- 3. Load personalities ---
      const personalities = await loadPersonalities(pool);

      // --- 4. Load regime tags ---
      const regimeMap = await loadRegimeTags(
        pool,
        config.underlying,
        config.fromDate,
        config.toDate,
      );

      // --- 5. Simulate each calendar day ---
      const trades: SimulatedTrade[] = [];
      let tradingDays = 0;
      const skippedDates: string[] = [];

      // Entry time constants for the scheduled signal (11:30 IST)
      const SCHEDULED_HHMM = '11:30';
      const ENTRY_START = '09:20';
      const ENTRY_CUTOFF = '15:00';

      for (const dateISO of allDays) {
        const snapshots = await loadDaySnapshots(pool, config.underlying, dateISO);

        if (snapshots.length === 0) {
          skippedDates.push(dateISO);
          continue;
        }

        tradingDays++;
        const regime = regimeMap.get(dateISO) ?? 'UNCLASSIFIED';
        const splitLabel = getSplitLabel(dateISO);

        // Per-personality daily trade state (reset each day)
        const dailyTradeCount = new Map<string, number>();
        for (const p of personalities) {
          dailyTradeCount.set(p.id, 0);
        }

        // --- 5d. Run in-memory peak detection ---
        const peakState: PeakDetectionState = {
          openStraddleValue: null,
          rocDeclineStreak: 0,
          confirmationStreak: 0,
          prevRoc: null,
        };

        let momentumSignalSnapshotIdx: number | null = null;
        let momentumSignalTimeMs: number | null = null;

        for (let i = 0; i < snapshots.length; i++) {
          const snap = snapshots[i];
          if (snap === undefined) continue;

          const hhmm = toISTHHMM(snap.timeMs);
          // Only consider snapshots within trading hours for signal generation
          if (hhmm < ENTRY_START || hhmm > ENTRY_CUTOFF) continue;

          if (updatePeakState(snap, peakState, detectionConfig)) {
            // First signal per day — dedup to one signal per day
            momentumSignalSnapshotIdx = i;
            momentumSignalTimeMs = snap.timeMs;
            break;
          }
        }

        // --- 5e. Find scheduled signal snapshot (closest to 11:30 IST) ---
        let scheduledSnapshotIdx: number | null = null;
        let scheduledTimeMs: number | null = null;
        let minDiff = Number.POSITIVE_INFINITY;
        for (let i = 0; i < snapshots.length; i++) {
          const snap = snapshots[i];
          if (snap === undefined) continue;
          const hhmm = toISTHHMM(snap.timeMs);
          // Compute diff in minutes from 11:30
          const [hStr, mStr] = SCHEDULED_HHMM.split(':');
          const targetMinutes = Number(hStr) * 60 + Number(mStr);
          const [sh, sm] = hhmm.split(':');
          const snapMinutes = Number(sh) * 60 + Number(sm);
          const diff = Math.abs(snapMinutes - targetMinutes);
          if (diff < minDiff) {
            minDiff = diff;
            scheduledSnapshotIdx = i;
            scheduledTimeMs = snap.timeMs;
          }
        }

        // --- 5f. Process each signal type against each personality ---
        type SignalSpec = {
          snapshotIdx: number;
          timeMs: number;
          signalType: 'MOMENTUM_EXHAUSTION' | 'SCHEDULED';
          adjustedProbability: number;
        };

        const signals: SignalSpec[] = [];

        if (momentumSignalSnapshotIdx !== null && momentumSignalTimeMs !== null) {
          signals.push({
            snapshotIdx: momentumSignalSnapshotIdx,
            timeMs: momentumSignalTimeMs,
            signalType: 'MOMENTUM_EXHAUSTION',
            adjustedProbability: 0.70,
          });
        }

        if (scheduledSnapshotIdx !== null && scheduledTimeMs !== null) {
          signals.push({
            snapshotIdx: scheduledSnapshotIdx,
            timeMs: scheduledTimeMs,
            signalType: 'SCHEDULED',
            adjustedProbability: 1.0,
          });
        }

        for (const sig of signals) {
          const entrySnap = snapshots[sig.snapshotIdx];
          if (entrySnap === undefined) continue;

          for (const personality of personalities) {
            const tradeCount = dailyTradeCount.get(personality.id) ?? 0;

            const dailyState: DailyState = {
              tradeCount,
              netPnl: '0',
              openPositions: 0,
            };

            const signalInput: StraddleSignalInput = {
              signalType: sig.signalType,
              signalId: crypto.randomUUID(),
              underlying: config.underlying,
              atmStrike: entrySnap.strike,
              spot: entrySnap.strike,
              straddleValue: entrySnap.straddleValue,
              vix: entrySnap.vix,
              adjustedProbability: sig.adjustedProbability,
              confidenceTier: sig.adjustedProbability >= 0.7 ? 'HIGH' : 'MEDIUM',
              signalTimeMs: sig.timeMs,
            };

            const filterResult = runPersonalityFilter(
              signalInput,
              personality,
              dailyState,
              sig.timeMs,
            );

            if (!filterResult.pass) continue;

            // Simulate the trade
            const { exitStraddleValue, exitReason, exitTimeMs } = simulateTrade(
              snapshots,
              sig.snapshotIdx,
              triggerConfig,
              sig.timeMs,
            );

            const entryVal = entrySnap.straddleValue;
            // Short straddle: profit when straddle value falls
            const pnlAbs = entryVal - exitStraddleValue;
            const pnlPct = entryVal !== 0 ? pnlAbs / entryVal : 0;

            trades.push({
              personalityId: personality.id,
              personalityName: personality.name,
              date: dateISO,
              regime,
              signalType: sig.signalType,
              adjustedProbability: sig.adjustedProbability,
              entryStraddleValue: entryVal,
              exitStraddleValue,
              exitReason,
              pnlPct,
              pnlAbs,
              entryTimeMs: sig.timeMs,
              exitTimeMs,
              split: splitLabel,
            });

            dailyTradeCount.set(personality.id, tradeCount + 1);
          }
        }
      }

      const backtestPersonalities: BacktestPersonality[] = personalities.map((p) => ({
        id: p.id,
        name: p.name,
        entryType: p.entryType,
        managementStyle: p.managementStyle,
        isFrozen: p.isFrozen,
      }));

      return {
        config,
        split,
        trades,
        personalities: backtestPersonalities,
        tradingDays,
        skippedDates,
      };
    },
  };
}
