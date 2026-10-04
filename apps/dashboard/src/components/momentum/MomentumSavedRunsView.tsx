'use client';

import { AlertTriangle, CheckCircle2, Star } from 'lucide-react';
import { useMemo, useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
import type { MomentumSavedRun, MomentumWeeklyStatus } from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { MomentumListSkeleton } from './MomentumSkeletons';

/** Custom Index and Broad Momentum price through the same bhavcopy-backed stock layer as
 * Stock mode (see weekly.py's A5 gate investigation), so they share the "stock" readiness
 * dataset key from /weekly/status rather than each needing their own. */
function readinessKey(dataset: unknown): 'etf' | 'stock' {
  return dataset === 'stock' || dataset === 'custom_index' || dataset === 'broad' ? 'stock' : 'etf';
}

/** B3: whether a favourite could produce a signal right now, so a blocked active favourite
 * is visible before Friday rather than discovered from a missed Telegram message. */
function readiness(
  run: MomentumSavedRun,
  status: MomentumWeeklyStatus | null,
): { ready: boolean; detail: string } | null {
  if (!run.favorite || !status) return null;
  const item = status.datasets.find((d) => d.key === readinessKey(run.config.dataset));
  if (!item) return null;
  return {
    ready: item.ready,
    detail: item.ready
      ? `Data through ${item.through ?? '—'}`
      : item.through
        ? `Data only through ${item.through} — this week's data isn't ingested yet.`
        : 'No data ingested yet.',
  };
}

const PERCENT_METRICS = new Set(['cagr', 'excess_cagr', 'max_drawdown', 'turnover_per_year']);
const METRICS: Array<[string, string]> = [
  ['cagr', 'CAGR'],
  ['excess_cagr', 'Edge vs benchmark'],
  ['max_drawdown', 'Max drawdown'],
  ['sharpe', 'Sharpe'],
  ['turnover_per_year', 'Annual turnover'],
  ['avg_holdings', 'Average holdings'],
];

const SETTING_LABELS: Record<string, string> = {
  start: 'From',
  end: 'To',
  universe: 'Universe',
  top_n: 'Positions held',
  exit_rank: 'Sell after rank',
  lookbacks: 'Lookback weeks',
  weights: 'Lookback weights',
  benchmark: 'Benchmark',
  rebalance: 'Rebalance cadence',
  rebalance_every: 'Weeks between rebalances',
  min_ranked: 'Minimum ranked names',
  tax: 'Capital gains tax',
  slippage_bps: 'Slippage (bps)',
};

type SortKey =
  | 'saved'
  | 'name'
  | 'cagr'
  | 'max_drawdown'
  | 'turnover_per_year'
  | 'sharpe'
  | 'excess_cagr';
const SORTS: Array<[SortKey, string]> = [
  ['saved', 'Saved date'],
  ['cagr', 'CAGR'],
  ['max_drawdown', 'Max drawdown'],
  ['turnover_per_year', 'Turnover'],
  ['sharpe', 'Sharpe'],
  ['excess_cagr', 'Edge vs benchmark'],
  ['name', 'Name'],
];
// The natural "best first" direction per column: high CAGR/Sharpe/edge, shallow drawdown
// (max_drawdown is stored negative, so descending already puts -20% above -50%), low turnover.
const BEST_FIRST_DESC: Record<SortKey, boolean> = {
  saved: true,
  name: false,
  cagr: true,
  max_drawdown: true,
  turnover_per_year: false,
  sharpe: true,
  excess_cagr: true,
};

function sortRuns(runs: MomentumSavedRun[], key: SortKey, reversed: boolean): MomentumSavedRun[] {
  const desc = BEST_FIRST_DESC[key] !== reversed;
  const value = (run: MomentumSavedRun): number | string | null =>
    key === 'saved'
      ? run.created_at
      : key === 'name'
        ? run.name.toLowerCase()
        : (run.kpis[key] ?? null);
  return [...runs].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    // Runs without the metric always sink to the bottom, whichever way the sort runs.
    if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
    if (y === null || y === undefined) return -1;
    const order = x < y ? -1 : x > y ? 1 : 0;
    return desc ? -order : order;
  });
}

function settingValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object')
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join(', ');
  return String(value);
}

