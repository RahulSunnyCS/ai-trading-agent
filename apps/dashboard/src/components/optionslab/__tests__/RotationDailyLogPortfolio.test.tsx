// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../../hooks/usePolledResource';
import { ROWS, log } from '../../../lib/__tests__/rotationDailyLogFixture';
import { formatInr } from '../../../lib/format';
import { DEFAULT_SETTING } from '../../../lib/portfolioStop';
import type { PortfolioDays } from '../../../types/rotationPortfolio';
import { RotationDailyLog } from '../RotationDailyLog';

const scored = ROWS.find((r) => r.status === 'scored' && r.lists.C?.per_lot_day != null);

function book(day: string, lots: number): PortfolioDays {
  return {
    basis: 'gross',
    source: 'recorded',
    setting: { amount: 10000, trail: null },
    rows: [
      {
        day,
        lists: {
          C: {
            lots,
            gross_log: 0,
            gross_without: 0,
            gross_with: -10361,
            stop_minute: 119,
            stop_label: '11:14',
            fired_by: 'stop',
            matches_log: true,
          },
        },
      },
    ],
    errors: [],
    totals: {},
  };
}

function stub(handler: (url: string) => unknown) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(handler(url)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

beforeEach(() => {
  clearPolledResourceCache();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the daily log with a portfolio stop', () => {
  it('lays the stopped figure and the flag over the log, keeping the log figure struck through', async () => {
    expect(scored).toBeDefined();
    const day = scored?.day ?? '';
    const lots = scored?.lists.C?.lots ?? 6;
    const calls = stub((url) => (url.includes('/portfolio/days') ? book(day, lots) : log()));
    render(<RotationDailyLog focus="C" portfolio={DEFAULT_SETTING} />);
    await screen.findByRole('table');
    await waitFor(() => expect(screen.getByText('PF stop 11:14')).toBeTruthy());
    expect(calls.some((c) => /portfolio\/days\?.*stop=10000/.test(c))).toBe(true);
    const row = screen.getByText('PF stop 11:14').closest('tr');
    expect(row).not.toBeNull();
    // the stopped figure per lot-day, with the log's own figure struck through beside it
    expect(row?.textContent).toContain(formatInr(-10361 / lots, { sign: true }));
    expect(row?.querySelector('.line-through')).not.toBeNull();
    expect(screen.getByText(/portfolio stop applied/)).toBeTruthy();
  });

  it('fetches nothing for the stop and shows the log as is when there is no stop', async () => {
    const calls = stub(() => log());
    render(<RotationDailyLog focus="C" portfolio={{ ...DEFAULT_SETTING, stop: '' }} />);
    await screen.findByRole('table');
    expect(calls.some((c) => c.includes('/portfolio/'))).toBe(false);
    expect(screen.queryByText(/PF stop/)).toBeNull();
  });

  it('keeps the log figures and says so while the stopped ones are replayed', async () => {
    stub((url) => (url.includes('/portfolio/days') ? new Promise(() => undefined) : log()));
    render(<RotationDailyLog focus="C" portfolio={DEFAULT_SETTING} />);
    await screen.findByRole('table');
    expect(screen.getByText(/Replaying the baskets under the portfolio stop/)).toBeTruthy();
  });
});
