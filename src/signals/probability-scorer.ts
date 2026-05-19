/**
 * probability-scorer.ts — pure probability scoring function for trade signals
 *
 * Computes an adjusted probability score for a given signal by applying
 * 9 independent adjustment factors on top of a raw exhaustion-based base
 * probability. The function is deliberately pure (no I/O, no side effects)
 * so it can be unit-tested exhaustively and called synchronously from any
 * decision context.
 *
 * Design decisions:
 *   - Pure function with no I/O: all inputs are pre-fetched by the caller.
 *     This matches the pattern established in personality-filter.ts and
 *     avoids N*10 Redis/DB calls when scoring signals for 10 personalities.
 *   - SCHEDULED signals short-circuit: they are pre-scheduled entries with
 *     a fixed 0.60 probability by policy. Macro adjustments are not applied
 *     because the entry is time-driven, not signal-quality-driven.
 *   - IST time extraction: we derive IST hour/minute/day-of-week from epoch ms
 *     using the 'Asia/Kolkata' locale string rather than a raw +330 offset,
 *     because toLocaleString is available in all target runtimes (Bun, Node,
 *     browser) and the IANA zone database handles edge cases like "24:00".
 *   - adjustmentBreakdown always has exactly 9 keys at value 0 if unused —
 *     consumers can sum or display the breakdown without null-checking each key.
 *   - All adjustments are independent (no cross-factor interactions). This is
 *     intentional: it keeps the model interpretable and auditable. Factor
 *     interactions would require empirical calibration we do not yet have.
 *   - Probability scores are NOT empirically calibrated yet — they function as
 *     relative rankings, not absolute probabilities. See technical.md.
 *   - The Clock parameter is accepted on ScoringInput but not used inside this
 *     function; signalTimeMs is the authoritative time for scoring decisions.
 *     Clock is included for consistency with the rest of the codebase's
 *     injection pattern and for future use if real-time lookups are added.
 */

import type { MacroContext } from '../ingestion/global-macro-feed.js';
import type { Clock } from '../utils/clock.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** All inputs required to score a single signal. */
export interface ScoringInput {
  /** Raw exhaustion score from peak-detection engine (0.0 – 1.0). */
  rawExhaustionScore: number;
  /** Signal classification. SCHEDULED signals receive a fixed probability. */
  signalType: 'MOMENTUM_EXHAUSTION' | 'SCHEDULED' | 'PULLBACK';
  /** Current India VIX value; null when the VIX feed is unavailable. */
  indiaVix: number | null;
  /** Current global macro context snapshot. Any field may be null. */
  macro: MacroContext;
  /**
   * Percentage change in total straddle OI from 9:15 AM open.
   * null = OI data unavailable (silent fail — adjustment treated as 0).
   */
  oiChangePct: number | null;
  /** Epoch milliseconds at which the signal was generated. */
  signalTimeMs: number;
  /**
   * Clock instance (injected for codebase consistency).
   * Not used directly in scoring — signalTimeMs is the authoritative timestamp.
   */
  clock: Clock;
}

