// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

import { apiGet, apiPost } from '../lib/api';
import {
  hydrateMomentumRuns,
  resetMomentumRunsForTests,
  useMomentumRunsStore,
} from './momentumRuns';

const mockGet = vi.mocked(apiGet);
const mockPost = vi.mocked(apiPost);
const result = { kpis: { cagr: 0.1 }, series: { dates: ['d'], strategy: [1] } };

function jobs(byId: Record<string, unknown>): void {
  mockGet.mockImplementation(async (url: string) => {
    const id = url.split('/').pop() as string;
    if (url.includes('saved-runs')) return { ok: true, data: [{ n: 4 }] } as never;
    const job = byId[id];
    return job
      ? ({ ok: true, data: { job } } as never)
      : ({ ok: false, error: 'gone', status: 404 } as never);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetMomentumRunsForTests();
  mockPost.mockReset();
  mockGet.mockReset();
});
afterEach(() => {
  resetMomentumRunsForTests();
  vi.useRealTimers();
});

describe('momentumRuns store', () => {
  it('runs several jobs at once and fills each tab when its job finishes', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('saved-runs')) return { ok: true, data: { name: 'Run 5' } } as never;
      const id = mockPost.mock.calls.filter(([u]) => u.includes('jobs')).length === 1 ? 'a' : 'b';
      return { ok: true, data: { job: { id, status: 'running' } } } as never;
    });
    const { startRun } = useMomentumRunsStore.getState();
    expect(await startRun('etf', { x: 1 }, false)).toBeNull();
    expect(await startRun('broad', { x: 2 }, true)).toBeNull();
    expect(mockPost).toHaveBeenCalledWith('/api/momentum/backtest/jobs', { x: 2, fresh: true });
    expect(useMomentumRunsStore.getState().runs.map((r) => r.id)).toEqual(['a', 'b']);
    expect(useMomentumRunsStore.getState().activeId).toBe('b');

    jobs({
      a: { id: 'a', status: 'done', result, error: null },
      b: { id: 'b', status: 'queued', result: null, error: null },
    });
    await vi.advanceTimersByTimeAsync(2100);
    const [a, b] = useMomentumRunsStore.getState().runs;
    expect(a?.status).toBe('done');
    expect(a?.result).toEqual(result);
    expect(a?.savedAs).toBe('Run 5'); // auto-saved, numbered after the existing saved runs
    expect(b?.status).toBe('queued');
  });

  it('marks a run failed when the service forgot the job (restart)', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      data: { job: { id: 'a', status: 'running' } },
    } as never);
    await useMomentumRunsStore.getState().startRun('etf', {}, false);
    jobs({});
    await vi.advanceTimersByTimeAsync(2100);
    expect(useMomentumRunsStore.getState().runs[0]?.status).toBe('failed');
  });

  it('reports a start failure without adding a tab', async () => {
    mockPost.mockResolvedValue({ ok: false, error: 'bad input' } as never);
    expect(await useMomentumRunsStore.getState().startRun('etf', {}, false)).toBe('bad input');
    expect(useMomentumRunsStore.getState().runs).toEqual([]);
  });

  it('re-attaches to in-flight runs after a reload', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      data: { job: { id: 'a', status: 'running' } },
    } as never);
    await useMomentumRunsStore.getState().startRun('etf', { x: 1 }, false);
    const stored = localStorage.getItem('ata-momentum-runs');
    resetMomentumRunsForTests(); // simulates a fresh page load
    localStorage.setItem('ata-momentum-runs', stored as string);
    hydrateMomentumRuns();
    expect(useMomentumRunsStore.getState().runs[0]).toMatchObject({ id: 'a', status: 'running' });
    jobs({ a: { id: 'a', status: 'done', result, error: null } });
    await vi.advanceTimersByTimeAsync(2100);
    expect(useMomentumRunsStore.getState().runs[0]?.status).toBe('done');
  });
});
