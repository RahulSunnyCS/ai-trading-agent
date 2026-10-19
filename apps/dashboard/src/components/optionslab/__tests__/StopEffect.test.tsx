// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StopEffectBlock } from '../rotation/StopEffect';

afterEach(cleanup);

describe('StopEffectBlock', () => {
  it('heads the lines "Without the portfolio stop" and shows each one', () => {
    render(
      <StopEffectBlock
        effect={{
          latest: { day: '2026-10-19', with: -8000, without: -11500, stopLabel: '11:14' },
          days: 6,
          totalWith: 2500,
          totalWithout: -1000,
          ddWith: -8000,
          ddWithout: -11500,
          firedDays: 1,
          firedEffect: 3500,
          skipped: 0,
        }}
      />,
    );
    const block = screen.getByRole('region', { name: 'Without the portfolio stop' });
    expect(within(block).getByText('stop reached at 11:14: +₹3,500')).toBeTruthy();
    expect(within(block).getByText('+₹2,500 with · -₹1,000 without · +₹3,500')).toBeTruthy();
    expect(within(block).getByText('on 1 of 6 days, net +₹3,500')).toBeTruthy();
  });
});
