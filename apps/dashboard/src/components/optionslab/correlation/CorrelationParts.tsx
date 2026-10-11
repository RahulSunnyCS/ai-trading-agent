'use client';

import { useMemo, useState } from 'react';

import { useCorrelationPick } from '../../../hooks/useLegwise';
import { type PairReadout, driftPoints } from '../../../lib/correlationView';
import {
  EMPTY,
  formatDay,
  formatInr,
  formatInt,
  formatMultiple,
  formatNumber,
  formatPct,
} from '../../../lib/format';
import type {
  CorrelationBasketStats,
  CorrelationMeasure,
  CorrelationResponse,
  CorrelationRollingRow,
} from '../../../types/legwise';
import { Badge } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { NumberField, Select } from '../../ui/Input';
import { SkeletonRows } from '../../ui/Skeleton';
import { StateMessage } from '../../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../../ui/Table';

// ---------------------------------------------------------------------------
// One pair, in words
// ---------------------------------------------------------------------------

function share(value: number | null): string {
  return value === null ? EMPTY : formatPct(value, 0);
}

export function PairCard({ pair, pinned }: { pair: PairReadout | null; pinned: boolean }) {
  if (pair === null) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted">
        Point at a cell, or use the arrow keys, to see two strategies side by side. Click to keep
        it.
      </p>
    );
  }
  if (pair.a === pair.b) {
    return (
      <div className="rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-sm">
        <p className="font-mono text-foreground">{pair.a}</p>
        <p className="mt-1 text-muted">
          The diagonal: a strategy against itself. It lost money on {formatInt(pair.daysALost)} of{' '}
          {formatInt(pair.days)} days.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-surface-2/60 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-foreground">
          {pair.a} <span className="text-faint">~</span> {pair.b}
        </p>
        {pinned ? <Badge tone="neutral">Kept</Badge> : null}
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-3">
        {[
          ['Daily P&L', pair.pearson],
          ['Rank', pair.spearman],
          ['Loss days', pair.lossCorr],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <dt className="text-xs uppercase tracking-wider text-faint">{String(label)}</dt>
            <dd className="font-mono text-base text-foreground">
              {formatNumber(value as number | null, 2)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-muted">
        When <span className="font-mono">{pair.a}</span> lost,{' '}
        <span className="font-mono">{pair.b}</span> lost too on {share(pair.bLostWhenALost)} of
        those days. The other way round: {share(pair.aLostWhenBLost)}. They lost together on{' '}
        {formatInt(pair.daysBothLost)} of {formatInt(pair.days)} days.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Each strategy
// ---------------------------------------------------------------------------

export function StrategyTable({
  r,
  order,
  average,
}: {
  r: CorrelationResponse;
  /** Display order (indexes into r.names). */
  order: readonly number[];
  /** Mean correlation to the others, by original index. */
  average: readonly (number | null)[];
}) {
  return (
    <Table maxHeight={420} stickyFirstCol>
      <THead>
        <Th>Strategy</Th>
        <Th align="right">Net (1 lot)</Th>
        <Th align="right">Max drawdown</Th>
        <Th align="right">Worst day</Th>
        <Th align="right">Loss days</Th>
        <Th align="right">Alike to others</Th>
      </THead>
      <tbody>
        {order.map((i) => {
          const name = r.names[i] ?? '';
          const p = r.parts[name];
          return (
            <TRow key={name}>
              <Td className="max-w-[16rem] truncate font-mono text-xs" title={name}>
                {name}
                {r.kinds[i] === 'legwise' ? (
                  <span className="ml-1.5 text-[10px] text-faint">live</span>
                ) : null}
              </Td>
              <Td align="right" numeric>
                {formatInr(p?.net, { compact: true })}
              </Td>
              <Td align="right" numeric>
                {formatInr(p?.max_dd, { compact: true })}
              </Td>
              <Td align="right" numeric>
                {formatInr(p?.worst_day, { compact: true })}
              </Td>
              <Td align="right" numeric>
                {formatPct(p?.loss_day_share, 0)}
              </Td>
              <Td align="right" numeric>
                {formatNumber(average[i] ?? null, 2)}
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Drift: the pairwise correlation block by block
// ---------------------------------------------------------------------------

const DRIFT_W = 640;
const DRIFT_H = 190;
const PAD = { l: 34, r: 12, t: 10, b: 26 };

export function DriftChart({
  rows,
  window,
}: { rows: readonly CorrelationRollingRow[]; window: number }) {
  const pts = useMemo(() => driftPoints(rows), [rows]);
  if (pts.length < 2) {
    return (
      <p className="text-sm text-muted">
        Fewer than two {window}-day blocks in this window, so there is no drift to show.
      </p>
    );
  }
  const x = (i: number) => PAD.l + (i * (DRIFT_W - PAD.l - PAD.r)) / (pts.length - 1);
  const y = (v: number) => PAD.t + ((1 - v) / 2) * (DRIFT_H - PAD.t - PAD.b);
  const have = pts.every((p) => p.mean !== null && p.min !== null && p.max !== null);
  const band = have
    ? [
        ...pts.map((p, i) => `${x(i)},${y(p.max as number)}`),
        ...[...pts].reverse().map((p, i) => `${x(pts.length - 1 - i)},${y(p.min as number)}`),
      ].join(' ')
    : '';
  const line = have ? pts.map((p, i) => `${x(i)},${y(p.mean as number)}`).join(' ') : '';
  return (
    <svg
      viewBox={`0 0 ${DRIFT_W} ${DRIFT_H}`}
      role="img"
      aria-label="Average pairwise correlation by block, with the range between the most and least alike pair"
      className="h-auto w-full max-w-3xl"
    >
      {[1, 0, -1].map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={DRIFT_W - PAD.r} y1={y(v)} y2={y(v)} className="stroke-border" />
          <text
            x={PAD.l - 6}
            y={y(v)}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-faint text-[10px]"
          >
            {v}
          </text>
        </g>
      ))}
      {band ? <polygon points={band} className="fill-primary/15" /> : null}
      {line ? (
        <polyline points={line} fill="none" strokeWidth={2} className="stroke-primary" />
      ) : null}
      {pts.map((p, i) => (
        <g key={p.label}>
          {p.mean !== null ? (
            <circle cx={x(i)} cy={y(p.mean)} r={3} className="fill-primary" />
          ) : null}
          <text x={x(i)} y={DRIFT_H - 8} textAnchor="middle" className="fill-faint text-[10px]">
            {formatDay(p.label).slice(3)}
          </text>
        </g>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// A basket whose members are not alike
// ---------------------------------------------------------------------------

function BasketLine({ label, s }: { label: string; s: CorrelationBasketStats }) {
  return (
    <TRow>
      <Td>{label}</Td>
      <Td align="right" numeric>
        {formatInr(s.net, { compact: true })}
      </Td>
      <Td align="right" numeric>
        {formatInr(s.max_dd, { compact: true })}
      </Td>
      <Td align="right" numeric>
        {formatInr(s.worst_day, { compact: true })}
      </Td>
      <Td align="right" numeric>
        {s.dd_ratio === null ? EMPTY : formatMultiple(s.dd_ratio, 2)}
      </Td>
    </TRow>
  );
}

interface Applied {
  k: number;
  maxCorr: number;
  require: string[];
}

function BasketResult({
  selectors,
  applied,
  measure,
  range,
}: {
  selectors: string;
  applied: Applied;
  measure: CorrelationMeasure;
  range: { from?: string | undefined; to?: string | undefined };
}) {
  const res = useCorrelationPick({
    selectors,
    k: applied.k,
    maxCorr: applied.maxCorr,
    measure,
    require: applied.require,
    from: range.from,
    to: range.to,
  });
  if (res.error) {
    return (
      <StateMessage variant="error" title="Could not build a basket" description={res.error} />
    );
  }
  if (res.data === null) return <SkeletonRows rows={4} />;
  const b = res.data;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {b.names.map((n) => (
          <Badge key={n} tone="info">
            <span className="font-mono">{n}</span>
          </Badge>
        ))}
        {b.short ? (
          <Badge tone="warning">
            only {b.names.length} of {b.wanted}: nothing else is below the cap
          </Badge>
        ) : null}
      </div>
      <Table>
        <THead>
          <Th>Basket</Th>
          <Th align="right">Net</Th>
          <Th align="right">Max drawdown</Th>
          <Th align="right">Worst day</Th>
          <Th align="right">vs parts</Th>
        </THead>
        <tbody>
          <BasketLine label="Not alike" s={b.stats} />
          <BasketLine label="Best ranked, no cap" s={b.uncapped} />
        </tbody>
      </Table>
      {b.skipped.length > 0 ? (
        <p className="text-xs text-muted">
          Left out for being too alike:{' '}
          {b.skipped
            .slice(0, 5)
            .map(([name, blocker, c]) => `${name} (${formatNumber(c, 2)} with ${blocker})`)
            .join(', ')}
          {b.skipped.length > 5 ? `, and ${b.skipped.length - 5} more` : ''}.
        </p>
      ) : null}
      <p className="text-xs text-faint">
        Chosen and measured on the same {formatInt(b.n_days)} days, so it looks better than it will.
        A description of this window, not a test.
      </p>
    </div>
  );
}

export function BasketBuilder({
  selectors,
  names,
  measure,
  range,
}: {
  selectors: string;
  names: readonly string[];
  measure: CorrelationMeasure;
  range: { from?: string | undefined; to?: string | undefined };
}) {
  const [k, setK] = useState(3);
  const [cap, setCap] = useState(0.6);
  const [required, setRequired] = useState<string[]>([]);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [version, setVersion] = useState(0);
  const usable = required.filter((n) => names.includes(n));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1 text-xs text-muted">
          How many
          <NumberField
            value={k}
            min={1}
            max={20}
            onChange={setK}
            aria-label="How many strategies"
          />
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted">
          Keep pairs below
          <NumberField
            value={cap}
            min={-0.9}
            max={1}
            onChange={setCap}
            aria-label="Keep pairs below this correlation"
          />
        </div>
        <div className="col-span-2 flex flex-col gap-1 text-xs text-muted sm:col-span-1">
          Must include
          <Select
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v && !required.includes(v)) setRequired([...required, v]);
            }}
            aria-label="Add a strategy the basket must include"
          >
            <option value="">Add…</option>
            {names
              .filter((n) => !required.includes(n))
              .map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
          </Select>
        </div>
      </div>
      {usable.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {usable.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRequired(required.filter((x) => x !== n))}
              className="rounded-full bg-surface-2 px-2.5 py-0.5 font-mono text-xs text-foreground ring-1 ring-inset ring-border hover:ring-border-strong"
              title="Remove from the must-include list"
            >
              {n} ×
            </button>
          ))}
        </div>
      ) : null}
      <Button
        variant="primary"
        size="sm"
        onClick={() => {
          setApplied({ k, maxCorr: cap, require: usable });
          setVersion((v) => v + 1);
        }}
      >
        Build a basket
      </Button>
      {applied ? (
        <BasketResult
          key={version}
          selectors={selectors}
          applied={applied}
          measure={measure}
          range={range}
        />
      ) : (
        <p className="text-xs text-muted">
          Picks the best-ranked strategies one at a time and skips any that is alike (above the cap)
          to one already kept. Uses the same strategies and dates as the grid.
        </p>
      )}
    </div>
  );
}
