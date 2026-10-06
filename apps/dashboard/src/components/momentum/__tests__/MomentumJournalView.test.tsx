// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MomentumJournal } from '../../../types/momentum';

const calls: string[] = [];
let response: MomentumJournal | null = null;

vi.mock('../../../hooks/usePolledResource', () => ({
  usePolledResource: (url: string) => {
    calls.push(url);
    return { data: response, loading: false, error: null, refetch: () => {} };
  },
}));

const { MomentumJournalView } = await import('../MomentumJournalView');

afterEach(() => {
  cleanup();
  calls.length = 0;
});

const journal: MomentumJournal = {
  available: true,
  weeks: [
    { week: '2026-10-09', entries: 2 },
    { week: '2026-10-02', entries: 1 },
  ],
  week: '2026-10-09',
  entries: [
    {
      entry_id: 7,
      recorded_at: '2026-10-09T09:10:02.000000Z',
      week: '2026-10-09',
      run_kind: 'preview',
      source: 'favourite',
      config_id: 'etf-1',
      config_name: 'ETF Weekly Core',
      dataset: 'etf',
      settings_hash: 'abcd1234abcd1234',
      code_commit: 'c4ee68c9404a1111+dirty',
      data_fingerprint: 'weekly_closes:sha256:ff',
      supersedes: null,
      prev_hash: '0'.repeat(64),
      row_hash: 'e'.repeat(64),
      holdings_before: { 'Nifty Realty': 0.6, Gold: 0.4 },
      actions: [
        { asset: 'Nifty IT', action: 'BUY', rank: 1 },
        { asset: 'Gold', action: 'SELL', rank: 14 },
        { asset: 'Nifty Realty', action: 'HOLD', rank: 2 },
      ],
      level: null,
    },
  ],
  check: {
    week: '2026-10-09',
    expected: 3,
    recorded: 1,
    items: [
      {
        config_id: 'etf-1',
        name: 'ETF Weekly Core',
        dataset: 'etf',
        run_kind: 'preview',
        status: 'recorded',
        entry_id: 7,
        week: '2026-10-09',
        recorded_at: '2026-10-09T09:10:02.000000Z',
        corrections: 0,
      },
      {
        config_id: 'stock-1',
        name: 'Stock Weekly Core',
        dataset: 'stock',
        run_kind: 'final',
        status: 'wrong_week',
        entry_id: 8,
        week: '2026-10-02',
        recorded_at: '2026-10-09T14:05:00.000000Z',
        corrections: 0,
      },
      {
        config_id: 'broad-1',
        name: 'Broad A',
        dataset: 'broad',
        run_kind: 'final',
        status: 'missing',
        entry_id: null,
        week: null,
        recorded_at: null,
        corrections: 0,
      },
    ],
    chain: { entries: 8, head: 'e'.repeat(64), problems: [] },
    warnings: ['1 entry was recorded from uncommitted code, so cannot be reproduced: #7'],
    ok: false,
  },
};

describe('MomentumJournalView', () => {
  it('explains that nothing is recorded before the first Friday', () => {
    response = { available: false, weeks: [], week: null, entries: [], check: null };
    render(<MomentumJournalView />);
    expect(screen.getByText('Nothing recorded yet')).toBeTruthy();
  });

  it("shows the week's check, the chain and the entries", () => {
    response = journal;
    render(<MomentumJournalView />);

    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(screen.getByText('Intact')).toBeTruthy();
    expect(screen.getByText('e'.repeat(16))).toBeTruthy();
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('Signal labelled week of 02 Oct 2026')).toBeTruthy();
    expect(screen.getByText(/recorded from uncommitted code/)).toBeTruthy();
    // Trades only in the table row: HOLD is not a trade.
    expect(screen.getByText('BUY Nifty IT')).toBeTruthy();
    expect(screen.getByText('SELL Gold')).toBeTruthy();
    expect(screen.queryByText('HOLD Nifty Realty')).toBeNull();
    expect(screen.getByText('Nifty Realty 60%, Gold 40%')).toBeTruthy();
  });

  it('opens an entry to show every action and its provenance', () => {
    response = journal;
    render(<MomentumJournalView />);
    fireEvent.click(screen.getByText('ETF Weekly Core', { selector: 'span' }));
    expect(screen.getByText('Actions in this signal')).toBeTruthy();
    expect(screen.getByText('HOLD')).toBeTruthy();
    expect(screen.getByText('uncommitted changes')).toBeTruthy();
    expect(screen.getByText('weekly_closes:sha256:ff')).toBeTruthy();
  });

  it('asks for another week when one is chosen', () => {
    response = journal;
    render(<MomentumJournalView />);
    fireEvent.change(screen.getByLabelText('Signal week'), { target: { value: '2026-10-02' } });
    expect(calls.at(-1)).toBe('/api/momentum/journal?week=2026-10-02');
  });
});
