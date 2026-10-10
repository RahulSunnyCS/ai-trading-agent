'use client';

/**
 * Rotation › "Why this pick?": for one list on one day, why each pick is in the basket.
 *
 * The journal keeps each list's picks and their composites, not the 298-wide breakdown, so this
 * widget shows the breakdown REBUILT by `GET /legwise/rotation/explain` from the stored results
 * before the day, the way the 09:16 ranking computes it, and says whether the rebuild reproduces
 * the journal entry. Nothing here changes a pick; it only explains one.
 */

import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useRotationExplain } from '../../hooks/useRotationExplain';
import { EMPTY, formatDay, formatInr, formatInt, formatNumber, formatPct } from '../../lib/format';
import {
  CRITERIA,
  CRITERION_FILL,
  CRITERION_HINT,
  CRITERION_LABEL,
  CRITERION_SHORT,
  LIST_KEYS,
  type ProvenanceFlag,
  boundaryLines,
  orderedRows,
  provenanceFlags,
  roleLabel,
  snapDay,
  stackSegments,
  stepDay,
  supportOf,
  whyLine,
} from '../../lib/rotationExplainView';
import type {
  RotationExplain,
  RotationListKey,
  RotationVariantRow,
} from '../../types/rotationExplain';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { Input } from '../ui/Input';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

const LIST_OPTIONS = LIST_KEYS.map((value) => ({ value, label: value }));

// ---------------------------------------------------------------------------
// Small parts
// ---------------------------------------------------------------------------

