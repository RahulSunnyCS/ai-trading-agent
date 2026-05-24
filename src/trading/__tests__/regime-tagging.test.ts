/**
 * Unit tests for the regime tagging engine (src/trading/regime-tagging.ts, T-33).
 *
 * WHAT IS TESTED:
 *   1. HAPPY-PATH LABELS: each of the four core regimes (EVENT_DAY, VOLATILE_REVERTING,
 *      TRENDING_STRONG, RANGING) on representative inputs.
 *   2. LOOK-AHEAD AUDIT: mutating future-day snapshots must not change day D's label.
 *   3. DETERMINISM: same inputs → same label on 100 repeated runs.
 *   4. EVENT_DAY PRECEDENCE: event calendar wins even when straddle data would qualify
 *      for VOLATILE_REVERTING or TRENDING_STRONG.
 *   5. UNCLASSIFIED on degraded input: both (a) backfill-gapped flag and (b) sparse data.
 *   6. UNCLASSIFIED confidence is the data-completeness fraction.
 *   7. Causal cutoff: snapshots after CLASSIFICATION_CUTOFF_IST are excluded.
 *
 * DB STRATEGY:
 *   The pure classifyDay() function is fully DB-free — it accepts plain data.
 *   All tests in this file call classifyDay() directly with synthetic inputs.
 *   No mocked Pool is needed; no Docker is required.
 *
 *   The DB-touching functions (loadSnapshotsForDay, writeRegimeTag, etc.) are
 *   exercised by integration tests in a separate file (not created here —
 *   integration tests require Docker and a live DB).
 */

import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_CUTOFF_IST,
  EXPECTED_SNAPSHOTS_PER_DAY,
  GAP_FRACTION_THRESHOLD,
  TRENDING_CONSISTENCY_THRESHOLD,
  TRENDING_NET_MOVE_THRESHOLD,
  VOLATILE_ACCELERATION_THRESHOLD,
  VOLATILE_SIGN_CHANGE_THRESHOLD,
  type ClassifyDayOptions,
  type IndexSample,
  type SnapshotInput,
  classifyDay,
} from '../regime-tagging.js';
import { FixedClock } from '../../utils/clock.js';

// ---------------------------------------------------------------------------
// Test-clock factory
// ---------------------------------------------------------------------------

/**
 * Create a FixedClock frozen at a specific IST date.
 * 2024-01-25 10:00 IST = 2024-01-25T04:30:00Z (UTC).
 * Using a Thursday (market day) for all tests.
 */
function makeClock(isoUtc = '2024-01-25T04:30:00.000Z'): FixedClock {
  return new FixedClock(isoUtc);
}

// ---------------------------------------------------------------------------
// Snapshot builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a snapshot at a UTC datetime with given roc and roc_acceleration.
 * The utcTime string must include time (e.g. '2024-01-25T06:00:00.000Z').
 */
function snap(utcTime: string, roc: number | null, rocAccel: number | null): SnapshotInput {
  return {
    time: new Date(utcTime),
    roc,
    roc_acceleration: rocAccel,
  };
}

/**
 * Build an index sample at a UTC datetime with a given price.
 */
function idx(utcTime: string, price: number): IndexSample {
  return { time: new Date(utcTime), price };
}

/**
 * Build the minimal ClassifyDayOptions with sensible defaults.
 * Tests override individual fields as needed.
 */
