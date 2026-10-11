import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTING,
  type PortfolioStopSetting,
  amountOf,
  buttonLabel,
  isOn,
  parseStored,
  problems,
  queryOf,
  summary,
  trailParam,
} from '../portfolioStop';

const make = (over: Partial<PortfolioStopSetting>): PortfolioStopSetting => ({
  ...DEFAULT_SETTING,
  ...over,
});

describe('the stop amount', () => {
  it('defaults to 10,000', () => {
    expect(amountOf(DEFAULT_SETTING)).toBe(10000);
    expect(queryOf(DEFAULT_SETTING)).toEqual({ stop: '10000', trail: null });
  });

  it.each(['', '  ', '0', '-5', '0.0'])('%j means no stop', (stop) => {
    const s = make({ stop });
    expect(amountOf(s)).toBeNull();
    expect(isOn(s)).toBe(false);
    expect(queryOf(s)).toEqual({ stop: null, trail: null });
  });

  it('reads thousands separators and flags text', () => {
    expect(amountOf(make({ stop: '12,500' }))).toBe(12500);
    expect(problems(make({ stop: 'abc' }))).toEqual(['Stop loss must be a number.']);
  });
});

describe('trailing', () => {
  it('Trail SL needs a stop and both numbers, and the move cannot beat the step', () => {
    expect(problems(make({ mode: 'sl', x: '1000', y: '500' }))).toEqual([]);
    expect(trailParam(make({ mode: 'sl', x: '1000', y: '500' }))).toBe('sl:1000,500');
    expect(problems(make({ mode: 'sl', stop: '', x: '1000', y: '500' }))[0]).toMatch(
      /needs a stop/,
    );
    expect(problems(make({ mode: 'sl', x: '', y: '500' })).join(' ')).toMatch(/profit step/);
    expect(problems(make({ mode: 'sl', x: '500', y: '1000' })).join(' ')).toMatch(
      /cannot move more/,
    );
  });

  it('Lock profit works with no stop loss, and B cannot exceed A', () => {
    const s = make({ stop: '', mode: 'lock', a: '2000', b: '500' });
    expect(problems(s)).toEqual([]);
    expect(isOn(s)).toBe(true);
    expect(queryOf(s)).toEqual({ stop: null, trail: 'lock:2000,500' });
    expect(problems(make({ mode: 'lock', a: '500', b: '2000' })).join(' ')).toMatch(
      /cannot be above/,
    );
  });

  it('Lock and trail sends all four numbers in order', () => {
    const s = make({ mode: 'locktrail', a: '2000', b: '500', x: '1000', y: '250' });
    expect(trailParam(s)).toBe('locktrail:2000,500,1000,250');
  });

  it('a mode with problems sends no trail rather than a wrong one', () => {
    expect(trailParam(make({ mode: 'locktrail', a: '2000', b: '500' }))).toBeNull();
  });
});

describe('the words', () => {
  it('says what each setting does', () => {
    expect(summary(DEFAULT_SETTING)).toBe('No trailing: the stop stays at -₹10,000.');
    expect(summary(make({ stop: '' }))).toMatch(/No portfolio stop/);
    expect(summary(make({ mode: 'sl', x: '1000', y: '500' }))).toBe(
      'Starts at -₹10,000; after +₹1,000 it is -₹9,500, after +₹2,000 it is -₹9,000. It never moves down.',
    );
    expect(summary(make({ mode: 'lock', a: '2000', b: '500' }))).toMatch(
      /Once profit touches ₹2,000 the basket closes if it falls back to ₹500\./,
    );
    expect(summary(make({ mode: 'locktrail', a: '2000', b: '500', x: '1000', y: '250' }))).toMatch(
      /the level is ₹500, then \+₹250 for every further ₹1,000/,
    );
  });

  it('labels the button', () => {
    expect(buttonLabel(DEFAULT_SETTING)).toBe('Portfolio stop ₹10,000');
    expect(buttonLabel(make({ stop: '' }))).toBe('Portfolio stop off');
    expect(buttonLabel(make({ mode: 'sl', x: '1000', y: '500' }))).toBe(
      'Portfolio stop ₹10,000 · trail 1,000 → 500',
    );
    expect(buttonLabel(make({ stop: '0', mode: 'lock', a: '2000', b: '500' }))).toBe(
      'Profit lock · lock 2,000 → 500',
    );
  });
});

describe('what was stored', () => {
  it('restores a good setting and falls back on anything else', () => {
    const s = make({ mode: 'lock', a: '2000', b: '500', stop: '8000' });
    expect(parseStored(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseStored(null)).toEqual(DEFAULT_SETTING);
    expect(parseStored({ mode: 'evil' })).toEqual(DEFAULT_SETTING);
    expect(parseStored({ mode: 'sl', stop: 'x'.repeat(50) }).stop).toBe('10000');
  });
});
