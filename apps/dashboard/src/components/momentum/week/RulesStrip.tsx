'use client';

import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';
import { formatDay, formatIstDateTime, formatPct, formatPp } from '../../../lib/format';
import type { MomentumLiveRules } from '../../../types/momentum';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Skeleton } from '../../ui/Skeleton';

const TRAILING_VALUE: Record<string, string> = {
  ok: 'within limits',
  breach: 'behind: review',
  pending: 'not enough weeks',
  unmeasurable: 'not measurable yet',
};

function Gauge({
  fill,
  tone,
  marks,
}: {
  /** 0–1 of the track. */
  fill: number;
  tone: 'primary' | 'warning' | 'negative';
  marks: Array<{ at: number; label: string }>;
}) {
  const bar = { primary: 'bg-primary', warning: 'bg-warning', negative: 'bg-negative' }[tone];
  return (
    <div className="relative mb-4 mt-2 h-2 rounded bg-surface-2">
      <div
        className={cn('h-2 rounded', bar)}
        style={{ width: `${Math.min(1, Math.max(0, fill)) * 100}%` }}
      />
      {marks.map((mark) => (
        <span
          key={mark.label}
          className="absolute -top-1 bottom-[-4px]"
          style={{ left: `${mark.at * 100}%` }}
        >
          <span className="block h-4 w-0.5 bg-foreground/50" />
          <span className="metric absolute top-4 -translate-x-1/2 whitespace-nowrap text-[10px] text-faint">
            {mark.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function Cell({
  label,
  value,
  tone,
  children,
}: { label: string; value: string; tone?: string | undefined; children?: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 basis-56 border-border px-4 py-3 sm:border-r last:border-r-0">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-faint">{label}</div>
      <div
        className={cn(
          'mt-1 font-semibold',
          /\d/.test(value) ? 'metric text-xl' : 'text-sm text-foreground',
          tone,
        )}
      >
        {value}
      </div>
      {children}
    </div>
  );
}

/**
 * The owner's live-money rules (BL-025) as the 21:30 check last measured them: the money gate,
 * drawdown against the cut and exit lines, paper against backtest, and the benchmark. "Check
 * now" re-runs the check here without sending anything.
 */
export function RulesStrip({
  rules,
  loading,
  onCheck,
}: {
  rules: MomentumLiveRules | null;
  loading: boolean;
  onCheck: () => void;
}) {
  const report = rules?.report ?? null;
  const checking = rules?.job?.status === 'running';
  const n = report?.numbers ?? {};
  const needs = report?.findings.filter((f) => f.needs_you) ?? [];
  const trailing = report?.findings.find((f) => f.rule === 'trailing');
  return (
    <Card flush>
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">
          Live-money rules
        </span>
        {report ? (
          needs.length ? (
            <Badge tone="negative" dot>
              {needs.length === 1 ? needs[0]?.title : `${needs.length} need you`}
            </Badge>
          ) : (
            <Badge tone="positive">All clear</Badge>
          )
        ) : null}
        <span className="text-xs text-muted">
          {report
            ? `${report.stage === 'paper' ? 'Paper' : 'Live'} · checked ${formatIstDateTime(report.checked_at)}${report.week ? ` · data to ${formatDay(report.week)}` : ''}${report.stale ? ` · stale, should reach ${formatDay(report.stale)}` : ''}`
            : loading
              ? null
              : 'Not checked yet: the check runs Fridays at 21:30.'}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onCheck} loading={checking}>
          {checking ? null : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
          {checking ? 'Checking…' : 'Check now'}
        </Button>
      </div>
      {rules?.job?.status === 'failed' ? (
        <p className="px-4 pt-2 text-xs text-negative">The check failed: {rules.job.error}</p>
      ) : null}
      {report && n.weeks !== undefined ? (
        <div className="flex flex-wrap">
          <Cell label="Money gate" value={`${n.weeks} / ${n.min_paper_weeks ?? '?'} weeks`}>
            <Gauge fill={(n.weeks ?? 0) / (n.min_paper_weeks || 1)} tone="primary" marks={[]} />
            <p className="text-xs text-muted">
              and must beat {n.must_beat}, with no drawdown rule hit
            </p>
          </Cell>
          <Cell
            label="Drawdown from peak"
            value={formatPct(n.drawdown ?? null)}
            tone={(n.drawdown ?? 0) < 0 ? 'text-negative' : undefined}
          >
            <Gauge
              fill={-(n.drawdown ?? 0) / (n.exit_at || 1)}
              tone={(n.drawdown ?? 0) <= -(n.cut_half_at ?? 1) ? 'negative' : 'warning'}
              marks={[
                {
                  at: (n.cut_half_at ?? 0) / (n.exit_at || 1),
                  label: `−${formatPct(n.cut_half_at ?? null, 0)} cut`,
                },
                { at: 1, label: `−${formatPct(n.exit_at ?? null, 0)} exit` },
              ]}
            />
            <p className="text-xs text-muted">worst so far {formatPct(n.worst_drawdown ?? null)}</p>
          </Cell>
          <Cell
            label={`Paper vs backtest, ${n.trailing_window_weeks ?? 13} wk`}
            value={TRAILING_VALUE[trailing?.level ?? 'unmeasurable'] ?? '—'}
          >
            <p className="mt-2 text-xs text-muted">{trailing?.detail}</p>
          </Cell>
          <Cell
            label={`vs ${n.must_beat ?? 'benchmark'}`}
            value={formatPp((n.return ?? 0) - (n.benchmark_return ?? 0))}
            tone={(n.return ?? 0) >= (n.benchmark_return ?? 0) ? 'text-positive' : 'text-negative'}
          >
            <p className="mt-2 text-xs text-muted">
              paper {formatPct(n.return ?? null)} · benchmark{' '}
              {formatPct(n.benchmark_return ?? null)}
            </p>
          </Cell>
        </div>
      ) : report ? (
        <ul className="space-y-1 px-4 py-3 text-sm">
          {report.findings.map((f) => (
            <li key={f.rule}>
              <span className="font-medium text-foreground">{f.title}</span>{' '}
              <span className="text-muted">{f.detail}</span>
            </li>
          ))}
        </ul>
      ) : loading ? (
        <div className="flex gap-4 px-4 py-3">
          <Skeleton className="h-12 flex-1" />
          <Skeleton className="h-12 flex-1" />
          <Skeleton className="h-12 flex-1" />
        </div>
      ) : (
        <div className="h-3" />
      )}
      {needs.some((f) => f.action) ? (
        <div className="border-t border-border px-4 py-2 text-xs text-foreground">
          {needs.map((f) => (f.action ? <p key={f.rule}>Your action: {f.action}</p> : null))}
        </div>
      ) : null}
    </Card>
  );
}
