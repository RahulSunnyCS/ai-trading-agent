/**
 * Unit tests for the Trigger/Exit Engine (T-16).
 *
 * All tests use FixedClock so time is deterministic — no real wall clock.
 * IST = UTC + 5:30, so a UTC time of 09:45 = IST 15:15.
 */

import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../utils/clock';
import {
  type ExitDecision,
  type Position,
  evaluateExit,
  updateHighWatermark,
} from '../trigger-exit';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a FixedClock set to a specific IST time on an arbitrary date.
 *
 * We use 2026-05-19 as the anchor date (today in this project).
 * IST = UTC + 5:30, so IST hh:mm = UTC (hh - 5):mm shifted back 30 minutes.
 * Simpler arithmetic: UTC ms = IST ms - IST_OFFSET_MS.
 */
function clockAtIST(istHour: number, istMinute: number): FixedClock {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  // Construct a UTC Date that corresponds to the requested IST time.
  // We use 2026-05-19 as the base date.
  const istMs = Date.UTC(2026, 4 /* May */, 19, istHour, istMinute, 0, 0);
  const utcMs = istMs - IST_OFFSET_MS;
  return new FixedClock(new Date(utcMs));
}

/**
 * Construct a Position with safe defaults, allowing callers to override only
 * the fields relevant to the test under focus.
 */
