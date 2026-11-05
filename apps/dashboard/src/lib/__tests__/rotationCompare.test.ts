import { describe, expect, it } from 'vitest';

import type { CompareBookFigures, RotationCompareResponse } from '../../types/rotationCompare';
import {
  ALARM_WORDS,
  COMPARE_WINDOWS,
  DEFAULT_COMPARE_WINDOW,
  alarmLine,
  gapCell,
  liveShare,
  rangeText,
  sigmaText,
  windowLabel,
  windowSubtitle,
} from '../rotationCompare';

const fig = (over: Partial<CompareBookFigures> = {}): CompareBookFigures => ({
  edge_sigma: 2.6,
  recorded_days: 11,
  gap_mean: 208,
  gap_lower: -162,
  gap_upper: 596,
  better_days_pct: 53,
  ...over,
});

function response(over: Partial<CompareBookFigures> = {}): RotationCompareResponse {
  const row = {
    days: 118,
    from: '2026-05-06',
    books: {
      t1: fig(over),
      core: fig({ recorded_days: 16, gap_mean: 102, gap_lower: -265, gap_upper: 458 }),
      base: { edge_sigma: 0.2, recorded_days: 0 },
    },
  };
  return {
    n_days: 439,
    first_day: '2025-01-10',
    last_day: '2026-11-05',
    windows: { months6: row },
    alarm: {
      window: 60,
      below: -500,
      books: { t1: { gap: 91, state: 'quiet', last_review_day: null } },
    },
  };
}

describe('compare windows', () => {
  it('offers the four windows and defaults to 6 months', () => {
    expect(COMPARE_WINDOWS.map((w) => w.value)).toEqual([
      'sessions60',
      'months6',
      'year1',
      'years2',
    ]);
    expect(DEFAULT_COMPARE_WINDOW).toBe('months6');
    expect(windowLabel('year1')).toBe('1 year');
  });
});

describe('rangeText', () => {
  it('says a range that spans zero includes it', () => {
    expect(rangeText(fig())).toMatchObject({ includesZero: true });
  });
  it('says a range above zero clears it', () => {
    expect(rangeText(fig({ gap_lower: 74, gap_upper: 435 }))).toMatchObject({
      includesZero: false,
    });
  });
  it('is null for the base, which has no gap', () => {
    expect(rangeText({ edge_sigma: 0.2, recorded_days: 0 })).toBeNull();
  });
});

describe('gapCell', () => {
  const read = (
    data: RotationCompareResponse | null,
    loading = false,
    error: string | null = null,
  ) => ({
    data,
    loading,
    error,
  });
  it('shows the gap with its range for an Adaptive book', () => {
    const c = gapCell(read(response()), 't1', 'months6');
    expect(c).toMatchObject({ kind: 'gap', money: 208, includesZero: true });
  });
  it('is "the base" for the base itself, whatever was read', () => {
    expect(gapCell(undefined, 'base', 'months6')).toEqual({ kind: 'base' });
  });
  it('is loading, an error or a dash, never a zero', () => {
    expect(gapCell(read(null, true), 't1', 'months6')).toEqual({ kind: 'loading' });
    expect(gapCell(read(null, false, 'boom'), 't1', 'months6')).toEqual({
      kind: 'error',
      text: 'boom',
    });
    expect(gapCell(read(response()), 't1', 'year1')).toEqual({ kind: 'none' });
  });
});

describe('sigmaText', () => {
  it('formats one decimal and a σ', () => {
    expect(sigmaText(fig())).toBe('2.6 σ');
  });
  it('is null without a spread or a figure', () => {
    expect(sigmaText(fig({ edge_sigma: null }))).toBeNull();
    expect(sigmaText(undefined)).toBeNull();
  });
});

describe('text helpers', () => {
  it('says how many sessions were live', () => {
    const row = response().windows.months6;
    expect(liveShare(row)).toContain('11 (Tuned) and 16 (Classic) were recorded live');
  });
  it('titles the window with its first and last session', () => {
    const t = windowSubtitle(response(), 'months6');
    expect(t).toContain('6 months · 118 sessions from');
  });
  it('words the alarm rule with the line and window', () => {
    expect(alarmLine(-500, 60)).toContain('60-session gap');
    expect(ALARM_WORDS.review.tone).toBe('negative');
  });
});
