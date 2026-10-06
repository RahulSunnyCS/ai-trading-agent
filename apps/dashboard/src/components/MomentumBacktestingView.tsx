'use client';

import {
  AlertCircle,
  ArrowUp,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Link as LinkIcon,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useAppRoute } from '../hooks/useAppRoute';
import { useMomentumWeeklyJob } from '../hooks/useMomentumWeeklyJob';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { cn } from '../lib/cn';
import { formatDuration, formatPct, formatPp } from '../lib/format';
import {
  type MomentumSettingsSection,
  describeConfig,
  diffConfigs,
  modifiedSections,
} from '../lib/momentumConfig';
import { usualDuration } from '../lib/momentumDurations';
import { MOMENTUM_DATASETS, MOMENTUM_SECTIONS, type MomentumSection, oneOf } from '../lib/routes';
import { type MomentumRun, hydrateMomentumRuns, useMomentumRunsStore } from '../store/momentumRuns';
import { hydrateMomentumViewFromStorage, useMomentumViewStore } from '../store/momentumView';
import {
  FULL_HISTORY_YEARS,
  getDefaultDateRangeYears,
  getDefaultMomentumDataset,
} from '../store/settings';
import type { MomentumResult, MomentumSavedRun } from '../types/momentum';
import { MomentumCircuitExposureLoader } from './momentum/MomentumCircuitExposure';
import { MomentumEquityChart } from './momentum/MomentumEquityChart';
import { MomentumJournalView } from './momentum/MomentumJournalView';
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
  settingsSectionDomId,
} from './momentum/MomentumSettingsPanel';
import { MomentumSettingsSkeleton } from './momentum/MomentumSkeletons';
import { MomentumWeeklyView } from './momentum/MomentumWeeklyView';
import { MomentumRunBar } from './momentum/backtest/MomentumRunBar';
import { MomentumSettingsChips } from './momentum/backtest/MomentumSettingsChips';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { SegmentedControl, type SegmentedOption } from './ui/SegmentedControl';
import { StateMessage } from './ui/StateMessage';
import { type TabItem, Tabs } from './ui/Tabs';
import { toast } from './ui/Toast';

type Dataset = 'etf' | 'stock' | 'custom_index' | 'broad';

const SECTIONS: Array<{ id: MomentumSection; label: string; description: string }> = [
  {
    id: 'backtest',
    label: 'Backtest',
    description: 'Test a momentum strategy against historical data.',
  },
  {
    id: 'scores',
    label: 'Momentum Scores',
    description: 'Explore current stock and sector momentum.',
  },
  {
    id: 'saved',
    label: 'Saved runs',
    description: 'Review and compare saved backtests for the selected dataset.',
  },
  {
    id: 'weekly',
    label: 'Weekly signal',
    description: 'Check the latest signal, schedule, and data readiness.',
  },
  {
    id: 'rebalance',
    label: 'Rebalance preview',
    description: 'Compare your holdings with a live model target.',
  },
  {
    id: 'journal',
    label: 'Journal',
    description: 'Every weekly signal as recorded, and whether this week was recorded in full.',
  },
];

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

/** The dataset switch (ETF Rotation / Broad Momentum). Shown on Backtest and on Saved runs: saved
 * runs are stored per dataset, so without it a run saved under the other dataset is invisible. */
const DATASET_OPTIONS: ReadonlyArray<SegmentedOption<Dataset>> = VISIBLE_DATASETS.map((item) => ({
  value: item.id,
  label: <span title={item.description}>{item.label}</span>,
}));

/**
 * The start date for a fresh form: Settings › Defaults › Backtest period (the last N years,
 * never earlier than the data begins) when one is set, else the dataset's own default.
 */
function defaultStart(meta: MomentumMeta, defaults: Record<string, unknown>): string {
  const fallback = stringDefault(defaults, 'start', meta.first_week);
  const years = getDefaultDateRangeYears();
  if (years === null) return fallback;
  if (years === FULL_HISTORY_YEARS) return meta.first_week;
  const from = new Date(`${meta.last_week}T00:00:00Z`);
  from.setUTCFullYear(from.getUTCFullYear() - years);
  const start = from.toISOString().slice(0, 10);
  return start > meta.first_week ? start : meta.first_week;
}

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

