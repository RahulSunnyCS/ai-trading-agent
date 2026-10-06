import { create } from 'zustand';

import { apiGet, apiPost } from '../lib/api';
import type { MomentumResult, MomentumSavedRun } from '../types/momentum';

/**
 * Momentum backtest runs, held OUTSIDE the view so they outlive it.
 *
 * A run is a background job on the Momentum service (`POST /api/momentum/backtest/jobs`, polled
 * at `/jobs/:id`). Keeping the runs and the poller at module level - not in component state -
 * means leaving the Momentum page and coming back finds the run still in flight (or finished),
 * and several runs can be in flight at once, each shown as its own tab. In-flight runs are also
 * mirrored to localStorage so a page reload re-attaches to them; finished runs are saved
 * server-side as "Saved runs", so they are never lost either way.
 */

export type MomentumRunStatus = 'queued' | 'running' | 'done' | 'failed';

export interface MomentumRun {
  /** The server's job id. */
  id: string;
  /** "Run 3" - a session counter, only to tell tabs apart. */
  label: string;
  dataset: string;
  config: Record<string, unknown>;
  fresh: boolean;
  status: MomentumRunStatus;
  startedAt: number;
  finishedAt: number | null;
  result: MomentumResult | null;
  error: string | null;
  /** Name of the saved run created from this one, once the auto-save has landed. */
  savedAs: string | null;
}

interface PersistedRun {
  id: string;
  label: string;
  dataset: string;
  config: Record<string, unknown>;
  fresh: boolean;
  startedAt: number;
}

interface MomentumRunsState {
  runs: MomentumRun[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  /** Starts a run; resolves to an error message when it could not be started. */
  startRun: (
    dataset: string,
    config: Record<string, unknown>,
    fresh: boolean,
  ) => Promise<string | null>;
  closeRun: (id: string) => void;
}

interface JobView {
  id: string;
  status: MomentumRunStatus;
  result: MomentumResult | null;
  error: string | null;
}

const STORAGE_KEY = 'ata-momentum-runs';
/** Delay before each poll after a run starts: quick at first, so a fast or cached run shows at
 * once, then every 2 s (BL-005). The last entry repeats. */
export const POLL_SCHEDULE_MS = [300, 700, 1500, 2000] as const;

const isActive = (run: MomentumRun): boolean => run.status === 'queued' || run.status === 'running';

function persist(runs: MomentumRun[], activeId: string | null): void {
  try {
    const inFlight: PersistedRun[] = runs
      .filter(isActive)
      .map(({ id, label, dataset, config, fresh, startedAt }) => ({
        id,
        label,
        dataset,
        config,
        fresh,
        startedAt,
      }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ runs: inFlight, activeId }));
  } catch {
    // Storage unavailable (private window, blocked) - runs just won't survive a reload.
  }
}

let nextSeq = 1;
let timer: ReturnType<typeof setTimeout> | null = null;
let pollIndex = 0;
let pollGeneration = 0;
const saving = new Set<string>();

export const useMomentumRunsStore = create<MomentumRunsState>((set, get) => ({
  runs: [],
  activeId: null,

  setActive: (id) => {
    set({ activeId: id });
    persist(get().runs, id);
  },

  startRun: async (dataset, config, fresh) => {
    const response = await apiPost<{ job: JobView }>(
      '/api/momentum/backtest/jobs',
      fresh ? { ...config, fresh: true } : config,
    );
    if (!response.ok) return response.error;
    const run: MomentumRun = {
      id: response.data.job.id,
      label: `Run ${nextSeq++}`,
      dataset,
      config,
      fresh,
      status: response.data.job.status,
      startedAt: Date.now(),
      finishedAt: null,
      result: null,
      error: null,
      savedAs: null,
    };
    set((state) => ({ runs: [...state.runs, run], activeId: run.id }));
    persist(get().runs, run.id);
    ensurePolling(true);
    return null;
  },

  closeRun: (id) => {
    const { runs, activeId } = get();
    const remaining = runs.filter((run) => run.id !== id);
    const nextActive = activeId === id ? (remaining[remaining.length - 1]?.id ?? null) : activeId;
    set({ runs: remaining, activeId: nextActive });
    persist(remaining, nextActive);
  },
}));

function patchRun(id: string, patch: Partial<MomentumRun>): void {
  useMomentumRunsStore.setState((state) => ({
    runs: state.runs.map((run) => (run.id === id ? { ...run, ...patch } : run)),
  }));
}

