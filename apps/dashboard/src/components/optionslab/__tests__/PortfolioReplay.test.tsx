// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const added: { kind: string; title: string | undefined; points: number }[] = [];

vi.mock('lightweight-charts', () => {
  const series = (kind: string, opts: { title?: string }) => {
    const entry = { kind, title: opts.title, points: 0 };
    added.push(entry);
    return {
      setData: (data: unknown[]) => {
        entry.points = data.length;
      },
      setMarkers: () => undefined,
    };
  };
  return {
    createChart: () => ({
      addLineSeries: (o: { title?: string }) => series('line', o),
      addBaselineSeries: (o: { title?: string }) => series('baseline', o),
      removeSeries: () => undefined,
      applyOptions: () => undefined,
      remove: () => undefined,
      timeScale: () => ({
        fitContent: () => undefined,
        subscribeVisibleTimeRangeChange: () => undefined,
        unsubscribeVisibleTimeRangeChange: () => undefined,
        timeToCoordinate: () => null,
      }),
    }),
  };
});

import { clearPolledResourceCache } from '../../../hooks/usePolledResource';
import { DEFAULT_SETTING } from '../../../lib/portfolioStop';
import type { PortfolioDay } from '../../../types/rotationPortfolio';
import { PortfolioReplay } from '../PortfolioReplay';

const N = 375;

function body(over: Partial<PortfolioDay['book']> = {}): PortfolioDay {
  const combined = Array.from({ length: N }, (_, i) => (i < 120 ? -i * 100 : -11900));
  const stopped = combined.map((v, i) => (i <= 100 ? v : (combined[100] ?? v)));
  return {
    day: '2026-09-11',
    list: 'A',
    basis: 'gross',
    setting: { amount: 10000, trail: null },
    book: {
      lots: 6,
      gross_log: -17986,
      gross_without: -17986,
      gross_with: -10000,
      stop_minute: 100,
      stop_label: '10:55',
      fired_by: 'stop',
      matches_log: true,
      ...over,
    },
    minutes: N,
    first_minute_label: '09:15',
    combined,
    stopped,
    level: combined.map((_, i) => (i <= 100 ? -10000 : null)),
    picks: [
      { name: 'N_wide_0917', lots: 2, role: 'core', gross: -6000, at_stop: -3000, path: combined },
      { name: 'S_wide_0917', lots: 2, role: 'core', gross: -6000, at_stop: -3000, path: combined },
    ],
  };
}

function stub(response: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response()),
  );
}
const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

beforeEach(() => {
  added.length = 0;
  clearPolledResourceCache();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PortfolioReplay', () => {
  it('draws the basket, each pick and the stop level, and says where it closed', async () => {
    stub(() => ok(body()));
    render(
      <PortfolioReplay
        day="2026-09-11"
        list="A"
        source="reconstructed"
        setting={DEFAULT_SETTING}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/Closed by the portfolio stop at 10:55/)).toBeTruthy();
    expect(screen.getByText(/List A as one basket/)).toBeTruthy();
    const titles = added.map((a) => a.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'N_wide_0917',
        'S_wide_0917',
        'Basket ₹',
        'No portfolio stop',
        'Stop level',
      ]),
    );
    // the level is drawn only up to the stop
    expect(added.find((a) => a.title === 'Stop level')?.points).toBe(101);
    expect(screen.queryByText(/differs from the log/)).toBeNull();
  });

  it('warns when the replay without a stop does not equal the log', async () => {
    stub(() => ok(body({ matches_log: false, gross_without: -17000 })));
    render(
      <PortfolioReplay
        day="2026-09-11"
        list="A"
        source="recorded"
        setting={DEFAULT_SETTING}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/differs from the log/)).toBeTruthy();
  });

  it('shows a clear error when the day cannot be replayed', async () => {
    stub(
      () =>
        new Response(JSON.stringify({ error: 'no collected NIFTY data for 2026-09-11' }), {
          status: 404,
        }),
    );
    render(
      <PortfolioReplay
        day="2026-09-11"
        list="A"
        source="recorded"
        setting={DEFAULT_SETTING}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/Could not replay this list/)).toBeTruthy();
    expect(screen.getByText(/no collected NIFTY data/)).toBeTruthy();
  });
});
