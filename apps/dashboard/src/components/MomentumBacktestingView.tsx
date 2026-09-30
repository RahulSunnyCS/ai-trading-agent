'use client';

import { Play, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import type { MomentumResult, MomentumSavedRun } from '../types/momentum';
import { MomentumAdvancedSettings, advancedDefaults } from './momentum/MomentumAdvancedSettings';
import { MomentumEquityChart } from './momentum/MomentumEquityChart';
import { MomentumRebalanceView } from './momentum/MomentumRebalanceView';
import { MomentumResultDetails } from './momentum/MomentumResultDetails';
import { MomentumSavedRunsView } from './momentum/MomentumSavedRunsView';
import { MomentumScoresView } from './momentum/MomentumScoresView';
import { MomentumWeeklyView } from './momentum/MomentumWeeklyView';
import { Button } from './ui/Button';
import { Card, CardHeader } from './ui/Card';
import { StateMessage } from './ui/StateMessage';

type Dataset = 'etf' | 'stock' | 'custom_index' | 'broad';

interface Instrument {
  name: string;
  display_name?: string | null;
  include: string;
  group: string;
  has_data: boolean;
}

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

/**
 * Saved runs are persisted server-side (P4 — see
 * packages/momentum-backtesting/src/momentum_backtesting/runs_store.py),
 * grouped by dataset just like the localStorage keys they replaced. A failed
 * fetch (service down, fresh catalog) degrades to an empty list rather than
 * blocking the backtest UI — saved runs are a convenience, not the golden path.
 */
async function fetchSavedRuns(dataset: Dataset): Promise<MomentumSavedRun[]> {
  const response = await apiGet<MomentumSavedRun[]>(`/api/momentum/saved-runs?dataset=${dataset}`);
  return response.ok ? response.data : [];
}

/**
 * First React slice of Momentum Backtesting. It deliberately talks only to the
 * Fastify proxy; the legacy Python UI remains available during parity work.
 */
export function MomentumBacktestingView() {
  const [section, setSection] = useState<'backtest' | 'scores' | 'saved' | 'weekly' | 'rebalance'>('backtest');
  const [dataset, setDataset] = useState<Dataset>('etf');
  const [meta, setMeta] = useState<MomentumMeta | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [topN, setTopN] = useState(5);
  const [exitRank, setExitRank] = useState(10);
  const [lookbacks, setLookbacks] = useState('1, 4, 13, 26, 52');
  const [weights, setWeights] = useState('');
  const [advanced, setAdvanced] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MomentumResult | null>(null);
  const [savedRuns, setSavedRuns] = useState<MomentumSavedRun[]>([]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const overlays = useMemo(
    () => savedRuns.filter((run, index) => index > 0 && run.overlay),
    [savedRuns],
  );

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

  async function loadMeta(nextDataset: Dataset): Promise<void> {
    setLoading(true);
    setError(null);
    setResult(null);
    const response = await apiGet<MomentumMeta>(`/api/momentum/meta?dataset=${nextDataset}`);
    setLoading(false);
    if (!response.ok) {
      setMeta(null);
      setError(response.error);
      return;
    }
    const nextMeta = response.data;
    setMeta(nextMeta);
    setSelected(selectedByDefault(nextMeta));
    setStart(stringDefault(nextMeta.defaults, 'start', nextMeta.first_week));
    setEnd(nextMeta.last_week);
    setTopN(numberDefault(nextMeta.defaults, 'top_n', 5));
    setExitRank(numberDefault(nextMeta.defaults, 'exit_rank', 10));
    const defaults = nextMeta.defaults.lookbacks;
    setLookbacks(Array.isArray(defaults) ? defaults.join(', ') : '1, 4, 13, 26, 52');
    setWeights(
      Array.isArray(nextMeta.defaults.weights) ? nextMeta.defaults.weights.join(', ') : '',
    );
    setAdvanced(advancedDefaults(nextMeta.defaults));
  }

  useEffect(() => {
    setSavedRuns([]);
    void fetchSavedRuns(dataset).then(setSavedRuns);
    void loadMeta(dataset);
  }, [dataset]);

  function loadSettings(run: MomentumSavedRun): void {
    const config = run.config;
    setSelected(
      Array.isArray(config.universe)
        ? config.universe.filter((value): value is string => typeof value === 'string')
        : [],
    );
    setStart(stringDefault(config, 'start', ''));
    setEnd(stringDefault(config, 'end', ''));
    setTopN(numberDefault(config, 'top_n', 5));
    setExitRank(numberDefault(config, 'exit_rank', 10));
    setLookbacks(
      Array.isArray(config.lookbacks) ? config.lookbacks.join(', ') : '1, 4, 13, 26, 52',
    );
    setWeights(Array.isArray(config.weights) ? config.weights.join(', ') : '');
    setAdvanced(advancedDefaults(config));
    setSection('backtest');
  }

  function toggleInstrument(name: string): void {
    setSelected((previous) =>
      previous.includes(name) ? previous.filter((value) => value !== name) : [...previous, name],
    );
  }

  function buildConfig(): Record<string, unknown> {
    if (!meta) throw new Error('Strategy settings are still loading.');
    const parsedLookbacks = lookbacks
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value > 0);
    if (parsedLookbacks.length === 0) {
      throw new Error('Enter one or more positive whole-number lookback windows.');
    }
    const parsedWeights = weights.trim()
      ? weights.split(',').map((value) => Number(value.trim()))
      : null;
    if (
      parsedWeights &&
      (parsedWeights.length !== parsedLookbacks.length ||
        parsedWeights.some((value) => !Number.isFinite(value)) ||
        parsedWeights.every((value) => value === 0))
    ) {
      throw new Error(
        'Give one finite weight per lookback window (negative is allowed, for a reversal signal — not all zero), or leave weights blank.',
      );
    }
    if (dataset !== 'broad' && selected.length === 0) {
      throw new Error('Select at least one instrument before running the strategy.');
    }
    return {
      ...meta.defaults, ...advanced, dataset,
      universe: dataset === 'broad' ? ['broad_momentum'] : selected,
      start, end, top_n: topN, exit_rank: exitRank,
      lookbacks: parsedLookbacks, weights: parsedWeights,
    };
  }

  async function runBacktest(): Promise<void> {
    let config: Record<string, unknown>;
    try { config = buildConfig(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    setRunning(true);
    setError(null);
    const response = await apiPost<MomentumResult>('/api/momentum/backtest', config);
    setRunning(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setResult(response.data);
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
    // Best-effort: a save failure (service hiccup) shouldn't block showing the result
    // that already rendered above — the run just won't appear under Saved runs.
    if (saved.ok) setSavedRuns((runs) => [saved.data, ...runs].slice(0, 10));
  }

  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border border-border bg-surface p-1">
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
      ) : (
        <>
          {section === 'saved' ? (
            <MomentumSavedRunsView
              runs={savedRuns}
              onRename={renameRun}
              onToggleOverlay={toggleOverlay}
              onRemove={removeRun}
              onLoad={loadSettings}
            />
          ) : (
            <>
              <Card>
                <CardHeader
                  title="Momentum Backtesting"
                  description="Weekly rotation research, now being migrated into the shared dashboard."
                  actions={
                    <Button size="sm" onClick={() => void loadMeta(dataset)} disabled={loading}>
                      <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
                      Refresh data
                    </Button>
                  }
                />
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {DATASETS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setDataset(item.id)}
                      className={`rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        dataset === item.id
                          ? 'border-primary bg-primary/10'
                          : 'border-border bg-surface-2/30 hover:border-border-strong'
                      }`}
                    >
                      <p className="text-sm font-medium text-foreground">{item.label}</p>
                      <p className="mt-1 text-xs text-muted">{item.description}</p>
                    </button>
                  ))}
                </div>
              </Card>

              {error ? (
                <StateMessage
                  variant="error"
                  title="Momentum backtest unavailable"
                  description={error}
                />
              ) : null}

              {loading || !meta ? null : (
                <>
                  <Card>
                    <CardHeader
                      title="Backtest settings"
                      description={`Data coverage: ${meta.first_week} to ${meta.last_week}`}
                    />
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                      <label className="text-xs text-muted">
                        Start
                        <input
                          className="mt-1 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm text-foreground"
                          type="date"
                          value={start}
                          onChange={(event) => setStart(event.target.value)}
                        />
                      </label>
                      <label className="text-xs text-muted">
                        End
                        <input
                          className="mt-1 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm text-foreground"
                          type="date"
                          value={end}
                          onChange={(event) => setEnd(event.target.value)}
                        />
                      </label>
                      <label className="text-xs text-muted">
                        Top N
                        <input
                          className="mt-1 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm text-foreground"
                          type="number"
                          min="1"
                          value={topN}
                          onChange={(event) => setTopN(Number(event.target.value))}
                        />
                      </label>
                      <label className="text-xs text-muted">
                        Exit rank
                        <input
                          className="mt-1 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm text-foreground"
                          type="number"
                          min="1"
                          value={exitRank}
                          onChange={(event) => setExitRank(Number(event.target.value))}
                        />
                      </label>
                      <label className="text-xs text-muted">
                        Lookbacks (weeks)
                        <input
                          className="mt-1 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm text-foreground"
                          value={lookbacks}
                          onChange={(event) => setLookbacks(event.target.value)}
                        />
                      </label>
                      <label className="text-xs text-muted">
                        Weights (optional)
                        <input
                          className="mt-1 w-full rounded-lg border bg-surface px-2 py-1.5 text-sm text-foreground"
                          value={weights}
                          onChange={(event) => setWeights(event.target.value)}
                          placeholder="One per lookback"
                        />
                      </label>
                    </div>
                  </Card>

                  <MomentumAdvancedSettings
                    dataset={dataset}
                    values={advanced}
                    benchmarks={
                      meta.benchmarks ??
                      meta.instruments
                        .filter((instrument) => instrument.has_data)
                        .map((instrument) => instrument.name)
                    }
                    onChange={(key, value) =>
                      setAdvanced((current) => ({ ...current, [key]: value }))
                    }
                  />

                  {dataset !== 'broad' ? (
                    <Card>
                      <CardHeader
                        title="Universe"
                        description={`${selected.length} instruments selected`}
                      />
                      <div className="max-h-80 columns-1 overflow-y-auto sm:columns-2 xl:columns-3">
                        {meta.instruments.map((instrument) => (
                          <label
                            key={instrument.name}
                            className="mb-2 flex break-inside-avoid items-center gap-2 text-sm text-foreground"
                          >
                            <input
                              type="checkbox"
                              checked={selectedSet.has(instrument.name)}
                              disabled={!instrument.has_data}
                              onChange={() => toggleInstrument(instrument.name)}
                            />
                            <span>{instrument.display_name ?? instrument.name}</span>
                            <span className="text-xs text-faint">{instrument.group}</span>
                          </label>
                        ))}
                      </div>
                    </Card>
                  ) : (
                    <Card>
                      <p className="text-sm text-muted">
                        Broad Momentum derives its eligible universe from the Total Market data and
                        refreshes its pool quarterly; it has no fixed instrument checklist.
                      </p>
                    </Card>
                  )}

                  <Button variant="primary" onClick={() => void runBacktest()} disabled={running}>
                    <Play className="h-3.5 w-3.5" />
                    {running ? 'Running momentum backtest…' : 'Run momentum backtest'}
                  </Button>
                </>
              )}

              {result ? (
                <>
                  <MomentumEquityChart
                    series={result.series}
                    benchmarkName={result.benchmark_name}
                    rotationWeeks={result.rotations.map((rotation) => rotation.week)}
                    overlays={overlays}
                  />
                  <MomentumResultDetails result={result} />
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
