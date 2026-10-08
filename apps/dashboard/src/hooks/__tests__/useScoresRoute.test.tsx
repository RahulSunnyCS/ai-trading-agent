// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scoresHref, useScoresRoute } from '../useScoresRoute';

describe('scoresHref', () => {
  it.each([
    [{ kind: 'sectors' as const }, '/momentum/scores/sectors'],
    [{ kind: 'stocks' as const }, '/momentum/scores/stocks'],
    [{ kind: 'sectors' as const, group: 'financials' }, '/momentum/scores/sectors/financials'],
    [
      { kind: 'sectors' as const, group: 'financials', sub: 'psu-banks', stock: 'SBIN' },
      '/momentum/scores/sectors/financials?sub=psu-banks&stock=SBIN',
    ],
    [{ kind: 'stocks' as const, stock: 'M&M' }, '/momentum/scores/stocks?stock=M%26M'],
    [{ kind: 'sectors' as const, group: null, sub: null, stock: null }, '/momentum/scores/sectors'],
  ])('%j -> %s', (target, href) => expect(scoresHref(target)).toBe(href));
});

describe('useScoresRoute', () => {
  beforeEach(() => window.history.replaceState(null, '', '/momentum/scores'));
  afterEach(cleanup);

  it('reads the view, sector, sub-sector and stock from the address', () => {
    window.history.replaceState(
      null,
      '',
      '/momentum/scores/sectors/financials?sub=psu-banks&stock=SBIN',
    );
    const { result } = renderHook(() => useScoresRoute());
    expect(result.current).toMatchObject({
      kind: 'sectors',
      group: 'financials',
      sub: 'psu-banks',
      stock: 'SBIN',
    });
  });

  it('opens on the Sectors view', () => {
    const { result } = renderHook(() => useScoresRoute());
    expect(result.current).toMatchObject({ kind: 'sectors', group: null, sub: null, stock: null });
  });

  it('moves with a pushed entry, and reflects it at once', () => {
    const { result } = renderHook(() => useScoresRoute());
    const before = window.history.length;
    act(() => result.current.go({ kind: 'sectors', group: 'metals-and-mining' }));
    expect(window.location.pathname).toBe('/momentum/scores/sectors/metals-and-mining');
    expect(window.history.length).toBe(before + 1);
    expect(result.current.group).toBe('metals-and-mining');
    // The same place again adds nothing.
    act(() => result.current.go({ kind: 'sectors', group: 'metals-and-mining' }));
    expect(window.history.length).toBe(before + 1);
  });

  it('marks the entry a stock drawer pushed, and replaces when stepping to another stock', () => {
    const { result } = renderHook(() => useScoresRoute());
    act(() => result.current.go({ kind: 'stocks', stock: 'BEL' }));
    expect(window.history.state).toMatchObject({ scoresDrawer: true });
    const length = window.history.length;
    act(() => result.current.go({ kind: 'stocks', stock: 'HAL' }, 'replace'));
    expect(window.history.length).toBe(length);
    expect(result.current.stock).toBe('HAL');
    expect(window.history.state).toMatchObject({ scoresDrawer: true });
  });

  it('closes a stock that was linked straight to by dropping the key in place', () => {
    window.history.replaceState(null, '', '/momentum/scores/stocks?stock=BEL');
    const { result } = renderHook(() => useScoresRoute());
    const length = window.history.length;
    act(() => result.current.closeStock({ kind: 'stocks' }));
    expect(window.location.pathname + window.location.search).toBe('/momentum/scores/stocks');
    expect(window.history.length).toBe(length);
    expect(result.current.stock).toBeNull();
  });

  it('does nothing when no stock is open', () => {
    const { result } = renderHook(() => useScoresRoute());
    const back = vi.spyOn(window.history, 'back');
    act(() => result.current.closeStock({ kind: 'sectors' }));
    expect(back).not.toHaveBeenCalled();
    back.mockRestore();
  });

  it('steps back over the entry the drawer pushed', () => {
    const { result } = renderHook(() => useScoresRoute());
    act(() => result.current.go({ kind: 'stocks', stock: 'BEL' }));
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    act(() => result.current.closeStock({ kind: 'stocks' }));
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });
});
