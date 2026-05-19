/**
 * Unit tests for instrument-registry.ts
 *
 * Tests ATM strike rounding (getAtmStrike) with concrete values and property
 * invariants. The property tests overlap in spirit with the ones in
 * src/utils/__tests__/atm-strike.property.test.ts but are focused on the
 * specific concrete examples listed in the task specification plus a few
 * edge cases.
 *
 * No network, DB, or Redis access — getAtmStrike is a pure function.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Underlying, getAtmStrike } from "../instrument-registry.js";

// ─── NIFTY concrete cases (50-point intervals) ───────────────────────────────

describe("getAtmStrike — NIFTY (50pt intervals)", () => {
  it("rounds 22137 up to 22150 (nearest 50 above)", () => {
    // 22137 / 50 = 442.74 → Math.round = 443 → 443 * 50 = 22150
    expect(getAtmStrike("NIFTY", 22137)).toBe(22150);
  });

  it("keeps 22100 unchanged (already on boundary)", () => {
    // 22100 / 50 = 442 exactly → 442 * 50 = 22100
    expect(getAtmStrike("NIFTY", 22100)).toBe(22100);
  });

  it("rounds 22124 down to 22100 (< 25 from lower bound)", () => {
    // 22124 / 50 = 442.48 → Math.round = 442 → 22100
    expect(getAtmStrike("NIFTY", 22124)).toBe(22100);
  });

  it("rounds 22125 up to 22150 (exactly halfway rounds up per Math.round)", () => {
    // 22125 / 50 = 442.5 → Math.round = 443 → 22150
    expect(getAtmStrike("NIFTY", 22125)).toBe(22150);
  });

  it("rounds 22000 (exact multiple) to 22000", () => {
    expect(getAtmStrike("NIFTY", 22000)).toBe(22000);
  });

  it("rounds 22074 down to 22050", () => {
    // 22074 / 50 = 441.48 → Math.round = 441 → 22050
    expect(getAtmStrike("NIFTY", 22074)).toBe(22050);
  });

  it("rounds 22076 up to 22100", () => {
    // 22076 / 50 = 441.52 → Math.round = 442 → 22100
    expect(getAtmStrike("NIFTY", 22076)).toBe(22100);
  });
});

// ─── BANKNIFTY concrete cases (100-point intervals) ──────────────────────────

describe("getAtmStrike — BANKNIFTY (100pt intervals)", () => {
  it("rounds 48150 up to 48200", () => {
    // 48150 / 100 = 481.5 → Math.round = 482 → 48200
    expect(getAtmStrike("BANKNIFTY", 48150)).toBe(48200);
  });

  it("keeps 48200 unchanged (already on boundary)", () => {
    expect(getAtmStrike("BANKNIFTY", 48200)).toBe(48200);
  });

  it("rounds 48749 down to 48700", () => {
    // 48749 / 100 = 487.49 → Math.round = 487 → 48700
    expect(getAtmStrike("BANKNIFTY", 48749)).toBe(48700);
  });

  it("rounds 48750 up to 48800 (half-up rule)", () => {
    // 48750 / 100 = 487.5 → Math.round = 488 → 48800
    expect(getAtmStrike("BANKNIFTY", 48750)).toBe(48800);
  });
});

// ─── SENSEX concrete cases (100-point intervals) ─────────────────────────────

describe("getAtmStrike — SENSEX (100pt intervals)", () => {
  it("rounds 81050 up to 81100 (half-up rule)", () => {
    // 81050 / 100 = 810.5 → Math.round = 811 → 81100
    expect(getAtmStrike("SENSEX", 81050)).toBe(81100);
  });

  it("keeps 81100 unchanged (already on boundary)", () => {
    expect(getAtmStrike("SENSEX", 81100)).toBe(81100);
  });

  it("rounds 81049 down to 81000", () => {
    // 81049 / 100 = 810.49 → Math.round = 810 → 81000
    expect(getAtmStrike("SENSEX", 81049)).toBe(81000);
  });
});

// ─── Property: result is always a multiple of the interval ───────────────────

describe("getAtmStrike — property: result is a multiple of the interval", () => {
  const intervals: Record<Underlying, number> = {
    NIFTY: 50,
    BANKNIFTY: 100,
    SENSEX: 100,
  };

  it("NIFTY result is always divisible by 50", () => {
    fc.assert(
      fc.property(fc.integer({ min: 15000, max: 30000 }), (spot) => {
        return getAtmStrike("NIFTY", spot) % intervals.NIFTY === 0;
      }),
    );
  });

  it("BANKNIFTY result is always divisible by 100", () => {
    fc.assert(
      fc.property(fc.integer({ min: 40000, max: 60000 }), (spot) => {
        return getAtmStrike("BANKNIFTY", spot) % intervals.BANKNIFTY === 0;
      }),
    );
  });

  it("SENSEX result is always divisible by 100", () => {
    fc.assert(
      fc.property(fc.integer({ min: 60000, max: 90000 }), (spot) => {
        return getAtmStrike("SENSEX", spot) % intervals.SENSEX === 0;
      }),
    );
  });
});

// ─── Property: |result - spot| <= interval / 2 ───────────────────────────────

describe("getAtmStrike — property: rounds by at most half the interval", () => {
  it("NIFTY: |result - spot| <= 25", () => {
    fc.assert(
      fc.property(fc.integer({ min: 15000, max: 30000 }), (spot) => {
        const strike = getAtmStrike("NIFTY", spot);
        return Math.abs(strike - spot) <= 25;
      }),
    );
  });

  it("BANKNIFTY: |result - spot| <= 50", () => {
    fc.assert(
      fc.property(fc.integer({ min: 40000, max: 60000 }), (spot) => {
        const strike = getAtmStrike("BANKNIFTY", spot);
        return Math.abs(strike - spot) <= 50;
      }),
    );
  });

  it("SENSEX: |result - spot| <= 50", () => {
    fc.assert(
      fc.property(fc.integer({ min: 60000, max: 90000 }), (spot) => {
        const strike = getAtmStrike("SENSEX", spot);
        return Math.abs(strike - spot) <= 50;
      }),
    );
  });
});
