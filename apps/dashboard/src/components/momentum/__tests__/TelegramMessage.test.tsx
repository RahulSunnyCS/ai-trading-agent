// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function open(): void {
  fireEvent.click(screen.getByRole('button', { name: /Telegram message/ }));
}

describe('TelegramMessage', () => {
  it('opens collapsed to when it was sent, with the message and Re-send inside', () => {
    render(<TelegramMessage message={message} onResend={() => undefined} />);
    expect(screen.getByText(/sent .* · final/)).toBeTruthy();
    expect(screen.queryByText(/SELL BALRAMCHIN/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Re-send/ })).toBeNull();
    open();
    expect(screen.getByText(/SELL BALRAMCHIN/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Re-send/ })).toBeTruthy();
  });

  it('says the sent message is a record when it is the first week', () => {
    render(<TelegramMessage message={message} onResend={() => undefined} firstWeek />);
    open();
    expect(screen.getByText(/as it was sent/)).toBeTruthy();
  });

  it('adds no note on any other week', () => {
    render(<TelegramMessage message={message} onResend={() => undefined} />);
    open();
    expect(screen.queryByText(/as it was sent/)).toBeNull();
  });
});
