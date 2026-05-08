import { describe, it, expect } from 'bun:test';
import {
  buildWeeklySymbol,
  buildMonthlySymbol,
  buildFyersSymbol,
  isMonthlyExpiry,
  nextThursday,
  nextFriday,
  parseFyersSymbol,
} from '../instrument-registry';

// ── Helpers ────────────────────────────────────────────────────────────────────

function date(year: number, month: number, day: number): Date {
  // month is 1-based for readability
  return new Date(year, month - 1, day, 15, 30, 0, 0);
}

// ── buildWeeklySymbol ──────────────────────────────────────────────────────────

describe('buildWeeklySymbol', () => {
  it('NIFTY May 8 2025 CE 24000 → NSE:NIFTY255824000CE', () => {
    expect(buildWeeklySymbol('NIFTY', date(2025, 5, 8), 24000, 'CE')).toBe('NSE:NIFTY255824000CE');
  });

  it('NIFTY May 29 2025 CE 24000 → NSE:NIFTY255924000CE', () => {
    expect(buildWeeklySymbol('NIFTY', date(2025, 5, 29), 24000, 'CE')).toBe('NSE:NIFTY255924000CE');
  });

  it('BANKNIFTY May 8 2025 CE 52000 → NSE:NIFTYBANK255852000CE (uses NIFTYBANK not BANKNIFTY)', () => {
    expect(buildWeeklySymbol('BANKNIFTY', date(2025, 5, 8), 52000, 'CE')).toBe('NSE:NIFTYBANK255852000CE');
  });

  it('SENSEX May 9 2025 PE 80000 → BSE:SENSEX255980000PE', () => {
    expect(buildWeeklySymbol('SENSEX', date(2025, 5, 9), 80000, 'PE')).toBe('BSE:SENSEX255980000PE');
  });

  it('October expiry uses month code O', () => {
    expect(buildWeeklySymbol('NIFTY', date(2025, 10, 2), 25000, 'CE')).toBe('NSE:NIFTY25O0225000CE');
  });

  it('November expiry uses month code N', () => {
    expect(buildWeeklySymbol('NIFTY', date(2025, 11, 6), 25000, 'CE')).toBe('NSE:NIFTY25N0625000CE');
  });

  it('December expiry uses month code D', () => {
    expect(buildWeeklySymbol('NIFTY', date(2025, 12, 4), 25000, 'CE')).toBe('NSE:NIFTY25D0425000CE');
  });

  it('single-digit day is zero-padded', () => {
    const sym = buildWeeklySymbol('NIFTY', date(2025, 5, 8), 24000, 'CE');
    // "08" not "8"
    expect(sym).toContain('2558');
  });
});

// ── buildMonthlySymbol ─────────────────────────────────────────────────────────

describe('buildMonthlySymbol', () => {
  it('NIFTY May 29 2025 CE 24000 → NSE:NIFTY25MAY202524000CE', () => {
    expect(buildMonthlySymbol('NIFTY', date(2025, 5, 29), 24000, 'CE')).toBe('NSE:NIFTY25MAY202524000CE');
  });

  it('December uses DEC abbreviation not D', () => {
    const sym = buildMonthlySymbol('NIFTY', date(2025, 12, 25), 25000, 'PE');
    expect(sym).toContain('DEC');
    expect(sym).not.toMatch(/25D\d/);
  });

  it('year in symbol is 4-digit', () => {
    const sym = buildMonthlySymbol('NIFTY', date(2025, 5, 29), 24000, 'CE');
    expect(sym).toContain('2025');
  });

  it('BANKNIFTY monthly uses NIFTYBANK segment', () => {
    const sym = buildMonthlySymbol('BANKNIFTY', date(2025, 5, 29), 52000, 'CE');
    expect(sym).toMatch(/^NSE:NIFTYBANK/);
  });
});

// ── isMonthlyExpiry ────────────────────────────────────────────────────────────

describe('isMonthlyExpiry', () => {
  it('May 29 2025 (last Thursday of May) → true', () => {
    expect(isMonthlyExpiry(date(2025, 5, 29))).toBe(true);
  });

  it('May 8 2025 (not last Thursday) → false', () => {
    expect(isMonthlyExpiry(date(2025, 5, 8))).toBe(false);
  });

  it('May 22 2025 (second-to-last Thursday) → false', () => {
    expect(isMonthlyExpiry(date(2025, 5, 22))).toBe(false);
  });

  it('January 30 2025 (last Thursday of Jan) → true', () => {
    expect(isMonthlyExpiry(date(2025, 1, 30))).toBe(true);
  });
});

// ── nextThursday ───────────────────────────────────────────────────────────────

describe('nextThursday', () => {
  it('Wednesday May 7 → Thursday May 8', () => {
    const result = nextThursday(new Date(2025, 4, 7)); // May 7
    expect(result.getDate()).toBe(8);
    expect(result.getMonth()).toBe(4); // May
  });

  it('Thursday May 8 → same day May 8 (not +7)', () => {
    const result = nextThursday(new Date(2025, 4, 8)); // May 8
    expect(result.getDate()).toBe(8);
  });

  it('Friday May 9 → next Thursday May 15', () => {
    const result = nextThursday(new Date(2025, 4, 9)); // May 9
    expect(result.getDate()).toBe(15);
  });

  it('Sunday May 11 → Thursday May 15', () => {
    const result = nextThursday(new Date(2025, 4, 11)); // May 11
    expect(result.getDate()).toBe(15);
  });

  it('result time is 15:30:00', () => {
    const result = nextThursday(new Date(2025, 4, 7));
    expect(result.getHours()).toBe(15);
    expect(result.getMinutes()).toBe(30);
    expect(result.getSeconds()).toBe(0);
  });
});