function makeOptions(overrides: Partial<ClassifyDayOptions> = {}): ClassifyDayOptions {
  return {
    tradeDate: '2024-01-25',
    symbol: 'NIFTY',
    snapshots: [],
    indexSamples: [],
    eventCalendarDates: new Set(),
    isBackfillGapped: false,
    clock: makeClock(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// IST time facts used in tests:
//
//   2024-01-25 09:15 IST = 2024-01-25T03:45:00.000Z  (market open)
//   2024-01-25 10:00 IST = 2024-01-25T04:30:00.000Z
//   2024-01-25 12:00 IST = 2024-01-25T06:30:00.000Z
//   2024-01-25 14:00 IST = 2024-01-25T08:30:00.000Z
//   2024-01-25 14:30 IST = 2024-01-25T09:00:00.000Z  (cutoff)
//   2024-01-25 15:00 IST = 2024-01-25T09:30:00.000Z  (after cutoff)
//   2024-01-25 15:30 IST = 2024-01-25T10:00:00.000Z  (market close)
//
//   2024-01-26 10:00 IST = 2024-01-26T04:30:00.000Z  (NEXT DAY — future)
// ---------------------------------------------------------------------------

// UTC times for 2024-01-25 at key IST hours
const T_0915 = '2024-01-25T03:45:00.000Z'; // 09:15 IST — market open
const T_1000 = '2024-01-25T04:30:00.000Z'; // 10:00 IST
const T_1200 = '2024-01-25T06:30:00.000Z'; // 12:00 IST
const T_1400 = '2024-01-25T08:30:00.000Z'; // 14:00 IST
const T_1430 = '2024-01-25T09:00:00.000Z'; // 14:30 IST — exactly at cutoff
const T_1500 = '2024-01-25T09:30:00.000Z'; // 15:00 IST — AFTER cutoff
const T_1530 = '2024-01-25T10:00:00.000Z'; // 15:30 IST — market close (after cutoff)

// UTC time for 2024-01-26 (the NEXT day — used in look-ahead audit)
const T_NEXT_1000 = '2024-01-26T04:30:00.000Z'; // 10:00 IST on the next day

// ---------------------------------------------------------------------------
// Helper: generate N representative "RANGING" snapshots
// (low absolute ROC, low acceleration, alternating ROC direction = noisy)
// ---------------------------------------------------------------------------

/**
 * Generate N snapshots starting at startUtc with 15-second spacing.
 * For RANGING: near-zero ROC, near-zero acceleration.
 */
function makeRangingSnapshots(n: number, startUtc: string): SnapshotInput[] {
  const startMs = new Date(startUtc).getTime();
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(startMs + i * 15_000),
    // Very small ROC alternating sign — low directional signal
    roc: i % 2 === 0 ? 0.01 : -0.01,
    roc_acceleration: 0.005,
  }));
}

/**
 * Generate N snapshots for VOLATILE_REVERTING:
 * high absolute acceleration and high ROC sign-change rate.
 */
function makeVolatileSnapshots(n: number, startUtc: string): SnapshotInput[] {
  const startMs = new Date(startUtc).getTime();
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(startMs + i * 15_000),
    // Alternating large ROC — every step reverses direction
    roc: i % 2 === 0 ? 1.0 : -1.0,
    // High acceleration — rapid changes in ROC
    roc_acceleration: i % 2 === 0 ? VOLATILE_ACCELERATION_THRESHOLD * 2 : -(VOLATILE_ACCELERATION_THRESHOLD * 2),
  }));
}

/**
 * Generate N snapshots for TRENDING_STRONG (downtrend view):
 * consistently negative ROC (straddle expanding = index falling) with
 * low acceleration (smooth trend, not whipsaw).
 *
 * For the trend to be detected, we also need index samples that show a
 * net downward move > TRENDING_NET_MOVE_THRESHOLD.
 */
function makeTrendingSnapshots(n: number, startUtc: string): SnapshotInput[] {
  const startMs = new Date(startUtc).getTime();
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(startMs + i * 15_000),
    // Consistently positive ROC (straddle expanding due to downside move)
    roc: 0.5,
    // Low acceleration — smooth trend, not whipsaw
    roc_acceleration: 0.01,
  }));
}

// ---------------------------------------------------------------------------
// 1. HAPPY-PATH LABELS
// ---------------------------------------------------------------------------

describe('classifyDay — EVENT_DAY', () => {
  it('returns EVENT_DAY with confidence=1.0 when date is in event calendar', () => {
    const result = classifyDay(makeOptions({
      tradeDate: '2024-01-25',
      eventCalendarDates: new Set(['2024-01-25']),
    }));

    expect(result.regime).toBe('EVENT_DAY');
    expect(result.regimeConfidence).toBe(1.0);
    expect(result.diagnostics.isEventDay).toBe(true);
  });

  it('does NOT return EVENT_DAY when date is NOT in event calendar', () => {
    const result = classifyDay(makeOptions({
      tradeDate: '2024-01-25',
      eventCalendarDates: new Set(['2024-01-24']), // different date
    }));

    expect(result.regime).not.toBe('EVENT_DAY');
    expect(result.diagnostics.isEventDay).toBe(false);
  });
});

