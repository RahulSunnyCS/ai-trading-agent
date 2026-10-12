// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearPolledResourceCache } from '../../hooks/usePolledResource';
import type {
  MatrixCell,
  MatrixCellDetail,
  MatrixResponse,
  MatrixUnavailable,
} from '../../types/rotationMatrix';
import { RotationMatrixPanel } from '../optionslab/RotationMatrixPanel';

const cell = (v: number, n = 205, extra: Partial<MatrixCell> = {}): MatrixCell => ({
  v,
  n,
  nv: n,
  m: { avg: v, stop_rate: 0.2, win_rate: 0.5, worst: -900 },
  ...extra,
});

function matrixResponse(over: Partial<MatrixResponse> = {}): MatrixResponse {
  return {
    available: true,
    view: 'family_slot',
    metric: 'avg',
    basis: 'all',
    list: null,
    unit: 'inr',
    metric_label: 'Average gross per one-lot strategy-day',
    aggregation: 'mean of the gross P&L of the pooled variant-days (one lot each)',
    selection_denominator: null,
    filters: { index: 'both', family: null, slot: null, weekday: null, dte: null, vix_band: null },
    min_n: 20,
    rows: [
      { key: 'N:wide', label: 'NIFTY Widesl OTM1' },
      { key: 'N:buy', label: 'NIFTY Buy closest premium 50' },
    ],
    cols: [
      { key: '0917', label: '09:17' },
      { key: '1517', label: '15:17' },
    ],
    periods: [
      {
        id: 'P1',
        label: 'P1 · Dec 2025 to Oct 2026',
        from: '2025-12-03',
        to: '2026-10-08',
        status: 'ok',
        reason: null,
        sessions: 207,
        waiting_on_results: null,
      },
    ],
    matrices: [
      {
        period: 'P1',
        status: 'ok',
        reason: null,
        sessions: 207,
        cells: [
          [cell(148), cell(-60, 9, { thin: true })],
          [
            { st: 'missing', reason: 'no stored result in this period', n: 0, nv: 0 },
            { st: 'na', reason: 'this strategy does not exist here' },
          ],
        ],
        row_summary: [cell(148), null],
        col_summary: [cell(148), cell(-60, 9, { thin: true })],
      },
    ],
    scale: { kind: 'diverging', min: -148, max: 148, limit: 148, clipped: false },
    difference: null,
    overlay: {
      source: 'recorded',
      available: false,
      reason: 'no entry has been recorded yet (the first is Monday 12 Oct 2026)',
      entries: 0,
      on_time: 0,
      late: [],
      scored: 0,
      waiting_on_results: [],
      lists: ['A', 'B', 'C', 'REF'],
      reconstructed: 'Reconstructed picks are not shown',
    },
    date_picks: null,
    as_of: null,
    meta: {
      slots: ['0917', '1517'],
      families: [
        { index: 'NIFTY', family: 'wide', key: 'N:wide', label: 'NIFTY Widesl OTM1' },
        { index: 'NIFTY', family: 'buy', key: 'N:buy', label: 'NIFTY Buy closest premium 50' },
      ],
      weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      dte: ['0', '1'],
      vix_bands: ['<10.5', '13-15', 'unknown'],
      store: {
        variants: 298,
        first: '2024-10-09',
        last: '2026-10-09',
        sessions: 492,
        days_without_attributes: [],
      },
      lists: { A: 'a', B: 'b', C: 'c', REF: 'r' },
      journal: { available: false, reason: 'no entry', on_time: 0, late: 0 },
    },
    all_periods: [],
    notes: ['Gross per one-lot strategy-day: one lot of one strategy, before brokerage.'],
    ...over,
  };
}

