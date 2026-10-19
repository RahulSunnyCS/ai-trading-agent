import { describe, expect, it } from 'vitest';

import type { RotationSummary } from '../../types/rotation';
import type { PortfolioBookRow, PortfolioDays } from '../../types/rotationPortfolio';
import { formatDay } from '../format';
import {
  BASE_STOP_KEYS,
  CORE_STOP_KEYS,
  DEFAULT_BASE_SETTING,
  T1_STOP_KEYS,
  amountOf,
  buttonLabel,
} from '../portfolioStop';
import { baseCard } from '../rotationListCards';
import { overlayBase, stopEffect, stopEffectRows } from '../rotationPortfolioView';

function row(
  without: number,
  withStop: number,
  label: string | null = null,
  over: Partial<PortfolioBookRow> = {},
): PortfolioBookRow {
  return {
    lots: 3,
    gross_log: without,
    gross_without: without,
    gross_with: withStop,
    stop_minute: label ? 100 : null,
    stop_label: label,
    fired_by: label ? 'stop' : null,
    matches_log: true,
    ...over,
  };
}

function book(key: 'C' | 'BASE', rows: [string, PortfolioBookRow][]): PortfolioDays {
  return {
    basis: 'gross',
    source: 'recorded',
    setting: { amount: 8000, trail: null },
    rows: rows.map(([day, r]) => ({ day, lists: { [key]: r } })),
    errors: [],
    totals: {},
  };
}

describe('stopEffect: what the stop changed, over the card’s own days', () => {
  const b = book('C', [
    ['2026-10-12', row(1000, 1000)],
    ['2026-10-13', row(-12000, -8100, '10:40')],
    ['2026-10-14', row(3000, 3000)],
    ['2026-10-15', row(-9000, -8050, '13:05')],
    ['2026-10-16', row(500, 500, null, { matches_log: false })],
  ]);
  const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19'];

  it('adds up with and without, the fired days and their net effect', () => {
    const e = stopEffect(b, 'C', days);
    expect(e).not.toBeNull();
    if (!e) return;
    expect(e.days).toBe(4);
    expect(e.totalWithout).toBe(1000 - 12000 + 3000 - 9000);
    expect(e.totalWith).toBe(1000 - 8100 + 3000 - 8050);
    expect(e.firedDays).toBe(2);
    expect(e.firedEffect).toBe(-8100 + 12000 + (-8050 + 9000));
    // from the running peak (starting at zero): without 1000, -11000, -8000, -17000; with 1000,
    // -7100, -4100, -12150
    expect(e.ddWithout).toBe(-18000);
    expect(e.ddWith).toBe(-13150);
    // the unmatched day and the day with no replay are not counted
    expect(e.skipped).toBe(2);
    expect(e.latest).toEqual({
      day: '2026-10-15',
      with: -8050,
      without: -9000,
      stopLabel: '13:05',
    });
  });

  it('only counts the card’s own days, and is null before a replay or a day', () => {
    expect(stopEffect(b, 'C', ['2026-10-12'])?.days).toBe(1);
    expect(stopEffect(null, 'C', days)).toBeNull();
    expect(stopEffect(b, 'C', [])).toBeNull();
    expect(stopEffect(b, 'BASE', days)).toBeNull(); // no BASE rows in a list book
  });

  it('says what happened in plain lines', () => {
    const e = stopEffect(b, 'C', days);
    if (!e) throw new Error('no effect');
    const lines = Object.fromEntries(stopEffectRows(e).map((r) => [r.label, r.value]));
    expect(lines[`Latest day, ${formatDay('2026-10-15')}`]).toBe('-₹8,050 with · -₹9,000 without');
    expect(lines['That day']).toBe('stop reached at 13:05: +₹950');
    expect(lines['Since the first day']).toBe('-₹12,150 with · -₹17,000 without · +₹4,850');
    expect(lines['Max drawdown']).toBe('-₹13,150 with · -₹18,000 without');
    expect(lines['Stop fired']).toBe('on 2 of 4 days, net +₹4,850');
    expect(lines['Not counted']).toBe('2 days with no matching replay');
  });

  it('says "stop not reached" on a day it did not fire', () => {
    const quiet = stopEffect(book('C', [['2026-10-12', row(1000, 1000)]]), 'C', ['2026-10-12']);
    if (!quiet) throw new Error('no effect');
    const lines = stopEffectRows(quiet);
    expect(lines.find((l) => l.label === 'That day')?.value).toBe('stop not reached');
    expect(lines.find((l) => l.label === 'Stop fired')?.value).toBe('on none of 1 day');
    expect(lines.some((l) => l.label === 'Not counted')).toBe(false);
  });
});

const summary = {
  n_days: 2,
  base: {
    definition: '',
    per_lot_day: 100,
    cumulative_per_lot: 200,
    max_drawdown_per_lot: 0,
    lots_per_day: 3,
    total: 600,
    max_drawdown: -50,
  },
  lists: {},
  days: [
    { day: '2026-10-12', base: 400, base_total: 1200 },
    { day: '2026-10-13', base: -200, base_total: -600 },
  ],
} as unknown as RotationSummary;

describe('the Fixed base card', () => {
  it('reads the read-out’s base over the same sessions, with no gap to itself', () => {
    const c = baseCard(summary);
    expect(c).toMatchObject({ id: 'BASE', key: null, isBase: true, name: 'Fixed base' });
    expect(c.note).toMatch(/2 × NIFTY Widesl OTM1 09:17 \+ 1 × NIFTY Dir ATM 09:24/);
    expect(c.latest).toEqual({ day: '2026-10-13', total: -600 });
    expect(c.total).toBe(600);
    expect(c.maxDrawdown).toBe(-50);
    expect(c.vsBase).toBeNull();
    const empty = baseCard({ ...summary, n_days: 0, days: [] } as RotationSummary);
    expect([empty.latest, empty.total, empty.maxDrawdown]).toEqual([null, null, null]);
  });

  it('follows its own stop, and only its card: the list figures are left alone', () => {
    const b = book('BASE', [['2026-10-13', row(-600, -400, '11:00')]]);
    const s = overlayBase(summary, b);
    expect(s.days?.[1]?.base_total).toBe(-400);
    expect(s.days?.[1]?.base).toBeCloseTo(-400 / 3, 6);
    expect(s.base?.total).toBe(1200 - 400);
    expect(s.base?.max_drawdown).toBe(-400);
    expect(baseCard(s).total).toBe(800);
    // a day that no longer replays to its stored figure keeps the registered one
    const stale = book('BASE', [['2026-10-13', row(-600, -400, '11:00', { matches_log: false })]]);
    expect(overlayBase(summary, stale)).toBe(summary);
    expect(overlayBase(summary, null)).toBe(summary);
  });

  it('has its own ₹8,000 stop in its own URL keys and storage', () => {
    expect(amountOf(DEFAULT_BASE_SETTING)).toBe(8000);
    expect(buttonLabel(DEFAULT_BASE_SETTING)).toBe('Portfolio stop ₹8,000');
    expect(BASE_STOP_KEYS).toMatchObject({ stopParam: 'pfstop_base', trailParam: 'pftrail_base' });
    const storage = [CORE_STOP_KEYS, T1_STOP_KEYS, BASE_STOP_KEYS].map((k) => k.storageKey);
    expect(new Set(storage).size).toBe(3);
  });
});
