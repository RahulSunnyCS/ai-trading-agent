import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIST,
  LIST_INFO,
  SEVERAL_LISTS_VISIBLE,
  UNIVERSE_LABEL,
  VISIBLE_LIST_KEYS,
  isVisibleList,
  listLabel,
  listName,
  listPhrase,
  listShort,
  listWithUniverse,
  renameListsIn,
} from '../rotationListNames';

describe('rotation list names', () => {
  it('names the four lists, keys unchanged', () => {
    expect(listName('A')).toBe('Steady');
    expect(listName('B')).toBe('Calendar');
    expect(listName('C')).toBe('Adaptive');
    expect(listName('REF')).toBe('Baseline');
  });

  it('leaves an unknown key as it is', () => {
    expect(listName('BASE')).toBe('BASE');
    expect(listLabel('BASE')).toBe('BASE');
    expect(listPhrase('D')).toBe('list D');
  });

  it('shows the key as a hint in a label', () => {
    expect(listLabel('A')).toBe('Steady (A)');
    expect(listLabel('REF')).toBe('Baseline (REF)');
    expect(listPhrase('C')).toBe('Adaptive list');
  });

  it('swaps a list key inside server text, and only after the word list', () => {
    expect(renameListsIn('List A: VIX since open')).toBe('Steady list: VIX since open');
    expect(renameListsIn('picks of list REF and List C')).toBe(
      'picks of Baseline list and Adaptive list',
    );
    expect(renameListsIn('A list of ten; list ABC')).toBe('A list of ten; list ABC');
  });

  it('has a two-letter tag for a corner mark, distinct from every key', () => {
    expect(['A', 'B', 'C', 'REF'].map(listShort)).toEqual(['St', 'Ca', 'Ad', 'Ba']);
    expect(listShort('BASE')).toBe('BASE');
  });

  it('shows Adaptive alone; the other three keys still have names for old rows', () => {
    expect(VISIBLE_LIST_KEYS).toEqual(['C']);
    expect(DEFAULT_LIST).toBe('C');
    expect(SEVERAL_LISTS_VISIBLE).toBe(false);
    expect(isVisibleList('C')).toBe(true);
    for (const hidden of ['A', 'B', 'REF', 'BASE', 'base', 'D', '']) {
      expect(isVisibleList(hidden)).toBe(false);
    }
    // a hidden key is still named, so journal rows and server text keep reading right
    expect(['A', 'B', 'REF'].map(listName)).toEqual(['Steady', 'Calendar', 'Baseline']);
  });

  it('names the live universe Core, never "base", with its size', () => {
    expect(UNIVERSE_LABEL).toBe('Core (298 variants)');
    expect(listWithUniverse('C')).toBe('Adaptive · Core (298 variants)');
    expect(UNIVERSE_LABEL.toLowerCase()).not.toContain('base');
  });

  it('carries the registered weights, summing to 100 for a weighted list', () => {
    for (const k of ['A', 'B', 'C'] as const) {
      const w = LIST_INFO[k].weights;
      expect(w).not.toBeNull();
      if (w) expect(w.own + w.weekday + w.dte + w.vix + w.family).toBe(100);
    }
    expect(LIST_INFO.REF.weights).toBeNull();
  });
});
