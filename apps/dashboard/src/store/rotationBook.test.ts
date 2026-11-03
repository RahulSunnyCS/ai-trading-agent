import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ROTATION_BOOK,
  ROTATION_BOOK_STORAGE_KEY,
  hydrateRotationBookFromStorage,
  parseStoredBook,
  useRotationBookStore,
} from './rotationBook';

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
  useRotationBookStore.setState({ view: DEFAULT_ROTATION_BOOK, hydrated: false });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseStoredBook', () => {
  it('reads { view } when it is a known book, and nothing else', () => {
    expect(parseStoredBook('{"view":"core"}')).toBe('core');
    expect(parseStoredBook('{"view":"base"}')).toBe('base');
    expect(parseStoredBook('{"view":"tuned"}')).toBe('tuned');
    expect(parseStoredBook('{"view":"classic"}')).toBeNull();
    expect(parseStoredBook('"core"')).toBeNull();
    expect(parseStoredBook('not json')).toBeNull();
    expect(parseStoredBook(null)).toBeNull();
  });
});

describe('the book store', () => {
  it('leads with Adaptive Tuned by default', () => {
    expect(DEFAULT_ROTATION_BOOK).toBe('tuned');
    fakeWindow();
    hydrateRotationBookFromStorage();
    expect(useRotationBookStore.getState()).toMatchObject({ view: 'tuned', hydrated: true });
  });

  it('applies a stored choice once, and persists a change', () => {
    const data = fakeWindow({ [ROTATION_BOOK_STORAGE_KEY]: '{"view":"base"}' });
    hydrateRotationBookFromStorage();
    expect(useRotationBookStore.getState().view).toBe('base');
    useRotationBookStore.getState().setView('core');
    hydrateRotationBookFromStorage();
    expect(useRotationBookStore.getState().view).toBe('core');
    expect(data.get(ROTATION_BOOK_STORAGE_KEY)).toBe('{"view":"core"}');
  });

  it('still works when storage is blocked', () => {
    fakeWindow({}, true);
    hydrateRotationBookFromStorage();
    expect(useRotationBookStore.getState().view).toBe('tuned');
    useRotationBookStore.getState().setView('base');
    expect(useRotationBookStore.getState().view).toBe('base');
  });
});