describe('classifyDay — VOLATILE_REVERTING', () => {
  it('returns VOLATILE_REVERTING when acceleration and sign-change rate exceed thresholds', () => {
    // Generate enough snapshots to pass the sparse-data gate.
    // EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD) is the minimum.
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeVolatileSnapshots(minRequired, T_0915);

    const result = classifyDay(makeOptions({ snapshots: snaps }));

    expect(result.regime).toBe('VOLATILE_REVERTING');
    expect(result.regimeConfidence).toBeGreaterThan(0);
    expect(result.regimeConfidence).toBeLessThanOrEqual(1);
  });

  it('diagnostics.meanAbsAcceleration exceeds threshold for VOLATILE_REVERTING day', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeVolatileSnapshots(minRequired, T_0915);

    const result = classifyDay(makeOptions({ snapshots: snaps }));
    expect(result.diagnostics.meanAbsAcceleration).toBeGreaterThanOrEqual(VOLATILE_ACCELERATION_THRESHOLD);
  });

  it('diagnostics.rocSignChangeFraction exceeds threshold for VOLATILE_REVERTING day', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeVolatileSnapshots(minRequired, T_0915);

    const result = classifyDay(makeOptions({ snapshots: snaps }));
    expect(result.diagnostics.rocSignChangeFraction).toBeGreaterThanOrEqual(VOLATILE_SIGN_CHANGE_THRESHOLD);
  });
});

describe('classifyDay — TRENDING_STRONG', () => {
  it('returns TRENDING_STRONG when net index move and consistency exceed thresholds', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    // Snapshots with consistent positive ROC (straddle expanding = index falling)
    const snaps = makeTrendingSnapshots(minRequired, T_0915);

    // Index samples showing a clear downtrend (net move well above threshold)
    const indexData: IndexSample[] = [
      idx(T_0915, 22000), // open
      idx(T_1200, 21890), // midday — 0.5% down
      idx(T_1400, 21780), // afternoon — 1.0% down total
    ];

    const result = classifyDay(makeOptions({
      snapshots: snaps,
      indexSamples: indexData,
    }));

    expect(result.regime).toBe('TRENDING_STRONG');
    expect(result.regimeConfidence).toBeGreaterThan(0);
  });

  it('diagnostics.netIndexMoveFraction exceeds threshold for TRENDING day', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeTrendingSnapshots(minRequired, T_0915);
    const indexData = [
      idx(T_0915, 22000),
      idx(T_1400, 21780),
    ];

    const result = classifyDay(makeOptions({ snapshots: snaps, indexSamples: indexData }));
    expect(result.diagnostics.netIndexMoveFraction).not.toBeNull();
    expect(Math.abs(result.diagnostics.netIndexMoveFraction!)).toBeGreaterThanOrEqual(TRENDING_NET_MOVE_THRESHOLD);
  });
});

