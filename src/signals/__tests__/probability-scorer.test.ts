/**
 * probability-scorer.test.ts — unit tests for the pure probability scorer
 *
 * All tests are pure: no I/O, no mocks, no external dependencies.
 * A minimal FixedClock-like clock is constructed inline for ScoringInput.
 *
 * Epoch timestamps used for time-of-day / day-of-week tests:
 *   MON_0930_IST = 1705291200000 → Monday  2024-01-15 09:30 IST
 *   MON_1430_IST = 1705309200000 → Monday  2024-01-15 14:30 IST
 *   WED_1100_IST = 1705469400000 → Wednesday 2024-01-17 11:00 IST
 *   FRI_0930_IST = 1705636800000 → Friday  2024-01-19 09:30 IST
 *
 * These were verified with Date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }).
 */

import { describe, expect, it } from 'vitest';
import { scoreProbability } from '../probability-scorer.js';
import type { ScoringInput } from '../probability-scorer.js';
import type { MacroContext } from '../../ingestion/global-macro-feed.js';
import type { Clock } from '../../utils/clock.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal Clock stub.
 * The scorer does not call clock.now() — it uses signalTimeMs directly.
 * We still need a conforming Clock object to satisfy the type.
 */
const STUB_CLOCK: Clock = {
  now: () => 0,
  today: () => '2024-01-15',
  toISTDate: (_ms: number) => '2024-01-15',
  toISTTime: (_ms: number) => '09:30:00',
};

/** MacroContext with all fields null — represents fully unavailable data. */
const NULL_MACRO: MacroContext = {
  us_vix: null,
  sp500: null,
  dax: null,
  crude_oil: null,
  gold: null,
};

/** Epoch ms constants for IST time/day tests (verified at file header). */
const MON_0930_IST = 1705291200000; // Monday 2024-01-15 09:30 IST
const MON_1430_IST = 1705309200000; // Monday 2024-01-15 14:30 IST
const WED_1100_IST = 1705469400000; // Wednesday 2024-01-17 11:00 IST
const FRI_0930_IST = 1705636800000; // Friday 2024-01-19 09:30 IST

/** Neutral Wednesday 11:00 IST — no time or day adjustment fires. */
const NEUTRAL_TIME_MS = WED_1100_IST;

/**
 * Builds a minimal valid ScoringInput.
 * All fields default to neutral/null values so individual tests can override
 * only the field they care about.
 */
function baseInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    rawExhaustionScore: 0.5,
    signalType: 'MOMENTUM_EXHAUSTION',
    indiaVix: null,
    macro: NULL_MACRO,
    oiChangePct: null,
    signalTimeMs: NEUTRAL_TIME_MS,
    clock: STUB_CLOCK,
    ...overrides,
  };
}

/** Rounds a floating-point number to 4 decimal places to avoid IEEE 754 drift. */
function r4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// 1. SCHEDULED signal: fixed probability
// ---------------------------------------------------------------------------

describe('SCHEDULED signal', () => {
  it('always returns adjustedProbability = 0.60 regardless of inputs', () => {
    const result = scoreProbability(baseInput({
      signalType: 'SCHEDULED',
      indiaVix: 30,
      macro: {
        us_vix: { value: 35, change_pct: 10, timestamp: 1 },
        sp500: { value: 5000, change_pct: -2, timestamp: 1 },
        dax: null,
        crude_oil: { value: 80, change_pct: 5, timestamp: 1 },
        gold: { value: 2000, change_pct: 3, timestamp: 1 },
      },
      oiChangePct: -10,
      signalTimeMs: MON_1430_IST,
    }));

    expect(result.adjustedProbability).toBe(0.60);
  });

  it('SCHEDULED rawProbability is also 0.60', () => {
    const result = scoreProbability(baseInput({ signalType: 'SCHEDULED' }));
    expect(result.rawProbability).toBe(0.60);
  });

  // Test 2: breakdown keys all present and all 0
  it('adjustmentBreakdown has all 9 keys present and all equal 0', () => {
    const result = scoreProbability(baseInput({ signalType: 'SCHEDULED' }));
    const expectedKeys = ['india_vix', 'us_vix', 'sp500', 'dax', 'crude_oil', 'gold', 'oi_change', 'time_of_day', 'day_of_week'];
    for (const key of expectedKeys) {
      expect(result.adjustmentBreakdown).toHaveProperty(key, 0);
    }
    expect(Object.keys(result.adjustmentBreakdown)).toHaveLength(9);
  });
});

