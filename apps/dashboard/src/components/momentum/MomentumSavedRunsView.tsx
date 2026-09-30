'use client';

import { useState } from 'react';

import type { MomentumSavedRun } from '../../types/momentum';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

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
  onRemove,
  onLoad,
}: {
  runs: MomentumSavedRun[];
  onRename: (id: string, name: string) => void;
  onToggleOverlay: (id: string, overlay: boolean) => void;
  onRemove: (id: string) => void;
  onLoad: (run: MomentumSavedRun) => void;
}) {
  const [compareId, setCompareId] = useState('');
  const current = runs[0];
  const comparison = runs.find((run) => run.id === compareId && run.id !== current?.id) ?? runs[1];

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="Saved runs"
          description="Named results and settings are saved, grouped by dataset."
        />
        {runs.length === 0 ? (
          <p className="text-sm text-muted">Run a backtest to start a comparison.</p>
        ) : null}
        {runs.map((run, index) => (
          <div
            key={run.id}
            className="flex flex-wrap items-center gap-3 border-t border-border py-3"
          >
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
        ))}
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
