import { create } from 'zustand';

import { apiGet, apiPost } from '../lib/api';
import { recordDuration } from '../lib/momentumDurations';
import type { MomentumResult, MomentumSavedRun, MomentumSectionName } from '../types/momentum';

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

/** Where a heavy section of a finished run stands. Its data, once loaded, sits in `result`. */
export interface MomentumSectionState {
  status: 'loading' | 'failed';
  error?: string;
}

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
  /** The step a running job has reached ("loading", "ranking", "simulating", "analysing"), as the
   * server last reported it, and the server's ordered list of steps. */
  stage?: string | null;
  stages?: string[] | undefined;
  /** Sections being fetched, or that failed to be. Absent once loaded (see `result`). */
  sections?: Partial<Record<MomentumSectionName, MomentumSectionState>>;
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
  /** Fetches one heavy part of a finished run into its result. Does nothing when it is already
   * loaded or on its way; after a failure it tries again. */
  loadSection: (runId: string, name: MomentumSectionName) => Promise<void>;
}

interface JobView {
  id: string;
  status: MomentumRunStatus;
  result: MomentumResult | null;
  error: string | null;
  stage?: string | null;
  stages?: string[];
  compute_started_at?: string | null;
  finished_at?: string | null;
  /** How long the computation took, in milliseconds. */
  compute_ms?: number | null;
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
let pollInFlight = false;
/** Bumped by the test seam so a poll still in flight from before a reset cannot restart the loop. */
let pollEpoch = 0;
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

  loadSection: async (runId, name) => {
    const run = get().runs.find((r) => r.id === runId);
    if (!run?.result || run.result[name] !== undefined) return;
    if (!run.result.sections_available?.includes(name)) return;
    if (run.sections?.[name]?.status === 'loading') return;
    markSection(runId, name, { status: 'loading' });
    const response = await apiGet<{ section: string; data: unknown }>(
      `/api/momentum/backtest/jobs/${runId}/sections/${name}`,
    );
    if (!response.ok) {
      markSection(runId, name, {
        status: 'failed',
        error:
          response.status === 410
            ? 'This run was released to make room for newer ones. Run it again to see this.'
            : response.error,
      });
      return;
    }
    // A null section (the circuit card when it could not be computed) is a real answer: it is
    // stored as null, which stays distinct from "not loaded yet" (undefined).
    const current = get().runs.find((r) => r.id === runId)?.result;
    if (current) patchRun(runId, { result: { ...current, [name]: response.data.data } });
    markSection(runId, name, null);
  },
}));

function markSection(
  runId: string,
  name: MomentumSectionName,
  state: MomentumSectionState | null,
): void {
  useMomentumRunsStore.setState((current) => ({
    runs: current.runs.map((run) => {
      if (run.id !== runId) return run;
      const { [name]: _previous, ...others } = run.sections ?? {};
      return { ...run, sections: state ? { ...others, [name]: state } : others };
    }),
  }));
}

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
      // BL-052: lets the server tell a data revision from a code change when the result moves.
      versions: result.versions ?? null,
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
    patchRun(run.id, { status: 'done', stage: null, finishedAt: Date.now(), result: job.result });
    rememberDuration(run.dataset, job);
    void saveFinishedRun(run, job.result);
  } else if (job.status === 'failed') {
    patchRun(run.id, {
      status: 'failed',
      finishedAt: Date.now(),
      error: job.error ?? 'The run failed.',
    });
  } else if (job.status !== run.status || (job.stage ?? null) !== (run.stage ?? null)) {
    patchRun(run.id, { status: job.status, stage: job.stage ?? null, stages: job.stages });
  }
}

/** Remember how long the server spent computing a finished run, for the banner's "usually about".
 * A run it answered from its cache says nothing about that. */
function rememberDuration(dataset: string, job: JobView): void {
  if (job.result?.cache?.hit) return;
  // The server's own millisecond figure; the timestamps it also sends are whole seconds, which is
  // too coarse for a run of a second or two.
  if (typeof job.compute_ms === 'number') {
    recordDuration(dataset, job.compute_ms);
    return;
  }
  const began = job.compute_started_at ? Date.parse(job.compute_started_at) : Number.NaN;
  const ended = job.finished_at ? Date.parse(job.finished_at) : Number.NaN;
  recordDuration(dataset, ended - began);
}

function schedulePoll(epoch: number): void {
  const delay = POLL_SCHEDULE_MS[Math.min(pollIndex, POLL_SCHEDULE_MS.length - 1)];
  pollIndex += 1;
  timer = setTimeout(() => {
    timer = null;
    const active = useMomentumRunsStore.getState().runs.filter(isActive);
    if (active.length === 0) return;
    // The next poll is scheduled only once this one has answered, so polls never overlap.
    pollInFlight = true;
    // A run whose poll throws (an answer with no job in it, say) must not end polling for the
    // others, or for itself next time: it is retried on the next tick like any other failure.
    void Promise.all(active.map((run) => pollOnce(run).catch(() => undefined))).then(() => {
      if (epoch !== pollEpoch) return; // the test seam reset the store while this was in flight
      pollInFlight = false;
      const { runs, activeId } = useMomentumRunsStore.getState();
      persist(runs, activeId);
      schedulePoll(epoch);
    });
  }, delay);
}

/** Polls every in-flight run until none are left, then stops itself. `restart` (a run just
 * started) goes back to the quick first polls. If a poll is in flight when that happens, the
 * answer to it schedules the next one at the quick pace, so a restart never overlaps polls. */
function ensurePolling(restart = false): void {
  if (pollInFlight) {
    if (restart) pollIndex = 0;
    return;
  }
  if (timer !== null) {
    if (!restart) return;
    clearTimeout(timer);
  }
  pollIndex = 0;
  schedulePoll(pollEpoch);
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
  pollInFlight = false;
  pollEpoch += 1;
  hydrated = false;
  nextSeq = 1;
  saving.clear();
  useMomentumRunsStore.setState({ runs: [], activeId: null });
}