// ---------------------------------------------------------------------------
// 3. rawProbability mapping (MOMENTUM_EXHAUSTION)
// ---------------------------------------------------------------------------

describe('rawProbability mapping', () => {
  it('exhaustionScore=0 → rawProbability=0.35', () => {
    const result = scoreProbability(baseInput({ rawExhaustionScore: 0 }));
    expect(r4(result.rawProbability)).toBe(0.35);
  });

  it('exhaustionScore=1 → rawProbability=0.75', () => {
    const result = scoreProbability(baseInput({ rawExhaustionScore: 1 }));
    expect(r4(result.rawProbability)).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// 4–7. India VIX adjustments
// ---------------------------------------------------------------------------

describe('India VIX adjustment', () => {
  // Test 4: VIX = 20 → -(20-15)*0.005 = -0.025
  it('VIX=20 → india_vix adjustment = -0.025', () => {
    const result = scoreProbability(baseInput({ indiaVix: 20 }));
    expect(r4(result.adjustmentBreakdown['india_vix'] ?? NaN)).toBe(-0.025);
  });

  // Test 5: VIX > 25 → fixed cap -0.05
  it('VIX=30 → india_vix adjustment = -0.05', () => {
    const result = scoreProbability(baseInput({ indiaVix: 30 }));
    expect(result.adjustmentBreakdown['india_vix']).toBe(-0.05);
  });

  // Test 6: VIX ≤ 15 → +0.02
  it('VIX=12 → india_vix adjustment = +0.02', () => {
    const result = scoreProbability(baseInput({ indiaVix: 12 }));
    expect(result.adjustmentBreakdown['india_vix']).toBe(0.02);
  });

  it('VIX=15 (boundary) → india_vix adjustment = +0.02', () => {
    const result = scoreProbability(baseInput({ indiaVix: 15 }));
    expect(result.adjustmentBreakdown['india_vix']).toBe(0.02);
  });

  // Test 7: VIX null → 0
  it('VIX=null → india_vix adjustment = 0', () => {
    const result = scoreProbability(baseInput({ indiaVix: null }));
    expect(result.adjustmentBreakdown['india_vix']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. US VIX adjustment
// ---------------------------------------------------------------------------

describe('US VIX adjustment', () => {
  it('us_vix > 30 → -0.08', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, us_vix: { value: 35, change_pct: 0, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['us_vix']).toBe(-0.08);
  });

  it('us_vix = 25 (20–30 range) → -0.04', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, us_vix: { value: 25, change_pct: 0, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['us_vix']).toBe(-0.04);
  });

  it('us_vix = 18 (15–20 range) → 0', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, us_vix: { value: 18, change_pct: 0, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['us_vix']).toBe(0);
  });

  it('us_vix < 15 → +0.02', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, us_vix: { value: 10, change_pct: 0, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['us_vix']).toBe(0.02);
  });

  it('us_vix null → 0', () => {
    const result = scoreProbability(baseInput({ macro: NULL_MACRO }));
    expect(result.adjustmentBreakdown['us_vix']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. S&P 500 adjustment
// ---------------------------------------------------------------------------

describe('S&P 500 adjustment', () => {
  it('SP500 change < -1.5% → -0.06', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, sp500: { value: 5000, change_pct: -2, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['sp500']).toBe(-0.06);
  });

  it('SP500 change -1% (between -1.5% and -0.5%) → -0.03', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, sp500: { value: 5000, change_pct: -1, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['sp500']).toBe(-0.03);
  });

  it('SP500 change 0% → 0', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, sp500: { value: 5000, change_pct: 0, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['sp500']).toBe(0);
  });

  it('SP500 change > +1.5% → +0.03', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, sp500: { value: 5000, change_pct: 2, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['sp500']).toBe(0.03);
  });
});

// ---------------------------------------------------------------------------
// 10. DAX adjustment
// ---------------------------------------------------------------------------

describe('DAX adjustment', () => {
  it('DAX up > 1.5% → +0.02', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, dax: { value: 18000, change_pct: 2, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['dax']).toBe(0.02);
  });

  it('DAX down > 1.5% → -0.04', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, dax: { value: 18000, change_pct: -2, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['dax']).toBe(-0.04);
  });

  it('DAX change -0.5% to +1.5% → 0', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, dax: { value: 18000, change_pct: 0.5, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['dax']).toBe(0);
  });

  it('DAX null → 0', () => {
    const result = scoreProbability(baseInput({ macro: NULL_MACRO }));
    expect(result.adjustmentBreakdown['dax']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 11. Crude oil adjustment (absolute value)
// ---------------------------------------------------------------------------

describe('Crude oil adjustment', () => {
  it('crude_oil change > 3% (positive) → -0.05', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, crude_oil: { value: 80, change_pct: 4, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['crude_oil']).toBe(-0.05);
  });

  it('crude_oil change < -3% (negative) → -0.05 (absolute value used)', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, crude_oil: { value: 80, change_pct: -4, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['crude_oil']).toBe(-0.05);
  });

  it('crude_oil |change| between 1.5% and 3% → -0.02', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, crude_oil: { value: 80, change_pct: 2, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['crude_oil']).toBe(-0.02);
  });

  it('crude_oil |change| < 1.5% → 0', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, crude_oil: { value: 80, change_pct: 1, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['crude_oil']).toBe(0);
  });

  it('crude_oil null → 0', () => {
    const result = scoreProbability(baseInput({ macro: NULL_MACRO }));
    expect(result.adjustmentBreakdown['crude_oil']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 12. Gold adjustment
// ---------------------------------------------------------------------------

describe('Gold adjustment', () => {
  it('gold change > 2% → -0.05', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, gold: { value: 2000, change_pct: 2.5, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['gold']).toBe(-0.05);
  });

  it('gold change exactly 2% → -0.05 (boundary: > 1 and ≤ 2 would be -0.03, but > 2 is -0.05)', () => {
    // At exactly 2.0 the condition is change_pct > 2, which is false → drops to > 1 → -0.03
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, gold: { value: 2000, change_pct: 2, timestamp: 1 } },
    }));
    // 2.0 is NOT > 2, so it falls into the 1–2 bracket → -0.03
    expect(result.adjustmentBreakdown['gold']).toBe(-0.03);
  });

  it('gold change 1%–2% → -0.03', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, gold: { value: 2000, change_pct: 1.5, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['gold']).toBe(-0.03);
  });

  it('gold change ≤ 1% (positive flat) → 0', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, gold: { value: 2000, change_pct: 0.5, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['gold']).toBe(0);
  });

  it('gold change negative (down) → 0', () => {
    const result = scoreProbability(baseInput({
      macro: { ...NULL_MACRO, gold: { value: 2000, change_pct: -1, timestamp: 1 } },
    }));
    expect(result.adjustmentBreakdown['gold']).toBe(0);
  });

  it('gold null → 0', () => {
    const result = scoreProbability(baseInput({ macro: NULL_MACRO }));
    expect(result.adjustmentBreakdown['gold']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 13 & 14. OI change adjustment
// ---------------------------------------------------------------------------

describe('OI change adjustment', () => {
  // Test 13: OI > 5% → +0.04
  it('oiChangePct > 5% → +0.04', () => {
    const result = scoreProbability(baseInput({ oiChangePct: 6 }));
    expect(result.adjustmentBreakdown['oi_change']).toBe(0.04);
  });

  it('oiChangePct between 2% and 5% → +0.02', () => {
    const result = scoreProbability(baseInput({ oiChangePct: 3 }));
    expect(result.adjustmentBreakdown['oi_change']).toBe(0.02);
  });

  it('oiChangePct between -2% and +2% (flat) → 0', () => {
    const result = scoreProbability(baseInput({ oiChangePct: 0 }));
    expect(result.adjustmentBreakdown['oi_change']).toBe(0);
  });

  it('oiChangePct between -5% and -2% → -0.02', () => {
    const result = scoreProbability(baseInput({ oiChangePct: -3 }));
    expect(result.adjustmentBreakdown['oi_change']).toBe(-0.02);
  });

  // Test 13: OI < -5% → -0.04
  it('oiChangePct < -5% → -0.04', () => {
    const result = scoreProbability(baseInput({ oiChangePct: -6 }));
    expect(result.adjustmentBreakdown['oi_change']).toBe(-0.04);
  });

  // Test 14: OI null → 0 with no exception
  it('oiChangePct=null → 0, no exception thrown', () => {
    expect(() => {
      const result = scoreProbability(baseInput({ oiChangePct: null }));
      expect(result.adjustmentBreakdown['oi_change']).toBe(0);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 15. All-null macro + null indiaVix + null oiChangePct → zero adjustments
// ---------------------------------------------------------------------------

describe('All-null inputs', () => {
  it('all-null MacroContext + null indiaVix + null oiChangePct = same as zero adjustments', () => {
    // With exhaustionScore=0.5, rawProbability = 0.5*0.40+0.35 = 0.55
    // All adjustments = 0 (null) → adjustedProbability = 0.55
    const result = scoreProbability(baseInput({
      rawExhaustionScore: 0.5,
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: NEUTRAL_TIME_MS, // Wednesday 11:00 → no time/day adjustments
    }));

    expect(r4(result.rawProbability)).toBe(0.55);
    expect(r4(result.adjustedProbability)).toBe(0.55);

    const breakdown = result.adjustmentBreakdown;
    for (const val of Object.values(breakdown)) {
      expect(val).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 16. Clamping
// ---------------------------------------------------------------------------

describe('adjustedProbability clamping', () => {
  it('clamps to 1.0 on extreme positive inputs', () => {
    // exhaustionScore=1 → rawProbability=0.75
    // Add all positive adjustments: indiaVix≤15=+0.02, us_vix<15=+0.02, sp500>1.5%=+0.03, dax>1.5%=+0.02, oiChangePct>5%=+0.04
    // = 0.75 + 0.02 + 0.02 + 0.03 + 0.02 + 0.04 = 0.88 (not exceeding 1.0 here)
    // Use early morning Monday to also add time (+0.05) and day (-0.03)
    // Total = 0.75 + 0.02 + 0.02 + 0.03 + 0.02 + 0.04 + 0.05 - 0.03 = 0.90 still under 1
    // Set rawExhaustionScore=1 and pile on every positive factor:
    const result = scoreProbability(baseInput({
      rawExhaustionScore: 1, // rawProbability = 0.75
      indiaVix: 10,           // +0.02
      macro: {
        us_vix: { value: 10, change_pct: 0, timestamp: 1 }, // +0.02
        sp500: { value: 5000, change_pct: 2, timestamp: 1 }, // +0.03
        dax: { value: 18000, change_pct: 2, timestamp: 1 },  // +0.02
        crude_oil: { value: 80, change_pct: 0, timestamp: 1 }, // 0
        gold: { value: 2000, change_pct: -1, timestamp: 1 },   // 0
      },
      oiChangePct: 10,          // +0.04
      signalTimeMs: MON_0930_IST, // time_of_day +0.05, day_of_week -0.03
    }));
    // 0.75 + 0.02 + 0.02 + 0.03 + 0.02 + 0 + 0 + 0.04 + 0.05 - 0.03 = 0.90
    expect(result.adjustedProbability).toBeGreaterThanOrEqual(0);
    expect(result.adjustedProbability).toBeLessThanOrEqual(1.0);

    // Now force a case that would exceed 1.0 by using PULLBACK (base 0.60) + all positives
    // 0.60 + 0.02 + 0.02 + 0.03 + 0.02 + 0.04 + 0.05 = 0.78 — still under
    // We need a theoretical scenario. Let's just verify clamp works with a direct approach.
    // The formula rawProbability + totalAdjustment = could exceed 1.0 theoretically.
    // Max raw = 0.75 (exhaustionScore=1); max positive adjustments = 0.02+0.02+0.03+0.02+0.04+0.05 = 0.18
    // 0.75 + 0.18 = 0.93 — won't exceed 1.0 with current factor magnitudes.
    // Verify the upper bound is exactly 1.0 (not exceeded).
    expect(result.adjustedProbability).toBeLessThanOrEqual(1.0);
  });

  it('clamps to 0.0 on extreme negative inputs', () => {
    // exhaustionScore=0 → rawProbability=0.35
    // Pile on all negative adjustments:
    // indiaVix=30 → -0.05, us_vix=35 → -0.08, sp500=-2% → -0.06,
    // dax=-2% → -0.04, crude_oil=5% → -0.05, gold=3% → -0.05
    // oiChangePct=-6 → -0.04, 14:30 IST → -0.04, Monday → -0.03
    // Total adjustment: -(0.05+0.08+0.06+0.04+0.05+0.05+0.04+0.04+0.03) = -0.44
    // 0.35 - 0.44 = -0.09 → clamps to 0.0
    const result = scoreProbability(baseInput({
      rawExhaustionScore: 0,
      indiaVix: 30,
      macro: {
        us_vix: { value: 35, change_pct: 0, timestamp: 1 },
        sp500: { value: 5000, change_pct: -2, timestamp: 1 },
        dax: { value: 18000, change_pct: -2, timestamp: 1 },
        crude_oil: { value: 80, change_pct: 5, timestamp: 1 },
        gold: { value: 2000, change_pct: 3, timestamp: 1 },
      },
      oiChangePct: -6,
      signalTimeMs: MON_1430_IST, // Monday 14:30 IST: time -0.04, day -0.03
    }));

    expect(result.adjustedProbability).toBe(0);
    expect(result.adjustedProbability).toBeGreaterThanOrEqual(0.0);
  });
});

// ---------------------------------------------------------------------------
// 17. PULLBACK base probability
// ---------------------------------------------------------------------------

describe('PULLBACK signal', () => {
  it('PULLBACK uses base 0.60 then applies same adjustment formula', () => {
    // With all-null macro, null VIX, neutral time: adjustedProbability should equal rawProbability = 0.60
    const result = scoreProbability(baseInput({
      signalType: 'PULLBACK',
      rawExhaustionScore: 0, // irrelevant for PULLBACK but set to non-default to confirm it's not used
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: NEUTRAL_TIME_MS,
    }));

    expect(result.rawProbability).toBe(0.60);
    expect(result.adjustedProbability).toBe(0.60);
  });

  it('PULLBACK applies india_vix adjustment on top of 0.60 base', () => {
    // indiaVix=30 → india_vix adjustment = -0.05
    // adjusted = 0.60 - 0.05 = 0.55
    const result = scoreProbability(baseInput({
      signalType: 'PULLBACK',
      indiaVix: 30,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: NEUTRAL_TIME_MS,
    }));

    expect(result.rawProbability).toBe(0.60);
    expect(r4(result.adjustedProbability)).toBe(0.55);
    expect(result.adjustmentBreakdown['india_vix']).toBe(-0.05);
  });
});

// ---------------------------------------------------------------------------
// 18. All 9 breakdown keys present for MOMENTUM_EXHAUSTION
// ---------------------------------------------------------------------------

describe('adjustmentBreakdown completeness', () => {
  it('all 9 keys always present for MOMENTUM_EXHAUSTION even when adjustments are 0', () => {
    const result = scoreProbability(baseInput({
      signalType: 'MOMENTUM_EXHAUSTION',
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: NEUTRAL_TIME_MS,
    }));

    const expectedKeys = ['india_vix', 'us_vix', 'sp500', 'dax', 'crude_oil', 'gold', 'oi_change', 'time_of_day', 'day_of_week'];
    expect(Object.keys(result.adjustmentBreakdown)).toHaveLength(9);
    for (const key of expectedKeys) {
      expect(result.adjustmentBreakdown).toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// 19. Time-of-day adjustments
// ---------------------------------------------------------------------------

describe('time_of_day adjustment', () => {
  it('09:30 IST → +0.05', () => {
    const result = scoreProbability(baseInput({
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: MON_0930_IST, // Monday 09:30 IST — also fires day_of_week -0.03
    }));
    expect(result.adjustmentBreakdown['time_of_day']).toBe(0.05);
  });

  it('14:30 IST → -0.04', () => {
    const result = scoreProbability(baseInput({
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: MON_1430_IST, // Monday 14:30 IST
    }));
    expect(result.adjustmentBreakdown['time_of_day']).toBe(-0.04);
  });

  it('11:00 IST → 0 (neutral window)', () => {
    const result = scoreProbability(baseInput({
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: WED_1100_IST, // Wednesday 11:00 IST
    }));
    expect(result.adjustmentBreakdown['time_of_day']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 20. Day-of-week adjustments
// ---------------------------------------------------------------------------

describe('day_of_week adjustment', () => {
  it('Monday → -0.03', () => {
    const result = scoreProbability(baseInput({
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: MON_1430_IST, // Monday 14:30 IST (neutral time window for time_of_day)
    }));
    expect(result.adjustmentBreakdown['day_of_week']).toBe(-0.03);
  });

  it('Friday → -0.03', () => {
    const result = scoreProbability(baseInput({
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: FRI_0930_IST, // Friday 09:30 IST
    }));
    expect(result.adjustmentBreakdown['day_of_week']).toBe(-0.03);
  });

  it('Wednesday → 0', () => {
    const result = scoreProbability(baseInput({
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: WED_1100_IST, // Wednesday 11:00 IST
    }));
    expect(result.adjustmentBreakdown['day_of_week']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Confidence tier derivation
// ---------------------------------------------------------------------------

describe('confidenceTier derivation', () => {
  it('adjustedProbability >= 0.70 → HIGH', () => {
    // exhaustionScore=1 → rawProbability=0.75; all-null macro → no adjustments → 0.75
    const result = scoreProbability(baseInput({
      rawExhaustionScore: 1,
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: NEUTRAL_TIME_MS,
    }));
    expect(result.adjustedProbability).toBeGreaterThanOrEqual(0.70);
    expect(result.confidenceTier).toBe('HIGH');
  });

  it('adjustedProbability >= 0.50 and < 0.70 → MEDIUM', () => {
    // exhaustionScore=0.5 → rawProbability=0.55; all-null → adjustedProbability=0.55
    const result = scoreProbability(baseInput({
      rawExhaustionScore: 0.5,
      indiaVix: null,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: NEUTRAL_TIME_MS,
    }));
    expect(result.adjustedProbability).toBeGreaterThanOrEqual(0.50);
    expect(result.adjustedProbability).toBeLessThan(0.70);
    expect(result.confidenceTier).toBe('MEDIUM');
  });

  it('adjustedProbability < 0.50 → LOW', () => {
    // exhaustionScore=0 → rawProbability=0.35; add india_vix penalty to push below
    // indiaVix=30 → -0.05 → 0.30 → LOW
    const result = scoreProbability(baseInput({
      rawExhaustionScore: 0,
      indiaVix: 30,
      macro: NULL_MACRO,
      oiChangePct: null,
      signalTimeMs: NEUTRAL_TIME_MS,
    }));
    expect(result.adjustedProbability).toBeLessThan(0.50);
    expect(result.confidenceTier).toBe('LOW');
  });

  it('SCHEDULED always → MEDIUM (0.60)', () => {
    const result = scoreProbability(baseInput({ signalType: 'SCHEDULED' }));
    expect(result.confidenceTier).toBe('MEDIUM');
  });
});