describe('classifyDay — RANGING', () => {
  it('returns RANGING for low-signal days (low ROC, low acceleration, no trend)', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeRangingSnapshots(minRequired, T_0915);

    // Flat index — almost no net move
    const indexData: IndexSample[] = [
      idx(T_0915, 22000),
      idx(T_1400, 22005), // 0.023% move — well below TRENDING_NET_MOVE_THRESHOLD
    ];

    const result = classifyDay(makeOptions({
      snapshots: snaps,
      indexSamples: indexData,
    }));

    expect(result.regime).toBe('RANGING');
    expect(result.regimeConfidence).toBeGreaterThan(0);
  });

  it('returns RANGING even with no index data (null netIndexMoveFraction)', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeRangingSnapshots(minRequired, T_0915);

    const result = classifyDay(makeOptions({ snapshots: snaps, indexSamples: [] }));

    expect(result.regime).toBe('RANGING');
    expect(result.diagnostics.netIndexMoveFraction).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. LOOK-AHEAD AUDIT (Critical)
// ---------------------------------------------------------------------------

describe('LOOK-AHEAD AUDIT', () => {
  /**
   * Test design (mirrors the T-56 look-ahead audit):
   *
   * We classify day D (2024-01-25) twice:
   *   Run 1: canonical snapshots for day D.
   *   Run 2: same day-D snapshots, plus we add snapshots labelled as 2024-01-26
   *          (the NEXT day) with dramatically different values.
   *
   * If the classifier for day D used any data from 2024-01-26, the label
   * would change between Run 1 and Run 2. The test asserts that it does NOT
   * change — proving the causal guarantee holds.
   *
   * HOW the cutoff enforces causality:
   *   The classifier filters snapshots to `dateIST === tradeDate`.
   *   Snapshots timestamped as 2024-01-26 have dateIST = '2024-01-26',
   *   which fails the filter for tradeDate = '2024-01-25'. They are excluded.
   */
  it('day D label is identical when next-day snapshots are added', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const dayDSnapshots = makeRangingSnapshots(minRequired, T_0915);

    // Run 1: only day D data
    const run1 = classifyDay(makeOptions({
      tradeDate: '2024-01-25',
      snapshots: dayDSnapshots,
      indexSamples: [idx(T_0915, 22000), idx(T_1400, 22005)],
    }));

    // Run 2: same day D data PLUS extreme next-day snapshots
    // Next-day snapshots have drastic values that would change the label if consumed.
    const nextDaySnapshots = makeVolatileSnapshots(minRequired, T_NEXT_1000).map((s) => ({
      ...s,
      // Set extreme values — if these were consumed, regime would flip to VOLATILE_REVERTING
      roc: 50.0,
      roc_acceleration: 100.0,
    }));
    const allSnapshots = [...dayDSnapshots, ...nextDaySnapshots];

    const run2 = classifyDay(makeOptions({
      tradeDate: '2024-01-25',
      snapshots: allSnapshots,
      indexSamples: [idx(T_0915, 22000), idx(T_1400, 22005)],
    }));

    // Day D's label must be identical regardless of next-day data presence
    expect(run2.regime).toBe(run1.regime);
    expect(run2.regimeConfidence).toBeCloseTo(run1.regimeConfidence, 4);
    expect(run2.diagnostics.snapshotCount).toBe(run1.diagnostics.snapshotCount);
    expect(run2.diagnostics.meanAbsAcceleration).toBeCloseTo(run1.diagnostics.meanAbsAcceleration, 6);
  });

  it('mutating future-day index samples does not change day D label', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeRangingSnapshots(minRequired, T_0915);

    // Run 1: flat index for day D
    const dayDIndex = [idx(T_0915, 22000), idx(T_1400, 22005)];
    const run1 = classifyDay(makeOptions({ snapshots: snaps, indexSamples: dayDIndex }));

    // Run 2: same day D data + extreme next-day index samples
    const nextDayIndex = [
      idx(T_NEXT_1000, 99999), // extreme price on next day
      idx('2024-01-26T08:30:00.000Z', 1),     // another next-day sample
    ];
    const run2 = classifyDay(makeOptions({
      snapshots: snaps,
      indexSamples: [...dayDIndex, ...nextDayIndex],
    }));

    expect(run2.regime).toBe(run1.regime);
    expect(run2.diagnostics.netIndexMoveFraction).toBeCloseTo(
      run1.diagnostics.netIndexMoveFraction ?? 0, 6,
    );
  });

  it('snapshots after CLASSIFICATION_CUTOFF_IST on day D are excluded from classification', () => {
    // This directly tests the causal cutoff (14:30 IST).
    // We add "after-cutoff" snapshots with extreme values that would change the label
    // if included. The classifier must exclude them.

    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const preCutoffSnaps = makeRangingSnapshots(minRequired, T_0915);

    // Snapshots at 15:00 IST (after 14:30 cutoff) — extreme values
    const postCutoffSnaps: SnapshotInput[] = [
      snap(T_1500, 50.0, 100.0), // 15:00 IST
      snap(T_1530, -50.0, -100.0), // 15:30 IST
    ];

    // Run 1: pre-cutoff only
    const run1 = classifyDay(makeOptions({ snapshots: preCutoffSnaps }));

    // Run 2: pre-cutoff + post-cutoff (extreme values that would change label)
    const run2 = classifyDay(makeOptions({
      snapshots: [...preCutoffSnaps, ...postCutoffSnaps],
    }));

    // Labels must match — post-cutoff snaps were excluded
    expect(run2.regime).toBe(run1.regime);
    expect(run2.diagnostics.snapshotCount).toBe(run1.diagnostics.snapshotCount);
  });

  it('snapshot AT exactly the cutoff time (14:30 IST) IS included', () => {
    // A snapshot at exactly 14:30:00 IST (= T_1430) must be included.
    // The filter is `timeIST <= cutoffHHMM`, so '14:30' <= '14:30' is true.
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeRangingSnapshots(minRequired, T_0915);
    const cutoffSnap = snap(T_1430, 0.02, 0.005); // at exactly 14:30 IST
    const all = [...snaps, cutoffSnap];

    const withCutoff = classifyDay(makeOptions({ snapshots: all }));
    const withoutCutoff = classifyDay(makeOptions({ snapshots: snaps }));

    // The cutoff snapshot adds 1 to the count
    expect(withCutoff.diagnostics.snapshotCount).toBe(withoutCutoff.diagnostics.snapshotCount + 1);
  });
});

