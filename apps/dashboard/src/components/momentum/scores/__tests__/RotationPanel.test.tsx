// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RotationGroup, StockScore } from '../../../../lib/momentumScores';
import { useMomentumScoresStore } from '../../../../store/momentumScores';
import { RotationPanel } from '../RotationPanel';

const flat = (value: number | null): Array<number | null> =>
  Array.from({ length: 18 }, () => value);

function group(
  key: string,
  s4: Array<number | null>,
  s26: Array<number | null>,
  over: Partial<RotationGroup> = {},
): RotationGroup {
  return {
    key,
    parent_group: key,
    subgroup: null,
    theme: false,
    member_count: 10,
    scored_count: 10,
    s4,
    s26,
    ...over,
  };
}

const stock = (symbol: string, over: Partial<StockScore> = {}): StockScore => ({
  symbol,
  company_name: symbol,
  parent_group: 'X',
  subgroup: 'Y',
  last_price: 100,
  change_1w_pct: 0,
  returns: {},
  scores: { '4': 70, '13': 70, '26': 70 },
  above_ma40: 0.1,
  ...over,
});

// A group that crossed from Leading to Weakening: its 4-week score fell off in the last weeks.
const falling = flat(60).map((v, i) => (i >= 15 ? 30 : v));
const GROUPS = [
  group('Strong', flat(50), flat(80)),
  group('Faller', falling, flat(70)),
  group('Weak', flat(50), flat(20)),
  group('Tiny', flat(50), flat(90), { scored_count: 2 }),
  group('Cross-Sector Themes', flat(50), flat(95), { theme: true }),
];

function renderPanel(onSelect = vi.fn(), selectedKey: string | null = null) {
  render(
    <RotationPanel
      groups={GROUPS}
      stocksOf={() => [stock('A'), stock('B', { above_ma40: -0.1 })]}
      lookbacks={[1, 2, 4, 8, 13, 26, 52]}
      selectedKey={selectedKey}
      onSelect={onSelect}
      title="Sector groups"
      meta="strongest first"
      unit="group"
      hint="Click a group."
    />,
  );
  return onSelect;
}

const tableRows = () =>
  within(screen.getByRole('region', { name: 'Sector groups' }))
    .getAllByRole('row')
    .slice(1);
const dots = () => screen.getAllByRole('button', { name: /^(Strong|Faller|Weak|Tiny)/ });

describe('RotationPanel', () => {
  beforeAll(() => {
    if (typeof ResizeObserver === 'undefined')
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
          unobserve() {}
        },
      );
  });
  beforeEach(() => useMomentumScoresStore.setState({ hidden: new Set(), minStocks: 5 }));
  afterEach(cleanup);

  it('puts dotted groups first, strongest first, and says why the rest have no dot', () => {
    renderPanel();
    expect(tableRows().map((row) => row.textContent?.slice(0, 18))).toEqual([
      expect.stringContaining('Strong'),
      expect.stringContaining('Faller'),
      expect.stringContaining('Weak'),
      expect.stringContaining('Cross-Sector Theme'),
      expect.stringContaining('Tiny'),
    ]);
    expect(screen.getByText('a theme basket, not a sector')).toBeTruthy();
    expect(screen.getByText('fewer than 5 scored stocks')).toBeTruthy();
    expect(dots()).toHaveLength(3); // Strong, Faller, Weak: not Tiny, not the theme
  });

  it('shows a move between quadrants in the table', () => {
    renderPanel();
    const faller = tableRows().find((row) => row.textContent?.startsWith('Faller'));
    expect(faller?.textContent).toContain('Weakening');
    expect(faller?.textContent).toContain('was Leading');
  });

  it('selects a group from its row, and from its dot with the keyboard', () => {
    const onSelect = renderPanel();
    fireEvent.click(tableRows()[0] as HTMLElement);
    expect(onSelect).toHaveBeenLastCalledWith('Strong');
    const weak = screen.getByRole('button', { name: /^Weak/ });
    fireEvent.keyDown(weak, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('Weak');
  });

  it('keeps only the groups that changed quadrant when asked', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Changed quadrant only' }));
    expect(tableRows()).toHaveLength(1);
    expect(tableRows()[0]?.textContent).toContain('Faller');
    expect(dots()).toHaveLength(1);
  });

  it('lets the reader lower the minimum stocks for a dot, and remembers it', () => {
    renderPanel();
    fireEvent.change(screen.getByRole('combobox', { name: 'Fewest scored stocks for a dot' }), {
      target: { value: '1' },
    });
    expect(useMomentumScoresStore.getState().minStocks).toBe(1);
    expect(dots()).toHaveLength(4); // Tiny gets a dot now
    expect(screen.queryByText('fewer than 5 scored stocks')).toBeNull();
  });

  it('finds a group by name', async () => {
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a group' }), {
      target: { value: 'weak' },
    });
    await act(async () => {});
    expect(tableRows()).toHaveLength(1);
    expect(tableRows()[0]?.textContent).toContain('Weak');
  });

  it('lights the picked group, and shows a tooltip on a dot', () => {
    renderPanel(vi.fn(), 'Weak');
    expect(screen.getByRole('button', { name: /^Weak/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^Strong/ }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: /^Strong/ }));
    expect(screen.getByText('4 weeks ago')).toBeTruthy();
    expect(screen.getByText('Above 40-week average')).toBeTruthy();
  });

  it('says so when nothing matches', async () => {
    renderPanel();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a group' }), {
      target: { value: 'zzz' },
    });
    await act(async () => {});
    expect(screen.getByText('No group matches.')).toBeTruthy();
    expect(screen.getByText(/Nothing to place/)).toBeTruthy();
  });
});
