import Decimal from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { calculatePnl } from "../pnl";

/**
 * CRITICAL property tests for short-straddle P&L sign convention and money math.
 *
 * These tests exist because the SHORT position sign convention is the single most
 * common source of silent bugs in paper-trading P&L accounting: a developer who
 * thinks "profit = exitValue − entryValue" (long convention) will pass all unit
 * tests that only check magnitude, but will invert every win/loss classification.
 */
describe("Short straddle P&L sign convention (CRITICAL)", () => {
  it("entry=100, straddle RISES to 130 → LOSS (negative pnl)", () => {
    const { grossPnl, isProfit } = calculatePnl("100", "130", 1, 1);
    // Straddle value increased: we bought it back MORE expensive → loss
    expect(new Decimal(grossPnl).lt(0)).toBe(true);
    expect(isProfit).toBe(false);
    expect(grossPnl).toBe("-30.00");
  });

  it("entry=100, straddle FALLS to 70 → PROFIT (positive pnl)", () => {
    const { grossPnl, isProfit } = calculatePnl("100", "70", 1, 1);
    // Straddle value decreased: we bought it back CHEAPER → profit
    expect(new Decimal(grossPnl).gt(0)).toBe(true);
    expect(isProfit).toBe(true);
    expect(grossPnl).toBe("30.00");
  });

  it("entry === exit → exactly zero pnl", () => {
    const { grossPnl, isProfit } = calculatePnl("250.50", "250.50", 2, 50);
    expect(grossPnl).toBe("0.00");
    // isProfit is false when grossPnl === 0 (Decimal.gt(0) returns false)
    expect(isProfit).toBe(false);
  });

  it("lot × lotSize scaling is correct", () => {
    // entry=200, exit=150, lots=2, lotSize=50 → profit = (200−150)*2*50 = 5000
    const { grossPnl, isProfit } = calculatePnl("200", "150", 2, 50);
    expect(grossPnl).toBe("5000.00");
    expect(isProfit).toBe(true);
  });

  it("100 × ₹0.10 increments = exactly ₹10.00 (no float drift)", () => {
    // IEEE-754: 0.1 * 100 in plain JS is 9.999999999999998, not 10.
    // This test proves decimal.js avoids that drift.
    let total = new Decimal("0");
    for (let i = 0; i < 100; i++) total = total.plus("0.10");
    expect(total.toFixed(2)).toBe("10.00");
  });

  it("P&L accumulation across 1000 random decimals matches decimal.js oracle (property)", () => {
    // Shrinks fast: fast-check will find a minimal counterexample if the
    // implementation is using native floats anywhere in the accumulation path.
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            entry: fc.float({ min: 50, max: 500, noNaN: true }),
            exit: fc.float({ min: 50, max: 500, noNaN: true }),
            lots: fc.integer({ min: 1, max: 10 }),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        (trades) => {
          // Sum all grossPnl values via decimal.js (oracle)
          const oracleSum = trades.reduce((acc, t) => {
            const expected = new Decimal(t.entry.toFixed(2))
              .minus(t.exit.toFixed(2))
              .mul(t.lots)
              .mul(50);
            return acc.plus(expected);
          }, new Decimal("0"));

          // Sum what our function returns
          const implSum = trades.reduce((acc, t) => {
            const { grossPnl } = calculatePnl(t.entry.toFixed(2), t.exit.toFixed(2), t.lots, 50);
            return acc.plus(new Decimal(grossPnl));
          }, new Decimal("0"));

          // Both should agree to 2 decimal places
          return oracleSum.toFixed(2) === implSum.toFixed(2);
        },
      ),
    );
  });

  it("P&L of single trade matches decimal.js oracle for arbitrary inputs (property)", () => {
    fc.assert(
      fc.property(
        fc.float({ min: 50, max: 500, noNaN: true }),
        fc.float({ min: 50, max: 500, noNaN: true }),
        fc.integer({ min: 1, max: 10 }),
        (entry, exit, lots) => {
          const { grossPnl } = calculatePnl(entry.toFixed(2), exit.toFixed(2), lots, 50);
          const expected = new Decimal(entry.toFixed(2))
            .minus(exit.toFixed(2))
            .mul(lots)
            .mul(50)
            .toFixed(2);
          return grossPnl === expected;
        },
      ),
    );
  });
});