// ---------------------------------------------------------------------------
// 3. DETERMINISM — 100x repeat-run-identical gate
// ---------------------------------------------------------------------------

describe('DETERMINISM', () => {
  it('classifyDay returns identical results on 100 repeated calls with the same inputs', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeVolatileSnapshots(minRequired, T_0915);
    const opts = makeOptions({ snapshots: snaps });

    // First run: establish the expected result
    const first = classifyDay(opts);

    // Repeat 99 more times — all must be byte-identical to the first
    for (let i = 1; i < 100; i++) {
      const repeat = classifyDay(opts);
      expect(repeat.regime).toBe(first.regime);
      expect(repeat.regimeConfidence).toBe(first.regimeConfidence);
      expect(repeat.diagnostics.meanAbsAcceleration).toBe(first.diagnostics.meanAbsAcceleration);
      expect(repeat.diagnostics.rocSignChangeFraction).toBe(first.diagnostics.rocSignChangeFraction);
      expect(repeat.diagnostics.snapshotCount).toBe(first.diagnostics.snapshotCount);
    }
  });

  it('RANGING day produces identical results on 100 repeated calls', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeRangingSnapshots(minRequired, T_0915);
    const opts = makeOptions({ snapshots: snaps, indexSamples: [idx(T_0915, 22000), idx(T_1400, 22005)] });

    const first = classifyDay(opts);
    for (let i = 1; i < 100; i++) {
      const repeat = classifyDay(opts);
      expect(repeat.regime).toBe(first.regime);
      expect(repeat.regimeConfidence).toBe(first.regimeConfidence);
    }
  });

  it('EVENT_DAY produces identical results on 100 repeated calls', () => {
    const opts = makeOptions({ eventCalendarDates: new Set(['2024-01-25']) });
    const first = classifyDay(opts);
    for (let i = 1; i < 100; i++) {
      expect(classifyDay(opts)).toStrictEqual(first);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. EVENT_DAY PRECEDENCE (wins over all other regimes)
// ---------------------------------------------------------------------------

describe('EVENT_DAY PRECEDENCE', () => {
  it('EVENT_DAY wins over VOLATILE_REVERTING when date is in calendar', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const volatileSnaps = makeVolatileSnapshots(minRequired, T_0915);

    // Without event calendar: should be VOLATILE_REVERTING
    const withoutEvent = classifyDay(makeOptions({ snapshots: volatileSnaps }));
    expect(withoutEvent.regime).toBe('VOLATILE_REVERTING');

    // With event calendar: must be EVENT_DAY
    const withEvent = classifyDay(makeOptions({
      snapshots: volatileSnaps,
      eventCalendarDates: new Set(['2024-01-25']),
    }));
    expect(withEvent.regime).toBe('EVENT_DAY');
    expect(withEvent.regimeConfidence).toBe(1.0);
  });

  it('EVENT_DAY wins over TRENDING_STRONG when date is in calendar', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const trendingSnaps = makeTrendingSnapshots(minRequired, T_0915);
    const indexData = [idx(T_0915, 22000), idx(T_1400, 21780)];

    // Without event calendar: should be TRENDING_STRONG
    const withoutEvent = classifyDay(makeOptions({ snapshots: trendingSnaps, indexSamples: indexData }));
    expect(withoutEvent.regime).toBe('TRENDING_STRONG');

    // With event calendar: must be EVENT_DAY
    const withEvent = classifyDay(makeOptions({
      snapshots: trendingSnaps,
      indexSamples: indexData,
      eventCalendarDates: new Set(['2024-01-25']),
    }));
    expect(withEvent.regime).toBe('EVENT_DAY');
  });

  it('EVENT_DAY wins over RANGING when date is in calendar', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const rangingSnaps = makeRangingSnapshots(minRequired, T_0915);

    const withEvent = classifyDay(makeOptions({
      snapshots: rangingSnaps,
      eventCalendarDates: new Set(['2024-01-25']),
    }));
    expect(withEvent.regime).toBe('EVENT_DAY');
  });

  it('EVENT_DAY confidence is always exactly 1.0', () => {
    // Verify this holds regardless of snapshot state
    const noCoverage = classifyDay(makeOptions({
      snapshots: [],
      eventCalendarDates: new Set(['2024-01-25']),
    }));
    expect(noCoverage.regimeConfidence).toBe(1.0);

    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const withSnaps = classifyDay(makeOptions({
      snapshots: makeVolatileSnapshots(minRequired, T_0915),
      eventCalendarDates: new Set(['2024-01-25']),
    }));
    expect(withSnaps.regimeConfidence).toBe(1.0);
  });

  it('VOLATILE_REVERTING wins over TRENDING_STRONG (precedence below EVENT_DAY)', () => {
    // Both VOLATILE and TRENDING thresholds are exceeded simultaneously.
    // VOLATILE_REVERTING must win because it has higher precedence.
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    // Snapshots that pass VOLATILE threshold: alternating large ROC, high acceleration
    const mixedSnaps: SnapshotInput[] = Array.from({ length: minRequired }, (_, i) => ({
      time: new Date(new Date(T_0915).getTime() + i * 15_000),
      // Alternating ROC (satisfies VOLATILE sign-change + acceleration)
      roc: i % 2 === 0 ? 1.0 : -1.0,
      roc_acceleration: i % 2 === 0 ? VOLATILE_ACCELERATION_THRESHOLD * 3 : -(VOLATILE_ACCELERATION_THRESHOLD * 3),
    }));

    // Index data showing a clear trend to also trigger TRENDING_STRONG
    const indexData = [idx(T_0915, 22000), idx(T_1400, 21780)];

    const result = classifyDay(makeOptions({
      snapshots: mixedSnaps,
      indexSamples: indexData,
    }));

    // VOLATILE_REVERTING must win
    expect(result.regime).toBe('VOLATILE_REVERTING');
  });
});