async function saveFinishedRun(run: MomentumRun, result: MomentumResult): Promise<void> {
  if (saving.has(run.id)) return;
  saving.add(run.id);
  try {
    const existing = await apiGet<MomentumSavedRun[]>(
      `/api/momentum/saved-runs?dataset=${run.dataset}`,
    );
    const sequence = Math.max(0, ...(existing.ok ? existing.data.map((saved) => saved.n) : [])) + 1;
    const kpis = result.kpis;
    const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
    const saved = await apiPost<MomentumSavedRun>('/api/momentum/saved-runs', {
      dataset: run.dataset,
      name: `Run ${sequence}`,
      config: run.config,
      kpis: {
        cagr: num(kpis.cagr),
        excess_cagr: num(kpis.excess_cagr),
        max_drawdown: num(kpis.max_drawdown),
        sharpe: num(kpis.sharpe),
        turnover_per_year: num(kpis.turnover_per_year),
        avg_holdings: num(kpis.avg_holdings),
      },
      dates: result.series.dates,
      strategy: result.series.strategy,
      overlay: false,
    });
    if (saved.ok) patchRun(run.id, { savedAs: saved.data.name });
  } finally {
    saving.delete(run.id);
  }
}

async function pollOnce(run: MomentumRun): Promise<void> {
  const response = await apiGet<{ job: JobView }>(`/api/momentum/backtest/jobs/${run.id}`);
  if (!response.ok) {
    // 404 = the Momentum service restarted and forgot the job; it can never finish. Anything
    // else (network blip, proxy 503) is transient: keep the run and try again next tick.
    if (response.status === 404) {
      patchRun(run.id, {
        status: 'failed',
        finishedAt: Date.now(),
        error: 'The Momentum service restarted while this run was in progress. Run it again.',
      });
    }
    return;
  }
  const { job } = response.data;
  if (job.status === 'done' && job.result) {
    patchRun(run.id, { status: 'done', finishedAt: Date.now(), result: job.result });
    void saveFinishedRun(run, job.result);
  } else if (job.status === 'failed') {
    patchRun(run.id, {
      status: 'failed',
      finishedAt: Date.now(),
      error: job.error ?? 'The run failed.',
    });
  } else if (job.status !== run.status) {
    patchRun(run.id, { status: job.status });
  }
}

function schedulePoll(generation: number): void {
  const delay = POLL_SCHEDULE_MS[Math.min(pollIndex, POLL_SCHEDULE_MS.length - 1)];
  pollIndex += 1;
  timer = setTimeout(() => {
    const active = useMomentumRunsStore.getState().runs.filter(isActive);
    if (active.length === 0) {
      timer = null;
      return;
    }
    // The next poll is scheduled only once this one has answered, so a slow response never
    // overlaps the next request. A restart while this one was in flight owns the loop now.
    void Promise.all(active.map(pollOnce)).then(() => {
      const { runs, activeId } = useMomentumRunsStore.getState();
      persist(runs, activeId);
      if (generation === pollGeneration) schedulePoll(generation);
    });
  }, delay);
}

/** Polls every in-flight run until none are left, then stops itself. `restart` (a run just
 * started) goes back to the quick first polls. */
function ensurePolling(restart = false): void {
  if (timer !== null && !restart) return;
  if (timer !== null) clearTimeout(timer);
  pollGeneration += 1;
  pollIndex = 0;
  schedulePoll(pollGeneration);
}

let hydrated = false;

/** Re-attach to runs that were in flight before a reload. Call once from a client effect. */
export function hydrateMomentumRuns(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { runs?: PersistedRun[]; activeId?: string | null };
    const known = new Set(useMomentumRunsStore.getState().runs.map((run) => run.id));
    const restored: MomentumRun[] = (saved.runs ?? [])
      .filter((run) => !known.has(run.id))
      .map((run) => ({
        ...run,
        status: 'running' as const,
        finishedAt: null,
        result: null,
        error: null,
        savedAs: null,
      }));
    if (restored.length === 0) return;
    for (const run of restored) {
      const n = Number(run.label.replace(/\D/g, ''));
      if (Number.isFinite(n) && n >= nextSeq) nextSeq = n + 1;
    }
    useMomentumRunsStore.setState((state) => ({
      runs: [...restored, ...state.runs],
      activeId: state.activeId ?? saved.activeId ?? restored[restored.length - 1]?.id ?? null,
    }));
    ensurePolling();
  } catch {
    // Corrupt or unavailable storage - start clean.
  }
}

/** Test seam: forget module state between tests. */
export function resetMomentumRunsForTests(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pollIndex = 0;
  pollGeneration += 1;
  hydrated = false;
  nextSeq = 1;
  saving.clear();
  useMomentumRunsStore.setState({ runs: [], activeId: null });
}
