/**
 * Unit tests for scheduled-entry.ts — T-15
 *
 * IST = UTC+5:30.  FixedClock is constructed with a UTC Date so that when the
 * module adds 5h30m it lands on the intended IST minute.
 *
 * Formula: UTC = IST - 5h30m
 *   e.g. IST 10:00 → UTC 04:30 → new Date('2026-01-07T04:30:00Z')
 *
 * Tests:
 *   1. isWithinEntryWindow — allowed when IST time is inside the window
 *   2. isWithinEntryWindow — blocked when IST time is before the window opens
 *   3. isWithinEntryWindow — blocked when IST time is at/after noEntryAfterIST
 *   4. isWithinEntryWindow — allowed when time falls in the second of two windows
 *   5. isEventDay — true for a matching date
 *   6. isEventDay — false for a non-matching date
 *   7. isEventDay — false for empty eventDates list
 *   8. checkDailyLossCap — allowed when P&L is -4999 and cap is 5000
 *   9. checkDailyLossCap — blocked when P&L exactly equals -dailyLossCap
 *  10. checkDailyLossCap — blocked when P&L is worse than cap (deeper loss)
 */

import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../utils/clock';
import { checkDailyLossCap, isEventDay, isWithinEntryWindow } from '../scheduled-entry';
import type { EntryWindow, ScheduledEntryConfig } from '../scheduled-entry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a ScheduledEntryConfig with a single default window (09:20–14:30)
 * and the default no-entry deadline (14:45).
 *
 * Pass a FixedClock frozen at the UTC equivalent of the IST time under test.
 */
function makeConfig(
  clock: FixedClock,
  overrides?: Partial<ScheduledEntryConfig>,
): ScheduledEntryConfig {
  return {
    entryWindows: [{ openIST: '09:20', closeIST: '14:30' }],
    noEntryAfterIST: '14:45',
    clock,
    ...overrides,
  };
}

/**
 * Create a FixedClock pinned to the UTC instant that corresponds to a given
 * IST time on an arbitrary fixed date (2026-01-07).
 *
 * IST hour/min → UTC: subtract 5h30m.
 * The date part of the ISO string is chosen to avoid midnight rollovers for
 * any IST time >= 05:30 (earliest window open is 09:20).
 */
function clockAtIST(istHour: number, istMin: number): FixedClock {
  // Compute UTC equivalent: shift back by 5h30m (= 330 minutes).
  const totalISTMinutes = istHour * 60 + istMin;
  const totalUTCMinutes = totalISTMinutes - 330; // 330 = 5*60+30
  const utcHour = Math.floor(totalUTCMinutes / 60);
  const utcMin = totalUTCMinutes % 60;

  // Zero-pad for ISO string construction.
  const hh = String(utcHour).padStart(2, '0');
  const mm = String(utcMin).padStart(2, '0');
  return new FixedClock(new Date(`2026-01-07T${hh}:${mm}:00Z`));
}

// ---------------------------------------------------------------------------
// isWithinEntryWindow
// ---------------------------------------------------------------------------

describe('isWithinEntryWindow', () => {
  it('returns allowed when IST time is inside the configured window', () => {
    // IST 10:00 is inside 09:20–14:30.
    const clock = clockAtIST(10, 0);
    const result = isWithinEntryWindow(makeConfig(clock));

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('within entry window');
  });

  it('returns not allowed when IST time is before the window opens', () => {
    // IST 09:00 is before the 09:20 open.
    const clock = clockAtIST(9, 0);
    const result = isWithinEntryWindow(makeConfig(clock));

    expect(result.allowed).toBe(false);
    // The time is before the window, not after the deadline — reason must
    // indicate "outside entry window", not the deadline message.
    expect(result.reason).toBe('outside entry window');
  });

  it('returns not allowed when IST time equals noEntryAfterIST', () => {
    // IST 14:45 exactly equals the deadline — must be blocked.
    const clock = clockAtIST(14, 45);
    const result = isWithinEntryWindow(makeConfig(clock));

    expect(result.allowed).toBe(false);
    // Deadline check fires first, so reason contains the deadline time.
    expect(result.reason).toContain('14:45');
  });

  it('returns not allowed when IST time is after noEntryAfterIST', () => {
    // IST 15:00 is past the 14:45 deadline.
    const clock = clockAtIST(15, 0);
    const result = isWithinEntryWindow(makeConfig(clock));

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('14:45');
  });

  it('returns allowed when time falls in the second of two configured windows', () => {
    // Two windows: morning 09:20–10:30, afternoon 13:00–14:30.
    // IST 13:15 is in the afternoon window only.
    const windows: EntryWindow[] = [
      { openIST: '09:20', closeIST: '10:30' },
      { openIST: '13:00', closeIST: '14:30' },
    ];
    const clock = clockAtIST(13, 15);
    const result = isWithinEntryWindow(makeConfig(clock, { entryWindows: windows }));

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('within entry window');
  });

  it('returns not allowed when time is between two windows (gap)', () => {
    // IST 11:00 is between the morning close (10:30) and afternoon open (13:00).
    const windows: EntryWindow[] = [
      { openIST: '09:20', closeIST: '10:30' },
      { openIST: '13:00', closeIST: '14:30' },
    ];
    const clock = clockAtIST(11, 0);
    const result = isWithinEntryWindow(makeConfig(clock, { entryWindows: windows }));

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('outside entry window');
  });
});

// ---------------------------------------------------------------------------
// isEventDay
// ---------------------------------------------------------------------------

describe('isEventDay', () => {
  it('returns true when the date matches an event date', () => {
    const date = new Date('2026-05-19T00:00:00Z');
    const result = isEventDay(date, ['2026-05-18', '2026-05-19', '2026-05-20']);
    expect(result).toBe(true);
  });

  it('returns false when the date does not match any event date', () => {
    const date = new Date('2026-05-21T00:00:00Z');
    const result = isEventDay(date, ['2026-05-18', '2026-05-19', '2026-05-20']);
    expect(result).toBe(false);
  });

  it('returns false when the eventDates list is empty', () => {
    const date = new Date('2026-05-19T00:00:00Z');
    const result = isEventDay(date, []);
    expect(result).toBe(false);
  });

  it('ignores the time component — same calendar date matches regardless of time', () => {
    // Date passed in UTC noon — YYYY-MM-DD portion is still 2026-05-19.
    const date = new Date('2026-05-19T12:00:00Z');
    const result = isEventDay(date, ['2026-05-19']);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkDailyLossCap
// ---------------------------------------------------------------------------

describe('checkDailyLossCap', () => {
  it('returns allowed when P&L is just above the negative cap boundary', () => {
    // -4999 < -5000 is false → not breached.
    const result = checkDailyLossCap(-4999, 5000);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('within daily loss limit');
  });

  it('returns not allowed when P&L exactly equals the negative cap', () => {
    // -5000 <= -5000 → breached (inclusive boundary per spec).
    const result = checkDailyLossCap(-5000, 5000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('daily loss cap breached');
  });

  it('returns not allowed when P&L is deeper than the cap', () => {
    // -6000 <= -5000 → breached.
    const result = checkDailyLossCap(-6000, 5000);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('daily loss cap breached');
  });

  it('returns allowed when P&L is positive (profit day)', () => {
    // +2000 is well above the cap threshold.
    const result = checkDailyLossCap(2000, 5000);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('within daily loss limit');
  });

  it('returns allowed when P&L is zero', () => {
    // 0 is not <= -5000.
    const result = checkDailyLossCap(0, 5000);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('within daily loss limit');
  });
});
