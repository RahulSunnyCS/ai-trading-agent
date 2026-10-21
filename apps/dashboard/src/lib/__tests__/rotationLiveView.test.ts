import { describe, expect, it } from 'vitest';

import { EMPTY } from '../format';
import {
  chartLines,
  dayBadges,
  emptyState,
  groupLabel,
  newestFirst,
  shapeThin,
  slippageText,
} from '../rotationLiveView';
import { day, response, running, shape } from './rotationLiveFixture';

describe('groupLabel', () => {
  it('names platform, broker and list, leaving out AlgoTest\'s own "all"', () => {
    expect(groupLabel({ platform: 'algotest', broker: 'finvasia', book: 't1' })).toBe(
      'AlgoTest · Shoonya · T1',
    );
    expect(groupLabel({ platform: 'quantiply', broker: 'angelone', book: 'core' })).toBe(
      'Quantiply · Angel One · Core',
    );
    expect(groupLabel({ platform: 'algotest', broker: 'all', book: null })).toBe('AlgoTest');
  });
});

describe('slippageText', () => {
  it('signs the amount and adds the percentage only where it is known', () => {
    expect(slippageText(120)).toBe('+₹120');
    expect(slippageText(-100, -0.4)).toContain('-₹100');
    expect(slippageText(-100, -0.4)).toContain('-0.4%');
    expect(slippageText(null)).toBe(EMPTY);
  });
});

describe('chartLines', () => {
  it('is one cumulative-slippage line per list, empty before a compared day', () => {
    expect(chartLines(response({ running: [] }))).toEqual([]);
    const [line] = chartLines(response());
    expect(line?.id).toBe('AlgoTest · Shoonya · T1');
    expect(line?.points).toEqual([{ time: '2026-10-21', value: -100 }]);
  });
});

describe('emptyState', () => {
  it('says why there is nothing to show, and is null once a day is compared', () => {
    expect(emptyState(response())).toBeNull();
    expect(emptyState(response({ running: [], days: [] }))?.title).toBe('No live capture yet');
    expect(emptyState(response({ running: [] }))?.title).toBe('No day compared yet');
  });
});

describe('dayBadges', () => {
  it('flags what was left out of the gap, and a missing capture', () => {
    expect(dayBadges(day({ captured: false }))).toEqual([
      { tone: 'warning', text: 'Not captured' },
    ]);
    const texts = dayBadges(
      day({
        not_traded: ['a', 'b'],
        off_slot: ['c'],
        open_legs: ['d'],
        no_paper: ['e'],
        failed_sections: [{ platform: 'quantiply', broker: 'angelone', error: 'login' }],
      }),
    ).map((b) => b.text);
    expect(texts).toEqual([
      'Quantiply not read',
      '2 did not trade',
      '1 off-slot',
      '1 with legs open',
      '1 no paper result',
    ]);
    expect(dayBadges(day())).toEqual([]);
  });
});

describe('newestFirst / shapeThin', () => {
  it('reverses without mutating, and calls under 5 variant-days thin', () => {
    const days = [day({ day: '2026-10-20' }), day({ day: '2026-10-21' })];
    expect(newestFirst(days).map((d) => d.day)).toEqual(['2026-10-21', '2026-10-20']);
    expect(days[0]?.day).toBe('2026-10-20');
    expect(shapeThin(shape({ variant_days: 4 }))).toBe(true);
    expect(shapeThin(shape({ variant_days: 5 }))).toBe(false);
    expect(running().points.length).toBe(1);
  });
});
