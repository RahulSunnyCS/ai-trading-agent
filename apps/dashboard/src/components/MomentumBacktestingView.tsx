'use client';

import { ChevronDown, Link as LinkIcon, Play, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { cn } from '../lib/cn';
import type { MomentumResult, MomentumSavedRun } from '../types/momentum';
import { MomentumEquityChart } from './momentum/MomentumEquityChart';
import { MomentumRebalanceView } from './momentum/MomentumRebalanceView';
import { MomentumResultDetails } from './momentum/MomentumResultDetails';
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

export function MomentumBacktestingView() {
  const [section, setSection] = useState<'backtest' | 'scores' | 'saved' | 'weekly' | 'rebalance'>(
    'backtest',
  );
  const [dataset, setDataset] = useState<Dataset>('etf');
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
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MomentumResult | null>(null);
  const [lastRunConfig, setLastRunConfig] = useState<Record<string, unknown> | null>(null);
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
  async function removeRun(id: string): Promise<void> {
    setSavedRuns((runs) => runs.filter((run) => run.id !== id));
    await apiDelete(`/api/momentum/saved-runs/${id}`);
  }

  async function loadMeta(nextDataset: Dataset, seed?: Record<string, unknown>): Promise<void> {
    setLoading(true);
    setError(null);
    setResult(null);
    setLastRunConfig(null);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadMeta is redefined every render; it should only re-run when the dataset itself changes
  useEffect(() => {
    setSavedRuns([]);
    void fetchSavedRuns(dataset).then(setSavedRuns);
    void loadMeta(dataset);
  }, [dataset]);

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

  async function runBacktest(): Promise<void> {
    let config: Record<string, unknown>;
    try {
      config = buildConfig();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setRunning(true);
    setError(null);
    const response = await apiPost<MomentumResult>('/api/momentum/backtest', config);
    setRunning(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setResult(response.data);
    setLastRunConfig(config);
    setSettingsOpen(false);
    const kpis = response.data.kpis;
    const sequence = Math.max(0, ...savedRuns.map((run) => run.n)) + 1;
    const saved = await apiPost<MomentumSavedRun>('/api/momentum/saved-runs', {
      dataset,
      name: `Run ${sequence}`,
      config,
      kpis: {
        cagr: typeof kpis.cagr === 'number' ? kpis.cagr : null,
        excess_cagr: typeof kpis.excess_cagr === 'number' ? kpis.excess_cagr : null,
        max_drawdown: typeof kpis.max_drawdown === 'number' ? kpis.max_drawdown : null,
        sharpe: typeof kpis.sharpe === 'number' ? kpis.sharpe : null,
        turnover_per_year:
          typeof kpis.turnover_per_year === 'number' ? kpis.turnover_per_year : null,
        avg_holdings: typeof kpis.avg_holdings === 'number' ? kpis.avg_holdings : null,
      },
      dates: response.data.series.dates,
      strategy: response.data.series.strategy,
      overlay: false,
    });
    if (saved.ok) setSavedRuns((runs) => [saved.data, ...runs].slice(0, 10));
  }

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
      const sharedDataset = (
        typeof decoded.dataset === 'string' ? decoded.dataset : 'etf'
      ) as Dataset;
      setDataset(sharedDataset);
      void loadMeta(sharedDataset, decoded);
    } catch {
      // Malformed/old link — ignore and fall back to defaults.
    }
  }, []);

  const summary = meta
    ? `${core.start || 'Start'} → ${core.end || 'End'} · ${values.rebalance ?? 'weekly'} · top ${core.topN} / exit >${core.exitRank} · ${values.benchmark ?? ''}`
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
        >
          Weekly signal
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
        <MomentumWeeklyView />
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
          onRemove={removeRun}
          onLoad={loadSettings}
        />
      ) : (
        <>
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {DATASETS.map((item) => (
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

          {error ? (
            <StateMessage
              variant="error"
              title="Momentum backtest unavailable"
              description={error}
            />
          ) : null}

          {loading || !meta ? null : (
            <div className="rounded-xl border border-border bg-surface">
              <button
                type="button"
                onClick={() => setSettingsOpen((open) => !open)}
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">Strategy settings</p>
                  {!settingsOpen ? <p className="truncate text-xs text-muted">{summary}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {dirty ? (
                    <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                      Changed since last run
                    </span>
                  ) : null}
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 text-faint transition-transform',
                      settingsOpen && 'rotate-180',
                    )}
                  />
                </div>
              </button>
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
                    <Button variant="primary" onClick={() => void runBacktest()} disabled={running}>
                      <Play className="h-3.5 w-3.5" />
                      {running ? 'Running momentum backtest…' : 'Run momentum backtest'}
                    </Button>
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
                    disabled={running}
                  >
                    <Play className="h-3.5 w-3.5" />
                    {running ? 'Running…' : dirty ? 'Run again' : 'Run momentum backtest'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {result ? (
            <>
              <MomentumEquityChart
                series={result.series}
                benchmarkName={result.benchmark_name}
                rotations={result.rotations}
                overlays={overlays}
              />
              <MomentumResultDetails
                result={result}
                config={lastRunConfig ?? {}}
                savedRuns={savedRuns}
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
