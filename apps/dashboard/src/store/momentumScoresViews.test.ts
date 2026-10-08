// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_STOCKS_SETTINGS, type StocksViewSettings } from '../lib/momentumScores';
import {
  DEFAULT_SCORES_VIEWS,
  MAX_SAVED_VIEWS,
  MAX_VIEW_NAME,
  MOMENTUM_SCORES_VIEWS_STORAGE_KEY,
  cleanViewName,
  hydrateMomentumScoresViewsFromStorage,
  parseStoredScoresViews,
  useMomentumScoresViewsStore,
} from './momentumScoresViews';

const LEADERS: StocksViewSettings = {
  view: 'leaders',
  group: 'Financials',
  query: 'bank',
  sort: { key: 'score', lookback: 13, ascending: false },
};

function reset(): void {
  useMomentumScoresViewsStore.setState({ views: [], stripHelpOpen: true });
}

describe('parseStoredScoresViews', () => {
  it('reads saved views and the card state', () => {
    const stored = JSON.stringify({
      views: [{ name: 'Bank leaders', settings: LEADERS }],
      stripHelpOpen: false,
    });
    expect(parseStoredScoresViews(stored)).toEqual({
      views: [{ name: 'Bank leaders', settings: LEADERS }],
      stripHelpOpen: false,
    });
  });

  it('gives the defaults for nothing, bad JSON or a wrong shape', () => {
    for (const stored of [null, '', '{nope', '[]', 'null', '7']) {
      expect(parseStoredScoresViews(stored)).toEqual(DEFAULT_SCORES_VIEWS);
    }
  });

  it('drops a view with a bad name or settings, keeps the rest, and the first of a repeated name', () => {
    const bad = { view: 'nonsense', group: '', query: '', sort: { key: 'rank', ascending: true } };
    const noLookback = { ...LEADERS, sort: { key: 'score', lookback: null, ascending: true } };
    const stored = JSON.stringify({
      views: [
        { name: 'Good', settings: LEADERS },
        { name: 'Bad settings', settings: bad },
        { name: 'No lookback', settings: noLookback },
        { name: '   ', settings: LEADERS },
        { name: 42, settings: LEADERS },
        { name: 'good', settings: DEFAULT_STOCKS_SETTINGS },
        'junk',
      ],
    });
    const { views, stripHelpOpen } = parseStoredScoresViews(stored);
    expect(views.map((view) => view.name)).toEqual(['Good']);
    expect(views[0]?.settings).toEqual(LEADERS);
    expect(stripHelpOpen).toBe(true); // absent means the first-visit default
  });

  it('keeps at most the limit', () => {
    const views = Array.from({ length: MAX_SAVED_VIEWS + 5 }, (_, i) => ({
      name: `v${i}`,
      settings: LEADERS,
    }));
    expect(parseStoredScoresViews(JSON.stringify({ views })).views).toHaveLength(MAX_SAVED_VIEWS);
  });

  it('fills the optional fields of a view with their defaults', () => {
    const minimal = { view: 'all', sort: { key: 'rank' } };
    const parsed = parseStoredScoresViews(
      JSON.stringify({ views: [{ name: 'Min', settings: minimal }] }),
    );
    expect(parsed.views[0]?.settings).toEqual({
      view: 'all',
      group: '',
      query: '',
      sort: { key: 'rank', lookback: null, ascending: true },
    });
  });
});

describe('cleanViewName', () => {
  it('trims, collapses spaces and cuts to the limit', () => {
    expect(cleanViewName('  Bank   leaders ')).toBe('Bank leaders');
    expect(cleanViewName('x'.repeat(MAX_VIEW_NAME + 10))).toHaveLength(MAX_VIEW_NAME);
  });
});

describe('the saved views store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    reset();
  });
  afterEach(() => window.localStorage.clear());

  it('saves a view, remembers it, and hydrates it after mount', () => {
    const { saveView } = useMomentumScoresViewsStore.getState();
    expect(saveView('Bank leaders', LEADERS)).toBe('saved');
    const stored = JSON.parse(
      window.localStorage.getItem(MOMENTUM_SCORES_VIEWS_STORAGE_KEY) ?? 'null',
    );
    expect(stored.views).toEqual([{ name: 'Bank leaders', settings: LEADERS }]);
    reset();
    hydrateMomentumScoresViewsFromStorage();
    expect(useMomentumScoresViewsStore.getState().views[0]?.name).toBe('Bank leaders');
  });

  it('replaces a view of the same name, ignoring case, in its place', () => {
    const { saveView } = useMomentumScoresViewsStore.getState();
    saveView('First', LEADERS);
    saveView('Second', DEFAULT_STOCKS_SETTINGS);
    expect(saveView('first', DEFAULT_STOCKS_SETTINGS)).toBe('replaced');
    const { views } = useMomentumScoresViewsStore.getState();
    expect(views.map((view) => view.name)).toEqual(['first', 'Second']);
    expect(views[0]?.settings).toEqual(DEFAULT_STOCKS_SETTINGS);
  });

  it('refuses an empty name and a thirteenth view', () => {
    const { saveView } = useMomentumScoresViewsStore.getState();
    expect(saveView('   ', LEADERS)).toBe('empty');
    for (let i = 0; i < MAX_SAVED_VIEWS; i += 1) expect(saveView(`v${i}`, LEADERS)).toBe('saved');
    expect(saveView('one more', LEADERS)).toBe('full');
    expect(saveView('v0', DEFAULT_STOCKS_SETTINGS)).toBe('replaced'); // still allowed when full
    expect(useMomentumScoresViewsStore.getState().views).toHaveLength(MAX_SAVED_VIEWS);
  });

  it('deletes a view and remembers that', () => {
    const { saveView, deleteView } = useMomentumScoresViewsStore.getState();
    saveView('A', LEADERS);
    saveView('B', LEADERS);
    deleteView('a');
    expect(useMomentumScoresViewsStore.getState().views.map((view) => view.name)).toEqual(['B']);
    expect(window.localStorage.getItem(MOMENTUM_SCORES_VIEWS_STORAGE_KEY)).toContain('"B"');
    expect(window.localStorage.getItem(MOMENTUM_SCORES_VIEWS_STORAGE_KEY)).not.toContain('"A"');
  });

  it('remembers whether the strip card is open', () => {
    useMomentumScoresViewsStore.getState().setStripHelpOpen(false);
    expect(useMomentumScoresViewsStore.getState().stripHelpOpen).toBe(false);
    reset();
    hydrateMomentumScoresViewsFromStorage();
    expect(useMomentumScoresViewsStore.getState().stripHelpOpen).toBe(false);
  });
});
