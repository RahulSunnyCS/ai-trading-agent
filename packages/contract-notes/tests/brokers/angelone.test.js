const { extract, searchSubject, noteDay } = require('../../brokers/angelone');
const fs = require('node:fs');
const path = require('node:path');

const sampleText = fs.readFileSync(
  path.join(__dirname, '../fixtures/angelone-sample.txt'),
  'utf-8',
);
const noMatchText = fs.readFileSync(
  path.join(__dirname, '../fixtures/angelone-no-match.txt'),
  'utf-8',
);
const mixedText = fs.readFileSync(
  path.join(__dirname, '../fixtures/angelone-mixed-segments.txt'),
  'utf-8',
);
const equityOnlyText = fs.readFileSync(
  path.join(__dirname, '../fixtures/angelone-equity-only.txt'),
  'utf-8',
);

describe('angelone.extract()', () => {
  test('extracts all three fields from valid PDF text', () => {
    const result = extract(sampleText);
    expect(result.error).toBeUndefined();
    expect(typeof result.payin_payout_obligation).toBe('number');
    expect(typeof result.net_brokerage).toBe('number');
    expect(typeof result.other_charges).toBe('number');
    expect(Number.isFinite(result.payin_payout_obligation)).toBe(true);
    expect(Number.isFinite(result.net_brokerage)).toBe(true);
    expect(Number.isFinite(result.other_charges)).toBe(true);
  });

  test('net_brokerage is non-negative', () => {
    expect(extract(sampleText).net_brokerage).toBeGreaterThanOrEqual(0);
  });

  test('other_charges is non-negative', () => {
    expect(extract(sampleText).other_charges).toBeGreaterThanOrEqual(0);
  });

  test('payin - (brokerage + other_charges) equals PDF final net', () => {
    // Regression: Angel One's obligation already has brokerage deducted; payin must add it back.
    // The note shows Pay In/Out Obligation = -1920.00, Brokerage = 120.00, Final Net = -2028.12
    const result = extract(sampleText);
    const computedFinalNet =
      result.payin_payout_obligation - (result.net_brokerage + result.other_charges);
    expect(computedFinalNet).toBeCloseTo(-2028.12, 1);
  });

  test('payin_payout_obligation is raw P&L before charges (obligation + brokerage added back)', () => {
    const result = extract(sampleText);
    expect(result.payin_payout_obligation).toBeCloseTo(-1800, 1);
  });

  test('returns error when the obligation table is not present', () => {
    const result = extract(noMatchText);
    expect(result.error).toMatch(/Obligation Details table not found/);
  });

  test('error includes text preview', () => {
    const result = extract(noMatchText);
    expect(result.error).toMatch(/Text preview:/);
  });

  test('returns error for empty text', () => {
    expect(extract('').error).toBeDefined();
  });

  test('returns error for null/undefined text', () => {
    expect(extract(null).error).toBeDefined();
    expect(extract(undefined).error).toBeDefined();
  });
});

describe('angelone.extract() segment filtering', () => {
  test('ignores the cash/equity row when a note mixes equity and F&O', () => {
    // Same F&O trades as the F&O-only sample, plus an NSE-CASH row.
    const mixed = extract(mixedText);
    const fnoOnly = extract(sampleText);
    expect(mixed.error).toBeUndefined();
    expect(mixed.payin_payout_obligation).toBeCloseTo(fnoOnly.payin_payout_obligation, 2);
    expect(mixed.net_brokerage).toBeCloseTo(fnoOnly.net_brokerage, 2);
    expect(mixed.other_charges).toBeCloseTo(fnoOnly.other_charges, 2);
  });

  test('reports which segments were skipped', () => {
    expect(extract(mixedText).skipped_segments).toEqual(['NSE-CASH (equity)']);
    expect(extract(sampleText).skipped_segments).toEqual([]);
  });

  test('derives per-segment brokerage instead of the all-segment total', () => {
    // The mixed note reports "Total Brokerage = 160.00" across both segments;
    // only the 120.00 charged on the F&O segment may be recorded.
    expect(mixedText).toContain('Total Brokerage = 160.00');
    expect(extract(mixedText).net_brokerage).toBeCloseTo(120, 2);
  });

  test('returns zeros for a note with no F&O segment', () => {
    const result = extract(equityOnlyText);
    expect(result.error).toBeUndefined();
    expect(result.payin_payout_obligation).toBe(0);
    expect(result.net_brokerage).toBe(0);
    expect(result.other_charges).toBe(0);
    expect(result.skipped_segments).toEqual(['NSE-CASH (equity)']);
  });

  test('fails loudly on an unrecognised segment label', () => {
    const result = extract(sampleText.replace(/BSE-FUTURES-1920/, 'BSE-WOMBAT-1920'));
    expect(result.error).toMatch(/unrecognised segment: BSE-WOMBAT/);
  });

  test('does not silently mis-read reordered columns', () => {
    // Swap the obligation and net-amount cells: the obligation/charges identity
    // must no longer hold and the extractor must refuse the row.
    const corrupted = sampleText.replace(
      'BSE-FUTURES-1920.0050.00150.1013.5113.5130.000.101.000.000.00-2028.12',
      'BSE-FUTURES-2028.1250.00150.1013.5113.5130.000.101.000.000.00-1920.00',
    );
    expect(extract(corrupted).error).toMatch(/column mismatch/);
  });
});

describe('angelone.searchSubject() / noteDay()', () => {
  test('searches the fixed contract-note subject', () => {
    expect(searchSubject('R12345678')).toBe('Contract Note - Equity Segment');
  });

  test('reads the session from the attachment name', () => {
    expect(noteDay({ filename: 'CN_R12345678_23102026.pdf', accountId: 'R12345678' })).toBe(
      '2026-10-23',
    );
  });

  test('accepts a revised note named with a suffix', () => {
    expect(noteDay({ filename: 'CN_R12345678_23102026_1.pdf', accountId: 'R12345678' })).toBe(
      '2026-10-23',
    );
  });

  test("ignores another account's note and other files", () => {
    expect(noteDay({ filename: 'CN_R11111111_23102026.pdf', accountId: 'R12345678' })).toBeNull();
    expect(noteDay({ filename: 'ledger.pdf', accountId: 'R12345678' })).toBeNull();
  });
});

describe('angelone.extract() table integrity', () => {
  test('errors when only the all-segment summary row is present', () => {
    const onlyTotal = sampleText.replace(
      'BSE-FUTURES-1920.0050.00150.1013.5113.5130.000.101.000.000.00-2028.12\n',
      '',
    );
    expect(extract(onlyTotal).error).toMatch(/no per-segment rows/);
  });
});