function metric(run: MomentumSavedRun | undefined, key: string): string {
  const value = run?.kpis[key];
  if (value === null || value === undefined) return '—';
  return PERCENT_METRICS.has(key) ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
}

export function MomentumSavedRunsView({
  dataset,
  runs,
  loading = false,
  onRename,
  onToggleOverlay,
  onToggleFavorite,
  onSetActive,
  onRemove,
  onLoad,
}: {
  dataset: 'etf' | 'stock' | 'custom_index' | 'broad';
  runs: MomentumSavedRun[];
  /** The list has not arrived yet: show placeholders, never the "no runs" empty state. */
  loading?: boolean;
  onRename: (id: string, name: string) => void;
  onToggleOverlay: (id: string, overlay: boolean) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onSetActive: (id: string) => void;
  onRemove: (id: string) => void;
  onLoad: (run: MomentumSavedRun) => void;
}) {
  const [baseId, setBaseId] = useState('');
  const [compareId, setCompareId] = useState('');
  const [draftNames, setDraftNames] = useState<Record<string, string>>({});
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('saved');
  const [reversed, setReversed] = useState(false);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = runs.filter(
      (run) =>
        (!favouritesOnly || run.favorite) && (!needle || run.name.toLowerCase().includes(needle)),
    );
    return sortRuns(filtered, sortKey, reversed);
  }, [runs, query, sortKey, reversed, favouritesOnly]);
  const current = runs.find((run) => run.id === baseId) ?? runs[0];
  const comparison =
    runs.find((run) => run.id === compareId && run.id !== current?.id) ??
    runs.find((run) => run.id !== current?.id);
  const differences =
    current && comparison
      ? Object.keys(current.config).filter(
          (key) => JSON.stringify(current.config[key]) !== JSON.stringify(comparison.config[key]),
        )
      : [];
  // Shares the Weekly signal tab's endpoint rather than threading its status down through
  // props — cheap to poll and keeps this view self-contained.
  const { data: status } = usePolledResource<MomentumWeeklyStatus>('/api/momentum/weekly/status', {
    cache: true,
  });

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={`Saved runs · ${({ etf: 'ETF Rotation', stock: 'Nifty 50 Stocks', custom_index: 'Custom Index', broad: 'Broad Momentum' } as const)[dataset]}`}
          description={`${loading ? 'Loading the saved runs' : `${runs.length} runs`} for this dataset. Favourites run every weekly cycle; only the active favourite is sent to Telegram.`}
        />
        {loading && runs.length === 0 ? (
          <MomentumListSkeleton rows={4} label="Loading saved runs" />
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted">Run a backtest to start a comparison.</p>
        ) : (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              type="search"
              aria-label="Search saved runs"
              placeholder="Search by name…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="min-w-56 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted">
              Sort by
              <select
                aria-label="Sort saved runs"
                value={sortKey}
                onChange={(event) => {
                  setSortKey(event.target.value as SortKey);
                  setReversed(false);
                }}
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              >
                {SORTS.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Reverse sort order"
              onClick={() => setReversed((value) => !value)}
            >
              {BEST_FIRST_DESC[sortKey] !== reversed ? '↓ Descending' : '↑ Ascending'}
            </Button>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                checked={favouritesOnly}
                onChange={(event) => setFavouritesOnly(event.target.checked)}
              />
              Favourites only
            </label>
            <span className="text-xs text-muted">
              Showing {shown.length} of {runs.length}
            </span>
          </div>
        )}
        {shown.map((run) => {
          // The overlay base is the first saved run, whatever order the list is sorted in.
          const index = runs.indexOf(run);
          const ready = readiness(run, status ?? null);
          return (
            <div key={run.id} className="border-t border-border py-3">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    aria-label={`Overlay ${run.name}`}
                    checked={run.overlay}
                    disabled={index === 0}
                    onChange={(event) => onToggleOverlay(run.id, event.target.checked)}
                  />
                  Overlay
                </label>
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    aria-label={`Favourite ${run.name}`}
                    checked={run.favorite}
                    onChange={(event) => onToggleFavorite(run.id, event.target.checked)}
                  />
                  <Star className="h-3.5 w-3.5" aria-hidden />
                  Favourite
                </label>
                {run.favorite ? (
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <input
                      type="radio"
                      name="active-weekly-strategy"
                      aria-label={`Use ${run.name} for Telegram`}
                      checked={run.active}
                      onChange={() => onSetActive(run.id)}
                    />
                    Telegram active
                  </label>
                ) : null}
                <input
                  aria-label={`Name for run ${run.n}`}
                  value={draftNames[run.id] ?? run.name}
                  maxLength={64}
                  onChange={(event) =>
                    setDraftNames((names) => ({ ...names, [run.id]: event.target.value }))
                  }
                  onBlur={() => {
                    const name = (draftNames[run.id] ?? run.name).trim();
                    if (name && name !== run.name) onRename(run.id, name);
                    setDraftNames((names) => {
                      const next = { ...names };
                      delete next[run.id];
                      return next;
                    });
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                  className="min-w-48 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                />
                <span className="text-xs text-muted">
                  CAGR {metric(run, 'cagr')} · DD {metric(run, 'max_drawdown')} · Turnover{' '}
                  {metric(run, 'turnover_per_year')} · Sharpe {metric(run, 'sharpe')}
                  {typeof run.config.start === 'string'
                    ? ` · ${run.config.start} → ${String(run.config.end ?? 'latest')}`
                    : ''}
                  {' · '}Saved{' '}
                  {new Date(run.created_at).toLocaleDateString('en-IN', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => onLoad(run)}>
                    Load settings
                  </Button>
                  {removeId === run.id ? (
                    <>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => {
                          onRemove(run.id);
                          setRemoveId(null);
                        }}
                      >
                        Confirm remove
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setRemoveId(null)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setRemoveId(run.id)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
              {ready ? (
                <div className="mt-2 flex items-center gap-1.5 pl-0.5 text-xs">
                  {ready.ready ? (
                    <Badge tone="positive" dot>
                      Ready for this week&apos;s weekly run
                    </Badge>
                  ) : (
                    <Badge tone="warning" dot>
                      Will be blocked this week
                    </Badge>
                  )}
                  <span className="flex items-center gap-1 text-muted">
                    {ready.ready ? (
                      <CheckCircle2 className="h-3 w-3" />
                    ) : (
                      <AlertTriangle className="h-3 w-3" />
                    )}
                    {ready.detail}
                  </span>
                </div>
              ) : null}
            </div>
          );
        })}
      </Card>

      {current && comparison ? (
        <Card>
          <CardHeader
            title="Compare runs"
            description="Choose any two saved runs from this dataset."
            actions={
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label="First run to compare"
                  value={current.id}
                  onChange={(event) => setBaseId(event.target.value)}
                  className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                >
                  {runs.map((run) => (
                    <option key={run.id} value={run.id}>
                      {run.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Second run to compare"
                  value={comparison.id}
                  onChange={(event) => setCompareId(event.target.value)}
                  className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                >
                  {runs
                    .filter((run) => run.id !== current.id)
                    .map((run) => (
                      <option key={run.id} value={run.id}>
                        {run.name}
                      </option>
                    ))}
                </select>
              </div>
            }
          />
          <Table>
            <THead>
              <Th>Metric</Th>
              <Th>{current.name}</Th>
              <Th>{comparison.name}</Th>
            </THead>
            <tbody>
              {METRICS.map(([key, label]) => (
                <TRow key={key}>
                  <Td>{label}</Td>
                  <Td numeric>{metric(current, key)}</Td>
                  <Td numeric>{metric(comparison, key)}</Td>
                </TRow>
              ))}
            </tbody>
          </Table>
          <h3 className="mb-2 mt-5 text-sm font-semibold">
            Settings that differ ({differences.length})
          </h3>
          <div className="space-y-1 text-xs text-muted">
            {differences.length === 0 ? (
              <p>No settings differ.</p>
            ) : (
              differences.map((key) => (
                <p key={key}>
                  <span className="font-semibold text-foreground">
                    {SETTING_LABELS[key] ?? key.replaceAll('_', ' ')}:
                  </span>{' '}
                  {settingValue(current.config[key])} → {settingValue(comparison.config[key])}
                </p>
              ))
            )}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
