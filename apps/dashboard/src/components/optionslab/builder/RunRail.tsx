/**
 * The builder's run rail: date range, live validation, Backtest (with its credit cost beside
 * it), Save, and a summary of the latest run. Sticky beside the form from `xl`.
 */

import { FlaskConical, Save } from 'lucide-react';
import type { ReactNode } from 'react';

import type { LegwiseValidateState } from '../../../hooks/useLegwiseValidate';
import { formatInt, formatPnl } from '../../../lib/format';
import {
  type PlacedIssues,
  backtestLabel,
  runTotals,
  shortRunId,
  sparkline,
} from '../../../lib/legwiseBuilder';
import { PERIOD_LABEL, type PeriodKey } from '../../../lib/legwiseGrid';
import { type BaselineComparison, statsOf } from '../../../lib/legwiseStats';
import type { BacktestResponse } from '../../../types/legwise';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { CopyButton } from '../../ui/CopyButton';
import { Input } from '../../ui/Input';
import { pnlClass } from '../shared';
import { LabeledField } from './fields';

const SPARK_W = 240;
const SPARK_H = 48;

function Sparkline({ values }: { values: number[] }) {
  const line = sparkline(values, SPARK_W, SPARK_H);
  if (!line.path) return null;
  const last = values[values.length - 1] ?? 0;
  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      className={`h-12 w-full ${pnlClass(last)}`}
      role="img"
      aria-label={`Cumulative P&L per lot, ending at ${formatPnl(last)}`}
    >
      {line.zeroY !== null && (
        <line
          x1={0}
          x2={SPARK_W}
          y1={line.zeroY}
          y2={line.zeroY}
          className="stroke-border"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={line.path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function ValidationBadge({
  validation,
  count,
}: { validation: LegwiseValidateState; count: number }) {
  if (validation.status === 'checking') return <Badge tone="neutral">Checking…</Badge>;
  if (validation.status === 'valid') return <Badge tone="positive">Valid</Badge>;
  if (validation.status === 'invalid')
    return (
      <Badge tone="negative">{count === 1 ? '1 problem' : `${formatInt(count)} problems`}</Badge>
    );
  return <Badge status="attention">Not checked</Badge>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="metric text-foreground">{children}</span>
    </div>
  );
}

export interface RunSummary {
  result: BacktestResponse;
  lots: number;
  comparison: BaselineComparison | null;
  /** The form has been edited since this run was made. */
  stale: boolean;
}

export function RunRail(props: {
  from: string;
  to: string;
  onFrom: (value: string) => void;
  onTo: (value: string) => void;
  /** The period the dates currently mean (a chip is lit), or null for a custom range. */
  period: PeriodKey | null;
  onPeriod: (key: PeriodKey) => void;
  /** Bar size and whether to run the days the quality gate refused (the CLI's --bars / --include-excluded). */
  bars: '1m' | '5m';
  onBars: (bars: '1m' | '5m') => void;
  includeExcluded: boolean;
  onIncludeExcluded: (on: boolean) => void;
  validation: LegwiseValidateState;
  issues: PlacedIssues;
  payment: { enabled: boolean; balance: number | null };
  running: boolean;
  saving: boolean;
  /** Why Save is unavailable (a bad file name), or null. */
  saveBlocked: string | null;
  onBacktest: () => void;
  onSave: () => void;
  /** What went wrong with the last run or save, already worded for the reader. */
  problem: ReactNode | null;
  summary: RunSummary | null;
}) {
  const { validation, issues, summary } = props;
  const blocked = validation.status === 'invalid' || validation.status === 'checking';
  const pending = props.running || props.saving;
  const totals = summary ? runTotals(summary.result.days, summary.lots) : null;
  const stats = summary ? statsOf(summary.result.days, summary.lots) : null;
  const cmp = summary?.comparison && summary.comparison.shared > 0 ? summary.comparison : null;
  const runId = summary?.result.run_id;

  return (
    <Card className="grid gap-5 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-base font-semibold tracking-tight text-foreground">Run</h2>
          <ValidationBadge validation={validation} count={issues.count} />
        </div>

        <fieldset className="flex flex-wrap items-center gap-1.5">
          <legend className="sr-only">Period</legend>
          {(['3m', '1y', 'all'] as const).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={props.period === key}
              onClick={() => props.onPeriod(key)}
              className={
                props.period === key
                  ? 'rounded-lg border border-primary bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary'
                  : 'rounded-lg border border-border px-2.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-foreground'
              }
            >
              {PERIOD_LABEL[key]}
            </button>
          ))}
        </fieldset>

        <div className="grid grid-cols-2 gap-2">
          <LabeledField label="From (blank = all)">
            <Input
              type="date"
              aria-label="Backtest from"
              value={props.from}
              max={props.to || undefined}
              onChange={(event) => props.onFrom(event.target.value)}
            />
          </LabeledField>
          <LabeledField label="To">
            <Input
              type="date"
              aria-label="Backtest to"
              value={props.to}
              min={props.from || undefined}
              onChange={(event) => props.onTo(event.target.value)}
            />
          </LabeledField>
        </div>

        <details className="rounded-lg border border-border px-3 py-2 text-xs">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            Test settings
            {props.bars !== '1m' || props.includeExcluded ? (
              <span className="ml-1.5 text-primary">
                (
                {[
                  props.bars === '5m' ? '5-minute bars' : '',
                  props.includeExcluded ? 'bad-data days included' : '',
                ]
                  .filter(Boolean)
                  .join(', ')}
                )
              </span>
            ) : null}
          </summary>
          <div className="mt-2 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted">Bars</span>
              <select
                aria-label="Bar size"
                value={props.bars}
                onChange={(event) => props.onBars(event.target.value as '1m' | '5m')}
                className="h-7 rounded border border-border bg-surface px-1.5 text-xs text-foreground"
              >
                <option value="1m">1 minute</option>
                <option value="5m">5 minutes</option>
              </select>
            </div>
            {props.bars === '5m' ? (
              <p className="text-faint">
                5-minute bars decide only on a window's start, so every time must be on a 5-minute
                mark (09:20, not 09:17); closest-premium strikes are not available.
              </p>
            ) : null}
            <label className="flex items-center justify-between gap-3">
              <span className="text-muted">Include days with bad data</span>
              <input
                type="checkbox"
                checked={props.includeExcluded}
                onChange={(event) => props.onIncludeExcluded(event.target.checked)}
              />
            </label>
          </div>
        </details>

        <div className="space-y-2">
          <Button
            variant="primary"
            className="w-full"
            loading={props.running}
            disabled={blocked || pending}
            onClick={props.onBacktest}
          >
            {props.running ? null : <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />}
            {props.running ? 'Running…' : backtestLabel(props.payment)}
          </Button>
          <Button
            className="w-full"
            loading={props.saving}
            disabled={blocked || pending || props.saveBlocked !== null}
            onClick={props.onSave}
          >
            {props.saving ? null : <Save className="h-3.5 w-3.5" aria-hidden="true" />}
            {props.saving ? 'Saving…' : 'Save'}
          </Button>
          <p className="text-xs text-faint">
            {props.payment.enabled
              ? 'Each backtest uses one credit and is kept as an experiment. Checking the form is free.'
              : 'Each backtest is kept as an experiment. Saving adds the strategy to the evening run.'}
          </p>
          {props.saveBlocked && <p className="text-xs text-negative">{props.saveBlocked}</p>}
        </div>

        {validation.status === 'unknown' && (
          <p className="text-xs text-warning">
            The form could not be checked ({validation.error ?? 'validator unreachable'}). A run
            with a mistake in it will be refused
            {props.payment.enabled ? ' and may still use a credit' : ''}.
          </p>
        )}
        {validation.status === 'invalid' && (
          <div className="space-y-1 text-xs">
            {issues.unplaced.map((issue) => (
              <p key={`${issue.path}:${issue.raw}`} className="text-negative">
                {issue.message}
              </p>
            ))}
            {issues.count > issues.unplaced.length && (
              <p className="text-muted">
                {issues.unplaced.length > 0 ? 'The rest are' : 'Problems are'} marked beside their
                fields; fix them to run or save.
              </p>
            )}
          </div>
        )}
        {props.problem && (
          <div
            role="alert"
            className="rounded-lg border border-negative/30 bg-negative/10 p-3 text-xs text-negative"
          >
            {props.problem}
          </div>
        )}
      </div>

      <div className="min-w-0">
        {summary && totals && stats && (
          <div className="space-y-2 lg:border-l lg:border-border lg:pl-5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-faint">
                Latest run
                {summary.result.bars === '5m' ? ' · 5-minute bars' : ''}
                {summary.result.include_excluded ? ' · bad-data days included' : ''}
              </span>
              {summary.stale && <Badge status="attention">Edited since</Badge>}
            </div>
            <div>
              <div
                className={`metric text-2xl font-semibold tracking-tight ${pnlClass(totals.net)}`}
              >
                {formatPnl(totals.net)}
              </div>
              <div className="text-xs text-muted">
                net ₹ per lot over {formatInt(totals.days)} days
              </div>
              {cmp && (
                <div className={`metric mt-1 text-xs font-medium ${pnlClass(cmp.deltaTotal)}`}>
                  Δ {formatPnl(cmp.deltaTotal)} vs saved over {formatInt(cmp.shared)} shared days
                </div>
              )}
            </div>
            <Sparkline values={stats.cumulative.map((point) => point.value)} />
            <Row label="Gross / lot">{formatPnl(totals.gross)}</Row>
            <Row label="Costs / lot">{formatPnl(-totals.costs)}</Row>
            <Row label="Up days">
              {formatInt(stats.up)} / {formatInt(stats.days)}
            </Row>
            {runId && (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted">Run id</span>
                <span className="flex items-center gap-1">
                  <code className="font-mono text-xs text-foreground" title={runId}>
                    {shortRunId(runId)}
                  </code>
                  <CopyButton text={runId} label="Copy run id" />
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