const DATASET_SHORT: Record<string, string> = {
  etf: 'ETF',
  stock: 'Stocks',
  custom_index: 'Custom',
  broad: 'Broad',
};

/** Where the settings column sticks under the app top bar: Tailwind's `top-[4.5rem]`. */
const SETTINGS_STICKY_TOP_PX = 72;

const inFlight = (run: MomentumRun): boolean => run.status === 'queued' || run.status === 'running';

/**
 * One name per run. A finished run is auto-saved under the server's own "Run N" sequence, and
 * that is the name it carries everywhere (this tab, the Performance card, Saved runs). Until
 * then the session counter is shown as "Unsaved N", so it cannot be mistaken for a saved run
 * that happens to have the same number.
 */
function runName(run: MomentumRun): string {
  return run.savedAs ?? run.label.replace(/^Run\b/, 'Unsaved');
}

const MAX_DIFF_LINES = 10;

/** The tab's tooltip: how long the run took and what it changed against the tab before it. */
function runTabTitle(run: MomentumRun, previous: MomentumRun | null, now: number): string {
  const lines = [
    `${runName(run)} · ${DATASET_SHORT[run.dataset] ?? run.dataset} · ${
      inFlight(run)
        ? `running for ${formatDuration(Math.max(0, now - run.startedAt))}`
        : run.status === 'failed'
          ? 'failed'
          : `took ${formatDuration((run.finishedAt ?? now) - run.startedAt)}`
    }${run.fresh ? ' · recomputed with caches dropped' : ''}`,
  ];
  if (!previous) return `${lines[0]}\nFirst run in this session.`;
  const changes = diffConfigs(previous.config, run.config);
  if (changes.length === 0) {
    lines.push(`Same settings as ${runName(previous)}.`);
  } else {
    lines.push(`Changed vs ${runName(previous)}:`, ...changes.slice(0, MAX_DIFF_LINES));
    if (changes.length > MAX_DIFF_LINES) {
      lines.push(`+ ${changes.length - MAX_DIFF_LINES} more`);
    }
  }
  return lines.join('\n');
}

const kpi = (run: MomentumRun, key: string): number | null => {
  const value = run.result?.kpis[key];
  return typeof value === 'number' ? value : null;
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
  const items: Array<TabItem<string>> = runs.map((run, index) => {
    const name = runName(run);
    return {
      value: run.id,
      title: runTabTitle(run, runs[index - 1] ?? null, now),
      label: (
        <>
          {run.status === 'queued' ? (
            <Clock className="h-3.5 w-3.5" aria-label="queued" />
          ) : run.status === 'running' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-label="running" />
          ) : run.status === 'done' ? (
            <CheckCircle2 className="h-3.5 w-3.5" aria-label="done" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" aria-label="failed" />
          )}
          <span className="font-medium">{name}</span>
          <span className="text-xs opacity-70">{DATASET_SHORT[run.dataset] ?? run.dataset}</span>
          {run.status === 'done' ? (
            <>
              <span className="metric text-xs">{formatPct(kpi(run, 'cagr'))}</span>
              <span className="metric text-xs opacity-70">
                {formatPp(kpi(run, 'excess_cagr'))} edge
              </span>
            </>
          ) : run.status === 'failed' ? (
            <span className="text-xs opacity-70">failed</span>
          ) : (
            <span className="metric text-xs opacity-70">
              {formatDuration(Math.max(0, now - run.startedAt))}
            </span>
          )}
        </>
      ),
      trailing: (
        <button
          type="button"
          onClick={() => onClose(run)}
          aria-label={`Close ${name}`}
          title={
            inFlight(run) ? 'Hide this tab (the run keeps going on the server)' : 'Close this tab'
          }
          className="rounded-md px-1.5 py-1.5 text-muted opacity-60 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ),
    };
  });
  return (
    <Tabs
      ariaLabel="Backtest runs"
      variant="pill"
      value={activeId ?? ''}
      items={items}
      onChange={(id) => {
        const run = runs.find((item) => item.id === id);
        if (run) onSelect(run);
      }}
    />
  );
}

