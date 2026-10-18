// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { MomentumWeekMessage } from '../../../types/momentum';
import { TelegramMessage } from '../week/SidePanels';

afterEach(cleanup);

const message: MomentumWeekMessage = {
  week: '2026-10-16',
  run: 'final',
  title: 'Momentum FINAL',
  body: 'SELL BALRAMCHIN',
  sent: true,
  headline: 'Trio',
  at: '2026-10-16T20:01:13+05:30',
};

describe('TelegramMessage', () => {
  it('says the sent message is a record when it is the first week', () => {
    render(<TelegramMessage message={message} onResend={() => undefined} firstWeek />);
    expect(screen.getByText(/as it was sent/)).toBeTruthy();
    expect(screen.getByText(/SELL BALRAMCHIN/)).toBeTruthy();
  });

  it('adds no note on any other week', () => {
    render(<TelegramMessage message={message} onResend={() => undefined} />);
    expect(screen.queryByText(/as it was sent/)).toBeNull();
  });
});
