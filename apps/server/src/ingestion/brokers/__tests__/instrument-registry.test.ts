/**
 * Unit tests for instrument-registry.ts
 *
 * Tests:
 *   1. ATM strike rounding (getAtmStrike) — concrete values and property invariants.
 *   2. getNearestWeekday — generalised weekday helper.
 *   3. getLastWeekdayOfMonth — monthly expiry helper (BANKNIFTY).
 *   4. getCurrentExpiry — per-underlying rules:
 *        NIFTY    → nearest Tuesday (weekly), 15:30 IST cut-off
 *        SENSEX   → nearest Thursday (weekly), 15:30 IST cut-off
 *        BANKNIFTY → last Tuesday of the month (monthly), roll-over logic
 *   5. buildOptionSymbol — exchange prefix per underlying (NIFTY/BANKNIFTY=NSE, SENSEX=BSE).
 *
 * No network, DB, or Redis access — all functions are pure.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../../../utils/clock.js';
import {
  type Underlying,
  buildOptionSymbol,
  getCurrentExpiry,
  getLastWeekdayOfMonth,
  getNearestWeekday,
  getAtmStrike,
} from '../instrument-registry.js';

// ─── NIFTY concrete cases (50-point intervals) ───────────────────────────────

describe('getAtmStrike — NIFTY (50pt intervals)', () => {
  it('rounds 22137 up to 22150 (nearest 50 above)', () => {
    // 22137 / 50 = 442.74 → Math.round = 443 → 443 * 50 = 22150
    expect(getAtmStrike('NIFTY', 22137)).toBe(22150);
  });

  it('keeps 22100 unchanged (already on boundary)', () => {
    // 22100 / 50 = 442 exactly → 442 * 50 = 22100
    expect(getAtmStrike('NIFTY', 22100)).toBe(22100);
  });

  it('rounds 22124 down to 22100 (< 25 from lower bound)', () => {
    // 22124 / 50 = 442.48 → Math.round = 442 → 22100
    expect(getAtmStrike('NIFTY', 22124)).toBe(22100);
  });

  it('rounds 22125 up to 22150 (exactly halfway rounds up per Math.round)', () => {
    // 22125 / 50 = 442.5 → Math.round = 443 → 22150
    expect(getAtmStrike('NIFTY', 22125)).toBe(22150);
  });

  it('rounds 22000 (exact multiple) to 22000', () => {
    expect(getAtmStrike('NIFTY', 22000)).toBe(22000);
  });

  it('rounds 22074 down to 22050', () => {
    // 22074 / 50 = 441.48 → Math.round = 441 → 22050
    expect(getAtmStrike('NIFTY', 22074)).toBe(22050);
  });

  it('rounds 22076 up to 22100', () => {
    // 22076 / 50 = 441.52 → Math.round = 442 → 22100
    expect(getAtmStrike('NIFTY', 22076)).toBe(22100);
  });
});

// ─── BANKNIFTY concrete cases (100-point intervals) ──────────────────────────

describe('getAtmStrike — BANKNIFTY (100pt intervals)', () => {
  it('rounds 48150 up to 48200', () => {
    // 48150 / 100 = 481.5 → Math.round = 482 → 48200
    expect(getAtmStrike('BANKNIFTY', 48150)).toBe(48200);
  });

  it('keeps 48200 unchanged (already on boundary)', () => {
    expect(getAtmStrike('BANKNIFTY', 48200)).toBe(48200);
  });

  it('rounds 48749 down to 48700', () => {
    // 48749 / 100 = 487.49 → Math.round = 487 → 48700
    expect(getAtmStrike('BANKNIFTY', 48749)).toBe(48700);
  });

  it('rounds 48750 up to 48800 (half-up rule)', () => {
    // 48750 / 100 = 487.5 → Math.round = 488 → 48800
    expect(getAtmStrike('BANKNIFTY', 48750)).toBe(48800);
  });
});

// ─── SENSEX concrete cases (100-point intervals) ─────────────────────────────

describe('getAtmStrike — SENSEX (100pt intervals)', () => {
  it('rounds 81050 up to 81100 (half-up rule)', () => {
    // 81050 / 100 = 810.5 → Math.round = 811 → 81100
    expect(getAtmStrike('SENSEX', 81050)).toBe(81100);
  });

  it('keeps 81100 unchanged (already on boundary)', () => {
    expect(getAtmStrike('SENSEX', 81100)).toBe(81100);
  });

  it('rounds 81049 down to 81000', () => {
    // 81049 / 100 = 810.49 → Math.round = 810 → 81000
    expect(getAtmStrike('SENSEX', 81049)).toBe(81000);
  });
});

// ─── Property: result is always a multiple of the interval ───────────────────

describe('getAtmStrike — property: result is a multiple of the interval', () => {
  const intervals: Record<Underlying, number> = {
    NIFTY: 50,
    BANKNIFTY: 100,
    SENSEX: 100,
  };

  it('NIFTY result is always divisible by 50', () => {
    fc.assert(
      fc.property(fc.integer({ min: 15000, max: 30000 }), (spot) => {
        return getAtmStrike('NIFTY', spot) % intervals.NIFTY === 0;
      }),
    );
  });

  it('BANKNIFTY result is always divisible by 100', () => {
    fc.assert(
      fc.property(fc.integer({ min: 40000, max: 60000 }), (spot) => {
        return getAtmStrike('BANKNIFTY', spot) % intervals.BANKNIFTY === 0;
      }),
    );
  });

  it('SENSEX result is always divisible by 100', () => {
    fc.assert(
      fc.property(fc.integer({ min: 60000, max: 90000 }), (spot) => {
        return getAtmStrike('SENSEX', spot) % intervals.SENSEX === 0;
      }),
    );
  });
});

// ─── Property: |result - spot| <= interval / 2 ───────────────────────────────

describe('getAtmStrike — property: rounds by at most half the interval', () => {
  it('NIFTY: |result - spot| <= 25', () => {
    fc.assert(
      fc.property(fc.integer({ min: 15000, max: 30000 }), (spot) => {
        const strike = getAtmStrike('NIFTY', spot);
        return Math.abs(strike - spot) <= 25;
      }),
    );
  });

  it('BANKNIFTY: |result - spot| <= 50', () => {
    fc.assert(
      fc.property(fc.integer({ min: 40000, max: 60000 }), (spot) => {
        const strike = getAtmStrike('BANKNIFTY', spot);
        return Math.abs(strike - spot) <= 50;
      }),
    );
  });

  it('SENSEX: |result - spot| <= 50', () => {
    fc.assert(
      fc.property(fc.integer({ min: 60000, max: 90000 }), (spot) => {
        const strike = getAtmStrike('SENSEX', spot);
        return Math.abs(strike - spot) <= 50;
      }),
    );
  });
});

// ─── getNearestWeekday ───────────────────────────────────────────────────────

describe('getNearestWeekday', () => {
  it('returns the same date when already on the target weekday', () => {
    // 2024-01-23 is a Tuesday (DOW 2)
    const tue = new Date('2024-01-23T00:00:00Z');
    const result = getNearestWeekday(tue, 2);
    expect(result.toISOString().slice(0, 10)).toBe('2024-01-23');
  });

  it('advances from Wednesday to the following Thursday', () => {
    // 2024-01-24 is a Wednesday (DOW 3); next Thursday is 2024-01-25
    const wed = new Date('2024-01-24T00:00:00Z');
    const result = getNearestWeekday(wed, 4);
    expect(result.toISOString().slice(0, 10)).toBe('2024-01-25');
  });

  it('advances from Thursday to the following Tuesday (wraps week)', () => {
    // 2024-01-25 is a Thursday (DOW 4); next Tuesday is 2024-01-30
    const thu = new Date('2024-01-25T00:00:00Z');
    const result = getNearestWeekday(thu, 2); // target=Tuesday
    expect(result.toISOString().slice(0, 10)).toBe('2024-01-30');
  });

  it('returns time-zeroed dates (UTC midnight)', () => {
    const fri = new Date('2024-01-26T12:30:45Z');
    const result = getNearestWeekday(fri, 2); // next Tuesday from Friday = 2024-01-30
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
    expect(result.toISOString().slice(0, 10)).toBe('2024-01-30');
  });
});

// ─── getLastWeekdayOfMonth ───────────────────────────────────────────────────

describe('getLastWeekdayOfMonth', () => {
  it('returns the last Tuesday of January 2024 (2024-01-30)', () => {
    // Jan 2024: Tuesdays are 2, 9, 16, 23, 30. Last = 30.
    const result = getLastWeekdayOfMonth(2024, 0, 2); // month 0 = January
    expect(result.toISOString().slice(0, 10)).toBe('2024-01-30');
  });

  it('returns the last Tuesday of February 2024 (2024-02-27)', () => {
    // Feb 2024: Tuesdays are 6, 13, 20, 27. Last = 27.
    const result = getLastWeekdayOfMonth(2024, 1, 2); // month 1 = February
    expect(result.toISOString().slice(0, 10)).toBe('2024-02-27');
  });

  it('returns the last Thursday of January 2024 (2024-01-25)', () => {
    // Jan 2024: Thursdays are 4, 11, 18, 25. Last = 25.
    const result = getLastWeekdayOfMonth(2024, 0, 4); // Thursday
    expect(result.toISOString().slice(0, 10)).toBe('2024-01-25');
  });

  it('handles month rollover correctly (month 12 = January of next year)', () => {
    // getLastWeekdayOfMonth(2024, 12, 2) = last Tuesday of January 2025
    // Jan 2025: Tuesdays are 7, 14, 21, 28. Last = 28.
    const result = getLastWeekdayOfMonth(2024, 12, 2);
    expect(result.toISOString().slice(0, 10)).toBe('2025-01-28');
  });

  it('returns time-zeroed dates (UTC midnight)', () => {
    const result = getLastWeekdayOfMonth(2024, 0, 2);
    expect(result.getUTCHours()).toBe(0);
    expect(result.getUTCMinutes()).toBe(0);
    expect(result.getUTCSeconds()).toBe(0);
  });
});

// ─── getCurrentExpiry — NIFTY (weekly Tuesday) ───────────────────────────────

describe('getCurrentExpiry — NIFTY (weekly Tuesday)', () => {
  it('returns same-day Tuesday when before 15:30 IST', () => {
    // 2024-01-23 is a Tuesday. 06:30 UTC = noon IST (12:00) — before cut-off.
    const clock = new FixedClock(new Date('2024-01-23T06:30:00Z'));
    const expiry = getCurrentExpiry('NIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-23');
  });

  it('returns same-day Tuesday exactly at 15:30 IST cut-off (edge — closed)', () => {
    // 2024-01-23 is a Tuesday. 10:00 UTC = 15:30 IST (exactly at cut-off).
    const clock = new FixedClock(new Date('2024-01-23T10:00:00Z'));
    const expiry = getCurrentExpiry('NIFTY', clock);
    // At 15:30 IST pastEOD is true → advance to next Tuesday (2024-01-30)
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-30');
  });

  it('advances to next Tuesday when past 15:30 IST on a Tuesday', () => {
    // 2024-01-23 is a Tuesday. 11:00 UTC = 16:30 IST — past cut-off.
    const clock = new FixedClock(new Date('2024-01-23T11:00:00Z'));
    const expiry = getCurrentExpiry('NIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-30');
  });

  it('returns the nearest Tuesday when today is Thursday (not expiry day)', () => {
    // 2024-01-25 is a Thursday. getNearestWeekday(Thu, Tue=2) → 2024-01-30.
    const clock = new FixedClock(new Date('2024-01-25T06:30:00Z'));
    const expiry = getCurrentExpiry('NIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-30');
  });

  it('returns same Tuesday whether before or on 15:30 on a non-expiry day', () => {
    // Wednesday 2024-01-24 at 17:00 IST (11:30 UTC) — past any cut-off, but
    // Wednesday is not expiry day so the cut-off has no effect.
    const clock = new FixedClock(new Date('2024-01-24T11:30:00Z'));
    const expiry = getCurrentExpiry('NIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-30'); // next Tuesday
  });
});

// ─── getCurrentExpiry — SENSEX (weekly Thursday) ─────────────────────────────

describe('getCurrentExpiry — SENSEX (weekly Thursday)', () => {
  it('returns same-day Thursday when before 15:30 IST', () => {
    // 2024-01-25 is a Thursday. 06:30 UTC = noon IST — before cut-off.
    const clock = new FixedClock(new Date('2024-01-25T06:30:00Z'));
    const expiry = getCurrentExpiry('SENSEX', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-25');
  });

  it('advances to next Thursday when past 15:30 IST on a Thursday', () => {
    // 2024-01-25 is a Thursday. 11:00 UTC = 16:30 IST — past cut-off.
    const clock = new FixedClock(new Date('2024-01-25T11:00:00Z'));
    const expiry = getCurrentExpiry('SENSEX', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-02-01');
  });

  it('returns the nearest Thursday when today is Tuesday', () => {
    // 2024-01-23 is a Tuesday. getNearestWeekday(Tue, Thu=4) → 2024-01-25.
    const clock = new FixedClock(new Date('2024-01-23T06:30:00Z'));
    const expiry = getCurrentExpiry('SENSEX', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-25');
  });
});

// ─── getCurrentExpiry — BANKNIFTY (monthly last Tuesday) ─────────────────────

describe('getCurrentExpiry — BANKNIFTY (last Tuesday of month)', () => {
  it('returns last Tuesday of current month when expiry is in the future', () => {
    // Today = 2024-01-15 (Monday). Last Tuesday of January 2024 = 2024-01-30.
    const clock = new FixedClock(new Date('2024-01-15T06:30:00Z'));
    const expiry = getCurrentExpiry('BANKNIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-30');
  });

  it('returns last Tuesday of current month when today IS the last Tuesday (before 15:30)', () => {
    // Today = 2024-01-30 (Tuesday, last of January). noon IST = before cut-off.
    const clock = new FixedClock(new Date('2024-01-30T06:30:00Z'));
    const expiry = getCurrentExpiry('BANKNIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-01-30');
  });

  it('rolls to next month when today IS the last Tuesday and past 15:30 IST', () => {
    // Today = 2024-01-30 (last Tuesday of Jan). 11:00 UTC = 16:30 IST — past cut-off.
    // Last Tuesday of February 2024 = 2024-02-27.
    const clock = new FixedClock(new Date('2024-01-30T11:00:00Z'));
    const expiry = getCurrentExpiry('BANKNIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-02-27');
  });

  it('rolls to next month when the last Tuesday is already past', () => {
    // Today = 2024-01-31 (Wednesday, after the last Tuesday 2024-01-30).
    // Last Tuesday of February 2024 = 2024-02-27.
    const clock = new FixedClock(new Date('2024-01-31T06:30:00Z'));
    const expiry = getCurrentExpiry('BANKNIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2024-02-27');
  });

  it('rolls to the correct month across a year boundary (December → January)', () => {
    // Today = 2024-12-26 (last Thursday of Dec is 2024-12-31 which is a Tuesday?
    // Let's check: Dec 2024 Tuesdays are 3, 10, 17, 24, 31. Last = 31.
    // Today = 2024-12-31 past 15:30 IST → last Tuesday of January 2025 = 2025-01-28.
    const clock = new FixedClock(new Date('2024-12-31T11:00:00Z')); // 16:30 IST
    const expiry = getCurrentExpiry('BANKNIFTY', clock);
    expect(expiry.toISOString().slice(0, 10)).toBe('2025-01-28');
  });
});

// ─── buildOptionSymbol — exchange prefix ─────────────────────────────────────

describe('buildOptionSymbol — exchange prefix per underlying', () => {
  const expiry = new Date('2024-01-23T00:00:00Z'); // arbitrary Tuesday date

  it('uses NSE: prefix for NIFTY', () => {
    const symbol = buildOptionSymbol('NIFTY', expiry, 22400, 'CE');
    expect(symbol.startsWith('NSE:')).toBe(true);
    expect(symbol).toBe('NSE:NIFTY2412322400CE');
  });

  it('uses NSE: prefix for BANKNIFTY', () => {
    const symbol = buildOptionSymbol('BANKNIFTY', expiry, 47400, 'CE');
    expect(symbol.startsWith('NSE:')).toBe(true);
    expect(symbol).toContain('BANKNIFTY');
  });

  it('uses BSE: prefix for SENSEX', () => {
    const symbol = buildOptionSymbol('SENSEX', expiry, 81000, 'CE');
    expect(symbol.startsWith('BSE:')).toBe(true);
    expect(symbol).toContain('SENSEX');
  });

  it('CE and PE variants differ only in the suffix', () => {
    const ce = buildOptionSymbol('NIFTY', expiry, 22400, 'CE');
    const pe = buildOptionSymbol('NIFTY', expiry, 22400, 'PE');
    expect(ce.slice(0, -2)).toBe(pe.slice(0, -2));
    expect(ce.endsWith('CE')).toBe(true);
    expect(pe.endsWith('PE')).toBe(true);
  });

  it('SENSEX option symbol does NOT start with NSE:', () => {
    // This was the core bug: SENSEX options were being built with NSE: prefix.
    const symbol = buildOptionSymbol('SENSEX', expiry, 81000, 'PE');
    expect(symbol.startsWith('NSE:')).toBe(false);
    expect(symbol.startsWith('BSE:')).toBe(true);
  });
});
