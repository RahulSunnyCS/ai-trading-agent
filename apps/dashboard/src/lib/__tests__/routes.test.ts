import { describe, expect, it } from 'vitest';

import { NAV_GROUPS } from '../../components/shell/nav';
import {
  COVERAGE_DEFAULT_SECTION,
  COVERAGE_SECTIONS,
  DEFAULT_TAB,
  MOMENTUM_SECTIONS,
  OPTIONS_LAB_DEFAULT_SECTION,
  OPTIONS_LAB_SECTIONS,
  PATH_ALIASES,
  aliasTarget,
  buildPath,
  builderMode,
  documentTitle,
  oneOf,
  parsePath,
  tabSegment,
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
    ['/coverage', 'coverage', []],
    ['/coverage/backfill', 'coverage', ['backfill']],
    ['/coverage/replay', 'coverage', ['replay']],
    ['/optionslab', 'optionslab', []],
    ['/optionslab/strategies', 'optionslab', ['strategies']],
    ['/optionslab/builder', 'optionslab', ['builder']],
    ['/optionslab/builder/yaml', 'optionslab', ['builder', 'yaml']],
    ['/optionslab/runs', 'optionslab', ['runs']],
    ['/optionslab/results', 'optionslab', ['results']],
    ['/optionslab/regimes', 'optionslab', ['regimes']],
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
    ['/momentum/journal', 'momentum', ['journal']],
    ['/brokerLogins', 'brokerLogins', []],
    ['/billing', 'pricing', []],
    ['/settings', 'settings', []],
    ['/guide', 'guide', []],
    ['/guide/momentum/journal', 'guide', ['momentum', 'journal']],
  ] as const)('known path %s resolves to %s', (path, tab, rest) => {
    expect(parsePath(path)).toEqual({ tab, rest: [...rest] });
    expect(aliasTarget(path)).toBeNull();
  });

  it.each([
    ['/pricing', '/billing', 'pricing', []],
    ['/brokers', '/brokerLogins', 'brokerLogins', []],
    ['/brokerlogins', '/brokerLogins', 'brokerLogins', []],
    ['/backfill', '/coverage/backfill', 'coverage', ['backfill']],
    ['/replay', '/coverage/replay', 'coverage', ['replay']],
    ['/data/backfill', '/coverage/backfill', 'coverage', ['backfill']],
    ['/data/replay', '/coverage/replay', 'coverage', ['replay']],
    ['/backtest', '/optionslab/builder/yaml', 'optionslab', ['builder', 'yaml']],
    ['/backtest/', '/optionslab/builder/yaml', 'optionslab', ['builder', 'yaml']],
    ['/optionslab/yaml', '/optionslab/builder/yaml', 'optionslab', ['builder', 'yaml']],
    ['/data/replay/', '/coverage/replay', 'coverage', ['replay']],
    ['/pricing/extra', '/billing/extra', 'pricing', ['extra']],
    ['/help', '/guide', 'guide', []],
    ['/docs', '/guide', 'guide', []],
    ['/docs/momentum/journal', '/guide/momentum/journal', 'guide', ['momentum', 'journal']],
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
    expect(aliasTarget('/pricings')).toBeNull();
    expect(aliasTarget('/coverage/backfill')).toBeNull();
    expect(aliasTarget('/data')).toBeNull();
    expect(parsePath('/data')).toEqual({ tab: null, rest: [] });
    expect(parsePath('/optionslab/yamlish')).toEqual({ tab: 'optionslab', rest: ['yamlish'] });
    expect(aliasTarget('/backtests')).toBeNull();
    // Momentum's own Backtest section is not the retired tab.
    expect(aliasTarget('/momentum/backtest')).toBeNull();
  });

  it('retires the backtest tab: it is no longer a tab id of its own', () => {
    const ids = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)) as string[];
    expect(ids).not.toContain('backtest');
    expect(parsePath('/backtest').tab).toBe('optionslab');
  });

  it('reads the builder mode from the path', () => {
    expect(builderMode(['builder'])).toBe('form');
    expect(builderMode(['builder', 'yaml'])).toBe('yaml');
    expect(builderMode(['builder', 'nope'])).toBe('form');
    expect(builderMode(['runs', 'yaml'])).toBe('form');
    expect(builderMode(parsePath('/backtest').rest)).toBe('yaml');
  });

  it('opens Daily results for the bare Options Lab path', () => {
    expect(OPTIONS_LAB_DEFAULT_SECTION).toBe('results');
    expect(oneOf(OPTIONS_LAB_SECTIONS, parsePath('/optionslab').rest[0])).toBeNull();
    expect(OPTIONS_LAB_SECTIONS).toEqual(['strategies', 'builder', 'runs', 'results', 'regimes']);
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
    expect(children('coverage')).toEqual([...COVERAGE_SECTIONS]);
  });

  it('retires the backfill and replay tab ids into Coverage, opening Backfill by default', () => {
    const ids = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)) as string[];
    expect(ids).not.toContain('backfill');
    expect(ids).not.toContain('replay');
    expect(COVERAGE_DEFAULT_SECTION).toBe('backfill');
    expect(oneOf(COVERAGE_SECTIONS, parsePath('/coverage').rest[0])).toBeNull();
  });

  it('serves the pricing tab at /billing', () => {
    expect(tabSegment('pricing')).toBe('billing');
    expect(tabSegment('coverage')).toBe('coverage');
    expect(buildPath('pricing')).toBe('/billing');
    expect(parsePath(buildPath('pricing'))).toEqual({ tab: 'pricing', rest: [] });
    expect(buildPath('coverage', 'replay')).toBe('/coverage/replay');
  });

  it.each([
    ['overview', [], 'Overview · AI Trading Agent'],
    ['trades', [], 'Trades · AI Trading Agent'],
    ['pnl', [], 'P&L · AI Trading Agent'],
    ['momentum', ['scores'], 'Momentum › Scores · AI Trading Agent'],
    ['momentum', ['scores', 'sectors'], 'Momentum › Scores · AI Trading Agent'],
    ['momentum', [], 'Momentum › Backtest · AI Trading Agent'],
    ['momentum', ['nope'], 'Momentum › Backtest · AI Trading Agent'],
    ['optionslab', ['strategies'], 'Options Lab › Strategies · AI Trading Agent'],
    ['optionslab', ['builder'], 'Options Lab › Builder · AI Trading Agent'],
    ['optionslab', ['builder', 'yaml'], 'Options Lab › Builder › YAML · AI Trading Agent'],
    ['optionslab', ['runs'], 'Options Lab › Runs · AI Trading Agent'],
    ['optionslab', ['results'], 'Options Lab › Daily results · AI Trading Agent'],
    ['optionslab', ['regimes'], 'Options Lab › Regimes · AI Trading Agent'],
    ['optionslab', [], 'Options Lab › Daily results · AI Trading Agent'],
    ['optionslab', ['nope'], 'Options Lab › Daily results · AI Trading Agent'],
    ['coverage', [], 'Coverage › Backfill · AI Trading Agent'],
    ['coverage', ['backfill'], 'Coverage › Backfill · AI Trading Agent'],
    ['coverage', ['replay'], 'Coverage › Replay · AI Trading Agent'],
    ['pricing', [], 'Billing · AI Trading Agent'],
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
