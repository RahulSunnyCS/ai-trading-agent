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

  it('polls quickly at first, so a fast or cached run shows within half a second', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      data: { job: { id: 'a', status: 'running' } },
    } as never);
    jobs({ a: { id: 'a', status: 'done', result, error: null } });
    await useMomentumRunsStore.getState().startRun('etf', {}, false);
    await vi.advanceTimersByTimeAsync(299);
    expect(useMomentumRunsStore.getState().runs[0]?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(1);
    expect(useMomentumRunsStore.getState().runs[0]?.status).toBe('done');
  });

  it('never sends a poll while the previous one is unanswered', async () => {
    mockPost.mockResolvedValue({
      ok: true,
      data: { job: { id: 'a', status: 'running' } },
    } as never);
    let release: (() => void) | null = null;
    mockGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, data: { job: { id: 'a', status: 'running' } } } as never);
        }),
    );
    await useMomentumRunsStore.getState().startRun('etf', {}, false);
    await vi.advanceTimersByTimeAsync(10_000); // the first poll hangs for 10 s
    expect(mockGet).toHaveBeenCalledTimes(1);
    (release as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(700); // answered: the next poll follows on the schedule
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('never overlaps polls when a run starts while one is in flight', async () => {
    let n = 0;
    mockPost.mockImplementation(
      async () => ({ ok: true, data: { job: { id: `r${++n}`, status: 'running' } } }) as never,
    );
    let answerFirst: (() => void) | null = null;
    mockGet.mockImplementation((url: string) => {
      const reply = { ok: true, data: { job: { id: url.split('/').pop(), status: 'running' } } };
      if (mockGet.mock.calls.length === 1) {
        return new Promise((resolve) => {
          answerFirst = () => resolve(reply as never);
        });
      }
      return Promise.resolve(reply as never);
    });
    const { startRun } = useMomentumRunsStore.getState();
    await startRun('etf', {}, false);
    await vi.advanceTimersByTimeAsync(300); // first poll sent, not answered
    await startRun('etf', {}, false); // a second run starts mid-poll
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockGet).toHaveBeenCalledTimes(1); // nothing new went out while it was unanswered
    (answerFirst as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(299);
    expect(mockGet).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // the answer restarted the quick pace: both runs
    expect(mockGet).toHaveBeenCalledTimes(3);
  });

  it('keeps polling every run after one run answers with something unusable', async () => {
    mockPost.mockImplementation(async (url: string) => {
      if (url.includes('saved-runs')) return { ok: true, data: { name: 'Run 5' } } as never;
      const id = mockPost.mock.calls.filter(([u]) => u.includes('jobs')).length === 1 ? 'a' : 'b';
      return { ok: true, data: { job: { id, status: 'running' } } } as never;
    });
    const { startRun } = useMomentumRunsStore.getState();
    await startRun('etf', {}, false);
    await startRun('etf', {}, false);
    let aAnswer: unknown = {}; // 200 with no job in it: reading `job.status` throws
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('saved-runs')) return { ok: true, data: [{ n: 4 }] } as never;
      return url.endsWith('/a')
        ? ({ ok: true, data: aAnswer } as never)
        : ({ ok: true, data: { job: { id: 'b', status: 'done', result, error: null } } } as never);
    });
    await vi.advanceTimersByTimeAsync(300);
    const [a1, b1] = useMomentumRunsStore.getState().runs;
    expect(b1?.status).toBe('done'); // the healthy run is not held up by the broken one
    expect(a1?.status).toBe('running');
    aAnswer = { job: { id: 'a', status: 'done', result, error: null } };
    await vi.advanceTimersByTimeAsync(700); // the loop is still alive
    expect(useMomentumRunsStore.getState().runs[0]?.status).toBe('done');
  });

  describe('loadSection', () => {
    const core = {
      kpis: { cagr: 0.1 },
      series: { dates: ['d'], strategy: [1] },
      sections_available: ['trades', 'circuit_exposure'],
    };

    async function finishedRun(): Promise<string> {
      mockPost.mockImplementation(async (url: string) =>
        url.includes('saved-runs')
          ? ({ ok: true, data: { name: 'Run 5' } } as never)
          : ({ ok: true, data: { job: { id: 'a', status: 'running' } } } as never),
      );
      await useMomentumRunsStore.getState().startRun('broad', {}, false);
      jobs({ a: { id: 'a', status: 'done', result: core, error: null } });
      await vi.advanceTimersByTimeAsync(300);
      expect(useMomentumRunsStore.getState().runs[0]?.status).toBe('done');
      await vi.advanceTimersByTimeAsync(0); // let the auto-save finish
      mockGet.mockReset(); // the calls below are the ones each test is about
      return 'a';
    }

    const sectionUrl = (name: string) => `/api/momentum/backtest/jobs/a/sections/${name}`;
    const run = () => useMomentumRunsStore.getState().runs[0];

    it('fetches a section into the run and clears its loading state', async () => {
      const id = await finishedRun();
      mockGet.mockResolvedValue({
        ok: true,
        data: { section: 'trades', data: [{ asset: 'X' }] },
      } as never);
      await useMomentumRunsStore.getState().loadSection(id, 'trades');
      expect(mockGet).toHaveBeenLastCalledWith(sectionUrl('trades'));
      expect(run()?.result?.trades).toEqual([{ asset: 'X' }]);
      expect(run()?.result?.kpis).toEqual({ cagr: 0.1 }); // the rest of the result is untouched
      expect(run()?.sections).toEqual({});
    });

    it('keeps a null section as the answer, distinct from not loaded', async () => {
      const id = await finishedRun();
      mockGet.mockResolvedValue({
        ok: true,
        data: { section: 'circuit_exposure', data: null },
      } as never);
      await useMomentumRunsStore.getState().loadSection(id, 'circuit_exposure');
      expect(run()?.result?.circuit_exposure).toBeNull();
    });

    it('asks once for a section that is already on its way or loaded', async () => {
      const id = await finishedRun();
      let answer: (() => void) | null = null;
      mockGet.mockImplementation(
        () =>
          new Promise((resolve) => {
            answer = () => resolve({ ok: true, data: { section: 'trades', data: [] } } as never);
          }),
      );
      const { loadSection } = useMomentumRunsStore.getState();
      const first = loadSection(id, 'trades');
      await loadSection(id, 'trades'); // in flight: ignored
      expect(run()?.sections?.trades).toEqual({ status: 'loading' });
      expect(mockGet).toHaveBeenCalledTimes(1);
      (answer as unknown as () => void)();
      await first;
      await loadSection(id, 'trades'); // loaded: ignored
      expect(mockGet).toHaveBeenCalledTimes(1);
    });

    it('ignores sections the run does not offer and runs it does not have', async () => {
      const id = await finishedRun();
      const { loadSection } = useMomentumRunsStore.getState();
      await loadSection(id, 'timeline'); // not in sections_available
      await loadSection('nope', 'trades');
      expect(mockGet).not.toHaveBeenCalled();
    });

    it('records a failure, explains a released run, and tries again when asked', async () => {
      const id = await finishedRun();
      const { loadSection } = useMomentumRunsStore.getState();
      mockGet.mockResolvedValue({ ok: false, error: 'boom', status: 500 } as never);
      await loadSection(id, 'trades');
      expect(run()?.sections?.trades).toEqual({ status: 'failed', error: 'boom' });
      expect(run()?.result?.trades).toBeUndefined();

      mockGet.mockResolvedValue({ ok: false, error: 'gone', status: 410 } as never);
      await loadSection(id, 'trades');
      expect(run()?.sections?.trades?.error).toMatch(/released/);

      mockGet.mockResolvedValue({ ok: true, data: { section: 'trades', data: [1] } } as never);
      await loadSection(id, 'trades');
      expect(run()?.result?.trades).toEqual([1]);
      expect(run()?.sections).toEqual({});
    });
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
