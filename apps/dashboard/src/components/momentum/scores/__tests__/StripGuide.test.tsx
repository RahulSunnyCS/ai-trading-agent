// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MOMENTUM_SCORES_VIEWS_STORAGE_KEY,
  hydrateMomentumScoresViewsFromStorage,
  useMomentumScoresViewsStore,
} from '../../../../store/momentumScoresViews';
import { StripGuide } from '../StripGuide';

describe('StripGuide', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useMomentumScoresViewsStore.setState({ views: [], stripHelpOpen: true });
  });
  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it('is open on a first visit and shows one example strip per trend tag', () => {
    render(<StripGuide />);
    const toggle = screen.getByRole('button', { name: 'How to read the strip' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('img', { name: /Deciles by lookback/ })).toHaveLength(5);
    for (const tag of ['Leader', 'Emerging', 'Fading', 'Laggard', 'Mixed']) {
      expect(screen.getByText(tag)).toBeTruthy();
    }
    expect(screen.getByText(/left to right: 1, 2, 4, 8, 13, 26 and 52 weeks/)).toBeTruthy();
  });

  it('folds to its title line on "Got it", opens again from it, and remembers', () => {
    render(<StripGuide />);
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryAllByRole('img', { name: /Deciles by lookback/ })).toHaveLength(0);
    const toggle = screen.getByRole('button', { name: 'How to read the strip' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(
      JSON.parse(window.localStorage.getItem(MOMENTUM_SCORES_VIEWS_STORAGE_KEY) ?? '{}'),
    ).toMatchObject({
      stripHelpOpen: false,
    });
    fireEvent.click(toggle);
    expect(screen.getAllByRole('img', { name: /Deciles by lookback/ })).toHaveLength(5);
  });

  it('stays folded after a reload', () => {
    window.localStorage.setItem(
      MOMENTUM_SCORES_VIEWS_STORAGE_KEY,
      JSON.stringify({ views: [], stripHelpOpen: false }),
    );
    render(<StripGuide />);
    act(() => hydrateMomentumScoresViewsFromStorage());
    expect(screen.queryAllByRole('img', { name: /Deciles by lookback/ })).toHaveLength(0);
  });
});
