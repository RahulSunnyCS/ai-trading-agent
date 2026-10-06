// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

import { MomentumCircuitExposureLoader } from '../../components/momentum/MomentumCircuitExposure';
import { apiGet } from '../../lib/api';
import { type MomentumRun, useMomentumRunsStore } from '../../store/momentumRuns';
import type { MomentumResult } from '../../types/momentum';
import { useRunSection } from '../useRunSection';

const mockGet = vi.mocked(apiGet);

function seedRun(result: Partial<MomentumResult>): void {
  const run: MomentumRun = {
    id: 'a',
    label: 'Run 1',
    dataset: 'broad',
    config: {},
    fresh: false,
    status: 'done',
    startedAt: 0,
    finishedAt: 1,
    result: { kpis: {}, series: {}, ...result } as MomentumResult,
    error: null,
    savedAs: null,
  };
  useMomentumRunsStore.setState({ runs: [run], activeId: 'a' });
}

beforeEach(() => {
  mockGet.mockReset();
  useMomentumRunsStore.setState({ runs: [], activeId: null });
});
afterEach(cleanup);

describe('useRunSection', () => {
  it('asks for a section the run announces but does not have, then returns it', async () => {
    seedRun({ sections_available: ['trades'] });
    mockGet.mockResolvedValue({
      ok: true,
      data: { section: 'trades', data: [{ asset: 'X' }] },
    } as never);
    const { result } = renderHook(() => useRunSection('a', 'trades'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual([{ asset: 'X' }]));
    expect(result.current.loading).toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('does not ask for a section the result already holds', () => {
    seedRun({ trades: [{ asset: 'Y' }] });
    const { result } = renderHook(() => useRunSection('a', 'trades'));
    expect(result.current).toMatchObject({ data: [{ asset: 'Y' }], loading: false, error: null });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('is simply empty for a section the run never had (not announced, not present)', () => {
    seedRun({});
    const { result } = renderHook(() => useRunSection('a', 'circuit_exposure'));
    expect(result.current).toMatchObject({ data: undefined, loading: false, error: null });
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('reports a failure once, does not loop on it, and retries when asked', async () => {
    seedRun({ sections_available: ['trades'] });
    mockGet.mockResolvedValue({ ok: false, error: 'boom', status: 500 } as never);
    const { result } = renderHook(() => useRunSection('a', 'trades'));
    await waitFor(() => expect(result.current.error).toBe('boom'));
    expect(result.current.loading).toBe(false);
    await act(async () => {});
    expect(mockGet).toHaveBeenCalledTimes(1); // no automatic second attempt

    mockGet.mockResolvedValue({ ok: true, data: { section: 'trades', data: [1] } } as never);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.data).toEqual([1]));
    expect(result.current.error).toBeNull();
  });
});

describe('MomentumCircuitExposureLoader', () => {
  it('shows a placeholder while the section loads, then the card', async () => {
    seedRun({ sections_available: ['circuit_exposure'] });
    let answer: (() => void) | null = null;
    mockGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              ok: true,
              data: {
                section: 'circuit_exposure',
                data: {
                  positions: 10,
                  touched: 4,
                  episodes: 5,
                  blocked_entries: 0,
                  blocked_exits: 0,
                  lc: [],
                  uc: [],
                  lc_escaped: [],
                  lc_trapped_count: 0,
                  lc_escaped_count: 0,
                  lc_trapped_sold_during: 0,
                },
              },
            } as never);
        }),
    );
    render(<MomentumCircuitExposureLoader runId="a" />);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
    expect(screen.getByText(/Worst circuit situations/)).toBeTruthy();
    await act(async () => (answer as unknown as () => void)());
    expect(screen.queryByLabelText('Loading')).toBeNull();
    expect(screen.getByText(/4 of 10 holdings/)).toBeTruthy();
  });

  it('renders nothing when the run has no circuit data (not Broad, or it could not be computed)', async () => {
    seedRun({ sections_available: ['circuit_exposure'] });
    mockGet.mockResolvedValue({
      ok: true,
      data: { section: 'circuit_exposure', data: null },
    } as never);
    const { container } = render(<MomentumCircuitExposureLoader runId="a" />);
    await waitFor(() => expect(screen.queryByLabelText('Loading')).toBeNull());
    expect(container.textContent).toBe('');

    cleanup();
    seedRun({}); // an ETF run never announced the section
    const etf = render(<MomentumCircuitExposureLoader runId="a" />);
    expect(etf.container.textContent).toBe('');
  });

  it('says so, and offers a retry, when the section fails', async () => {
    seedRun({ sections_available: ['circuit_exposure'] });
    mockGet.mockResolvedValue({ ok: false, error: 'boom', status: 500 } as never);
    render(<MomentumCircuitExposureLoader runId="a" />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