const detail: MatrixCellDetail = {
  view: 'family_slot',
  row: { key: 'N:wide', label: 'NIFTY Widesl OTM1' },
  col: { key: '0917', label: '09:17' },
  period: 'P1',
  period_label: 'P1 · Dec 2025 to Oct 2026',
  basis: 'all',
  list: null,
  pooling: 'one strategy: each value is its gross for one lot',
  stats: {
    sessions: 2,
    variant_days: 2,
    avg: 50,
    win_rate: 0.5,
    stop_rate: 0,
    worst: -100,
    best: 200,
  },
  days: [
    { day: '2026-01-05', weekday: 'Mon', gross: 200, n_variants: 1, n_stopped: 0, stopped_by: '' },
    { day: '2026-01-06', weekday: 'Tue', gross: -100, n_variants: 1, n_stopped: 0, stopped_by: '' },
  ],
  cumulative: [
    { day: '2026-01-05', cum: 200 },
    { day: '2026-01-06', cum: 100 },
  ],
  variants: [{ name: 'N_wide_0917', n: 2, avg: 50, win_rate: 0.5, worst: -100 }],
  variants_total: 1,
  overlay: matrixResponse().overlay,
};

function openSettings() {
  fireEvent.click(screen.getByRole('button', { name: /Settings/ }));
}

const ok = (body: unknown, status = 200) => Response.json(body, { status });

