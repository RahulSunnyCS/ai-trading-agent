// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { response, row, summary } from '../../../lib/__tests__/rotationLotPlansFixture';

const hook = vi.hoisted(() => ({
  state: { data: null, loading: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  },
  books: [] as string[],
}));

vi.mock('../../../hooks/useRotationLotPlans', () => ({
  useRotationLotPlans: (book: string) => {
    hook.books.push(book);
    return hook.state;
  },
}));

// the chart is Lightweight Charts (canvas): out of scope here, so a plain stand-in
vi.mock('../shared', () => ({
  CumulativeLines: ({ lines }: { lines: { id: string }[] }) => (
    <div data-testid="lines">{lines.map((l) => l.id).join(',')}</div>
  ),
  pnlClass: () => '',
}));

import { RotationLotPlans } from '../RotationLotPlans';

function scored(book: 'core' | 't1') {
  return response({
    book,
    today: '2026-10-20',
    counts: { scored: 1, waiting: 0, late: 0, unverified: 0, entries: 1 },
    plans: [
      summary({ plan: 'as_picked', days: 1, net: 800, net_per_day: 800 }),
      summary({ plan: 'dir_boost', days: 1, net: 1200, net_per_day: 1200 }),
      summary({ plan: 'duo', days: 1, net: 500, net_per_day: 500 }),
    ],
    cumulative: [{ day: '2026-10-19', as_picked: 800, dir_boost: 1200, duo: 500 }],
    rows: [row({ day: '2026-10-19', book })],
  });
}

beforeEach(() => {
  hook.state = { data: null, loading: false, error: null, refetch: vi.fn() };
  hook.books = [];
});
afterEach(cleanup);

describe('RotationLotPlans', () => {
  it('shows the plans, the chart and the daily rows for the chosen book', () => {
    hook.state.data = scored('core');
    render(<RotationLotPlans />);
    expect(hook.books.at(-1)).toBe('core');
    expect(screen.getAllByText('Dir Boost').length).toBeGreaterThan(0);
    expect(screen.getByTestId('lines').textContent).toBe('As picked,Dir Boost,Duo');
    expect(screen.getByText('19 Oct 2026')).toBeTruthy();
  });

  it('never shows a response held for the other book', () => {
    hook.state.data = scored('t1'); // the T1 answer is still held while Core is asked for
    render(<RotationLotPlans />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('lines')).toBeNull();
    // switching to T1 asks for T1; the Core answer held then is not shown either
    hook.state.data = scored('core');
    fireEvent.click(screen.getByRole('radio', { name: 'T1' }));
    expect(hook.books.at(-1)).toBe('t1');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an error instead of held figures', () => {
    hook.state.data = scored('core');
    hook.state.error = '500: the journal cannot be read';
    render(<RotationLotPlans />);
    expect(screen.getByText('Could not read the lot plans')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByTestId('lines')).toBeNull();
  });

  it('says tracking starts on Monday before the first entry', () => {
    hook.state.data = response();
    render(<RotationLotPlans />);
    expect(screen.getByText('Tracking starts Mon 19 Oct')).toBeTruthy();
    expect(screen.queryByTestId('lines')).toBeNull();
  });
});
