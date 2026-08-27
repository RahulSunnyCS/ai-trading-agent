const { columnToLetter, letterToColumn, buildAccountValues } = require("../updateSheet");

describe("columnToLetter()", () => {
  test.each([
    [1, "A"],
    [4, "D"],
    [26, "Z"],
    [27, "AA"],
    [52, "AZ"],
    [53, "BA"],
    [702, "ZZ"],
  ])("column %i → %s", (col, letter) => {
    expect(columnToLetter(col)).toBe(letter);
  });
});

describe("letterToColumn()", () => {
  test.each([
    ["A", 1],
    ["D", 4],
    ["Z", 26],
    ["AA", 27],
    ["AZ", 52],
    ["BA", 53],
    ["ZZ", 702],
  ])("%s → %i", (letter, col) => {
    expect(letterToColumn(letter)).toBe(col);
  });

  test("round-trip: letterToColumn(columnToLetter(n)) === n", () => {
    for (const n of [1, 4, 26, 27, 52, 100, 702]) {
      expect(letterToColumn(columnToLetter(n))).toBe(n);
    }
  });
});

describe("buildAccountValues()", () => {
  test("returns five values [payin, brokerage, other, total, final] from a full match", () => {
    const vals = buildAccountValues({
      payin_payout_obligation: 100,
      net_brokerage: 20,
      other_charges: 5,
    });
    // total = 20 + 5 = 25; final = payin - total = 100 - 25 = 75
    expect(vals).toEqual([100, 20, 5, 25, 75]);
  });

  test("totalCharges = net_brokerage + other_charges", () => {
    const [, brokerage, other, total] = buildAccountValues({
      payin_payout_obligation: 0,
      net_brokerage: 15,
      other_charges: 7,
    });
    expect(total).toBe(brokerage + other);
  });

  test("final_net = payin - total_charges", () => {
    const [payin, , , total, finalNet] = buildAccountValues({
      payin_payout_obligation: -9275.75,
      net_brokerage: 160,
      other_charges: 579.36,
    });
    expect(finalNet).toBeCloseTo(payin - total, 2);
    expect(finalNet).toBeCloseTo(-10015.11, 2);
  });

  test("defaults all to zero when match is undefined", () => {
    expect(buildAccountValues(undefined)).toEqual([0, 0, 0, 0, 0]);
  });

  test("defaults all to zero when match is null", () => {
    expect(buildAccountValues(null)).toEqual([0, 0, 0, 0, 0]);
  });

  test("handles missing fields with zero fallback", () => {
    const vals = buildAccountValues({ payin_payout_obligation: 50 });
    // total = 0; final = 50 - 0 = 50
    expect(vals).toEqual([50, 0, 0, 0, 50]);
  });
});

describe("isDateCell()", () => {
  const { isDateCell } = require("../updateSheet");

  test("recognises the date format this pipeline writes", () => {
    expect(isDateCell("26 May 26")).toBe(true);
    expect(isDateCell("01-May-25")).toBe(true);
  });

  test("does not treat totals rows, notes or blanks as dates", () => {
    for (const value of ["", null, undefined, "Total", "Grand Total", "notes"]) {
      expect(isDateCell(value)).toBe(false);
    }
  });
});
