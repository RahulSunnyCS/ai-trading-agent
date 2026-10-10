// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { MomentumFridaySpread } from '../../../types/momentum';
import { MomentumFridayLuckBody } from '../MomentumFridayLuck';

afterEach(cleanup);

const spread: MomentumFridaySpread = {
  every: 2,
  phases: [
    { offset: 0, cagr: 0.4, max_drawdown: -0.3, ulcer: 0.1 },
    { offset: 1, cagr: 0.35, max_drawdown: -0.33, ulcer: 0.12 },
  ],
  blend: { cagr: 0.38, max_drawdown: -0.29, ulcer: 0.09 },
  cagr_spread: 0.05,
};

describe('MomentumFridayLuckBody', () => {
  it('shows each Friday and the whole account', () => {
    render(<MomentumFridayLuckBody spread={spread} />);
    expect(screen.getByText('Friday 1 of 2')).toBeTruthy();
    expect(screen.getByText('Friday 2 of 2')).toBeTruthy();
    expect(screen.getByText('All Fridays (split)')).toBeTruthy();
    expect(screen.getByText(/5\.0 pp/)).toBeTruthy();
  });
});
