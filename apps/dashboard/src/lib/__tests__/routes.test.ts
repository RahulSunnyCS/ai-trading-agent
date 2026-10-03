import { describe, expect, it } from 'vitest';

import { buildPath, oneOf, parsePath } from '../routes';

describe('routes', () => {
  it('parses a top-level tab', () => {
    expect(parsePath('/pnl')).toEqual({ tab: 'pnl', rest: [] });
  });

  it('parses nested segments and ignores trailing slashes', () => {
    expect(parsePath('/momentum/backtest/broad/')).toEqual({
      tab: 'momentum',
      rest: ['backtest', 'broad'],
    });
  });

  it('treats the root and unknown paths as no tab', () => {
    expect(parsePath('/')).toEqual({ tab: null, rest: [] });
    expect(parsePath('/nope/momentum')).toEqual({ tab: null, rest: [] });
  });

  it('builds paths, skipping empty segments', () => {
    expect(buildPath('momentum', 'backtest', 'etf')).toBe('/momentum/backtest/etf');
    expect(buildPath('optionslab', undefined)).toBe('/optionslab');
  });

  it('round-trips', () => {
    expect(parsePath(buildPath('optionslab', 'builder'))).toEqual({
      tab: 'optionslab',
      rest: ['builder'],
    });
  });

  it('oneOf narrows to allowed values only', () => {
    expect(oneOf(['a', 'b'] as const, 'b')).toBe('b');
    expect(oneOf(['a', 'b'] as const, 'c')).toBeNull();
    expect(oneOf(['a', 'b'] as const, undefined)).toBeNull();
  });
});
