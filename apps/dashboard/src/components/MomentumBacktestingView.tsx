'use client';

import {
  AlertCircle,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  Clock,
  Link as LinkIcon,
  Loader2,
  Play,
  RefreshCw,
  RotateCw,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useAppRoute } from '../hooks/useAppRoute';
import { useMomentumWeeklyJob } from '../hooks/useMomentumWeeklyJob';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { cn } from '../lib/cn';
import { MOMENTUM_DATASETS, MOMENTUM_SECTIONS, type MomentumSection, oneOf } from '../lib/routes';
import { type MomentumRun, hydrateMomentumRuns, useMomentumRunsStore } from '../store/momentumRuns';
import type { MomentumResult, MomentumSavedRun } from '../types/momentum';
import { MomentumCircuitExposureCard } from './momentum/MomentumCircuitExposure';
import { MomentumEquityChart } from './momentum/MomentumEquityChart';
import { MomentumRebalanceView } from './momentum/MomentumRebalanceView';
import {
  MomentumPerformanceCard,
  MomentumResultDetails,
  type MomentumRunInfo,
} from './momentum/MomentumResultDetails';
import { MomentumResultsSkeleton, MomentumRunBanner } from './momentum/MomentumRunProgress';
import { MomentumSavedRunsView } from './momentum/MomentumSavedRunsView';
import { MomentumScoresView } from './momentum/MomentumScoresView';
import {
  type CoreSettings,
  type Instrument,
  type LookbackRow,
  MomentumSettingsPanel,
  momentumSettingsDefaults,
} from './momentum/MomentumSettingsPanel';
import { MomentumWeeklyView } from './momentum/MomentumWeeklyView';
import { Button } from './ui/Button';
import { StateMessage } from './ui/StateMessage';

type Dataset = 'etf' | 'stock' | 'custom_index' | 'broad';

interface MomentumMeta {
  instruments: Instrument[];
  first_week: string;
  last_week: string;
  defaults: Record<string, unknown>;
  benchmarks?: string[];
}

const DATASETS: Array<{ id: Dataset; label: string; description: string }> = [
  {
    id: 'etf',
    label: 'ETF Rotation',
    description: 'Sector, broad-market, commodity and international ETFs',
  },
  {
    id: 'stock',
    label: 'Nifty 50 Stocks',
    description: 'Survivorship-aware stock momentum with defensive assets',
  },
  {
    id: 'custom_index',
    label: 'Custom Index',
    description: 'Category-level inner stock rotations',
  },
  {
    id: 'broad',
    label: 'Broad Momentum',
    description: 'Total Market pool with optional category selection',
  },
];

// Owner, 2026-10-01: only ETF Rotation and Broad Momentum are offered in the tab. The Nifty 50
// Stocks and Custom Index datasets stay in DATASETS (labels, saved runs, the API) and can be
// re-shown by adding their ids back here.
const VISIBLE_DATASET_IDS: ReadonlySet<Dataset> = new Set<Dataset>(['etf', 'broad']);
const VISIBLE_DATASETS = DATASETS.filter((item) => VISIBLE_DATASET_IDS.has(item.id));

function numberDefault(defaults: Record<string, unknown>, key: string, fallback: number): number {
  const value = defaults[key];
  return typeof value === 'number' ? value : fallback;
}

function stringDefault(defaults: Record<string, unknown>, key: string, fallback: string): string {
  const value = defaults[key];
  return typeof value === 'string' ? value : fallback;
}

function selectedByDefault(meta: MomentumMeta): string[] {
  return meta.instruments
    .filter((instrument) => instrument.has_data && instrument.include !== 'optional')
    .map((instrument) => instrument.name);
}

function lookbacksFromConfig(config: Record<string, unknown>): LookbackRow[] {
  const weeks = Array.isArray(config.lookbacks)
    ? config.lookbacks.filter((v): v is number => typeof v === 'number')
    : [1, 4, 13, 26, 52];
  const weights = Array.isArray(config.weights)
    ? config.weights.filter((v): v is number => typeof v === 'number')
    : null;
  return weeks.map((w, i) => ({ weeks: w, weight: weights?.[i] ?? 1 }));
}

function comparableConfig(config: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b))),
  );
}