// ---------------------------------------------------------------------------
// 5. UNCLASSIFIED on degraded input
// ---------------------------------------------------------------------------

describe('UNCLASSIFIED — degraded input', () => {
  it('returns UNCLASSIFIED when isBackfillGapped=true regardless of data quality', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    // Even with full, high-quality data — gapped flag forces UNCLASSIFIED
    const goodSnaps = makeVolatileSnapshots(minRequired, T_0915);

    const result = classifyDay(makeOptions({
      snapshots: goodSnaps,
      isBackfillGapped: true,
    }));

    expect(result.regime).toBe('UNCLASSIFIED');
    expect(result.diagnostics.isBackfillGapped).toBe(true);
  });

  it('returns UNCLASSIFIED when snapshot count is below minimum (sparse data gate)', () => {
    // Need fewer than (1 - GAP_FRACTION_THRESHOLD) * EXPECTED_SNAPSHOTS_PER_DAY
    const insufficientCount = Math.floor(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD)) - 1;
    const sparseSnaps = makeRangingSnapshots(insufficientCount, T_0915);

    const result = classifyDay(makeOptions({ snapshots: sparseSnaps }));

    expect(result.regime).toBe('UNCLASSIFIED');
    expect(result.diagnostics.dataCompleteness).toBeLessThan(1 - GAP_FRACTION_THRESHOLD);
  });

  it('returns UNCLASSIFIED with zero snapshots', () => {
    const result = classifyDay(makeOptions({ snapshots: [] }));
    expect(result.regime).toBe('UNCLASSIFIED');
    expect(result.regimeConfidence).toBe(0);
    expect(result.diagnostics.dataCompleteness).toBe(0);
  });

  it('UNCLASSIFIED regimeConfidence equals the data-completeness fraction', () => {
    // Half the required snapshots
    const halfRequired = Math.floor(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD) / 2);
    const sparseSnaps = makeRangingSnapshots(halfRequired, T_0915);

    const result = classifyDay(makeOptions({ snapshots: sparseSnaps }));

    expect(result.regime).toBe('UNCLASSIFIED');
    // regimeConfidence should equal dataCompleteness
    expect(result.regimeConfidence).toBeCloseTo(result.diagnostics.dataCompleteness, 6);
    // dataCompleteness = halfRequired / EXPECTED_SNAPSHOTS_PER_DAY
    const expectedCompleteness = Math.min(1.0, halfRequired / EXPECTED_SNAPSHOTS_PER_DAY);
    expect(result.regimeConfidence).toBeCloseTo(expectedCompleteness, 6);
  });

  it('isBackfillGapped=true with EVENT_DAY: EVENT_DAY still wins (calendar lookup is pre-gap-check)', () => {
    // EVENT_DAY is checked FIRST in the precedence chain, before the UNCLASSIFIED gate.
    // A gapped event day should still be EVENT_DAY.
    const result = classifyDay(makeOptions({
      snapshots: [],
      eventCalendarDates: new Set(['2024-01-25']),
      isBackfillGapped: true,
    }));

    expect(result.regime).toBe('EVENT_DAY');
    expect(result.regimeConfidence).toBe(1.0);
  });

  it('exactly at the minimum threshold: day with exactly the minimum snapshots is NOT UNCLASSIFIED', () => {
    // The minimum is (1 - GAP_FRACTION_THRESHOLD) * EXPECTED_SNAPSHOTS_PER_DAY.
    // A day with exactly this count should pass the gate and be classifiable.
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeRangingSnapshots(minRequired, T_0915);

    const result = classifyDay(makeOptions({ snapshots: snaps }));

    // Should NOT be UNCLASSIFIED — exactly at threshold passes
    expect(result.regime).not.toBe('UNCLASSIFIED');
  });
});

