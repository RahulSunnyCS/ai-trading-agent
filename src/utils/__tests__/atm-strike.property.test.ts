import fc from "fast-check";
import { describe, expect, it } from "vitest";
// Import from the real instrument-registry. T-11 (instrument-registry) may not
// yet be committed to this branch; if the import fails, the test fails loudly
// and clearly at import time rather than silently passing with a stub.
// The inline fallback below is intentionally NOT used — importing the real
// function is the acceptance criterion for this task.
import { type Underlying, getAtmStrike } from "../../ingestion/brokers/instrument-registry";

describe("ATM strike rounding (property tests)", () => {
  it("NIFTY strikes are always multiples of 50", () => {
    fc.assert(
      fc.property(fc.float({ min: 15000, max: 30000, noNaN: true }), (spot) => {
        const strike = getAtmStrike("NIFTY", spot);
        // Strike must be divisible by 50 with no remainder
        return strike % 50 === 0;
      }),
    );
  });

  it("BANKNIFTY strikes are always multiples of 100", () => {
    fc.assert(
      fc.property(fc.float({ min: 40000, max: 60000, noNaN: true }), (spot) => {
        const strike = getAtmStrike("BANKNIFTY", spot);
        return strike % 100 === 0;
      }),
    );
  });

  it("SENSEX strikes are always multiples of 100", () => {
    fc.assert(
      fc.property(fc.float({ min: 60000, max: 90000, noNaN: true }), (spot) => {
        const strike = getAtmStrike("SENSEX", spot);
        return strike % 100 === 0;
      }),
    );
  });

  it("result is the nearest valid strike to spot (property)", () => {
    // For every underlying, the ATM strike must be closer to spot than any
    // adjacent valid strike. Ties (exactly halfway) are allowed to round either
    // direction — we just verify the absolute distance is ≤ (interval / 2).
    const intervals: Record<Underlying, number> = {
      NIFTY: 50,
      BANKNIFTY: 100,
      SENSEX: 100,
    };

    const underlyings: Underlying[] = ["NIFTY", "BANKNIFTY", "SENSEX"];

    for (const underlying of underlyings) {
      const interval = intervals[underlying];
      const [min, max] =
        underlying === "NIFTY"
          ? [15000, 30000]
          : underlying === "BANKNIFTY"
            ? [40000, 60000]
            : [60000, 90000];

      fc.assert(
        fc.property(fc.float({ min, max, noNaN: true }), (spot) => {
          const strike = getAtmStrike(underlying, spot);
          const distance = Math.abs(strike - spot);
          // Must be within half an interval of the spot (true nearest-strike property)
          return distance <= interval / 2;
        }),
      );
    }
  });

  it("known concrete values (NIFTY)", () => {
    // NIFTY interval = 50
    expect(getAtmStrike("NIFTY", 22334)).toBe(22350); // 22334/50 = 446.68 → round to 447 → 22350
    expect(getAtmStrike("NIFTY", 22324)).toBe(22300); // 22324/50 = 446.48 → round to 446 → 22300
    expect(getAtmStrike("NIFTY", 22325)).toBe(22350); // exactly halfway → Math.round rounds up (0.5 rule)
    expect(getAtmStrike("NIFTY", 22000)).toBe(22000); // exact multiple → unchanged
  });

  it("known concrete values (BANKNIFTY)", () => {
    // BANKNIFTY interval = 100
    expect(getAtmStrike("BANKNIFTY", 48750)).toBe(48800); // 48750/100 = 487.5 → Math.round = 488 → 48800
    expect(getAtmStrike("BANKNIFTY", 48740)).toBe(48700); // 48740/100 = 487.4 → 487 → 48700
    expect(getAtmStrike("BANKNIFTY", 48800)).toBe(48800); // exact multiple → unchanged
  });

  it("known concrete values (SENSEX)", () => {
    // SENSEX interval = 100
    expect(getAtmStrike("SENSEX", 79123)).toBe(79100); // 79123/100 = 791.23 → 791 → 79100
    expect(getAtmStrike("SENSEX", 79150)).toBe(79200); // 79150/100 = 791.5 → 792 → 79200
    expect(getAtmStrike("SENSEX", 79200)).toBe(79200); // exact multiple → unchanged
  });
});
