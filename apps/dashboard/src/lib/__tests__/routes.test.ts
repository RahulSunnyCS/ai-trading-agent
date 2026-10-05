import { describe, expect, it } from 'vitest';

import { NAV_GROUPS } from '../../components/shell/nav';
import {
  DEFAULT_TAB,
  MOMENTUM_SECTIONS,
  OPTIONS_LAB_SECTIONS,
  PATH_ALIASES,
  aliasTarget,
  buildPath,
  documentTitle,
  oneOf,
  parsePath,
} from '../routes';

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

  // Every path that has ever resolved must keep landing on its view. When a tab is renamed
  // or merged, its old path moves to PATH_ALIASES and stays in this table.
  it.each([
    ['/overview', 'overview', []],
    ['/live', 'live', []],
    ['/trades', 'trades', []],
    ['/personalities', 'personalities', []],
    ['/pnl', 'pnl', []],
    ['/regime', 'regime', []],
    ['/backfill', 'backfill', []],
    ['/replay', 'replay', []],
    ['/backtest', 'backtest', []],
    ['/optionslab', 'optionslab', []],
    ['/optionslab/results', 'optionslab', ['results']],
    ['/optionslab/regimes', 'optionslab', ['regimes']],
    ['/optionslab/builder', 'optionslab', ['builder']],
    ['/momentum', 'momentum', []],
    ['/momentum/backtest', 'momentum', ['backtest']],
    ['/momentum/backtest/etf', 'momentum', ['backtest', 'etf']],
    ['/momentum/backtest/stock', 'momentum', ['backtest', 'stock']],
    ['/momentum/backtest/custom_index', 'momentum', ['backtest', 'custom_index']],
    ['/momentum/backtest/broad', 'momentum', ['backtest', 'broad']],
    ['/momentum/scores', 'momentum', ['scores']],
    ['/momentum/scores/stocks', 'momentum', ['scores', 'stocks']],
    ['/momentum/scores/sectors', 'momentum', ['scores', 'sectors']],
    ['/momentum/saved', 'momentum', ['saved']],
    ['/momentum/weekly', 'momentum', ['weekly']],
    ['/momentum/rebalance', 'momentum', ['rebalance']],
    ['/brokerLogins', 'brokerLogins', []],
    ['/pricing', 'pricing', []],
    ['/settings', 'settings', []],
  ] as const)('known path %s resolves to %s', (path, tab, rest) => {
    expect(parsePath(path)).toEqual({ tab, rest: [...rest] });
    expect(aliasTarget(path)).toBeNull();
  });

  it.each([
    ['/billing', '/pricing', 'pricing', []],
    ['/brokers', '/brokerLogins', 'brokerLogins', []],
    ['/brokerlogins', '/brokerLogins', 'brokerLogins', []],
    ['/data/backfill', '/backfill', 'backfill', []],
    ['/data/replay', '/replay', 'replay', []],
    ['/optionslab/yaml', '/backtest', 'backtest', []],
    ['/data/replay/', '/replay', 'replay', []],
    ['/billing/extra', '/pricing/extra', 'pricing', ['extra']],
  ] as const)('alias %s redirects to %s', (path, target, tab, rest) => {
    expect(aliasTarget(path)).toBe(target);
    expect(parsePath(path)).toEqual({ tab, rest: [...rest] });
    expect(parsePath(target)).toEqual({ tab, rest: [...rest] });
  });

  it('every alias points at a known tab and never at another alias', () => {
    for (const target of Object.values(PATH_ALIASES)) {
      expect(parsePath(target).tab).not.toBeNull();
      expect(aliasTarget(target)).toBeNull();
    }
  });

  it('does not treat a partial segment or an unknown path as an alias', () => {
    expect(aliasTarget('/billings')).toBeNull();
    expect(aliasTarget('/data')).toBeNull();
    expect(parsePath('/data')).toEqual({ tab: null, rest: [] });
    expect(parsePath('/optionslab/yamlish')).toEqual({ tab: 'optionslab', rest: ['yamlish'] });
  });

  it('survives a malformed percent-escape', () => {
    expect(parsePath('/%E0%A4%A')).toEqual({ tab: null, rest: [] });
  });

  it('nested nav links are exactly the sub-routes the views accept', () => {
    const children = (id: string) =>
      NAV_GROUPS.flatMap((group) => group.items)
        .find((item) => item.id === id)
        ?.children?.map((child) => child.segment);
    expect(children('optionslab')).toEqual([...OPTIONS_LAB_SECTIONS]);
    expect(children('momentum')).toEqual([...MOMENTUM_SECTIONS]);
  });

  it.each([
    ['overview', [], 'Overview · AI Trading Agent'],
    ['trades', [], 'Trades · AI Trading Agent'],
    ['pnl', [], 'P&L · AI Trading Agent'],
    ['backtest', [], 'YAML backtest · AI Trading Agent'],
    ['momentum', ['scores'], 'Momentum › Scores · AI Trading Agent'],
    ['momentum', ['scores', 'sectors'], 'Momentum › Scores · AI Trading Agent'],
    ['momentum', [], 'Momentum › Backtest · AI Trading Agent'],
    ['momentum', ['nope'], 'Momentum › Backtest · AI Trading Agent'],
    ['optionslab', ['builder'], 'Options Lab › Strategy builder · AI Trading Agent'],
    ['optionslab', [], 'Options Lab › Daily results · AI Trading Agent'],
  ] as const)('titles %s %j as %s', (tab, rest, title) => {
    expect(documentTitle(tab, rest)).toBe(title);
  });

  it('renders Overview while the root path is being redirected', () => {
    expect(DEFAULT_TAB).toBe('overview');
    expect(buildPath(DEFAULT_TAB)).toBe('/overview');
  });

  it('titles an unknown route with the app name alone', () => {
    expect(documentTitle(null)).toBe('AI Trading Agent');
  });
});
