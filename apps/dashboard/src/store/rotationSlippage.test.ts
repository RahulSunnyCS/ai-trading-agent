import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ROTATION_SLIPPAGE,
  ROTATION_SLIPPAGE_STORAGE_KEY,
  hydrateRotationSlippageFromStorage,
  parseStoredSlippage,
  useRotationSlippageStore,
} from './rotationSlippage';

function fakeWindow(initial: Record<string, string> = {}, blocked = false) {
  const data = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => {
      if (blocked) throw new Error('blocked');
      return data.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error('blocked');
      data.set(key, value);
    },
  };
  vi.stubGlobal('window', { localStorage });
  return data;
}

beforeEach(() => {
  useRotationSlippageStore.setState({ on: DEFAULT_ROTATION_SLIPPAGE, hydrated: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseStoredSlippage', () => {
  it('reads { on } and nothing else', () => {
    expect(parseStoredSlippage('{"on":false}')).toBe(false);
    expect(parseStoredSlippage('{"on":true}')).toBe(true);
    expect(parseStoredSlippage(null)).toBeNull();
    expect(parseStoredSlippage('')).toBeNull();
    expect(parseStoredSlippage('not json')).toBeNull();
    expect(parseStoredSlippage('{"on":"yes"}')).toBeNull();
    expect(parseStoredSlippage('[true]')).toBeNull();
    expect(parseStoredSlippage('null')).toBeNull();
  });
});

describe('the slippage store', () => {
  it('is on by default', () => {
    expect(DEFAULT_ROTATION_SLIPPAGE).toBe(true);
    fakeWindow();
    hydrateRotationSlippageFromStorage();
    expect(useRotationSlippageStore.getState()).toMatchObject({ on: true, hydrated: true });
  });

  it('applies a stored choice once, after mount', () => {
    fakeWindow({ [ROTATION_SLIPPAGE_STORAGE_KEY]: '{"on":false}' });
    hydrateRotationSlippageFromStorage();
    expect(useRotationSlippageStore.getState().on).toBe(false);
    // a later call does not re-read storage over a choice made since
    useRotationSlippageStore.getState().setOn(true);
    hydrateRotationSlippageFromStorage();
    expect(useRotationSlippageStore.getState().on).toBe(true);
  });

  it('persists a change', () => {
    const data = fakeWindow();
    useRotationSlippageStore.getState().setOn(false);
    expect(data.get(ROTATION_SLIPPAGE_STORAGE_KEY)).toBe('{"on":false}');
    expect(useRotationSlippageStore.getState().on).toBe(false);
  });

  it('still works when storage is blocked', () => {
    fakeWindow({}, true);
    hydrateRotationSlippageFromStorage();
    expect(useRotationSlippageStore.getState().on).toBe(true);
    useRotationSlippageStore.getState().setOn(false);
    expect(useRotationSlippageStore.getState().on).toBe(false);
  });
});
