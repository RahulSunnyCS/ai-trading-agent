import { describe, expect, it } from 'vitest';

import {
  EMPTY,
  formatDay,
  formatDuration,
  formatInr,
  formatInt,
  formatIstDate,
  formatIstDateTimeShort,
  formatIstTime,
  formatMultiple,
  formatNumber,
  formatPct,
  formatPp,
  formatRelative,
} from '../format';

describe('numbers', () => {
  it('groups the Indian way and fixes decimals', () => {
    expect(formatNumber(1234567.891)).toBe('12,34,567.89');
    expect(formatNumber(1.5, 0)).toBe('2');
    expect(formatNumber(2, 2, { trim: true })).toBe('2');
    expect(formatNumber(2.5, 2, { trim: true })).toBe('2.5');
    expect(formatNumber(0.5, 2, { sign: true })).toBe('+0.50');
    expect(formatNumber(-0.5, 2, { sign: true })).toBe('-0.50');
    expect(formatInt(123456)).toBe('1,23,456');
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    'renders %s as the empty marker in every formatter',
    (value) => {
      for (const format of [
        formatNumber,
        formatInt,
        formatInr,
        formatPct,
        formatPp,
        formatMultiple,
      ]) {
        expect(format(value)).toBe(EMPTY);
      }
    },
  );
});

describe('formatInr', () => {
  it('prefixes ₹ and groups en-IN', () => {
    expect(formatInr(123456)).toBe('₹1,23,456');
    expect(formatInr(1234.5, { dp: 2 })).toBe('₹1,234.50');
    expect(formatInr(0)).toBe('₹0');
  });

  it('puts the sign before the rupee symbol', () => {
    expect(formatInr(-1234)).toBe('-₹1,234');
    expect(formatInr(1234, { sign: true })).toBe('+₹1,234');
    expect(formatInr(0, { sign: true })).toBe('₹0');
  });

  it('compacts to lakh and crore', () => {
    expect(formatInr(125_000, { compact: true })).toBe('₹1.25 L');
    expect(formatInr(34_000_000, { compact: true })).toBe('₹3.40 Cr');
    expect(formatInr(-125_000, { compact: true })).toBe('-₹1.25 L');
    expect(formatInr(99_999, { compact: true })).toBe('₹99,999');
  });
});

describe('percentages', () => {
  it('formatPct takes a fraction by default', () => {
    expect(formatPct(0.1234)).toBe('12.3%');
    expect(formatPct(0.1234, 0)).toBe('12%');
    expect(formatPct(-0.05, 1)).toBe('-5.0%');
    expect(formatPct(0.05, 1, { sign: true })).toBe('+5.0%');
  });

  it('formatPct accepts a value already in percent', () => {
    expect(formatPct(12.34, 2, { unit: 'percent' })).toBe('12.34%');
  });

  it('formatPp is always signed', () => {
    expect(formatPp(0.012)).toBe('+1.2 pp');
    expect(formatPp(-0.012)).toBe('-1.2 pp');
    expect(formatPp(0)).toBe('0.0 pp');
    expect(formatPp(1.25, 2, { unit: 'percent' })).toBe('+1.25 pp');
    expect(formatPp(0.012, 1, { sign: false })).toBe('1.2 pp');
  });

  it('formatMultiple', () => {
    expect(formatMultiple(1.234)).toBe('1.2×');
    expect(formatMultiple(1.234, 2)).toBe('1.23×');
  });
});

describe('dates', () => {
  // 18:35 UTC on the 19th is 00:05 IST on the 20th.
  const instant = '2026-05-19T18:35:07.000Z';

  it('formats instants in IST regardless of the host time zone', () => {
    expect(formatIstDate(instant)).toBe('20 May 2026');
    expect(formatIstTime(instant)).toBe('00:05');
    expect(formatIstTime(instant, { seconds: true })).toBe('00:05:07');
    expect(formatIstDateTimeShort(instant)).toBe('20 May 2026, 00:05');
  });

  it('formatDay never shifts a calendar day', () => {
    expect(formatDay('2026-10-05')).toBe('05 Oct 2026');
    expect(formatDay('2026-10-05T00:00:00')).toBe('05 Oct 2026');
  });

  it('renders missing or malformed dates as the empty marker', () => {
    expect(formatIstDate(null)).toBe(EMPTY);
    expect(formatIstTime('not a date')).toBe(EMPTY);
    expect(formatDay('')).toBe(EMPTY);
    expect(formatDay('nope')).toBe(EMPTY);
  });

  it('formatRelative', () => {
    const now = new Date('2026-05-20T10:00:00.000Z');
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
    expect(formatRelative(ago(2), now)).toBe('just now');
    expect(formatRelative(ago(42), now)).toBe('42s ago');
    expect(formatRelative(ago(5 * 60 + 10), now)).toBe('5 min ago');
    expect(formatRelative(ago(3 * 3600 + 5), now)).toBe('3 h ago');
    expect(formatRelative(ago(2 * 86_400 + 5), now)).toBe('2 d ago');
    expect(formatRelative(null, now)).toBe(EMPTY);
  });

  it('formatDuration', () => {
    expect(formatDuration(4200)).toBe('4.2s');
    expect(formatDuration(37_400)).toBe('37s');
    expect(formatDuration(125_000)).toBe('2m 05s');
    expect(formatDuration(null)).toBe(EMPTY);
  });
});