/** Output of the probability scorer. */
export interface ScoringResult {
  /** Unadjusted base probability before macro/context factors. */
  rawProbability: number;
  /** Final clamped probability after all 9 adjustments. */
  adjustedProbability: number;
  /** Tier classification derived from adjustedProbability. */
  confidenceTier: 'HIGH' | 'MEDIUM' | 'LOW';
  /**
   * Contribution of each of the 9 adjustment factors.
   * All 9 keys are always present; value is 0 when the factor did not apply.
   * Keys: india_vix, us_vix, sp500, dax, crude_oil, gold, oi_change, time_of_day, day_of_week
   */
  adjustmentBreakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Clamps a value to the inclusive [min, max] range.
 * Used for both per-factor magnitude caps and the final probability clamp.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Represents IST time components extracted from an epoch-ms timestamp.
 * Used internally by getISTComponents.
 */
interface ISTComponents {
  hour: number;    // 0–23
  minute: number;  // 0–59
  dayOfWeek: number; // 0 (Sunday) – 6 (Saturday), matching Date.getDay() semantics
}

/**
 * Extracts IST time components from an epoch-ms timestamp.
 *
 * We use toLocaleString with 'Asia/Kolkata' rather than a raw UTC+5:30 offset
 * because the IANA database is the authoritative source for IST and handles
 * edge cases like "24:00" (midnight wraparound) that a manual +330 minute
 * offset could produce incorrectly.
 *
 * The locale format 'en-US' with hour12:false produces "HH:MM" strings that
 * are straightforward to split and parse.
 */
function getISTComponents(epochMs: number): ISTComponents {
  // Build a Date object in IST and extract the components we need.
  // We use toLocaleDateString separately for day-of-week to avoid parsing
  // a combined datetime string which can vary by runtime.

  const dateInIST = new Date(epochMs);

  // Extract hour and minute using the Asia/Kolkata timezone.
  // hour12:false gives "HH:MM" format (e.g. "09:30" or "14:00").
  const timeStr = dateInIST.toLocaleString('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  });

  // Extract day-of-week using a separate locale call with the 'narrow' format.
  // We ask for 'numeric' weekday which isn't directly available, so we use the
  // epoch-ms approach: offset by IST (+330 minutes = 19800000 ms) and use UTC
  // getDay(). This avoids parsing locale-dependent day names.
  //
  // Why +330-minute offset instead of another toLocaleString call?
  // IST has no DST, so +05:30 is always correct. A second toLocaleString call
  // for weekday names would produce locale-specific strings ("Mon", "Monday")
  // that are fragile to parse. The numeric approach is unambiguous.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +5:30 in milliseconds
  const dayOfWeek = new Date(epochMs + IST_OFFSET_MS).getUTCDay();

  const parts = timeStr.split(':');
  // Guard against unexpected format from toLocaleString
  let hour = parseInt(parts[0] ?? '0', 10);
  const minute = parseInt(parts[1] ?? '0', 10);

  // Some runtimes may emit "24" for midnight — normalise to 0.
  if (hour === 24) {
    hour = 0;
  }

  return { hour, minute, dayOfWeek };
}

// ---------------------------------------------------------------------------
// Individual adjustment factor computations
// ---------------------------------------------------------------------------

/**
 * India VIX adjustment.
 *
 * High VIX means more uncertainty; we reduce probability to reflect that
 * premium decay (the basis of MOMENTUM_EXHAUSTION trades) is less predictable
 * in volatile markets. Low VIX is a mild positive signal.
 *
 * Cap: total penalty from this single factor is capped at -0.10 to prevent
 * one factor from dominating the entire adjustment.
 */
function adjustIndiaVix(indiaVix: number | null): number {
  if (indiaVix === null) return 0;

  let raw: number;
  if (indiaVix <= 15) {
    raw = 0.02;
  } else if (indiaVix <= 25) {
    // Smooth linear penalty: 0 at VIX=15, -0.05 at VIX=25
    raw = -((indiaVix - 15) * 0.005);
  } else {
    raw = -0.05;
  }

  // Apply the magnitude cap: adjustment cannot be worse than -0.10
  return clamp(raw, -0.10, 0.10);
}

/**
 * US VIX adjustment.
 *
 * US equity fear gauge affects global risk appetite. Elevated US VIX signals
 * risk-off sentiment that typically spills over into Indian markets.
 */
function adjustUsVix(usVixValue: number | null): number {
  if (usVixValue === null) return 0;

  if (usVixValue < 15) return 0.02;
  if (usVixValue <= 20) return 0;
  if (usVixValue <= 30) return -0.04;
  return -0.08;
}

/**
 * S&P 500 daily change adjustment.
 *
 * Large S&P 500 moves correlate with Nifty gap-open risk and intraday
 * sentiment. Positive S&P moves reduce uncertainty; negative moves increase it.
 */
function adjustSP500(changePct: number | null): number {
  if (changePct === null) return 0;

  if (changePct < -1.5) return -0.06;
  if (changePct < -0.5) return -0.03;
  if (changePct <= 1.5) return 0;
  return 0.03;
}

/**
 * DAX daily change adjustment.
 *
 * European market sentiment (DAX) is a secondary global risk indicator for
 * Indian afternoon sessions. Lower magnitude than S&P 500 given reduced
 * direct correlation.
 */
function adjustDax(changePct: number | null): number {
  if (changePct === null) return 0;

  if (changePct < -1.5) return -0.04;
  if (changePct < -0.5) return -0.02;
  if (changePct <= 1.5) return 0;
  return 0.02;
}

/**
 * Crude oil daily change adjustment (uses absolute value).
 *
 * Large crude oil moves — in either direction — signal macro uncertainty
 * relevant to Indian markets (India is a major oil importer). Direction does
 * not matter here; magnitude of disruption is what reduces signal confidence.
 */
function adjustCrudeOil(changePct: number | null): number {
  if (changePct === null) return 0;

  const absChange = Math.abs(changePct);
  if (absChange > 3) return -0.05;
  if (absChange >= 1.5) return -0.02;
  return 0;
}

/**
 * Gold daily change adjustment.
 *
 * Rising gold is a risk-off signal (flight to safety). A strong gold rally
 * suggests investors are de-risking, which reduces the reliability of options
 * premium decay signals. Gold falling or neutral has no adjustment — the
 * absence of a risk-off flight is not a positive signal in itself.
 */
function adjustGold(changePct: number | null): number {
  if (changePct === null) return 0;

  if (changePct > 2) return -0.05;
  if (changePct > 1) return -0.03;
  // Includes zero and negative: gold down or flat = no adjustment
  return 0;
}

/**
 * Open Interest change adjustment.
 *
 * OI buildup from the 9:15 AM open confirms genuine market participation:
 * new positions are being written, which supports premium decay continuation.
 * OI unwinding (positions closing) reduces signal reliability — participants
 * are exiting, not confirming the move.
 *
 * null is a silent fail — OI data is optional. If unavailable, we do not
 * penalise or boost the score. The "null = neutral" policy prevents unavailable
 * data from inadvertently biasing strategy selection. This is particularly useful
 * in SIMULATE mode where OI tracking may not be available.
 */
function adjustOiChange(oiChangePct: number | null): number {
  if (oiChangePct === null) return 0;

  if (oiChangePct > 5) return 0.04;
  if (oiChangePct >= 2) return 0.02;
  if (oiChangePct > -2) return 0;  // -2% to +2%: flat OI, neutral
  if (oiChangePct >= -5) return -0.02;
  return -0.04;
}

/**
 * Time-of-day adjustment (in IST).
 *
 * 09:20–09:45: Early morning straddle premium is elevated post-open; momentum
 * exhaustion signals here are particularly reliable (premium has further to decay).
 *
 * 14:00–15:00: End-of-day session sees erratic positioning ahead of close.
 * Signals in this window are less reliable due to short-covering and position
 * squaring that can produce false momentum readings.
 */
function adjustTimeOfDay(ist: ISTComponents): number {
  const { hour, minute } = ist;

  // 09:20–09:45 IST: positive boost
  if (hour === 9 && minute >= 20 && minute <= 45) return 0.05;

  // 14:00–15:00 IST: penalty
  if (hour === 14 || (hour === 15 && minute === 0)) return -0.04;

  return 0;
}

/**
 * Day-of-week adjustment (in IST).
 *
 * Monday: Market gaps from weekend news are not yet absorbed; early momentum
 * readings have higher false-positive rates.
 *
 * Friday: Weekly expiry effects create distorted premium behaviour on Fridays.
 * Nifty weekly options expire every Thursday, but Friday sees rollover activity
 * that affects straddle OI and premium unpredictably.
 *
 * Both get an equal -0.03 penalty. Other days have no adjustment.
 */
function adjustDayOfWeek(ist: ISTComponents): number {
  // dayOfWeek follows JavaScript Date.getDay() conventions: 0=Sunday, 1=Monday, ..., 5=Friday, 6=Saturday
  if (ist.dayOfWeek === 1) return -0.03; // Monday
  if (ist.dayOfWeek === 5) return -0.03; // Friday
  return 0;
}

// ---------------------------------------------------------------------------
// Exported zero-breakdown helper (keeps SCHEDULED return DRY)
// ---------------------------------------------------------------------------

/**
 * Returns a breakdown record with all 9 required keys set to 0.
 * Used for SCHEDULED signals (no adjustments applied) and as the
 * baseline for building MOMENTUM_EXHAUSTION / PULLBACK breakdowns.
 */
function zeroBreakdown(): Record<string, number> {
  return {
    india_vix: 0,
    us_vix: 0,
    sp500: 0,
    dax: 0,
    crude_oil: 0,
    gold: 0,
    oi_change: 0,
    time_of_day: 0,
    day_of_week: 0,
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Scores a signal's probability of success given market context.
 *
 * Returns a ScoringResult with rawProbability, adjustedProbability,
 * confidenceTier, and a per-factor adjustmentBreakdown.
 *
 * This function is pure: it performs no I/O, has no side effects, and is
 * deterministic for a given input.
 */
export function scoreProbability(input: ScoringInput): ScoringResult {
  const { signalType, rawExhaustionScore, indiaVix, macro, oiChangePct, signalTimeMs } = input;

  // ------------------------------------------------------------------
  // SCHEDULED: fixed probability, no adjustments
  // ------------------------------------------------------------------
  // SCHEDULED signals are time-triggered (not signal-quality-driven), so macro
  // context adjustments do not apply — the entry decision has already been made.
  if (signalType === 'SCHEDULED') {
    return {
      rawProbability: 0.60,
      adjustedProbability: 0.60,
      confidenceTier: 'MEDIUM',
      adjustmentBreakdown: zeroBreakdown(),
    };
  }

  // ------------------------------------------------------------------
  // Base probability by signal type
  // ------------------------------------------------------------------
  let rawProbability: number;

  if (signalType === 'MOMENTUM_EXHAUSTION') {
    // Linear mapping: score 0 → 0.35, score 1 → 0.75
    rawProbability = rawExhaustionScore * 0.40 + 0.35;
  } else {
    // PULLBACK: fixed base, then same adjustment formula as MOMENTUM_EXHAUSTION
    rawProbability = 0.60;
  }

  // ------------------------------------------------------------------
  // Compute all 9 adjustments
  // ------------------------------------------------------------------
  const ist = getISTComponents(signalTimeMs);

  const breakdown: Record<string, number> = {
    india_vix: adjustIndiaVix(indiaVix),
    us_vix: adjustUsVix(macro.us_vix?.value ?? null),
    sp500: adjustSP500(macro.sp500?.change_pct ?? null),
    dax: adjustDax(macro.dax?.change_pct ?? null),
    crude_oil: adjustCrudeOil(macro.crude_oil?.change_pct ?? null),
    gold: adjustGold(macro.gold?.change_pct ?? null),
    oi_change: adjustOiChange(oiChangePct),
    time_of_day: adjustTimeOfDay(ist),
    day_of_week: adjustDayOfWeek(ist),
  };

  // ------------------------------------------------------------------
  // Sum adjustments and clamp final probability
  // ------------------------------------------------------------------
  const totalAdjustment = Object.values(breakdown).reduce((sum, v) => sum + v, 0);
  const adjustedProbability = clamp(rawProbability + totalAdjustment, 0.0, 1.0);

  // ------------------------------------------------------------------
  // Confidence tier
  // ------------------------------------------------------------------
  let confidenceTier: 'HIGH' | 'MEDIUM' | 'LOW';
  if (adjustedProbability >= 0.70) {
    confidenceTier = 'HIGH';
  } else if (adjustedProbability >= 0.50) {
    confidenceTier = 'MEDIUM';
  } else {
    confidenceTier = 'LOW';
  }

  return {
    rawProbability,
    adjustedProbability,
    confidenceTier,
    adjustmentBreakdown: breakdown,
  };
}