function stub(handler: (url: string) => Response) {
  const fetchMock = vi.fn(async (url: string) => handler(String(url)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  clearPolledResourceCache();
  // the page opens on today's session when no period is named: these tests start from P1
  window.history.replaceState(null, '', '/optionslab/matrix?period=P1');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RotationMatrixPanel', () => {
  it('prints signed values, dashes a missing cell and mutes a thin one', async () => {
    stub(() => ok(matrixResponse()));
    render(<RotationMatrixPanel />);
    const wide = await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17: \+₹148/);
    expect(wide.textContent).toBe('+148');
    const thin = screen.getByLabelText(/NIFTY Widesl OTM1, 15:17: -₹60/);
    expect(thin.className).toContain('italic');
    expect(thin.getAttribute('aria-label')).toContain('thin sample');
    expect(thin.getAttribute('aria-label')).toContain('9 sessions');
    const missing = screen.getByLabelText(
      /NIFTY Buy closest premium 50, 09:17: missing, no stored result in this period/,
    );
    expect(missing.textContent).toBe('—');
    expect(missing.className).toContain('border-dashed');
    const na = screen.getByLabelText(/NIFTY Buy closest premium 50, 15:17/) as HTMLButtonElement;
    expect(na.disabled).toBe(true);
    expect(na.textContent).toBe('');
  });

  it('says there are no recorded picks rather than showing an empty overlay', async () => {
    stub(() => ok(matrixResponse()));
    render(<RotationMatrixPanel />);
    expect(await screen.findByText(/Not available: no entry has been recorded yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing is reconstructed here/)).toBeTruthy();
  });

  it('states why a period is unavailable instead of drawing an empty grid', async () => {
    stub(() =>
      ok(
        matrixResponse({
          periods: [
            {
              id: 'P3',
              label: 'P3 · Apr 2022 to Oct 2024',
              from: null,
              to: null,
              status: 'unavailable',
              reason: 'not in the rotation store',
              sessions: null,
              waiting_on_results: null,
            },
          ],
          matrices: [{ period: 'P3', status: 'unavailable', reason: 'not in the rotation store' }],
          scale: null,
        }),
      ),
    );
    render(<RotationMatrixPanel />);
    expect(await screen.findByText('P3 · Apr 2022 to Oct 2024 is not available')).toBeTruthy();
    expect(screen.getByText('not in the rotation store')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows an empty store as such', async () => {
    const empty: MatrixUnavailable = {
      available: false,
      reason: 'no strategy has stored results yet',
      meta: matrixResponse().meta,
    };
    stub(() => ok(empty));
    render(<RotationMatrixPanel />);
    expect(await screen.findByText('No strategy has stored results yet')).toBeTruthy();
  });

  it('offers Retry when the request fails', async () => {
    const fetchMock = stub(() => ok({ error: 'the rotation store is unreadable' }, 500));
    render(<RotationMatrixPanel />);
    expect(await screen.findByText('Could not load the matrix')).toBeTruthy();
    const calls = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(calls));
  });

  it('opens a cell in the drawer with the cell request carrying the same filters', async () => {
    const fetchMock = stub((url) =>
      url.includes('/matrix/cell') ? ok(detail) : ok(matrixResponse()),
    );
    render(<RotationMatrixPanel />);
    fireEvent.click(await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17: \+₹148/));
    expect(await screen.findByText(/one strategy: each value is its gross/)).toBeTruthy();
    const cellCall = fetchMock.mock.calls
      .map(([u]) => String(u))
      .find((u) => u.includes('/matrix/cell'));
    expect(cellCall).toContain('row=N%3Awide');
    expect(cellCall).toContain('col=0917');
    expect(cellCall).toContain('period=P1');
    expect(screen.getByText('Running total by session')).toBeTruthy();
  });

  it('asks the API for both periods when compare is on', async () => {
    const fetchMock = stub(() => ok(matrixResponse()));
    render(<RotationMatrixPanel />);
    await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17: \+₹148/);
    openSettings();
    fireEvent.click(screen.getByText('P1 and P2'));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.map(([u]) => String(u)).some((u) => u.includes('compare=P1%2CP2')),
      ).toBe(true),
    );
  });
  it('keeps one tab stop on a cell that can take focus', async () => {
    stub(() => ok(matrixResponse()));
    render(<RotationMatrixPanel />);
    await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17/);
    const stops = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('data-r') && b.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect((stops[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('says so when a later request fails and the old grid is still on screen', async () => {
    let fail = false;
    stub(() =>
      fail ? ok({ error: 'selection frequency needs a list' }, 422) : ok(matrixResponse()),
    );
    render(<RotationMatrixPanel />);
    await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17/);
    fail = true;
    fireEvent.click(screen.getByLabelText('Refresh the matrix'));
    expect(
      await screen.findByText('The latest request failed; this is the previous result'),
    ).toBeTruthy();
    expect(screen.getByText(/selection frequency needs a list/)).toBeTruthy();
    expect(screen.getByLabelText(/NIFTY Widesl OTM1, 09:17/)).toBeTruthy();
  });

  it('opens both periods for a difference cell and forgets the difference when compare ends', async () => {
    const base = matrixResponse();
    const g1 = base.matrices[0];
    const two = matrixResponse({
      periods: [
        {
          id: 'P1',
          label: 'P1 · Dec 2025 to Oct 2026',
          from: null,
          to: null,
          status: 'ok',
          reason: null,
          sessions: 207,
          waiting_on_results: null,
        },
        {
          id: 'P2',
          label: 'P2 · Jan to Aug 2025',
          from: null,
          to: null,
          status: 'ok',
          reason: null,
          sessions: 158,
          waiting_on_results: null,
        },
      ],
      matrices: g1 ? [g1, { ...g1, period: 'P2' }] : [],
      difference: {
        status: 'ok',
        minuend: 'P1',
        subtrahend: 'P2',
        unit: 'inr',
        note: 'the first period minus the second',
        scale: { kind: 'diverging', min: -50, max: 50, limit: 50, clipped: false },
        cells: [
          [
            { v: 10, n: [205, 158] },
            { st: 'missing', reason: 'one of the periods has no value here' },
          ],
          [{ st: 'missing', reason: 'one of the periods has no value here' }, { st: 'na' }],
        ],
      },
    });
    const fetchMock = stub((url) =>
      url.includes('/matrix/cell') ? ok(detail) : ok(url.includes('compare=') ? two : base),
    );
    render(<RotationMatrixPanel />);
    await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17/);
    openSettings();
    fireEvent.click(screen.getByText('P1 and P2'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.click(await screen.findByText('Difference'));
    fireEvent.click(
      await screen.findByLabelText(
        /NIFTY Widesl OTM1, 09:17: \+10 pp|NIFTY Widesl OTM1, 09:17: \+₹10/,
      ),
    );
    await waitFor(() => {
      const cells = fetchMock.mock.calls
        .map(([u]) => String(u))
        .filter((u) => u.includes('/matrix/cell'));
      expect(cells.some((u) => u.includes('period=P1'))).toBe(true);
      expect(cells.some((u) => u.includes('period=P2'))).toBe(true);
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    openSettings();
    fireEvent.click(screen.getByText('One period'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('Difference')).toBeNull());
    expect(document.body.textContent).not.toContain('minus P2');
  });

  describe('default view: the latest scored session', () => {
    const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const probeResponse = () =>
      matrixResponse({
        view: 'date_slot',
        rows: days.map((d) => ({ key: d, label: d, date: d })),
      });
    const handler = (url: string) =>
      url.includes('view=date_slot') ? ok(probeResponse()) : ok(matrixResponse());
    const mainCalls = (fetchMock: ReturnType<typeof stub>) =>
      fetchMock.mock.calls
        .map(([u]) => String(u))
        .filter((u) => u.includes('/matrix?') && !u.includes('view=date_slot'));

    it('opens on the latest scored day as one session with min_n=1 and says which day', async () => {
      window.history.replaceState(null, '', '/optionslab/matrix');
      const fetchMock = stub(handler);
      render(<RotationMatrixPanel />);
      await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17/);
      const calls = mainCalls(fetchMock);
      expect(calls.length).toBeGreaterThan(0);
      for (const u of calls) {
        expect(u).toContain('period=custom');
        expect(u).toContain('from=2026-10-09');
        expect(u).toContain('to=2026-10-09');
        expect(u).toContain('min_n=1');
        expect(u).not.toContain('period=P1');
      }
      expect(screen.getByTestId('matrix-summary').textContent).toContain('Session of 09 Oct 2026');
      expect(screen.getByText(/Showing the latest scored session, 09 Oct 2026/)).toBeTruthy();
    });

    it('keeps a period named in the URL and never asks for the latest day', async () => {
      window.history.replaceState(null, '', '/optionslab/matrix?period=P2&minn=5');
      const fetchMock = stub(handler);
      render(<RotationMatrixPanel />);
      await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17/);
      const calls = mainCalls(fetchMock);
      expect(calls.every((u) => u.includes('period=P2') && u.includes('min_n=5'))).toBe(true);
      expect(screen.queryByText(/Showing the latest scored session/)).toBeNull();
    });

    it('keeps the pulse view as of its own date, not a single day', async () => {
      window.history.replaceState(null, '', '/optionslab/matrix?view=pulse');
      const fetchMock = stub(handler);
      render(<RotationMatrixPanel />);
      await waitFor(() => expect(mainCalls(fetchMock).length).toBeGreaterThan(0));
      expect(mainCalls(fetchMock).every((u) => !u.includes('period='))).toBe(true);
    });

    it('a quick preset names the period in the URL and Reset to today clears it', async () => {
      window.history.replaceState(null, '', '/optionslab/matrix');
      const fetchMock = stub(handler);
      render(<RotationMatrixPanel />);
      await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17/);
      openSettings();
      fireEvent.click(await screen.findByText('Last 5 sessions'));
      await waitFor(() => expect(window.location.search).toContain('period=custom'));
      expect(window.location.search).toContain('from=2026-10-05');
      expect(window.location.search).toContain('to=2026-10-09');
      await waitFor(() =>
        expect(mainCalls(fetchMock).some((u) => u.includes('from=2026-10-05'))).toBe(true),
      );
      fireEvent.click(screen.getByText('Reset to today'));
      await waitFor(() => expect(window.location.search).toBe(''));
    });

    it('Latest day returns to following the newest session and keeps other settings', async () => {
      window.history.replaceState(null, '', '/optionslab/matrix?period=P1&family=widesl');
      stub(handler);
      render(<RotationMatrixPanel />);
      await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17/);
      openSettings();
      fireEvent.click(screen.getByText('Latest day'));
      await waitFor(() => expect(window.location.search).toBe('?family=widesl'));
    });

    it('One period after P1 and P2 (cmp only in the URL) stays on P1, not today', async () => {
      window.history.replaceState(null, '', '/optionslab/matrix?cmp=1');
      stub(handler);
      render(<RotationMatrixPanel />);
      await screen.findByLabelText(/NIFTY Widesl OTM1, 09:17/);
      openSettings();
      fireEvent.click(screen.getByText('One period'));
      await waitFor(() => expect(window.location.search).toBe('?period=P1'));
    });

    it('falls back to P1 and says so when no scored session can be found', async () => {
      window.history.replaceState(null, '', '/optionslab/matrix');
      const fetchMock = stub((url) =>
        url.includes('view=date_slot') ? ok({ error: 'down' }, 500) : ok(matrixResponse()),
      );
      render(<RotationMatrixPanel />);
      expect(await screen.findByText(/could not be found, so this shows P1/)).toBeTruthy();
      expect(mainCalls(fetchMock).some((u) => u.includes('period=P1'))).toBe(true);
    });
  });
});
