import { describe, expect, it } from 'bun:test';
import { DEFAULT_BACKUP_VOLUME, backupDestination } from '../backup.js';
import { firstWeekdayOfMonth } from '../schedule.js';

describe('backup', () => {
  it('goes to the SSD when it is mounted', () => {
    const { dest, fallback } = backupDestination({}, (p) => p === DEFAULT_BACKUP_VOLUME);
    expect(dest).toBe(`${DEFAULT_BACKUP_VOLUME}/TradingData`);
    expect(fallback).toBe(false);
  });

  it('falls back to ~/Downloads when it is not', () => {
    const { dest, fallback } = backupDestination({}, () => false);
    expect(dest.endsWith('/Downloads/TradingData-backup')).toBe(true);
    expect(fallback).toBe(true);
  });

  it('honours BACKUP_VOLUME', () => {
    const { dest } = backupDestination({ BACKUP_VOLUME: '/Volumes/Other' }, () => true);
    expect(dest).toBe('/Volumes/Other/TradingData');
  });

  it('runs on the first Sunday of the month only', () => {
    const firstSunday = firstWeekdayOfMonth(0);
    expect(firstSunday('2026-11-01')).toBe(true); // a Sunday, day 1
    expect(firstSunday('2026-11-08')).toBe(false); // second Sunday
    expect(firstSunday('2026-10-04')).toBe(true);
    expect(firstSunday('2026-10-05')).toBe(false); // Monday
  });
});