// ---------------------------------------------------------------------------
// 6. Threshold constants are exported and have expected values
// ---------------------------------------------------------------------------

describe('Threshold constants', () => {
  it('CLASSIFICATION_CUTOFF_IST is "14:30"', () => {
    expect(CLASSIFICATION_CUTOFF_IST).toBe('14:30');
  });

  it('GAP_FRACTION_THRESHOLD is 0.5 (50%)', () => {
    expect(GAP_FRACTION_THRESHOLD).toBe(0.5);
  });

  it('TRENDING_NET_MOVE_THRESHOLD is 0.6% (0.006)', () => {
    expect(TRENDING_NET_MOVE_THRESHOLD).toBe(0.006);
  });

  it('VOLATILE_ACCELERATION_THRESHOLD is 0.15', () => {
    expect(VOLATILE_ACCELERATION_THRESHOLD).toBe(0.15);
  });

  it('EXPECTED_SNAPSHOTS_PER_DAY matches the documented 15-second cadence over 5h15m', () => {
    // 09:15 to 14:30 = 5h15m = 315min = 18 900 seconds / 15 = 1 260
    expect(EXPECTED_SNAPSHOTS_PER_DAY).toBe(1_260);
  });
});

// ---------------------------------------------------------------------------
// 7. Edge cases and boundary conditions
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('classifies correctly when all ROC values are null (first snapshots only)', () => {
    // All snapshots have null ROC (e.g. only 1-2 snapshots in the day after cutoff).
    // With enough snapshots for the gate but all-null ROC, it should still classify.
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const nullRocSnaps: SnapshotInput[] = Array.from({ length: minRequired }, (_, i) => ({
      time: new Date(new Date(T_0915).getTime() + i * 15_000),
      roc: null,
      roc_acceleration: null,
    }));

    const result = classifyDay(makeOptions({ snapshots: nullRocSnaps }));
    // With all-null ROC and no index data → defaults to RANGING (lowest-signal label)
    expect(result.regime).toBe('RANGING');
    expect(result.diagnostics.meanAbsAcceleration).toBe(0);
    expect(result.diagnostics.rocSignChangeFraction).toBe(0);
  });

  it('handles a single index sample gracefully (no net move computable)', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));
    const snaps = makeRangingSnapshots(minRequired, T_0915);
    const oneIndexSample = [idx(T_0915, 22000)]; // only 1 sample — can't compute net move

    const result = classifyDay(makeOptions({ snapshots: snaps, indexSamples: oneIndexSample }));
    // With only 1 index sample, netIndexMoveFraction must be null
    expect(result.diagnostics.netIndexMoveFraction).toBeNull();
    // Defaults to RANGING since trend cannot be detected
    expect(result.regime).toBe('RANGING');
  });

  it('regimeConfidence is always clamped to [0, 1]', () => {
    // Use extreme values to test the clamping
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));

    const test1 = classifyDay(makeOptions({ snapshots: makeVolatileSnapshots(minRequired, T_0915) }));
    expect(test1.regimeConfidence).toBeGreaterThanOrEqual(0);
    expect(test1.regimeConfidence).toBeLessThanOrEqual(1);

    const test2 = classifyDay(makeOptions({ snapshots: makeRangingSnapshots(minRequired, T_0915) }));
    expect(test2.regimeConfidence).toBeGreaterThanOrEqual(0);
    expect(test2.regimeConfidence).toBeLessThanOrEqual(1);
  });

  it('returns correct tradeDate and symbol in result', () => {
    const result = classifyDay(makeOptions({
      tradeDate: '2024-03-15',
      symbol: 'BANKNIFTY',
    }));
    expect(result.tradeDate).toBe('2024-03-15');
    expect(result.symbol).toBe('BANKNIFTY');
  });

  it('UNCLASSIFIED day has diagnostics.isBackfillGapped set correctly', () => {
    const gappedResult = classifyDay(makeOptions({
      snapshots: [],
      isBackfillGapped: true,
    }));
    expect(gappedResult.diagnostics.isBackfillGapped).toBe(true);

    const sparseResult = classifyDay(makeOptions({
      snapshots: [],
      isBackfillGapped: false,
    }));
    expect(sparseResult.diagnostics.isBackfillGapped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Verify TRENDING_CONSISTENCY_THRESHOLD usage in labelling
// ---------------------------------------------------------------------------

describe('TRENDING_STRONG threshold boundary conditions', () => {
  it('does NOT classify as TRENDING if net move is above threshold but consistency is below', () => {
    const minRequired = Math.ceil(EXPECTED_SNAPSHOTS_PER_DAY * (1 - GAP_FRACTION_THRESHOLD));

    // Index shows a net move above threshold (0.8%)
    const indexData = [idx(T_0915, 22000), idx(T_1400, 21824)]; // ~0.8% down

    // But snapshots show mixed ROC direction (inconsistent trend)
    const inconsistentSnaps: SnapshotInput[] = Array.from({ length: minRequired }, (_, i) => ({
      time: new Date(new Date(T_0915).getTime() + i * 15_000),
      // 25% positive, 75% negative — not consistent enough (below TRENDING_CONSISTENCY_THRESHOLD)
      // For downtrend, expected straddle ROC sign = +1 (expansion).
      // If only 25% match → trendConsistencyFraction = 0.25 < 0.55
      roc: i % 4 === 0 ? 0.5 : -0.5,
      roc_acceleration: 0.01,
    }));

    const result = classifyDay(makeOptions({
      snapshots: inconsistentSnaps,
      indexSamples: indexData,
    }));

    // Consistency is 25% — below TRENDING_CONSISTENCY_THRESHOLD (0.55)
    // Should NOT be TRENDING_STRONG. But might be RANGING (low accel, low sign-change).
    // (Note: high sign-change rate could make it VOLATILE, but accel is low here)
    expect(result.regime).not.toBe('TRENDING_STRONG');
    expect(result.diagnostics.trendConsistencyFraction).toBeLessThan(TRENDING_CONSISTENCY_THRESHOLD);
  });
});
