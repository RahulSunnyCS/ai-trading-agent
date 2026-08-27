const { extract, subject, bodyFilter } = require("../../brokers/angelone");
const fs = require("fs");
const path = require("path");

const sampleText = fs.readFileSync(path.join(__dirname, "../fixtures/angelone-sample.txt"), "utf-8");
const noMatchText = fs.readFileSync(path.join(__dirname, "../fixtures/angelone-no-match.txt"), "utf-8");
const mixedText = fs.readFileSync(path.join(__dirname, "../fixtures/angelone-mixed-segments.txt"), "utf-8");
const equityOnlyText = fs.readFileSync(path.join(__dirname, "../fixtures/angelone-equity-only.txt"), "utf-8");

describe("angelone.extract()", () => {
  test("extracts all three fields from valid PDF text", () => {
    const result = extract(sampleText);
    expect(result.error).toBeUndefined();
    expect(typeof result.payin_payout_obligation).toBe("number");
    expect(typeof result.net_brokerage).toBe("number");
    expect(typeof result.other_charges).toBe("number");
    expect(isFinite(result.payin_payout_obligation)).toBe(true);
    expect(isFinite(result.net_brokerage)).toBe(true);
    expect(isFinite(result.other_charges)).toBe(true);
  });

  test("net_brokerage is non-negative", () => {
    expect(extract(sampleText).net_brokerage).toBeGreaterThanOrEqual(0);
  });

  test("other_charges is non-negative", () => {
    expect(extract(sampleText).other_charges).toBeGreaterThanOrEqual(0);
  });

  test("payin - (brokerage + other_charges) equals PDF final net", () => {
    // Regression: Angel One's obligation already has brokerage deducted; payin must add it back.
    // PDF shows Pay In/Out Obligation = -3809, Brokerage = 240, Final Net = -4005.53
    const result = extract(sampleText);
    const computedFinalNet = result.payin_payout_obligation - (result.net_brokerage + result.other_charges);
    expect(computedFinalNet).toBeCloseTo(-4005.53, 1);
  });

  test("payin_payout_obligation is raw P&L before charges (obligation + brokerage added back)", () => {
    const result = extract(sampleText);
    expect(result.payin_payout_obligation).toBeCloseTo(-3569, 1);
  });

  test("returns error when the obligation table is not present", () => {
    const result = extract(noMatchText);
    expect(result.error).toMatch(/Obligation Details table not found/);
  });

  test("error includes text preview", () => {
    const result = extract(noMatchText);
    expect(result.error).toMatch(/Text preview:/);
  });

  test("returns error for empty text", () => {
    expect(extract("").error).toBeDefined();
  });

  test("returns error for null/undefined text", () => {
    expect(extract(null).error).toBeDefined();
    expect(extract(undefined).error).toBeDefined();
  });
});

describe("angelone.extract() segment filtering", () => {
  test("ignores the cash/equity row when a note mixes equity and F&O", () => {
    // Same F&O trades as the F&O-only sample, plus an NSE-CASH row.
    const mixed = extract(mixedText);
    const fnoOnly = extract(sampleText);
    expect(mixed.error).toBeUndefined();
    expect(mixed.payin_payout_obligation).toBeCloseTo(fnoOnly.payin_payout_obligation, 2);
    expect(mixed.net_brokerage).toBeCloseTo(fnoOnly.net_brokerage, 2);
    expect(mixed.other_charges).toBeCloseTo(fnoOnly.other_charges, 2);
  });

  test("reports which segments were skipped", () => {
    expect(extract(mixedText).skipped_segments).toEqual(["NSE-CASH (equity)"]);
    expect(extract(sampleText).skipped_segments).toEqual([]);
  });

  test("derives per-segment brokerage instead of the all-segment total", () => {
    // The mixed note reports "Total Brokerage = 291.90" across both segments;
    // only the 240.00 charged on the F&O segment may be recorded.
    expect(mixedText).toContain("Total Brokerage = 291.90");
    expect(extract(mixedText).net_brokerage).toBeCloseTo(240, 2);
  });

  test("returns zeros for a note with no F&O segment", () => {
    const result = extract(equityOnlyText);
    expect(result.error).toBeUndefined();
    expect(result.payin_payout_obligation).toBe(0);
    expect(result.net_brokerage).toBe(0);
    expect(result.other_charges).toBe(0);
    expect(result.skipped_segments).toEqual(["NSE-CASH (equity)"]);
  });

  test("fails loudly on an unrecognised segment label", () => {
    const result = extract(sampleText.replace(/BSE-FUTURES-3809/, "BSE-WOMBAT-3809"));
    expect(result.error).toMatch(/unrecognised segment: BSE-WOMBAT/);
  });

  test("does not silently mis-read reordered columns", () => {
    // Swap the obligation and net-amount cells: the obligation/charges identity
    // must no longer hold and the extractor must refuse the row.
    const corrupted = sampleText.replace(
      "BSE-FUTURES-3809.0099.00284.3525.5925.5944.210.142.000.000.00-4005.53",
      "BSE-FUTURES-4005.5399.00284.3525.5925.5944.210.142.000.000.00-3809.00"
    );
    expect(extract(corrupted).error).toMatch(/column mismatch/);
  });
});

describe("angelone.subject()", () => {
  test("returns fixed contract note subject", () => {
    expect(subject()).toBe("Contract Note - Equity Segment");
  });
});

describe("angelone.bodyFilter()", () => {
  test("formats date as DD/MM/YYYY", () => {
    expect(bodyFilter(new Date("2025-04-30"))).toBe("30/04/2025");
  });

  test("pads single-digit day and month", () => {
    expect(bodyFilter(new Date("2025-01-05"))).toBe("05/01/2025");
  });
});

describe("angelone.extract() table integrity", () => {
  test("errors when only the all-segment summary row is present", () => {
    const onlyTotal = sampleText.replace(
      "BSE-FUTURES-3809.0099.00284.3525.5925.5944.210.142.000.000.00-4005.53\n",
      ""
    );
    expect(extract(onlyTotal).error).toMatch(/no per-segment rows/);
  });
});