/** Saved runs are persisted server-side, grouped by dataset. */
async function fetchSavedRuns(dataset: Dataset): Promise<MomentumSavedRun[]> {
  const response = await apiGet<MomentumSavedRun[]>(`/api/momentum/saved-runs?dataset=${dataset}`);
  return response.ok ? response.data : [];
}

const DATASET_SHORT: Record<string, string> = {
  etf: 'ETF',
  stock: 'Stocks',
  custom_index: 'Custom',
  broad: 'Broad',
};

/** One tab per run - queued, running, finished or failed - so runs can go side by side. */
function MomentumRunTabs({
  runs,
  activeId,
  now,
  onSelect,
  onClose,
}: {
  runs: MomentumRun[];
  activeId: string | null;
  now: number;
  onSelect: (run: MomentumRun) => void;
  onClose: (run: MomentumRun) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Backtest runs"
      className="flex gap-2 overflow-x-auto rounded-xl border border-border bg-surface p-2"
    >
      {runs.map((run) => {
        const inFlight = run.status === 'queued' || run.status === 'running';
        const selected = run.id === activeId;
        const seconds = Math.max(
          0,
          Math.floor(((inFlight ? now : (run.finishedAt ?? now)) - run.startedAt) / 1000),
        );
        return (
          <div
            key={run.id}
            className={cn(
              'flex shrink-0 items-center rounded-lg border text-sm transition-colors',
              selected
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-surface-2/30 text-muted hover:border-border-strong hover:text-foreground',
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(run)}
              className="flex items-center gap-2 rounded-l-lg px-3 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {run.status === 'queued' ? (
                <Clock className="h-3.5 w-3.5" aria-label="queued" />
              ) : run.status === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="running" />
              ) : run.status === 'done' ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-positive" aria-label="done" />
              ) : (
                <AlertCircle className="h-3.5 w-3.5 text-negative" aria-label="failed" />
              )}
              <span className="font-medium">{run.label}</span>
              <span className="text-xs opacity-70">
                {DATASET_SHORT[run.dataset] ?? run.dataset}
              </span>
              <span className="font-mono text-xs tabular-nums opacity-70">{seconds}s</span>
            </button>
            <button
              type="button"
              onClick={() => onClose(run)}
              aria-label={`Close ${run.label}`}
              title={
                inFlight ? 'Hide this tab (the run keeps going on the server)' : 'Close this tab'
              }
              className="rounded-r-lg px-1.5 py-1.5 opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function MomentumBacktestingView() {
  // Lives here, not in the Weekly view, so the section tab can show that a run is still
  // going after the user has moved to another section.
  const weekly = useMomentumWeeklyJob();
  const { rest, navigate } = useAppRoute();
  const section: MomentumSection = oneOf(MOMENTUM_SECTIONS, rest[0]) ?? 'backtest';
  const urlDataset = section === 'backtest' ? oneOf(MOMENTUM_DATASETS, rest[1]) : null;
  const runs = useMomentumRunsStore((state) => state.runs);
  const activeRunId = useMomentumRunsStore((state) => state.activeId);
  const activeRun = runs.find((run) => run.id === activeRunId) ?? null;
  // Seeds the settings from the run you were looking at when you left this page (first load only).
  const mountSeedRef = useRef<Record<string, unknown> | null>(activeRun?.config ?? null);
  const [dataset, setDatasetState] = useState<Dataset>(() => {
    if (urlDataset && VISIBLE_DATASET_IDS.has(urlDataset)) return urlDataset;
    const initial = activeRun?.dataset;
    return initial === 'etf' ||
      initial === 'stock' ||
      initial === 'custom_index' ||
      initial === 'broad'
      ? initial
      : 'etf';
  });
  // The URL carries section + dataset (/momentum/backtest/broad), so a refresh or a pasted link
  // reopens the same view; back/forward flows in through urlDataset.
  useEffect(() => {
    if (urlDataset && VISIBLE_DATASET_IDS.has(urlDataset) && urlDataset !== dataset) {
      setDatasetState(urlDataset);
    }
  }, [urlDataset, dataset]);
  function setDataset(next: Dataset): void {
    setDatasetState(next);
    if (section === 'backtest') navigate('momentum', 'backtest', next);
  }
  function setSection(next: MomentumSection): void {
    navigate('momentum', next, next === 'backtest' ? dataset : undefined);
  }
  const [meta, setMeta] = useState<MomentumMeta | null>(null);
  const [core, setCore] = useState<CoreSettings>({
    start: '',
    end: '',
    topN: 5,
    exitRank: 10,
    lookbacks: [],
    selected: [],
  });
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [doneNoticeAt, setDoneNoticeAt] = useState<number | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Why the LAST Run click produced no new results (a validation message, or the server's 4xx/5xx).
  // Kept apart from `error` (data failed to load) on purpose: after a failed run the previous
  // results stay on screen, and the reason must be visible right where Run was clicked.
  const [startError, setStartError] = useState<string | null>(null);
  const runErrorRef = useRef<HTMLDivElement>(null);
  // Everything about "the run on screen" is derived from the store, so it survives leaving
  // this page and several runs can be in flight at once (one tab each).
  const running =
    activeRun !== null && (activeRun.status === 'queued' || activeRun.status === 'running');
  const runningFresh = running && activeRun.fresh;
  const runStartedAt = running ? activeRun.startedAt : null;
  const result: MomentumResult | null = activeRun?.result ?? null;
  const lastRunConfig = activeRun?.status === 'done' ? activeRun.config : null;
  const runError = startError ?? (activeRun?.status === 'failed' ? activeRun.error : null);
  const runInfo: MomentumRunInfo | null =
    activeRun?.status === 'done' && activeRun.finishedAt !== null
      ? {
          finishedAt: activeRun.finishedAt,
          durationMs: activeRun.finishedAt - activeRun.startedAt,
          savedAs: activeRun.savedAs,
          fresh: activeRun.fresh,
        }
      : null;
  const inFlightCount = runs.filter(
    (run) => run.status === 'queued' || run.status === 'running',
  ).length;
  const [savedRuns, setSavedRuns] = useState<MomentumSavedRun[]>([]);
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const overlays = useMemo(
    () => savedRuns.filter((run, index) => index > 0 && run.overlay),
    [savedRuns],
  );

  function onCoreChange(patch: Partial<CoreSettings>): void {
    setCore((current) => ({ ...current, ...patch }));
  }
  function onValueChange(key: string, value: unknown): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function renameRun(id: string, name: string): Promise<void> {
    setSavedRuns((runs) => runs.map((run) => (run.id === id ? { ...run, name } : run)));
    await apiPatch(`/api/momentum/saved-runs/${id}`, { name });
  }
  async function toggleOverlay(id: string, overlay: boolean): Promise<void> {
    setSavedRuns((runs) => runs.map((run) => (run.id === id ? { ...run, overlay } : run)));
    await apiPatch(`/api/momentum/saved-runs/${id}`, { overlay });
  }
  async function toggleFavorite(id: string, favorite: boolean): Promise<void> {
    setSavedRuns((runs) =>
      runs.map((run) =>
        run.id === id ? { ...run, favorite, active: favorite ? run.active : false } : run,
      ),
    );
    await apiPatch(`/api/momentum/saved-runs/${id}`, { favorite });
  }
  async function setActive(id: string): Promise<void> {
    setSavedRuns((runs) =>
      runs.map((run) => ({
        ...run,
        favorite: run.id === id ? true : run.favorite,
        active: run.id === id,
      })),
    );
    await apiPatch(`/api/momentum/saved-runs/${id}`, { active: true });
  }
  async function removeRun(id: string): Promise<void> {
    setSavedRuns((runs) => runs.filter((run) => run.id !== id));
    await apiDelete(`/api/momentum/saved-runs/${id}`);
  }

  async function loadMeta(nextDataset: Dataset, seed?: Record<string, unknown>): Promise<void> {
    setLoading(true);
    setError(null);
    setStartError(null);
    const response = await apiGet<MomentumMeta>(`/api/momentum/meta?dataset=${nextDataset}`);
    setLoading(false);
    if (!response.ok) {
      setMeta(null);
      setError(response.error);
      return;
    }
    const nextMeta = response.data;
    setMeta(nextMeta);
    const base = seed ?? nextMeta.defaults;
    setCore({
      selected: Array.isArray(seed?.universe)
        ? (seed.universe as unknown[]).filter((v): v is string => typeof v === 'string')
        : selectedByDefault(nextMeta),
      start: stringDefault(base, 'start', nextMeta.first_week),
      end: stringDefault(base, 'end', nextMeta.last_week),
      topN: numberDefault(base, 'top_n', 5),
      exitRank: numberDefault(base, 'exit_rank', 10),
      lookbacks: lookbacksFromConfig({
        lookbacks: base.lookbacks ?? nextMeta.defaults.lookbacks,
        weights: base.weights,
      }),
    });
    setValues(
      momentumSettingsDefaults({
        ...nextMeta.defaults,
        ...(seed ?? {}),
        benchmark: stringDefault(base, 'benchmark', nextMeta.benchmarks?.[0] ?? ''),
      }),
    );
  }

  useEffect(() => {
    hydrateMomentumRuns();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadMeta is redefined every render; it should only re-run when the dataset itself changes
  useEffect(() => {
    setSavedRuns([]);
    void fetchSavedRuns(dataset).then(setSavedRuns);
    const seed = mountSeedRef.current;
    mountSeedRef.current = null;
    void loadMeta(dataset, seed && seed.dataset === dataset ? seed : undefined);
    // Show a run of the dataset you switched to (a tab picked from another dataset already
    // matches and is left alone), else nothing.
    const { runs: all, activeId, setActive } = useMomentumRunsStore.getState();
    if (all.find((run) => run.id === activeId)?.dataset !== dataset) {
      setActive([...all].reverse().find((run) => run.dataset === dataset)?.id ?? null);
    }
  }, [dataset]);

  // A run that finishes while you are on this page refreshes the saved-runs list (the store
  // auto-saves it) so overlays and the "Saved runs" count are current.
  const savedKey = runs.map((run) => run.savedAs ?? '').join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey is the trigger
  useEffect(() => {
    void fetchSavedRuns(dataset).then(setSavedRuns);
  }, [savedKey]);

  function loadSettings(run: MomentumSavedRun): void {
    const config = run.config;
    setCore({
      selected: Array.isArray(config.universe)
        ? config.universe.filter((v): v is string => typeof v === 'string')
        : [],
      start: stringDefault(config, 'start', ''),
      end: stringDefault(config, 'end', ''),
      topN: numberDefault(config, 'top_n', 5),
      exitRank: numberDefault(config, 'exit_rank', 10),
      lookbacks: lookbacksFromConfig(config),
    });
    setValues((current) => momentumSettingsDefaults({ ...current, ...config }));
    setSection('backtest');
    setSettingsOpen(true);
  }

  function buildConfig(): Record<string, unknown> {
    if (!meta) throw new Error('Strategy settings are still loading.');
    const parsedLookbacks = core.lookbacks
      .map((row) => row.weeks)
      .filter((value) => Number.isInteger(value) && value > 0);
    if (parsedLookbacks.length === 0) {
      throw new Error('Add at least one positive whole-number lookback window.');
    }
    const parsedWeights = core.lookbacks.map((row) => row.weight);
    if (
      parsedWeights.some((value) => !Number.isFinite(value)) ||
      parsedWeights.every((value) => value === 0)
    ) {
      throw new Error(
        'Give one finite weight per lookback window (negative is allowed, for a reversal signal — not all zero).',
      );
    }
    if (dataset !== 'broad' && core.selected.length === 0) {
      throw new Error('Select at least one instrument before running the strategy.');
    }
    if (core.exitRank < core.topN) {
      throw new Error('Sell-when-rank-exceeds must be at least Top N.');
    }
    return {
      ...meta.defaults,
      ...values,
      dataset,
      universe: dataset === 'broad' ? ['broad_momentum'] : core.selected,
      start: core.start,
      end: core.end,
      top_n: core.topN,
      exit_rank: core.exitRank,
      lookbacks: parsedLookbacks,
      weights: parsedWeights,
    };
  }

  /**
   * `fresh` is the "re-run from scratch" icon: the server drops its cached rankings and data and
   * reloads before computing. It is sent alongside the config but is NOT part of it, so it never
   * enters `lastRunConfig`, a saved run, or the "changed since last run" comparison.
   */
  async function runBacktest({ fresh = false }: { fresh?: boolean } = {}): Promise<void> {
    let config: Record<string, unknown>;
    setStartError(null);
    try {
      config = buildConfig();
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setError(null);
    setStarting(true);
    const failure = await useMomentumRunsStore.getState().startRun(dataset, config, fresh);
    setStarting(false);
    if (failure) setStartError(failure);
  }

  // When the run on screen finishes while you are here, tuck the settings away and, if the
  // summary is out of view, say so where you are looking. Switching to an already-finished tab
  // changes the run id, so it does neither.
  const watchedRef = useRef<{ id: string | null; running: boolean }>({ id: null, running: false });
  // Layout effect, not requestAnimationFrame: it measures the freshly committed layout
  // immediately, even in a background tab where animation frames are paused.
  useLayoutEffect(() => {
    const prev = watchedRef.current;
    const nowDone = activeRun?.status === 'done';
    watchedRef.current = { id: activeRun?.id ?? null, running };
    if (!(prev.running && prev.id === activeRun?.id && nowDone)) return;
    setSettingsOpen(false);
    const rect = summaryRef.current?.getBoundingClientRect();
    // The header + headline numbers sit at the card's top edge; a sliver of its bottom
    // peeking into view doesn't count as "seen".
    const visible = rect !== undefined && rect.top > 56 && rect.top < window.innerHeight - 120;
    setDoneNoticeAt(visible ? null : (activeRun?.finishedAt ?? Date.now()));
  }, [activeRun?.id, activeRun?.status, activeRun?.finishedAt, running]);

  // A failed run leaves the previous results on screen, so bring the reason into view: the Run
  // button sits at the bottom of a long form and the user would otherwise see nothing happen.
  useEffect(() => {
    if (runError) runErrorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [runError]);

  // Ticks the elapsed-time readout while a run is in flight.
  useEffect(() => {
    if (inFlightCount === 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [inFlightCount]);
  const elapsedMs = runStartedAt === null ? 0 : Math.max(0, now - runStartedAt);

  const finishedAt = runInfo?.finishedAt ?? null;
  useEffect(() => {
    if (doneNoticeAt === null) return;
    const timer = setTimeout(() => setDoneNoticeAt(null), 6000);
    return () => clearTimeout(timer);
  }, [doneNoticeAt]);

  // Ctrl/Cmd+Enter runs the backtest from anywhere in the settings panel. A ref keeps the
  // handler reading the latest run() without re-attaching the listener on every keystroke.
  const runStateRef = useRef({ running, meta, run: runBacktest });
  runStateRef.current = { running, meta, run: runBacktest };

  useEffect(() => {
    if (section !== 'backtest') return;
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        const { running: isRunning, meta: currentMeta, run } = runStateRef.current;
        if (!isRunning && currentMeta) void run();
      }
    }
    const node = containerRef.current;
    node?.addEventListener('keydown', onKeyDown);
    return () => node?.removeEventListener('keydown', onKeyDown);
  }, [section]);

  const currentConfig = meta
    ? (() => {
        try {
          return buildConfig();
        } catch {
          return null;
        }
      })()
    : null;
  const dirty =
    lastRunConfig !== null &&
    currentConfig !== null &&
    comparableConfig(currentConfig) !== comparableConfig(lastRunConfig);

  function shareLink(): void {
    if (!currentConfig) return;
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(currentConfig))));
    const url = `${window.location.origin}${window.location.pathname}#momentum-cfg=${encoded}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs once on mount only, to seed state from a shared link
  useEffect(() => {
    const hash = window.location.hash;
    const marker = '#momentum-cfg=';
    if (!hash.startsWith(marker)) return;
    try {
      const decoded = JSON.parse(
        decodeURIComponent(escape(atob(hash.slice(marker.length)))),
      ) as Record<string, unknown>;
      const requested = (typeof decoded.dataset === 'string' ? decoded.dataset : 'etf') as Dataset;
      // A link to a hidden dataset opens ETF Rotation instead of an unreachable tab.
      const sharedDataset: Dataset = VISIBLE_DATASET_IDS.has(requested) ? requested : 'etf';
      setDataset(sharedDataset);
      void loadMeta(sharedDataset, decoded);
    } catch {
      // Malformed/old link — ignore and fall back to defaults.
    }
  }, []);

  const summary = meta
    ? `${core.start || 'Start'} → ${core.end || 'End'} · ${values.rebalance === 'monthly' ? 'monthly' : Number(values.rebalance_every ?? 1) > 1 ? `every ${values.rebalance_every} weeks` : 'weekly'} · top ${core.topN} / exit >${core.exitRank} · ${values.benchmark ?? ''}`
    : '';

  return (
    <div ref={containerRef} className="space-y-5">
      <div className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-1">
        <Button
          size="sm"
          variant={section === 'backtest' ? 'primary' : 'ghost'}
          onClick={() => setSection('backtest')}
        >
          Backtest
          {inFlightCount > 0 ? (
            <span className="relative ml-1 flex h-2 w-2" aria-label={`${inFlightCount} running`}>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : null}
        </Button>
        <Button
          size="sm"
          variant={section === 'scores' ? 'primary' : 'ghost'}
          onClick={() => setSection('scores')}
        >
          Momentum Scores
        </Button>
        <Button
          size="sm"
          variant={section === 'saved' ? 'primary' : 'ghost'}
          onClick={() => setSection('saved')}
        >
          Saved runs ({savedRuns.length})
        </Button>
        <Button
          size="sm"
          variant={section === 'weekly' ? 'primary' : 'ghost'}
          onClick={() => setSection('weekly')}
          title={weekly.running ? 'Weekly signal is running in the background' : undefined}
        >
          Weekly signal
          {weekly.running ? (
            <span className="relative ml-1 flex h-2 w-2" aria-label="running">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
          ) : null}
        </Button>
        <Button
          size="sm"
          variant={section === 'rebalance' ? 'primary' : 'ghost'}
          onClick={() => setSection('rebalance')}
        >
          Rebalance now
        </Button>
      </div>

      {section === 'scores' ? (
        <MomentumScoresView />
      ) : section === 'weekly' ? (
        <MomentumWeeklyView weekly={weekly} />
      ) : section === 'rebalance' ? (
        <MomentumRebalanceView
          dataset={dataset}
          buildConfig={buildConfig}
          onChooseDataset={setDataset}
        />
      ) : section === 'saved' ? (
        <MomentumSavedRunsView
          runs={savedRuns}
          onRename={renameRun}
          onToggleOverlay={toggleOverlay}
          onToggleFavorite={toggleFavorite}
          onSetActive={setActive}
          onRemove={removeRun}
          onLoad={loadSettings}
        />
      ) : (
        <>
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {VISIBLE_DATASETS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setDataset(item.id)}
                    title={item.description}
                    className={cn(
                      'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      dataset === item.id
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-surface-2/30 text-muted hover:border-border-strong hover:text-foreground',
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <Button size="sm" onClick={() => void loadMeta(dataset)} disabled={loading}>
                <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                Refresh data
              </Button>
            </div>
          </div>

          {runs.length > 0 ? (
            <MomentumRunTabs
              runs={runs}
              activeId={activeRunId}
              now={now}
              onSelect={(run) => {
                setStartError(null);
                useMomentumRunsStore.getState().setActive(run.id);
                if (run.dataset !== dataset) setDataset(run.dataset as Dataset);
              }}
              onClose={(run) => useMomentumRunsStore.getState().closeRun(run.id)}
            />
          ) : null}

          {error ? (
            <StateMessage
              variant="error"
              title="Momentum backtest unavailable"
              description={error}
            />
          ) : null}

          {loading || !meta ? null : (
            <div className="rounded-xl border border-border bg-surface">
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((open) => !open)}
                  aria-expanded={settingsOpen}
                  className="min-w-0 flex-1 text-left"
                >
                  <p className="text-sm font-semibold text-foreground">Strategy settings</p>
                  {!settingsOpen ? <p className="truncate text-xs text-muted">{summary}</p> : null}
                </button>
                <div className="flex shrink-0 items-center gap-1.5">
                  {dirty ? (
                    <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                      Changed since last run
                    </span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void runBacktest({ fresh: true })}
                    disabled={starting}
                    title="Re-run from scratch: drops the server's cached rankings and data, reloads them, then recomputes"
                    aria-label="Re-run from scratch"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RotateCw
                      className={cn(
                        'h-3.5 w-3.5 shrink-0',
                        running && runningFresh && 'animate-spin',
                      )}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setSettingsOpen((open) => !open)}
                    aria-label={settingsOpen ? 'Collapse settings' : 'Expand settings'}
                    className="rounded p-1 text-faint hover:text-foreground"
                  >
                    <ChevronDown
                      className={cn('h-4 w-4 transition-transform', settingsOpen && 'rotate-180')}
                    />
                  </button>
                </div>
              </div>
              {settingsOpen ? (
                <div className="space-y-4 border-t border-border p-4">
                  <MomentumSettingsPanel
                    dataset={dataset}
                    instruments={meta.instruments}
                    firstWeek={meta.first_week}
                    lastWeek={meta.last_week}
                    benchmarks={
                      meta.benchmarks ??
                      meta.instruments.filter((i) => i.has_data).map((i) => i.name)
                    }
                    core={core}
                    onCoreChange={onCoreChange}
                    values={values}
                    onChange={onValueChange}
                  />
                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                    <Button
                      variant="primary"
                      onClick={() => void runBacktest()}
                      disabled={starting}
                    >
                      {starting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      {starting ? 'Starting…' : 'Run momentum backtest'}
                    </Button>
                    {inFlightCount > 0 ? (
                      <span className="text-xs text-muted">
                        {inFlightCount} running — starting another runs it alongside
                      </span>
                    ) : null}
                    <span className="hidden text-xs text-faint sm:inline">Ctrl/Cmd + Enter</span>
                    <Button size="sm" onClick={shareLink}>
                      <LinkIcon className="h-3.5 w-3.5" />{' '}
                      {copied ? 'Link copied' : 'Copy shareable link'}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void runBacktest()}
                    disabled={starting}
                  >
                    {starting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {starting ? 'Starting…' : dirty ? 'Run again' : 'Run momentum backtest'}
                  </Button>
                </div>
              )}
              {runError ? (
                <div
                  ref={runErrorRef}
                  role="alert"
                  className="mx-4 mb-4 rounded-lg border border-negative/30 bg-negative/10 px-3 py-2.5 text-sm text-negative"
                >
                  <p className="font-medium">The run didn&apos;t finish</p>
                  <p className="mt-0.5 text-foreground/80">{runError}</p>
                </div>
              ) : null}
            </div>
          )}

          {running ? (
            // Pinned under the app top bar, so the timer stays visible while you scroll.
            <div className="sticky top-[4.5rem] z-20">
              <MomentumRunBanner
                elapsedMs={elapsedMs}
                dataset={dataset}
                datasetLabel={DATASETS.find((item) => item.id === dataset)?.label ?? 'momentum'}
                hasPreviousResult={false}
                queued={activeRun?.status === 'queued'}
              />
            </div>
          ) : null}

          {doneNoticeAt !== null && runInfo ? (
            // Zero-height sticky slot: the pill floats over the page without shifting content.
            <div className="sticky top-[4.5rem] z-20 h-0">
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    summaryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    setDoneNoticeAt(null);
                  }}
                  className="inline-flex animate-fade-in items-center gap-2 rounded-full border border-positive/30 bg-surface px-4 py-2 text-sm text-foreground shadow-elevated transition-colors hover:border-positive/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CheckCircle2 className="h-4 w-4 text-positive" />
                  Results updated · took {(runInfo.durationMs / 1000).toFixed(1)}s
                  <span className="inline-flex items-center gap-1 font-medium text-primary">
                    View summary <ArrowUp className="h-3.5 w-3.5" />
                  </span>
                </button>
              </div>
            </div>
          ) : null}

          {running && !result ? <MomentumResultsSkeleton /> : null}

          {result ? (
            <div
              className={cn(
                'space-y-5 transition-opacity duration-300',
                running && 'pointer-events-none select-none opacity-40',
              )}
              aria-busy={running}
            >
              <div ref={summaryRef} className="scroll-mt-20">
                <MomentumPerformanceCard
                  result={result}
                  config={lastRunConfig ?? {}}
                  stale={dirty && !running}
                  lastRunFailed={runError !== null && !running}
                  runInfo={runInfo}
                />
              </div>
              <MomentumEquityChart
                series={result.series}
                benchmarkName={result.benchmark_name}
                rotations={result.rotations}
                overlays={overlays}
                comparisons={result.comparisons ?? []}
                flashKey={finishedAt}
              />
              <MomentumResultDetails
                result={result}
                config={lastRunConfig ?? {}}
                savedRuns={savedRuns}
                flashKey={finishedAt}
              />
              <MomentumCircuitExposureCard exposure={result.circuit_exposure} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
