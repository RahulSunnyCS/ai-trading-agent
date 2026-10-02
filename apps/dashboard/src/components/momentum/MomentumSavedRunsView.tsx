'use client';

import { AlertTriangle, CheckCircle2, Star } from 'lucide-react';
import { useState } from 'react';

import { usePolledResource } from '../../hooks/usePolledResource';
import type { MomentumSavedRun, MomentumWeeklyStatus } from '../../types/momentum';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

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

function metric(run: MomentumSavedRun | undefined, key: string): string {
  const value = run?.kpis[key];
  if (value === null || value === undefined) return '—';
  return PERCENT_METRICS.has(key) ? `${(value * 100).toFixed(1)}%` : value.toFixed(2);
}

export function MomentumSavedRunsView({
  runs,
  onRename,
  onToggleOverlay,
  onToggleFavorite,
  onSetActive,
  onRemove,
  onLoad,
}: {
  runs: MomentumSavedRun[];
  onRename: (id: string, name: string) => void;
  onToggleOverlay: (id: string, overlay: boolean) => void;
  onToggleFavorite: (id: string, favorite: boolean) => void;
  onSetActive: (id: string) => void;
  onRemove: (id: string) => void;
  onLoad: (run: MomentumSavedRun) => void;
}) {
  const [compareId, setCompareId] = useState('');
  const current = runs[0];
  const comparison = runs.find((run) => run.id === compareId && run.id !== current?.id) ?? runs[1];
  // Shares the Weekly signal tab's endpoint rather than threading its status down through
  // props — cheap to poll and keeps this view self-contained.
  const { data: status } = usePolledResource<MomentumWeeklyStatus>('/api/momentum/weekly/status');

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Saved strategies"
          description="Favourite strategies run every weekly cycle. Only the active favourite is sent to Telegram."
        />
        {runs.length === 0 ? (
          <p className="text-sm text-muted">Run a backtest to start a comparison.</p>
        ) : null}
        {runs.map((run, index) => {
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
                  value={run.name}
                  maxLength={64}
                  onChange={(event) => onRename(run.id, event.target.value)}
                  className="min-w-48 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                />
                <span className="text-xs text-muted">
                  CAGR {metric(run, 'cagr')} · DD {metric(run, 'max_drawdown')} · Sharpe{' '}
                  {metric(run, 'sharpe')}
                  {typeof run.config.start === 'string' ? ` · Start ${run.config.start}` : ''}
                </span>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" onClick={() => onLoad(run)}>
                    Load settings
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onRemove(run.id)}>
                    Remove
                  </Button>
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
            actions={
              <select
                aria-label="Compare current run with"
                value={comparison.id}
                onChange={(event) => setCompareId(event.target.value)}
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
              >
                {runs.slice(1).map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.name}
                  </option>
                ))}
              </select>
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
          <h3 className="mb-2 mt-5 text-sm font-semibold">Settings that differ</h3>
          <div className="space-y-1 text-xs text-muted">
            {Object.keys(current.config)
              .filter(
                (key) =>
                  JSON.stringify(current.config[key]) !== JSON.stringify(comparison.config[key]),
              )
              .map((key) => (
                <p key={key}>
                  <span className="font-semibold text-foreground">{key.replaceAll('_', ' ')}:</span>{' '}
                  {JSON.stringify(current.config[key])} → {JSON.stringify(comparison.config[key])}
                </p>
              ))}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