// ── nextFriday ─────────────────────────────────────────────────────────────────

describe('nextFriday', () => {
  it('Thursday May 8 → Friday May 9', () => {
    const result = nextFriday(new Date(2025, 4, 8)); // May 8
    expect(result.getDate()).toBe(9);
  });

  it('Friday May 9 → same day May 9 (not +7)', () => {
    const result = nextFriday(new Date(2025, 4, 9)); // May 9
    expect(result.getDate()).toBe(9);
  });

  it('Saturday May 10 → next Friday May 16', () => {
    const result = nextFriday(new Date(2025, 4, 10)); // May 10
    expect(result.getDate()).toBe(16);
  });

  it('result time is 15:30:00', () => {
    const result = nextFriday(new Date(2025, 4, 8));
    expect(result.getHours()).toBe(15);
    expect(result.getMinutes()).toBe(30);
  });
});

// ── parseFyersSymbol ───────────────────────────────────────────────────────────

describe('parseFyersSymbol', () => {
  it('parses weekly NIFTY CE symbol', () => {
    const r = parseFyersSymbol('NSE:NIFTY255824000CE');
    expect(r).not.toBeNull();
    expect(r?.underlying).toBe('NIFTY');
    expect(r?.strike).toBe(24000);
    expect(r?.optionType).toBe('CE');
    expect(r?.expiry.getFullYear()).toBe(2025);
    expect(r?.expiry.getMonth()).toBe(4); // May = 4
    expect(r?.expiry.getDate()).toBe(8);
  });

  it('parses weekly BANKNIFTY symbol (NIFTYBANK segment → BANKNIFTY underlying)', () => {
    const r = parseFyersSymbol('NSE:NIFTYBANK255852000CE');
    expect(r?.underlying).toBe('BANKNIFTY');
    expect(r?.strike).toBe(52000);
  });

  it('parses October weekly symbol (O month code)', () => {
    const r = parseFyersSymbol('NSE:NIFTY25O0225000CE');
    expect(r?.expiry.getMonth()).toBe(9); // October = 9
    expect(r?.expiry.getDate()).toBe(2);
  });

  it('returns null for index symbol NSE:NIFTY-INDEX', () => {
    expect(parseFyersSymbol('NSE:NIFTY-INDEX')).toBeNull();
  });

  it('returns null for NSE:INDIAVIX-INDEX', () => {
    expect(parseFyersSymbol('NSE:INDIAVIX-INDEX')).toBeNull();
  });

  it('returns null for BSE:SENSEX-INDEX', () => {
    expect(parseFyersSymbol('BSE:SENSEX-INDEX')).toBeNull();
  });
});

// ── Round-trip tests ───────────────────────────────────────────────────────────

describe('round-trip: buildWeeklySymbol → parseFyersSymbol', () => {
  it('NIFTY round-trip preserves underlying, strike, optionType, expiry', () => {
    const expiry = date(2025, 5, 8);
    const sym    = buildWeeklySymbol('NIFTY', expiry, 24000, 'CE');
    const parsed = parseFyersSymbol(sym);
    expect(parsed?.underlying).toBe('NIFTY');
    expect(parsed?.strike).toBe(24000);
    expect(parsed?.optionType).toBe('CE');
    expect(parsed?.expiry.getDate()).toBe(8);
    expect(parsed?.expiry.getMonth()).toBe(4);
  });

  it('BANKNIFTY round-trip (key test: NIFTYBANK segment must survive parse)', () => {
    const expiry = date(2025, 5, 8);
    const sym    = buildWeeklySymbol('BANKNIFTY', expiry, 52000, 'PE');
    const parsed = parseFyersSymbol(sym);
    expect(parsed?.underlying).toBe('BANKNIFTY');
    expect(parsed?.strike).toBe(52000);
    expect(parsed?.optionType).toBe('PE');
  });

  it('SENSEX round-trip', () => {
    const expiry = date(2025, 5, 9);
    const sym    = buildWeeklySymbol('SENSEX', expiry, 80000, 'PE');
    const parsed = parseFyersSymbol(sym);
    expect(parsed?.underlying).toBe('SENSEX');
    expect(parsed?.strike).toBe(80000);
  });
});

// ── buildFyersSymbol dispatch ──────────────────────────────────────────────────

describe('buildFyersSymbol', () => {
  it('uses weekly format for non-monthly expiry', () => {
    const sym = buildFyersSymbol({ underlying: 'NIFTY', expiry: date(2025, 5, 8), strike: 24000, optionType: 'CE' });
    // Weekly format: no month abbreviation, just digit month code
    expect(sym).toBe('NSE:NIFTY255824000CE');
  });

  it('uses monthly format for last Thursday of the month', () => {
    const sym = buildFyersSymbol({ underlying: 'NIFTY', expiry: date(2025, 5, 29), strike: 24000, optionType: 'CE' });
    expect(sym).toContain('MAY');
  });
});