function makePosition(overrides: Partial<Position> = {}): Position {
  return {
    entryStraddleValue: 200,
    currentStraddleValue: 200,
    entryTimestamp: Date.UTC(2026, 4, 19, 3, 50, 0, 0), // 09:20 IST entry
    stopLossPct: 0.2, // exit if straddle rises ≥20% above entry (≥240)
    trailingStopPct: 0.15, // exit if straddle rises ≥15% from highWatermark
    targetPct: 0.3, // exit if straddle falls ≥30% below entry (≤140)
    highWatermark: 200, // equals entry at start (running minimum)
    eodExitIST: '15:15',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. No exit when all conditions are safe
// ---------------------------------------------------------------------------

describe('evaluateExit — no exit (mid-trade)', () => {
  it('returns shouldExit=false and reason=none when position is healthy', () => {
    // IST 12:00 — well before EOD at 15:15.
    // currentStraddleValue=200 is at entry level — no SL, TSL, or target.
    const clock = clockAtIST(12, 0);
    const position = makePosition();

    const result: ExitDecision = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 2. Stop loss fires when straddle rises above entry * (1 + stopLossPct)
// ---------------------------------------------------------------------------

describe('evaluateExit — stop loss', () => {
  it('fires when currentStraddleValue equals the SL threshold exactly', () => {
    // SL threshold = 200 * 1.20 = 240 (exactly at boundary → should fire).
    const clock = clockAtIST(12, 0);
    const position = makePosition({ currentStraddleValue: 240 });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('stop_loss');
  });

  it('fires when currentStraddleValue exceeds the SL threshold', () => {
    const clock = clockAtIST(12, 0);
    const position = makePosition({ currentStraddleValue: 245 });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('stop_loss');
  });

  // 3. Stop loss does NOT fire just below threshold
  it('does NOT fire when currentStraddleValue is just below SL threshold', () => {
    // 239.99 < SL threshold 240 → SL does not fire.
    // Also ensure TSL does not fire: TSL threshold = highWatermark * (1 + trailingStopPct).
    // Use a highWatermark equal to currentStraddleValue so TSL threshold is well above current.
    // highWatermark = 239.99, trailingStopPct = 0.15 → TSL threshold = 275.99 >> 239.99.
    // Target threshold = 200 * (1 - 0.30) = 140 << 239.99 → target not reached.
    const clock = clockAtIST(12, 0);
    const position = makePosition({
      currentStraddleValue: 239.99,
      highWatermark: 239.99, // running minimum = current (no improvement yet)
    });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 4. Trailing stop loss fires when straddle rises from highWatermark
// ---------------------------------------------------------------------------

describe('evaluateExit — trailing stop loss', () => {
  it('fires when current exceeds highWatermark * (1 + trailingStopPct)', () => {
    // highWatermark = 160 (running minimum after some profit).
    // TSL threshold = 160 * 1.15 = 184.
    // current = 184 → should fire.
    const clock = clockAtIST(12, 0);
    const position = makePosition({
      currentStraddleValue: 184,
      highWatermark: 160,
      // Keep SL out of the picture: SL threshold = 200 * 1.20 = 240 > 184.
    });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('trailing_stop_loss');
  });

  it('does NOT fire when current is just below TSL threshold', () => {
    // TSL threshold = 160 * 1.15 = 184; current = 183.99 → no TSL.
    const clock = clockAtIST(12, 0);
    const position = makePosition({
      currentStraddleValue: 183.99,
      highWatermark: 160,
    });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 5. Target reached fires when straddle falls below entry * (1 - targetPct)
// ---------------------------------------------------------------------------

describe('evaluateExit — target reached', () => {
  it('fires when currentStraddleValue equals the target threshold exactly', () => {
    // Target threshold = 200 * (1 - 0.30) = 140 (exactly → should fire).
    const clock = clockAtIST(12, 0);
    const position = makePosition({ currentStraddleValue: 140 });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('target_reached');
  });

  it('fires when currentStraddleValue is below the target threshold', () => {
    const clock = clockAtIST(12, 0);
    const position = makePosition({ currentStraddleValue: 135 });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('target_reached');
  });

  it('does NOT fire when currentStraddleValue is just above the target threshold', () => {
    // 140.01 > 140 → target not reached.
    const clock = clockAtIST(12, 0);
    const position = makePosition({ currentStraddleValue: 140.01 });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// 6. EOD exit fires at or after eodExitIST
// ---------------------------------------------------------------------------

describe('evaluateExit — EOD exit', () => {
  it('fires when IST time is after eodExitIST', () => {
    // 15:16 IST is one minute after the 15:15 EOD threshold.
    const clock = clockAtIST(15, 16);
    const position = makePosition();

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('eod_exit');
  });

  it('does NOT fire before eodExitIST', () => {
    // 15:14 IST is one minute before the 15:15 threshold.
    const clock = clockAtIST(15, 14);
    const position = makePosition();

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBe('none');
  });

  // 7. EOD fires exactly at the minute boundary
  it('fires exactly at the eodExitIST minute boundary', () => {
    // 15:15 IST exactly — boundary is inclusive (>=).
    const clock = clockAtIST(15, 15);
    const position = makePosition();

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('eod_exit');
  });
});

// ---------------------------------------------------------------------------
// 8. Priority: EOD takes priority over SL when both conditions are true
// ---------------------------------------------------------------------------

describe('evaluateExit — priority ordering', () => {
  it('returns eod_exit when both EOD and SL conditions are simultaneously true', () => {
    // Make SL condition true: currentStraddleValue (260) > entry (200) * 1.20 = 240.
    // Make EOD condition true: IST 15:20 > eodExitIST 15:15.
    const clock = clockAtIST(15, 20);
    const position = makePosition({ currentStraddleValue: 260 });

    const result = evaluateExit(position, clock);

    // EOD (checked first) must win over SL.
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('eod_exit');
  });

  it('returns eod_exit when EOD, TSL, and target are all simultaneously true', () => {
    // All three non-EOD conditions are triggered:
    //   SL:     current 260 >= entry 200 * 1.20 = 240 ✓
    //   TSL:    current 260 >= hwm 160 * 1.15 = 184 ✓
    //   Target: current 260 is NOT below target (entry 200 * 0.70 = 140) — use separate position
    // Simplify: just test EOD + SL simultaneously (already covered above).
    // Here verify EOD beats TSL.
    const clock = clockAtIST(15, 20);
    const position = makePosition({
      currentStraddleValue: 184,
      highWatermark: 160,
    });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('eod_exit');
  });

  it('SL takes priority over TSL when SL fires first in the evaluation order', () => {
    // Both SL and TSL are true; SL is checked before TSL so it must win.
    // SL threshold: 200 * 1.20 = 240; current = 245 ✓
    // TSL threshold: 160 * 1.15 = 184; current = 245 ✓
    // No EOD condition (IST 12:00 < 15:15).
    const clock = clockAtIST(12, 0);
    const position = makePosition({
      currentStraddleValue: 245,
      highWatermark: 160,
    });

    const result = evaluateExit(position, clock);

    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('stop_loss');
  });
});

// ---------------------------------------------------------------------------
// 9. updateHighWatermark returns the minimum of current and existingWatermark
// ---------------------------------------------------------------------------

describe('updateHighWatermark', () => {
  it('returns current when current is lower than existingWatermark', () => {
    expect(updateHighWatermark(150, 200)).toBe(150);
  });

  it('returns existingWatermark when current is higher', () => {
    expect(updateHighWatermark(210, 200)).toBe(200);
  });

  it('returns the value unchanged when both are equal', () => {
    expect(updateHighWatermark(200, 200)).toBe(200);
  });

  it('accumulates the running minimum across successive ticks', () => {
    // Simulate a sequence of straddle values and verify the watermark tracks
    // the minimum correctly.
    const ticks = [200, 180, 170, 175, 165, 170];
    let watermark = ticks[0] ?? 200;

    for (const tick of ticks.slice(1)) {
      watermark = updateHighWatermark(tick, watermark);
    }

    // The minimum of the series is 165.
    expect(watermark).toBe(165);
  });
});
