import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CUTS } from '../hooks/useLegwise';
import {
  LEGACY_REGIME_CUTS_KEY,
  REGIME_CUTS_STORAGE_KEY,
  getRegimeCuts,
  hydrateRegimeCutsFromStorage,
  isDefaultCuts,
  normaliseCuts,
  parseStoredCuts,
  resolveStoredCuts,
  segmentNames,
  useRegimeCutsStore,
  validateCuts,
} from './regimeCuts';

function fakeWindow(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
  vi.stubGlobal('window', { localStorage });
  return data;
}

beforeEach(() => {
  useRegimeCutsStore.setState({ cuts: DEFAULT_CUTS, hydrated: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('validateCuts', () => {
  it('accepts 1 to 4 increasing times inside the session', () => {
    expect(validateCuts(['10:30', '13:30'])).toBeNull();
    expect(validateCuts(['09:16'])).toBeNull();
    expect(validateCuts(['10:00', '11:00', '12:00', '15:29'])).toBeNull();
  });

  it('rejects the wrong count, shape, range or order', () => {
    expect(validateCuts([])).toMatch(/between 1 and 4/);
    expect(validateCuts(['10:00', '11:00', '12:00', '13:00', '14:00'])).toMatch(/between/);
    expect(validateCuts(['1030'])).toMatch(/look like/);
    expect(validateCuts(['10:75'])).toMatch(/look like/);
    expect(validateCuts(['09:15'])).toMatch(/inside the session/);
    expect(validateCuts(['15:30'])).toMatch(/inside the session/);
    expect(validateCuts(['13:30', '10:30'])).toMatch(/increasing/);
    expect(validateCuts(['10:30', '10:30'])).toMatch(/increasing/);
  });
});

describe('normaliseCuts / parseStoredCuts', () => {
  it('reads the versioned shape and the legacy bare array', () => {
    expect(parseStoredCuts('{"cuts":["11:00","14:00"]}')).toEqual(['11:00', '14:00']);
    expect(parseStoredCuts('["11:00","14:00"]')).toEqual(['11:00', '14:00']);
  });

  it('trims entries and drops seconds', () => {
    expect(normaliseCuts([' 10:30 ', '13:30:00'])).toEqual(['10:30', '13:30']);
  });

  it('returns null for anything malformed', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'not json',
      '{"cuts":',
      'null',
      '42',
      '"10:30"',
      '{}',
      '{"cuts":"10:30"}',
      '[10.5, 13.5]',
      '["10:30", null]',
      '[]',
      '["13:30","10:30"]',
      '["08:00"]',
      '["10:00","11:00","12:00","13:00","14:00"]',
    ]) {
      expect(parseStoredCuts(raw), String(raw)).toBeNull();
    }
  });
});

describe('resolveStoredCuts', () => {
  it('falls back to DEFAULT_CUTS (as a copy) when nothing usable is stored', () => {
    const cuts = resolveStoredCuts(null, 'garbage');
    expect(cuts).toEqual([...DEFAULT_CUTS]);
    expect(cuts).not.toBe(DEFAULT_CUTS);
  });

  it('keeps cuts customised under the legacy key', () => {
    expect(resolveStoredCuts(null, '["11:15"]')).toEqual(['11:15']);
  });

  it('prefers the versioned key, unless it is malformed', () => {
    expect(resolveStoredCuts('{"cuts":["12:00"]}', '["11:15"]')).toEqual(['12:00']);
    expect(resolveStoredCuts('{"cuts":["25:00"]}', '["11:15"]')).toEqual(['11:15']);
  });
});

describe('segmentNames / isDefaultCuts', () => {
  it('names each segment between the session edges', () => {
    expect(segmentNames(['10:30', '13:30'])).toEqual(['09:15–10:30', '10:30–13:30', '13:30–15:30']);
  });

  it('knows the built-in cuts', () => {
    expect(isDefaultCuts([...DEFAULT_CUTS])).toBe(true);
    expect(isDefaultCuts(['10:30'])).toBe(false);
  });
});

describe('store', () => {
  it('starts from DEFAULT_CUTS, the same on the server and on the first client render', () => {
    expect(useRegimeCutsStore.getState().cuts).toBe(DEFAULT_CUTS);
    expect(getRegimeCuts()).toBe(DEFAULT_CUTS); // no window: nothing to hydrate from
    expect(useRegimeCutsStore.getState().hydrated).toBe(false);
  });

  it('setCuts applies valid cuts and refuses invalid ones', () => {
    const { setCuts } = useRegimeCutsStore.getState();
    expect(setCuts(['11:00', '14:00'])).toBe(true);
    expect(getRegimeCuts()).toEqual(['11:00', '14:00']);
    expect(setCuts(['14:00', '11:00'])).toBe(false);
    expect(getRegimeCuts()).toEqual(['11:00', '14:00']);
  });

  it('setCuts keeps the same array when the cuts did not change', () => {
    const { setCuts } = useRegimeCutsStore.getState();
    setCuts(['11:00']);
    const before = useRegimeCutsStore.getState().cuts;
    setCuts(['11:00']);
    expect(useRegimeCutsStore.getState().cuts).toBe(before);
  });

  it('persists under the versioned key and resetCuts restores the defaults', () => {
    const data = fakeWindow();
    useRegimeCutsStore.getState().setCuts(['12:15']);
    expect(data.get(REGIME_CUTS_STORAGE_KEY)).toBe('{"cuts":["12:15"]}');
    useRegimeCutsStore.getState().resetCuts();
    expect(getRegimeCuts()).toBe(DEFAULT_CUTS);
    expect(parseStoredCuts(data.get(REGIME_CUTS_STORAGE_KEY))).toEqual([...DEFAULT_CUTS]);
  });

  it('hydrates from the legacy key once, and a later call does not overwrite a newer choice', () => {
    fakeWindow({ [LEGACY_REGIME_CUTS_KEY]: '["11:15","14:15"]' });
    hydrateRegimeCutsFromStorage();
    expect(useRegimeCutsStore.getState()).toMatchObject({
      cuts: ['11:15', '14:15'],
      hydrated: true,
    });
    useRegimeCutsStore.getState().setCuts(['12:00']);
    hydrateRegimeCutsFromStorage();
    expect(getRegimeCuts()).toEqual(['12:00']);
  });

  it('hydrates to the defaults when the stored value is malformed', () => {
    fakeWindow({ [REGIME_CUTS_STORAGE_KEY]: '{"cuts":["nope"]}' });
    expect(getRegimeCuts()).toBe(DEFAULT_CUTS);
    expect(useRegimeCutsStore.getState().hydrated).toBe(true);
  });

  it('survives a storage that throws', () => {
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
    expect(getRegimeCuts()).toBe(DEFAULT_CUTS);
    expect(useRegimeCutsStore.getState().setCuts(['11:00'])).toBe(true);
    expect(getRegimeCuts()).toEqual(['11:00']);
  });
});
