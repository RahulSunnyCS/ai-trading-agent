import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MOMENTUM_ALERTS_STORAGE_KEY,
  hydrateMomentumAlertsFromStorage,
  mergeAlertMemory,
  parseStoredAlertMemory,
  useMomentumAlertsStore,
} from './momentumAlerts';

describe('alert memory parsing', () => {
  it('gives an empty memory for nothing, bad JSON or a wrong shape', () => {
    expect(parseStoredAlertMemory(null)).toEqual({});
    expect(parseStoredAlertMemory('{nope')).toEqual({});
    expect(parseStoredAlertMemory('[1]')).toEqual({});
    expect(parseStoredAlertMemory('7')).toEqual({});
  });

  it('keeps only id → YYYY-MM-DD entries', () => {
    expect(
      parseStoredAlertMemory(JSON.stringify({ a: '2026-10-09', b: 5, c: 'yesterday', d: null })),
    ).toEqual({ a: '2026-10-09' });
  });
});

describe('alert memory store', () => {
  beforeEach(() => {
    useMomentumAlertsStore.setState({ shown: {}, hydrated: false });
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
      },
    });
  });

  it('is not hydrated until the stored memory is read, then is', () => {
    expect(useMomentumAlertsStore.getState().hydrated).toBe(false);
    window.localStorage.setItem(MOMENTUM_ALERTS_STORAGE_KEY, JSON.stringify({ a: '2026-10-09' }));
    hydrateMomentumAlertsFromStorage();
    expect(useMomentumAlertsStore.getState()).toMatchObject({
      hydrated: true,
      shown: { a: '2026-10-09' },
    });
  });

  it('remembers a shown alert in storage', () => {
    useMomentumAlertsStore.getState().markShown('a', '2026-10-09');
    expect(JSON.parse(window.localStorage.getItem(MOMENTUM_ALERTS_STORAGE_KEY) ?? '{}')).toEqual({
      a: '2026-10-09',
    });
  });

  it('still works, for this visit, when storage throws', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('blocked');
        },
        setItem: () => {
          throw new Error('blocked');
        },
      },
    });
    hydrateMomentumAlertsFromStorage();
    expect(useMomentumAlertsStore.getState()).toMatchObject({ hydrated: true, shown: {} });
    useMomentumAlertsStore.getState().markShown('a', '2026-10-09');
    expect(useMomentumAlertsStore.getState().shown).toEqual({ a: '2026-10-09' });
  });

  it('forgets cleared alerts from earlier days', () => {
    useMomentumAlertsStore.setState({ shown: { a: '2026-10-08', b: '2026-10-09' } });
    useMomentumAlertsStore.getState().prune([], '2026-10-09');
    expect(useMomentumAlertsStore.getState().shown).toEqual({ b: '2026-10-09' });
  });
});

describe('two tabs', () => {
  it('keeps the later day for an alert both remember and everything either remembers', () => {
    expect(
      mergeAlertMemory({ a: '2026-10-08', b: '2026-10-09' }, { a: '2026-10-09', c: '2026-10-07' }),
    ).toEqual({ a: '2026-10-09', b: '2026-10-09', c: '2026-10-07' });
  });
});
