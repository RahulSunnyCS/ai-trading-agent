const { extract, subject } = require("../../brokers/finvasia");
const fs = require("fs");
const path = require("path");

const sampleText = fs.readFileSync(path.join(__dirname, "../fixtures/finvasia-sample.txt"), "utf-8");
const noMatchText = fs.readFileSync(path.join(__dirname, "../fixtures/finvasia-no-match.txt"), "utf-8");
const mixedText = fs.readFileSync(path.join(__dirname, "../fixtures/finvasia-mixed-segments.txt"), "utf-8");
const equityOnlyText = fs.readFileSync(path.join(__dirname, "../fixtures/finvasia-equity-only.txt"), "utf-8");

describe("finvasia.extract()", () => {
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
    const result = extract(sampleText);
    expect(result.net_brokerage).toBeGreaterThanOrEqual(0);
  });

  test("other_charges is non-negative", () => {
    const result = extract(sampleText);
    expect(result.other_charges).toBeGreaterThanOrEqual(0);
  });

  test("payin - (brokerage + other_charges) equals PDF final net", () => {
    // Regression: brokerage must not be double-counted.
    // PDF shows Pay in/Payout Obligation = -9275.75, Brokerage = 160, Final Net = -10015.11
    const result = extract(sampleText);
    const computedFinalNet = result.payin_payout_obligation - (result.net_brokerage + result.other_charges);
    expect(computedFinalNet).toBeCloseTo(-10015.11, 1);
  });

  test("payin_payout_obligation matches PDF obligation (brokerage not deducted from it)", () => {
    const result = extract(sampleText);
    expect(result.payin_payout_obligation).toBeCloseTo(-9275.75, 1);
  });

  test("returns error when the obligation table is not present", () => {
    const result = extract(noMatchText);
    expect(result.error).toMatch(/Obligation Detail table not found/);
  });

  test("error includes text preview", () => {
    const result = extract(noMatchText);
    expect(result.error).toMatch(/Text preview:/);
  });

  test("returns error for empty text", () => {
    const result = extract("");
    expect(result.error).toBeDefined();
  });

  test("returns error for null/undefined text", () => {
    expect(extract(null).error).toBeDefined();
    expect(extract(undefined).error).toBeDefined();
  });
});

describe("finvasia.extract() segment filtering", () => {
  test("ignores the cash/equity row when a note mixes equity and F&O", () => {
    // Same F&O trades as the F&O-only sample, plus an NSECAP-NCL row.
    const mixed = extract(mixedText);
    const fnoOnly = extract(sampleText);
    expect(mixed.error).toBeUndefined();
    expect(mixed.payin_payout_obligation).toBeCloseTo(fnoOnly.payin_payout_obligation, 2);
    expect(mixed.net_brokerage).toBeCloseTo(fnoOnly.net_brokerage, 2);
    expect(mixed.other_charges).toBeCloseTo(fnoOnly.other_charges, 2);
  });

  test("reports which segments were skipped", () => {
    expect(extract(mixedText).skipped_segments).toEqual(["NSECAP-NCL (equity)"]);
    expect(extract(sampleText).skipped_segments).toEqual([]);
  });

  test("keeps only the F&O brokerage when equity is present", () => {
    // The equity row carries 94.70 of brokerage; only the F&O 160.00 counts.
    expect(mixedText).toContain("94.70");
    expect(extract(mixedText).net_brokerage).toBeCloseTo(160, 2);
  });

  test("returns zeros for a note with no F&O segment", () => {
    const result = extract(equityOnlyText);
    expect(result.error).toBeUndefined();
    expect(result.payin_payout_obligation).toBe(0);
    expect(result.net_brokerage).toBe(0);
    expect(result.other_charges).toBe(0);
    expect(result.skipped_segments).toEqual(["NSECAP-NCL (equity)"]);
  });

  test("fails loudly on an unrecognised segment label", () => {
    const result = extract(sampleText.replace(/NSEFNO-NCL/, "NSEWOMBAT-NCL"));
    expect(result.error).toMatch(/unrecognised segment: NSEWOMBAT-NCL/);
  });

  test("ignores a dropped row whose cell count is unexpected", () => {
    // Only the F&O rows are read, so an odd-shaped cash row must not fail a
    // note whose F&O side parses cleanly.
    const shortCashRow = mixedText.replace(
      "NSECAP-NCL 250.00 120.00",
      "NSECAP-NCL 250.00"
    );
    const result = extract(shortCashRow);
    expect(result.error).toBeUndefined();
    expect(result.payin_payout_obligation).toBeCloseTo(-9275.75, 2);
    expect(result.net_brokerage).toBeCloseTo(160, 2);
  });

  test("does not silently mis-read reordered cells", () => {
    // Swap the Final Net and Pay in/Payout Obligation cells: the charges
    // identity must no longer hold and the extractor must refuse the row.
    const corrupted = sampleText.replace("-10015.11\n-9275.75", "-9275.75\n-10015.11");
    expect(extract(corrupted).error).toMatch(/column mismatch/);
  });
});

describe("finvasia.subject()", () => {
  test("includes accountId and formatted date", () => {
    const result = subject("FA1234", new Date("2025-04-30"));
    expect(result).toContain("FA1234");
    expect(result).toContain("30-04-2025");
  });
});