/** The composite as a 0..1 track with one slice per criterion. */
export function CompositeBar({ row }: { row: RotationVariantRow }) {
  const segments = stackSegments(row);
  const text = segments.map((s) => `${s.label} ${formatNumber(s.contribution, 3)}`).join(', ');
  return (
    <div
      role="img"
      aria-label={`Composite ${formatNumber(row.composite, 3)}: ${text}`}
      title={`${formatNumber(row.composite, 4)} = ${text}`}
      className="flex h-2.5 w-full min-w-[96px] overflow-hidden rounded-full bg-surface-2"
    >
      {segments.map((s) => (
        <span
          key={s.key}
          className={CRITERION_FILL[s.key]}
          style={{ width: `${s.widthPct}%` }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

function Legend({ weights }: { weights: Record<string, number> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      {CRITERIA.filter((k) => (weights[k] ?? 0) > 0).map((k) => (
        <li key={k} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${CRITERION_FILL[k]}`} aria-hidden="true" />
          {CRITERION_LABEL[k]} {formatPct(weights[k] ?? 0, 0)}
        </li>
      ))}
    </ul>
  );
}

function Flag({ flag }: { flag: ProvenanceFlag }) {
  return (
    <span className="inline-flex items-center gap-1" title={flag.detail}>
      <Badge tone={flag.tone}>{flag.label}</Badge>
    </span>
  );
}

function slotLabel(r: { index: string; family: string; slot: string }): string {
  return `${r.index === 'NIFTY' ? 'N' : 'S'} ${r.family} ${r.slot}`;
}

// ---------------------------------------------------------------------------
// The picks and the nearest alternatives
// ---------------------------------------------------------------------------

function RankingTable({
  rows,
  selected,
  onSelect,
  recorded,
  boundary,
}: {
  boundary: RotationExplain['boundary'];
  rows: RotationVariantRow[];
  selected: string | null;
  onSelect: (variant: string) => void;
  recorded: RotationExplain['recorded'];
}) {
  return (
    <Table maxHeight={360} stickyFirstCol>
      <THead>
        <Th dense>Strategy</Th>
        <Th dense align="right">
          Rank
        </Th>
        <Th dense align="right">
          Composite
        </Th>
        <Th dense>Made of</Th>
        <Th dense>Role</Th>
      </THead>
      <tbody>
        {rows.map((r) => {
          const kept = recorded?.composite[r.variant];
          return (
            <TRow
              key={r.variant}
              onClick={() => onSelect(r.variant)}
              selected={r.variant === selected}
            >
              <Td dense className="max-w-[12rem] truncate font-mono text-xs" title={r.variant}>
                {r.variant}
              </Td>
              <Td
                dense
                align="right"
                numeric
                title={r.pool_rank ? `Rank among non-Buy: ${r.pool_rank}` : undefined}
              >
                {formatInt(r.rank)}
              </Td>
              <Td
                dense
                align="right"
                numeric
                title={
                  kept === undefined ? undefined : `The journal recorded ${formatNumber(kept, 4)}`
                }
              >
                {formatNumber(r.composite, 3)}
              </Td>
              <Td dense className="w-40">
                <CompositeBar row={r} />
              </Td>
              <Td dense className="whitespace-nowrap text-xs text-muted">
                {roleLabel(r, boundary)}
              </Td>
            </TRow>
          );
        })}
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// One pick, criterion by criterion
// ---------------------------------------------------------------------------

function CriterionTable({ row, data }: { row: RotationVariantRow; data: RotationExplain }) {
  const lookbacks = data.list_info.lookbacks;
  const shown = CRITERIA.filter((k) => data.list_info.weights[k] > 0 || k === 'rfam');
  return (
    <Table>
      <THead>
        <Th dense>Criterion</Th>
        <Th dense align="right" title="The criterion's value in rupees for one lot">
          ₹ / lot
        </Th>
        {lookbacks.map((l) => (
          <Th
            dense
            align="right"
            key={l.days}
            title={`Matching days in the last ${l.days} days; weight ${formatPct(l.weight, 0)}`}
          >
            {l.days}d
          </Th>
        ))}
        <Th
          dense
          align="right"
          title="Rank among all variants on this criterion (100% is the best)"
        >
          Pctl
        </Th>
        <Th dense align="right">
          Wt
        </Th>
        <Th dense align="right" title="Weight × percentile; the points add up to the composite">
          Pts
        </Th>
      </THead>
      <tbody>
        {shown.map((k) => {
          const c = row.criteria[k];
          const sup = supportOf(c);
          const off = (data.list_info.weights[k] ?? 0) <= 0;
          return (
            <TRow key={k} className={off ? 'opacity-60' : ''}>
              <Td
                dense
                className="whitespace-nowrap"
                title={`${CRITERION_LABEL[k]}: ${CRITERION_HINT[k]}${c.group ? ` Family band ${c.group}.` : ''}`}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${CRITERION_FILL[k]}`}
                    aria-hidden="true"
                  />
                  {CRITERION_SHORT[k]}
                </span>
              </Td>
              <Td dense align="right" numeric className="whitespace-nowrap">
                {formatInr(c.value, { sign: true })}
              </Td>
              {lookbacks.map((l, i) => {
                const w = c.windows?.[i];
                if (!w) {
                  return (
                    <Td dense align="right" numeric key={l.days} className="text-faint">
                      {EMPTY}
                    </Td>
                  );
                }
                return (
                  <Td
                    dense
                    align="right"
                    numeric
                    key={l.days}
                    className={w.matching_days === 0 ? 'text-faint' : ''}
                    title={
                      w.matching_days === 0
                        ? `No matching day in the last ${l.days}: this window is left out of the blend`
                        : `${w.matching_days} matching days, mean ${formatInr(w.mean)} per lot, adds ${formatInr(w.part)} to the fit`
                    }
                  >
                    {formatInt(w.matching_days)}
                  </Td>
                );
              })}
              <Td dense align="right" numeric>
                {formatPct(c.pct, 0)}
              </Td>
              <Td dense align="right" numeric>
                {formatPct(c.weight, 0)}
              </Td>
              <Td
                dense
                align="right"
                numeric
                title={sup?.thin && !off ? 'Few matching days: thin support' : undefined}
              >
                {formatNumber(c.contribution, 3)}
                {sup?.thin && !off ? <span className="ml-1 text-warning">!</span> : null}
              </Td>
            </TRow>
          );
        })}
        <TRow>
          <Td dense className="font-medium">
            Composite
          </Td>
          <Td dense>{null}</Td>
          {lookbacks.map((l) => (
            <Td dense key={l.days}>
              {null}
            </Td>
          ))}
          <Td dense>{null}</Td>
          <Td dense align="right" numeric>
            {formatPct(1, 0)}
          </Td>
          <Td dense align="right" numeric className="font-medium">
            {formatNumber(row.composite, 3)}
          </Td>
        </TRow>
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

function Body({
  data,
  selected,
  onSelect,
}: {
  data: RotationExplain;
  selected: string | null;
  onSelect: (variant: string) => void;
}) {
  const rows = useMemo(() => orderedRows(data.picks, data.top), [data]);
  const current = rows.find((r) => r.variant === selected) ?? data.picks[0] ?? rows[0] ?? null;
  const lines = boundaryLines(data.boundary);
  const flags = provenanceFlags(data);
  const ctx = data.context;
  const rec = data.reconstruction;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {flags.map((f) => (
          <Flag key={f.id} flag={f} />
        ))}
        <span className="text-xs text-muted">
          {ctx.weekday}, VIX {ctx.vix_open === null ? EMPTY : formatNumber(ctx.vix_open, 2)} (
          {ctx.vix_band}), days to expiry NIFTY {ctx.dte.NIFTY} / SENSEX {ctx.dte.SENSEX}
        </span>
        <span className="text-xs text-faint">
          from {formatInt(data.history.days)} earlier days, {formatDay(data.history.from)} to{' '}
          {formatDay(data.history.to)}
        </span>
      </div>

      {rec.source === 'recorded' && rec.max_abs_diff !== null ? (
        <p className="text-xs text-muted">
          Checked against the entry: largest composite difference{' '}
          {formatNumber(rec.max_abs_diff, 4)}
          {rec.inputs_match === null
            ? ''
            : rec.inputs_match
              ? ', the stored results are unchanged since it was written.'
              : ', and the stored results have changed since it was written.'}
        </p>
      ) : null}

      {data.warnings.map((w) => (
        <StateMessage key={w} variant="error" title="Check this day" description={w} />
      ))}

      {data.scored === null ? (
        <p className="text-xs text-muted">
          Not scored: the day's results are not stored yet, so no outcome is shown.
        </p>
      ) : null}

      <Legend weights={data.list_info.weights} />

      <RankingTable
        rows={rows}
        selected={current?.variant ?? null}
        onSelect={onSelect}
        recorded={data.recorded}
        boundary={data.boundary}
      />

      {current ? (
        <div className="space-y-2 rounded-lg border border-border bg-surface-2/60 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-mono text-sm text-foreground">
              {current.variant}{' '}
              <span className="text-xs text-muted">
                {slotLabel(current)} · rank {formatInt(current.rank)}
                {data.scored?.picked_gross[current.variant] !== undefined
                  ? ` · gross ${formatInr(data.scored.picked_gross[current.variant], { sign: true })} per lot`
                  : ''}
              </span>
            </p>
            <p className="text-xs text-muted">{whyLine(current)}</p>
          </div>
          <CriterionTable row={current} data={data} />
          <p className="text-xs text-faint">
            Percentiles rank this variant among all {formatInt(data.n_variants)}; points are weight
            × percentile and add up to the composite. A window with no matching day is left out and
            the others are re-weighted. All figures are one lot, gross.
          </p>
        </div>
      ) : null}

      <ul className="space-y-1.5">
        {lines.map((l) => (
          <li key={l.id} className="grid grid-cols-[7.5rem_1fr] items-start gap-2 text-sm">
            <Badge tone={l.tone} className="justify-center whitespace-nowrap">
              {l.id === 'override' ? 'Widesl minimum' : l.id === 'excluded' ? 'Boundary' : 'Buy'}
            </Badge>
            <span className="text-muted">{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RotationWhyThisPick({
  list,
  onList,
}: {
  list: RotationListKey;
  onList: (list: RotationListKey) => void;
}) {
  const [day, setDay] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const res = useRotationExplain(day, list);
  const data = res.data;
  const days = data?.available.days ?? [];
  const shownDay = data?.day ?? day ?? '';

  function go(next: string | null): void {
    if (next) {
      setDay(next);
      setSelected(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Why this pick?"
        description="Each criterion's value, percentile, weight and points, with the days behind every fit."
        actions={
          <SegmentedControl
            value={list}
            options={LIST_OPTIONS}
            onChange={(next) => {
              onList(next);
              setSelected(null);
            }}
            ariaLabel="List"
            size="sm"
          />
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Previous day"
          disabled={!data || days.length === 0}
          onClick={() => go(stepDay(days, shownDay, -1))}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Input
          type="date"
          className="w-40"
          aria-label="Day to explain"
          value={shownDay}
          min={data?.available.first ?? undefined}
          max={data?.available.last ?? undefined}
          onChange={(e) => {
            if (!e.target.value) return;
            go(days.length ? snapDay(days, e.target.value) : e.target.value);
          }}
        />
        <Button
          size="icon"
          variant="ghost"
          aria-label="Next day"
          disabled={!data || days.length === 0}
          onClick={() => go(stepDay(days, shownDay, 1))}
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        {data?.available.default ? (
          <Button size="sm" variant="ghost" onClick={() => go(data.available.default)}>
            {data.available.recorded.length > 0 ? 'Latest recorded' : 'Latest day'}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          onClick={res.refetch}
          disabled={res.loading}
          aria-label="Refresh the explanation"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${res.loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
        </Button>
      </div>

      {res.error ? (
        <div className="space-y-3">
          <StateMessage
            variant="error"
            title="This day cannot be explained"
            description={res.error}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={res.refetch}>
              Retry
            </Button>
            {day !== undefined ? (
              <Button size="sm" variant="ghost" onClick={() => setDay(undefined)}>
                Back to the latest day
              </Button>
            ) : null}
          </div>
        </div>
      ) : data === null ? (
        <SkeletonRows rows={6} />
      ) : (
        <div className={res.loading ? 'opacity-60 transition-opacity' : undefined}>
          <Body data={data} selected={selected} onSelect={setSelected} />
        </div>
      )}
    </Card>
  );
}
