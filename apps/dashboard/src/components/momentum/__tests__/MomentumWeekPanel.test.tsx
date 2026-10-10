// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { MomentumResult } from '../../../types/momentum';
import { WeekPanel } from '../MomentumResultDetails';

afterEach(cleanup);

const result = { open_positions: [], held_categories: [] } as unknown as MomentumResult;

describe('WeekPanel', () => {
  it('says an All Fridays run has no combined signal, and still shows the open positions', () => {
    render(
      <WeekPanel
        runId="run-1"
        result={result}
        config={{ split_fridays: true, rebalance: 'weekly', rebalance_every: 4 }}
      />,
    );
    expect(screen.getByText(/no combined signal/i)).toBeTruthy();
    expect(screen.getByText('Open positions')).toBeTruthy();
  });
});
