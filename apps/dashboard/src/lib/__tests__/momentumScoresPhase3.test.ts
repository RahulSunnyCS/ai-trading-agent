import { describe, expect, it } from 'vitest';

import {
  type CircuitLock,
  DEFAULT_STOCKS_SETTINGS,
  STRIP_EXAMPLES,
  STRIP_EXAMPLE_LOOKBACKS,
  type StockScore,
  type StocksViewSettings,
  describeSettings,
  lockCounts,
  normalizeSettings,
  sameSettings,
  settingsFit,
  stripExampleScores,
  trendOf,
} from '../momentumScores';

const LOOKBACKS = [1, 2, 4, 8, 13, 26, 52];

const BANK_LEADERS: StocksViewSettings = {
  view: 'leaders',
  group: 'Financials',
  query: ' bank ',
  sort: { key: 'score', lookback: 13, ascending: false },
};

describe('the strip card examples', () => {
  it('each example strip is named by the page the way the card says', () => {
    for (const example of STRIP_EXAMPLES) {
      const stock = {
        scores: stripExampleScores(example.deciles),
      } as unknown as StockScore;
      expect(trendOf(stock), example.trend).toBe(example.trend);
    }
  });

  it('covers every trend tag once, with a decile for every lookback', () => {
    expect(STRIP_EXAMPLES.map((example) => example.trend).sort()).toEqual([
      'emerging',
      'fading',
      'laggard',
      'leader',
      'mixed',
    ]);
    for (const example of STRIP_EXAMPLES) {
      expect(example.deciles).toHaveLength(STRIP_EXAMPLE_LOOKBACKS.length);
      expect(example.deciles.every((d) => d >= 1 && d <= 10)).toBe(true);
    }
  });
});

describe('lockCounts', () => {
  it('counts the lower and upper locks listed', () => {
    const lock = (direction: 'LC' | 'UC'): CircuitLock => ({
      direction,
      start: '2026-01-05',
      end: '2026-01-07',
      days: 3,
      band_pct: 5,
      move_pct: -10,
      ongoing: false,
    });
    expect(lockCounts([lock('LC'), lock('UC'), lock('LC')])).toEqual({ lc: 2, uc: 1 });
    expect(lockCounts([])).toEqual({ lc: 0, uc: 0 });
  });
});

describe('sameSettings', () => {
  it('ignores spaces around the search text, and the lookback of a sort that has none', () => {
    expect(sameSettings(BANK_LEADERS, { ...BANK_LEADERS, query: 'bank' })).toBe(true);
    const byRank = { ...DEFAULT_STOCKS_SETTINGS };
    expect(
      sameSettings(byRank, { ...byRank, sort: { key: 'rank', lookback: 4, ascending: true } }),
    ).toBe(true);
  });
  it('tells apart a different view, group, direction or lookback', () => {
    expect(sameSettings(BANK_LEADERS, { ...BANK_LEADERS, view: 'fading' })).toBe(false);
    expect(sameSettings(BANK_LEADERS, { ...BANK_LEADERS, group: '' })).toBe(false);
    expect(
      sameSettings(BANK_LEADERS, {
        ...BANK_LEADERS,
        sort: { key: 'score', lookback: 13, ascending: true },
      }),
    ).toBe(false);
    expect(
      sameSettings(BANK_LEADERS, {
        ...BANK_LEADERS,
        sort: { key: 'score', lookback: 26, ascending: false },
      }),
    ).toBe(false);
  });
});

describe('normalizeSettings', () => {
  it('accepts a complete view and cuts a very long search', () => {
    expect(normalizeSettings(BANK_LEADERS)).toEqual(BANK_LEADERS);
    expect(normalizeSettings({ ...BANK_LEADERS, query: 'x'.repeat(500) })?.query).toHaveLength(80);
  });
  it('refuses what cannot be applied', () => {
    for (const bad of [
      null,
      [],
      'leaders',
      { ...BANK_LEADERS, view: 'unknown' },
      { ...BANK_LEADERS, sort: null },
      { ...BANK_LEADERS, sort: { key: 'members', lookback: null, ascending: true } },
      { ...BANK_LEADERS, sort: { key: 'score', lookback: null, ascending: true } },
      { ...BANK_LEADERS, sort: { key: 'return', lookback: 2.5, ascending: true } },
      { ...BANK_LEADERS, sort: { key: 'return', lookback: 0, ascending: true } },
    ]) {
      expect(normalizeSettings(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('drops the lookback of a sort that does not use one', () => {
    const view = normalizeSettings({
      ...BANK_LEADERS,
      sort: { key: 'high', lookback: 13, ascending: false },
    });
    expect(view?.sort).toEqual({ key: 'high', lookback: null, ascending: false });
  });
});

describe('settingsFit', () => {
  it('keeps a view whose sector and lookback still exist', () => {
    expect(settingsFit(BANK_LEADERS, ['Financials', 'Energy'], LOOKBACKS)).toEqual(BANK_LEADERS);
  });
  it('falls back to all sectors for a sector that is gone, and to the rank for a lost lookback', () => {
    const fit = settingsFit(
      { ...BANK_LEADERS, sort: { key: 'return', lookback: 39, ascending: false } },
      ['Energy'],
      LOOKBACKS,
    );
    expect(fit.group).toBe('');
    expect(fit.sort).toEqual(DEFAULT_STOCKS_SETTINGS.sort);
    expect(fit.view).toBe('leaders'); // the rest of the view is kept
  });
});

describe('describeSettings', () => {
  it('says what a view holds in one line', () => {
    expect(describeSettings(BANK_LEADERS)).toBe(
      'Leaders · Financials · “bank” · by 13w score, highest first',
    );
  });
  it('says only "All" for the default', () => {
    expect(describeSettings(DEFAULT_STOCKS_SETTINGS)).toBe('All');
  });
  it('names the direction of a rank or name sort', () => {
    expect(
      describeSettings({
        ...DEFAULT_STOCKS_SETTINGS,
        sort: { key: 'rank', lookback: null, ascending: false },
      }),
    ).toBe('All · by rank, weakest first');
    expect(
      describeSettings({
        ...DEFAULT_STOCKS_SETTINGS,
        sort: { key: 'name', lookback: null, ascending: true },
      }),
    ).toBe('All · by name, A to Z');
  });
});
