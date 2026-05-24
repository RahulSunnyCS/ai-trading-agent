/**
 * Unit tests for src/frontend/lib/format.ts
 *
 * All IST date/time assertions pass explicit Date instances so the tests are
 * deterministic regardless of the host machine's local timezone (CI servers
 * typically run in UTC; developer machines may be in any timezone).
 */

import { describe, it, expect } from 'vitest';
import { toNumberOrNull, formatPnl, formatIstDateTime, istToday } from '../format.js';

// ---------------------------------------------------------------------------
// toNumberOrNull
// ---------------------------------------------------------------------------

describe('toNumberOrNull', () => {
  it('returns null for null input', () => {
    expect(toNumberOrNull(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(toNumberOrNull(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(toNumberOrNull('')).toBeNull();
  });

  it('returns null for a non-numeric string (NaN after parseFloat)', () => {
    expect(toNumberOrNull('abc')).toBeNull();
  });

  it('returns null for a string that is only whitespace (parseFloat returns NaN)', () => {
    // parseFloat('   ') returns NaN — treated as absent/malformed
    expect(toNumberOrNull('   ')).toBeNull();
  });

  it('parses a valid positive numeric string', () => {
    expect(toNumberOrNull('1234.50')).toBe(1234.5);
  });

  it('parses a valid negative numeric string', () => {
    expect(toNumberOrNull('-50.00')).toBe(-50);
  });

  it('passes a number through unchanged (positive)', () => {
    expect(toNumberOrNull(42)).toBe(42);
  });

  it('passes a number through unchanged (zero)', () => {
    expect(toNumberOrNull(0)).toBe(0);
  });

  it('passes a number through unchanged (negative)', () => {
    expect(toNumberOrNull(-99.9)).toBe(-99.9);
  });

  it('returns null for the number NaN', () => {
    // NaN is a valid JS number type value but semantically absent — must return null
    expect(toNumberOrNull(NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatPnl
// ---------------------------------------------------------------------------

describe('formatPnl', () => {
  it('formats a positive value with a "+" prefix', () => {
    // en-IN locale: 1,234.50
    expect(formatPnl(1234.5)).toBe('+1,234.50');
  });

  it('formats a negative value with a "-" prefix', () => {
    expect(formatPnl(-50)).toBe('-50.00');
  });

  it('formats zero with no sign (neither + nor -)', () => {
    // "+" on zero is misleading — zero is neither profit nor loss
    expect(formatPnl(0)).toBe('0.00');
  });

  it('formats a small positive value with 2 decimal places', () => {
    expect(formatPnl(0.5)).toBe('+0.50');
  });

  it('formats a small negative value with 2 decimal places', () => {
    expect(formatPnl(-0.01)).toBe('-0.01');
  });

  it('uses en-IN lakh grouping for large values', () => {
    // 1,00,000.00 is the Indian convention (lakh separator)
    expect(formatPnl(100000)).toBe('+1,00,000.00');
  });

  it('rounds to 2 decimal places (down)', () => {
    expect(formatPnl(1.234)).toBe('+1.23');
  });

  it('rounds to 2 decimal places (up)', () => {
    expect(formatPnl(1.235)).toBe('+1.24');
  });
});

// ---------------------------------------------------------------------------
// formatIstDateTime
// ---------------------------------------------------------------------------

describe('formatIstDateTime', () => {
  it('converts a UTC timestamp to the correct IST date-time string', () => {
    // 2026-05-28T09:15:00Z  →  IST 14:45:00 on 2026-05-28  (UTC+5:30)
    // en-IN Intl format with hour12:false: "28/05/2026, 14:45:00"
    const result = formatIstDateTime('2026-05-28T09:15:00.000Z');
    expect(result).toBe('28/05/2026, 14:45:00');
  });

  it('is stable regardless of host timezone (same input, same output on any machine)', () => {
    // UTC midnight on 2026-01-01 is 05:30 IST on 2026-01-01
    const result = formatIstDateTime('2026-01-01T00:00:00.000Z');
    // The host machine's local timezone does NOT affect this output because
    // Intl.DateTimeFormat is pinned to 'Asia/Kolkata'.
    expect(result).toBe('01/01/2026, 05:30:00');
  });

  it('correctly renders an IST time before midnight (UTC the next day)', () => {
    // 2026-05-27T20:00:00Z  →  IST 01:30:00 on 2026-05-28
    const result = formatIstDateTime('2026-05-27T20:00:00.000Z');
    expect(result).toBe('28/05/2026, 01:30:00');
  });
});

// ---------------------------------------------------------------------------
// istToday — IST "today" boundary correctness
// ---------------------------------------------------------------------------

describe('istToday', () => {
  it('returns the correct IST date for a UTC time well within the day', () => {
    // 2026-05-28T10:00:00Z → IST 15:30 on 2026-05-28
    const result = istToday(new Date('2026-05-28T10:00:00.000Z'));
    expect(result).toBe('2026-05-28');
  });

  it('returns the PREVIOUS IST date for a UTC time just before IST midnight', () => {
    // IST midnight on 2026-05-28 = 2026-05-27T18:30:00Z
    // One second earlier: 2026-05-27T18:29:59Z → IST 23:59:59 on 2026-05-27
    const justBefore = new Date('2026-05-27T18:29:59.000Z');
    expect(istToday(justBefore)).toBe('2026-05-27');
  });

  it('returns the NEXT IST date exactly at IST midnight', () => {
    // 2026-05-27T18:30:00Z → IST 00:00:00 on 2026-05-28
    const atMidnight = new Date('2026-05-27T18:30:00.000Z');
    expect(istToday(atMidnight)).toBe('2026-05-28');
  });

  it('handles a UTC time that is ahead of IST (next UTC day, same IST day)', () => {
    // 2026-05-28T20:00:00Z → IST 01:30:00 on 2026-05-29
    const result = istToday(new Date('2026-05-28T20:00:00.000Z'));
    expect(result).toBe('2026-05-29');
  });

  it('returns a YYYY-MM-DD formatted string (not local-timezone date parts)', () => {
    // Verify format shape; any valid IST date must match this pattern
    const result = istToday(new Date('2026-05-28T09:15:00.000Z'));
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