// The dataset being worked on, for sections whose URL carries none (Saved runs). Lives out here
// because leaving the Momentum tab altogether unmounts this view; moving between its sections
// does not (useAppRoute updates the URL in place).
let lastDataset: Dataset | null = null;

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
    if (lastDataset && VISIBLE_DATASET_IDS.has(lastDataset)) return lastDataset;
    // Settings › Defaults › Momentum dataset.
    const preferred = getDefaultMomentumDataset();
    if (preferred && VISIBLE_DATASET_IDS.has(preferred)) return preferred;
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
  const [reloading, setReloading] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Which accordions the user opened or closed, by id. Held here, not in the panel, so it
  // survives collapsing the settings and lets a summary chip open the accordion it describes.
  const [openSections, setOpenSections] = useState<
    Partial<Record<MomentumSettingsSection, boolean>>
  >({});
  // Full-width results (from xl): the settings column is hidden and the chips row above the
  // results stands in for it, with its own Run buttons. Remembered in this browser.
  const resultsExpanded = useMomentumViewStore((state) => state.resultsExpanded);
  const setResultsExpanded = useMomentumViewStore((state) => state.setResultsExpanded);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const settingsColumnRef = useRef<HTMLElement>(null);
  const [starting, setStarting] = useState<'run' | 'fresh' | null>(null);
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
  const running = activeRun !== null && inFlight(activeRun);
  const runStartedAt = running ? activeRun.startedAt : null;
  // How long a real run of this dataset usually takes here: read once per run, not on every tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when a run starts, not per render
  const usualMs = useMemo(() => usualDuration(dataset), [dataset, activeRun?.id]);
  // While a new run computes, the last finished run of the same dataset stays on screen (faded)
  // instead of a skeleton. Only a first-ever run has nothing to show.
  const previousRun = running
    ? (runs
        .slice(0, runs.indexOf(activeRun))
        .reverse()
        .find((run) => run.status === 'done' && run.result && run.dataset === activeRun.dataset) ??
      null)
    : null;
  const shownRun = activeRun?.status === 'done' ? activeRun : previousRun;
  const result: MomentumResult | null = shownRun?.result ?? null;
  const shownConfig = shownRun?.config ?? null;
  const lastRunConfig = activeRun?.status === 'done' ? activeRun.config : null;
  const runError = startError ?? (activeRun?.status === 'failed' ? activeRun.error : null);
  const runInfo: MomentumRunInfo | null =
    shownRun && shownRun.finishedAt !== null
      ? {
          finishedAt: shownRun.finishedAt,
          durationMs: shownRun.finishedAt - shownRun.startedAt,
          savedAs: shownRun.savedAs,
          fresh: shownRun.fresh,
        }
      : null;
  const inFlightCount = runs.filter(inFlight).length;
  const [savedRuns, setSavedRuns] = useState<MomentumSavedRun[]>([]);
  // Until the first response lands the list is unknown, not empty: the Saved runs section shows
  // placeholders and its tab shows no count, rather than "0 runs".
  const [savedRunsLoading, setSavedRunsLoading] = useState(true);
  const [savedRunsLoadError, setSavedRunsLoadError] = useState<string | null>(null);
  const savedRunsRequest = useRef(0);
  const [savedRunError, setSavedRunError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const overlays = useMemo(
    () => savedRuns.filter((run, index) => index > 0 && run.overlay),
    [savedRuns],
  );

  /** Saved runs are persisted server-side, grouped by dataset. Only the newest request may update
   * the list, so a slow response for the dataset you just left can't replace the current one. */
  async function refreshSavedRuns(target: Dataset): Promise<void> {
    const request = ++savedRunsRequest.current;
    const response = await apiGet<MomentumSavedRun[]>(`/api/momentum/saved-runs?dataset=${target}`);
    if (request !== savedRunsRequest.current) return;
    setSavedRunsLoading(false);
    if (response.ok) {
      setSavedRuns(response.data);
      setSavedRunsLoadError(null);
    } else {
      setSavedRunsLoadError(response.error);
    }
  }

  function onCoreChange(patch: Partial<CoreSettings>): void {
    setCore((current) => ({ ...current, ...patch }));
  }
  function onValueChange(key: string, value: unknown): void {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function patchRun(id: string, patch: Record<string, unknown>): Promise<void> {
    setSavedRunError(null);
    const response = await apiPatch(`/api/momentum/saved-runs/${id}`, patch);
    if (!response.ok) {
      setSavedRunError(response.error);
      return;
    }
    await refreshSavedRuns(dataset);
  }
  async function renameRun(id: string, name: string): Promise<void> {
    await patchRun(id, { name });
  }
  async function toggleOverlay(id: string, overlay: boolean): Promise<void> {
    await patchRun(id, { overlay });
  }
  async function toggleFavorite(id: string, favorite: boolean): Promise<void> {
    await patchRun(id, { favorite });
  }
  async function setActive(id: string): Promise<void> {
    await patchRun(id, { active: true });
  }
  async function removeRun(id: string): Promise<void> {
    setSavedRunError(null);
    const response = await apiDelete(`/api/momentum/saved-runs/${id}`);
    if (!response.ok) {
      setSavedRunError(response.error);
      return;
    }
    await refreshSavedRuns(dataset);
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
      start: seed
        ? stringDefault(base, 'start', nextMeta.first_week)
        : defaultStart(nextMeta, base),
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
    if (seed) mountSeedRef.current = null;
  }

  /**
   * "Reload prices": refetch the dataset's meta (price coverage, instruments, benchmarks) and
   * keep every edited setting. Only an end date still sitting on the old last week follows the
   * new one, since that is the default tracking the data rather than an edit.
   */
  async function reloadPrices(): Promise<void> {
    setReloading(true);
    setError(null);
    const response = await apiGet<MomentumMeta>(`/api/momentum/meta?dataset=${dataset}`);
    setReloading(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    const previousLastWeek = meta?.last_week;
    setMeta(response.data);
    setCore((current) =>
      current.end === previousLastWeek ? { ...current, end: response.data.last_week } : current,
    );
  }

  useEffect(() => {
    hydrateMomentumRuns();
    hydrateMomentumViewFromStorage();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadMeta is redefined every render; it should only re-run when the dataset itself changes
  useEffect(() => {
    setSavedRuns([]);
    setSavedRunsLoading(true);
    setSavedRunsLoadError(null);
    setSavedRunError(null);
    void refreshSavedRuns(dataset);
    lastDataset = dataset;
    const seed = mountSeedRef.current;
    const usable = seed && seed.dataset === dataset ? seed : undefined;
    if (!usable) mountSeedRef.current = null;
    void loadMeta(dataset, usable);
    // Show a run of the dataset you switched to (a tab picked from another dataset already
    // matches and is left alone), else nothing.
    const { runs: all, activeId, setActive } = useMomentumRunsStore.getState();
    if (all.find((run) => run.id === activeId)?.dataset !== dataset) {
      setActive([...all].reverse().find((run) => run.dataset === dataset)?.id ?? null);
    }
  }, [dataset]);

  // A run that finishes while you are on this page refreshes the saved-runs list (the store
  // auto-saves it) so overlays and the "Saved runs" count are current. Only on a change: the
  // dataset effect above already loads the list on mount.
  const savedKey = runs.map((run) => run.savedAs ?? '').join('|');
  const savedKeyRef = useRef(savedKey);
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey is the trigger
  useEffect(() => {
    if (savedKeyRef.current === savedKey) return;
    savedKeyRef.current = savedKey;
    void refreshSavedRuns(dataset);
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
    // Replace, not merge: a setting the saved run does not carry goes back to its default
    // instead of keeping whatever the form held.
    setValues((current) =>
      momentumSettingsDefaults(meta ? { ...meta.defaults, ...config } : { ...current, ...config }),
    );
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
    // Broad Momentum has its own selection keys and no Top N / exit-rank fields to correct.
    if (dataset !== 'broad' && core.exitRank < core.topN) {
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
   * `fresh` is the "Re-run fresh" button: the server drops its cached rankings and data and
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
    setStarting(fresh ? 'fresh' : 'run');
    const failure = await useMomentumRunsStore.getState().startRun(dataset, config, fresh);
    setStarting(null);
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

  // A failed run leaves the previous results on screen, so bring the reason (shown in the run
  // bar, by the button) into view; otherwise nothing would seem to happen.
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

  // Ctrl/Cmd+Enter runs the backtest from anywhere in the settings column. Ignored while a run
  // request is already being sent, so holding the keys cannot queue duplicates.
  function onSettingsKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
    event.preventDefault();
    if (starting === null && meta) void runBacktest();
  }

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
      toast('Shareable link copied');
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

  // The form's current settings as one config (never throws, unlike buildConfig). It feeds the
  // summary chips and the per-accordion "modified" dots, so the two cannot disagree.
  const formConfig = useMemo<Record<string, unknown>>(
    () => ({
      ...values,
      universe: core.selected,
      start: core.start,
      end: core.end,
      top_n: core.topN,
      exit_rank: core.exitRank,
      lookbacks: core.lookbacks.map((row) => row.weeks),
      weights: core.lookbacks.map((row) => row.weight),
    }),
    [values, core],
  );
  const described = describeConfig({ ...formConfig, end: core.end || 'End' }, dataset);
  // What a fresh form for this dataset holds: the same values loadMeta() seeds without a run.
  const defaultsConfig = useMemo<Record<string, unknown> | null>(() => {
    if (!meta) return null;
    const rows = lookbacksFromConfig({ lookbacks: meta.defaults.lookbacks });
    return {
      ...momentumSettingsDefaults({
        ...meta.defaults,
        benchmark: stringDefault(meta.defaults, 'benchmark', meta.benchmarks?.[0] ?? ''),
      }),
      universe: selectedByDefault(meta),
      start: defaultStart(meta, meta.defaults),
      end: stringDefault(meta.defaults, 'end', meta.last_week),
      top_n: numberDefault(meta.defaults, 'top_n', 5),
      exit_rank: numberDefault(meta.defaults, 'exit_rank', 10),
      lookbacks: rows.map((row) => row.weeks),
      weights: rows.map((row) => row.weight),
    };
  }, [meta]);
  const modified = useMemo(
    () =>
      defaultsConfig
        ? modifiedSections(formConfig, defaultsConfig, dataset)
        : new Set<MomentumSettingsSection>(),
    [formConfig, defaultsConfig, dataset],
  );

  const toggleSection = useCallback((id: MomentumSettingsSection, open: boolean): void => {
    setOpenSections((current) => ({ ...current, [id]: open }));
  }, []);

  // A summary chip was clicked: open its accordion, then bring it into view once it has rendered.
  const [revealSection, setRevealSection] = useState<{
    id: MomentumSettingsSection;
    tick: number;
  } | null>(null);
  function openSection(id: MomentumSettingsSection): void {
    toggleSection(id, true);
    setSettingsOpen(true);
    // The accordion lives in the settings column, so bring that back beside the results.
    setResultsExpanded(false);
    setRevealSection((current) => ({ id, tick: (current?.tick ?? 0) + 1 }));
  }
  useEffect(() => {
    if (!revealSection) return;
    const node = document.getElementById(settingsSectionDomId(revealSection.id));
    if (!node) return;
    const body = settingsBodyRef.current;
    if (body && body.scrollHeight > body.clientHeight + 1) {
      // Two-pane layout: the settings column scrolls on its own, so move only that column.
      const offset = node.getBoundingClientRect().top - body.getBoundingClientRect().top;
      body.scrollTo({ top: body.scrollTop + offset - 8, behavior: 'smooth' });
    } else {
      node.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    node.querySelector('button')?.focus({ preventScroll: true });
  }, [revealSection]);

  // The settings column is as tall as the viewport below it allows, so its run bar is on screen
  // both before the page is scrolled (the column starts under the page header) and once it is
  // stuck under the top bar. CSS alone can only express the stuck case.
  const settingsShown = section === 'backtest' && meta !== null && !loading;
  useEffect(() => {
    // Hidden in full-width results; measured again when the column comes back.
    if (!settingsShown || resultsExpanded) return;
    const node = settingsColumnRef.current;
    if (!node) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const top = Math.max(SETTINGS_STICKY_TOP_PX, Math.round(node.getBoundingClientRect().top));
      node.style.setProperty('--settings-top', `${top}px`);
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [settingsShown, resultsExpanded]);

  const resultEnd = result?.series.dates.at(-1);
  const datasetLabel = DATASETS.find((item) => item.id === dataset)?.label ?? 'Momentum';

  return (
    <div className="space-y-5">
      <Tabs
        ariaLabel="Momentum sections"
        variant="pill"
        className="w-fit"
        value={section}
        onChange={setSection}
        items={SECTIONS.map((item) => ({
          value: item.id,
          label: (
            <span
              className="inline-flex min-h-7 items-center gap-2"
              title={
                item.id === 'weekly' && weekly.running
                  ? 'Weekly signal is running in the background'
                  : undefined
              }
            >
              {item.label}
              {item.id === 'saved' ? (savedRunsLoading ? ' (…)' : ` (${savedRuns.length})`) : ''}
              {item.id === 'backtest' && inFlightCount > 0 ? (
                <span className="relative flex h-2 w-2" aria-label={`${inFlightCount} running`}>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              ) : null}
              {item.id === 'weekly' && weekly.running ? (
                <span className="relative flex h-2 w-2" aria-label="running">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              ) : null}
            </span>
          ),
        }))}
      />
      <p className="text-sm text-muted">
        {SECTIONS.find((item) => item.id === section)?.description}
      </p>
      <div
        id="momentum-section-panel"
        role="tabpanel"
        aria-label={SECTIONS.find((item) => item.id === section)?.label}
        className="space-y-5"
      >
        {section === 'scores' ? (
          <MomentumScoresView />
        ) : section === 'weekly' ? (
          <MomentumWeeklyView weekly={weekly} />
        ) : section === 'journal' ? (
          <MomentumJournalView />
        ) : section === 'rebalance' ? (
          <MomentumRebalanceView currentBroadConfig={dataset === 'broad' ? currentConfig : null} />
        ) : section === 'saved' ? (
          <div className="space-y-3">
            <SegmentedControl
              ariaLabel="Dataset"
              value={dataset}
              options={DATASET_OPTIONS}
              onChange={setDataset}
            />
            {savedRunError ? (
              <StateMessage
                variant="error"
                title="Could not update saved run"
                description={savedRunError}
              />
            ) : null}
            {savedRunsLoadError ? (
              <StateMessage
                variant="error"
                title="Could not load saved runs"
                description={savedRunsLoadError}
              />
            ) : null}
            <MomentumSavedRunsView
              dataset={dataset}
              runs={savedRuns}
              loading={savedRunsLoading}
              onRename={renameRun}
              onToggleOverlay={toggleOverlay}
              onToggleFavorite={toggleFavorite}
              onSetActive={setActive}
              onRemove={removeRun}
              onLoad={loadSettings}
            />
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SegmentedControl
                  ariaLabel="Dataset"
                  value={dataset}
                  options={DATASET_OPTIONS}
                  onChange={setDataset}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => void reloadPrices()}
                    disabled={loading || reloading}
                    title="Fetch the latest price coverage; your edited settings are kept"
                  >
                    <RefreshCw className={reloading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                    Reload prices
                  </Button>
                  {confirmReset ? (
                    <>
                      <span className="text-xs text-muted">Discard every edited setting?</span>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          setConfirmReset(false);
                          void loadMeta(dataset);
                        }}
                      >
                        Reset
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmReset(true)}
                      disabled={loading || reloading}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Reset to defaults
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {error ? (
              <StateMessage
                variant="error"
                title="Momentum backtest unavailable"
                description={error}
              />
            ) : null}

            {/* Two panes from xl: settings on the left in their own scroll, results on the right,
                so a setting and what it does to the result are on screen together. */}
            <div
              className={cn(
                'grid gap-5 xl:items-start',
                !resultsExpanded &&
                  'xl:grid-cols-[26.5rem_minmax(0,1fr)] 2xl:grid-cols-[28.5rem_minmax(0,1fr)]',
              )}
            >
              {loading || !meta ? (
                error ? (
                  <div className={cn('hidden', !resultsExpanded && 'xl:block')} />
                ) : (
                  <div className={cn(resultsExpanded && 'xl:hidden')}>
                    <MomentumSettingsSkeleton />
                  </div>
                )
              ) : (
                <section
                  ref={settingsColumnRef}
                  aria-label="Strategy settings"
                  onKeyDown={onSettingsKeyDown}
                  className={cn(
                    'rounded-xl border border-border bg-surface xl:sticky xl:top-[4.5rem] xl:max-h-[calc(100vh-var(--settings-top,4.5rem)-1rem)] xl:min-h-[20rem] xl:flex-col',
                    // Hidden, not unmounted, in full-width results: edits and open accordions stay.
                    resultsExpanded ? 'xl:hidden' : 'xl:flex',
                  )}
                >
                  <div className="flex items-center gap-2 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <h2 className="text-sm font-semibold text-foreground">Strategy settings</h2>
                      <p className="truncate text-xs text-muted">
                        {modified.size === 0
                          ? 'Dataset defaults'
                          : `${modified.size} ${modified.size === 1 ? 'section' : 'sections'} changed from the defaults`}
                      </p>
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={shareLink}
                      disabled={!currentConfig}
                      aria-label="Copy shareable link"
                      title={
                        copied
                          ? 'Link copied'
                          : 'Copy shareable link: a URL that reopens this page with these settings'
                      }
                    >
                      {copied ? (
                        <Check className="h-4 w-4 text-positive" />
                      ) : (
                        <LinkIcon className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="xl:hidden"
                      onClick={() => setSettingsOpen((open) => !open)}
                      aria-expanded={settingsOpen}
                      aria-label={settingsOpen ? 'Collapse settings' : 'Expand settings'}
                    >
                      <ChevronDown
                        className={cn('h-4 w-4 transition-transform', settingsOpen && 'rotate-180')}
                      />
                    </Button>
                  </div>
                  {/* Collapsing (below xl only) hides the panel rather than unmounting it. */}
                  <div
                    ref={settingsBodyRef}
                    className={cn(
                      'border-t border-border p-4 xl:min-h-0 xl:flex-1 xl:overflow-y-auto',
                      !settingsOpen && 'hidden xl:block',
                    )}
                  >
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
                      openSections={openSections}
                      onToggleSection={toggleSection}
                      modifiedSections={modified}
                    />
                  </div>
                  <MomentumRunBar
                    starting={starting}
                    disabled={!meta}
                    dirty={dirty}
                    hasRun={lastRunConfig !== null}
                    inFlightCount={inFlightCount}
                    runError={runError}
                    runErrorRef={runErrorRef}
                    onRun={(options) => void runBacktest(options)}
                  />
                </section>
              )}

              <div className="min-w-0 space-y-4">
                {meta && !loading ? (
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <MomentumSettingsChips
                        datasetLabel={datasetLabel}
                        chips={described.chips}
                        pricesThrough={meta.last_week}
                        onOpenSection={openSection}
                      />
                    </div>
                    {/* The settings column's stand-in while the results are full width. */}
                    {resultsExpanded ? (
                      <div className="hidden shrink-0 flex-wrap items-center gap-2 xl:flex">
                        {dirty ? <Badge tone="warning">Changed since last run</Badge> : null}
                        <Button
                          size="sm"
                          onClick={() => setResultsExpanded(false)}
                          title="Show the settings beside the results"
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                          Settings
                        </Button>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={starting === 'run'}
                          disabled={starting !== null}
                          onClick={() => void runBacktest({ fresh: false })}
                          title="Run the backtest with these settings"
                        >
                          {starting === 'run' ? null : (
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          {dirty && lastRunConfig !== null ? 'Run again' : 'Run'}
                        </Button>
                        <Button
                          size="icon"
                          loading={starting === 'fresh'}
                          disabled={starting !== null}
                          onClick={() => void runBacktest({ fresh: true })}
                          aria-label="Re-run fresh"
                          title="Re-run from scratch: drops the server's cached rankings and data, reloads them, then recomputes. Slower; use it when the numbers look stale."
                        >
                          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    ) : null}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="hidden xl:inline-flex"
                      aria-pressed={resultsExpanded}
                      onClick={() => setResultsExpanded(!resultsExpanded)}
                      aria-label={
                        resultsExpanded ? 'Show settings beside results' : 'Full-width results'
                      }
                      title={
                        resultsExpanded ? 'Show settings beside results' : 'Full-width results'
                      }
                    >
                      {resultsExpanded ? (
                        <Minimize2 className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Maximize2 className="h-4 w-4" aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                ) : null}

                {/* The run bar that normally reports a failed run is in the hidden column. */}
                {resultsExpanded && runError ? (
                  <div
                    role="alert"
                    className="hidden rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-sm text-negative xl:block"
                  >
                    <p className="font-medium">The run didn&apos;t finish</p>
                    <p className="mt-0.5 text-foreground/80">{runError}</p>
                  </div>
                ) : null}

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

                {running ? (
                  // Pinned under the app top bar, so the timer stays visible while you scroll.
                  <div className="sticky top-[4.5rem] z-20">
                    <MomentumRunBanner
                      elapsedMs={elapsedMs}
                      dataset={dataset}
                      datasetLabel={datasetLabel}
                      hasPreviousResult={result !== null}
                      queued={activeRun?.status === 'queued'}
                      stage={activeRun?.stage ?? null}
                      usualMs={usualMs}
                    />
                  </div>
                ) : null}

                {doneNoticeAt !== null && runInfo && !running ? (
                  // Zero-height sticky slot: the pill floats over the page without shifting content.
                  <div className="sticky top-[4.5rem] z-20 h-0">
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={() => {
                          summaryRef.current?.scrollIntoView({
                            behavior: 'smooth',
                            block: 'start',
                          });
                          setDoneNoticeAt(null);
                        }}
                        className="inline-flex animate-fade-in items-center gap-2 rounded-full border border-positive/30 bg-surface px-4 py-2 text-sm text-foreground shadow-elevated transition-colors hover:border-positive/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <CheckCircle2 className="h-4 w-4 text-positive" />
                        Results updated · took {formatDuration(runInfo.durationMs)}
                        <span className="inline-flex items-center gap-1 font-medium text-primary">
                          View summary <ArrowUp className="h-3.5 w-3.5" />
                        </span>
                      </button>
                    </div>
                  </div>
                ) : null}

                {running && !result ? <MomentumResultsSkeleton /> : null}

                {!running && !result && !activeRun && meta && !loading ? (
                  <StateMessage
                    variant="empty"
                    title="No results yet"
                    description="Choose the settings and press Run momentum backtest (Ctrl/Cmd + Enter). The result appears here."
                  />
                ) : null}

                {result ? (
                  <div
                    className={cn(
                      'space-y-5 transition-opacity duration-300',
                      running && 'pointer-events-none select-none opacity-40',
                    )}
                    aria-busy={running}
                  >
                    <div ref={summaryRef} className="scroll-mt-20">
                      {dataset === 'broad' && meta && resultEnd && resultEnd < meta.last_week ? (
                        <div className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground">
                          Result ends {resultEnd}, while prices extend to {meta.last_week}. Some
                          weeks may have been skipped for insufficient ranked names. Check “Simulate
                          every week” in Broad Momentum settings.
                        </div>
                      ) : null}
                      <MomentumPerformanceCard
                        result={result}
                        config={shownConfig ?? {}}
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
                      broad={shownRun?.dataset === 'broad'}
                    />
                    {/* Broad only (renders nothing otherwise): the worst circuit-lock situations,
                        after the chart so the overview leads straight into it. Fetched after
                        the result lands: it costs a second engine run to build. */}
                    <MomentumCircuitExposureLoader runId={shownRun?.id ?? ''} />
                    <MomentumResultDetails
                      runId={shownRun?.id ?? ''}
                      result={result}
                      config={shownConfig ?? {}}
                      savedRuns={savedRuns}
                      flashKey={finishedAt}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
