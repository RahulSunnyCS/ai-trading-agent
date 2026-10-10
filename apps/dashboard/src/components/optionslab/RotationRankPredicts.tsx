'use client';

/**
 * Rotation › "Does rank predict results?": the daily rank correlation between the morning
 * composite over every variant and that day's realised gross per variant.
 *
 * One value per day, never pooled. The forward days (recorded before the first entry time) are
 * the registered test and are empty until the first scored day; the research window shows the
 * same numbers on history, labelled so, so the chart is useful now. Figures come from
 * `GET /legwise/rotation/ic` (`rotation/rankic.py`). Nothing here changes a list.
 */

import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useRotationIc } from '../../hooks/useRotationExplain';
import { EMPTY, formatDay, formatInr, formatInt, formatPct } from '../../lib/format';
import { tooltipPlacement } from '../../lib/momentumResult';
import {
  type ChartSize,
  type IcBar,
  LIST_KEYS,
  formatIc,
  icDomain,
  icLayout,
  icRows,
  icVerdict,
  nearestBar,
} from '../../lib/rotationExplainView';
import type {
  RotationIc,
  RotationIcDay,
  RotationIcSummary,
  RotationListKey,
} from '../../types/rotationExplain';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StatCard } from '../ui/StatCard';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

const LIST_OPTIONS = LIST_KEYS.map((value) => ({ value, label: value }));

type View = 'forward' | 'research';
type Window = '63' | 'p1' | 'all';

const VIEW_OPTIONS: SegmentedOption<View>[] = [
  { value: 'forward', label: 'Forward days' },
  { value: 'research', label: 'Research days' },
];

const WINDOW_OPTIONS: SegmentedOption<Window>[] = [
  { value: '63', label: 'Last 63' },
  { value: 'p1', label: 'Since Dec 2025' },
  { value: 'all', label: 'All history' },
];

const RANGE: Record<Window, { from?: string }> = {
  '63': {},
  p1: { from: '2025-12-03' },
  all: { from: '2024-01-01' },
};

const SIZE: ChartSize = { width: 640, height: 210, left: 44, right: 12, top: 12, bottom: 26 };
const TIP_W = 230;
const TIP_H = 112;

// ---------------------------------------------------------------------------
// The chart
// ---------------------------------------------------------------------------

function barClass(kind: RotationIcDay['kind']): string {
  return kind === 'forward' ? 'fill-series-2' : kind === 'late' ? 'fill-faint' : 'fill-series-1';
}

const KIND_LABEL: Record<RotationIcDay['kind'], string> = {
  forward: 'Forward day',
  late: 'Late entry, not forward',
  research: 'Research day',
};

function IcChart({ ic, reference }: { ic: RotationIc; reference: number | null }) {
  const layout = useMemo(
    () => icLayout(ic.days, ic.running, SIZE, icDomain(ic.days, ic.running)),
    [ic.days, ic.running],
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<IcBar | null>(null);
  const frame = useRef(0);
  const cursor = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  function place(): void {
    frame.current = 0;
    const host = hostRef.current;
    const tip = tipRef.current;
    const at = cursor.current;
    if (!host || !tip || !at) return;
    const rect = host.getBoundingClientRect();
    const p = tooltipPlacement(
      at,
      { width: tip.offsetWidth || TIP_W, height: tip.offsetHeight || TIP_H },
      { left: 0, top: 0, right: rect.width, bottom: rect.height },
    );
    tip.style.transform = `translate(${p.left}px, ${p.top}px)`;
  }

  function onMove(e: React.MouseEvent<SVGSVGElement>): void {
    const rect = e.currentTarget.getBoundingClientRect();
    const hostRect = hostRef.current?.getBoundingClientRect();
    if (!hostRect || rect.width === 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * SIZE.width;
    setActive(nearestBar(layout, x));
    cursor.current = { x: e.clientX - hostRect.left, y: e.clientY - hostRect.top };
    if (frame.current === 0) frame.current = requestAnimationFrame(place);
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Escape') {
      setActive(null);
      return;
    }
    const i = active ? active.i + (e.key === 'ArrowRight' ? 1 : -1) : layout.bars.length - 1;
    const next = layout.bars[Math.max(0, Math.min(layout.bars.length - 1, i))] ?? null;
    setActive(next);
    const host = hostRef.current;
    if (next && host) {
      const rect = host.getBoundingClientRect();
      cursor.current = {
        x: (next.x / SIZE.width) * rect.width,
        y: (layout.zeroY / SIZE.height) * rect.height,
      };
      if (frame.current === 0) frame.current = requestAnimationFrame(place);
    }
  }

  const day = active ? ic.days[active.i] : null;
  const run = active ? ic.running[active.i] : null;
  const refY = layout.referenceY(reference);

  return (
    <figure
      ref={hostRef}
      className="relative"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart steps through days with the arrow keys
      tabIndex={0}
      onKeyDown={onKey}
      onMouseLeave={() => setActive(null)}
      aria-label="Daily rank correlation of the composite. Arrow keys step through days."
    >
      <svg
        viewBox={`0 0 ${SIZE.width} ${SIZE.height}`}
        className="h-auto w-full"
        onMouseMove={onMove}
        role="img"
        aria-label={`Rank correlation per day over ${ic.n_days} days`}
      >
        {layout.ticks.map((t) => (
          <g key={t}>
            <line
              x1={SIZE.left}
              x2={SIZE.width - SIZE.right}
              y1={layout.yFor(t)}
              y2={layout.yFor(t)}
              className={t === 0 ? 'stroke-border-strong' : 'stroke-border'}
            />
            <text
              x={SIZE.left - 6}
              y={layout.yFor(t)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-faint text-[10px]"
            >
              {formatIc(t)}
            </text>
          </g>
        ))}
        {layout.band ? <polygon points={layout.band} className="fill-primary/15" /> : null}
        {layout.bars.map((b) =>
          b.value === null ? null : (
            <rect
              key={b.day}
              x={b.x}
              y={b.y}
              width={b.width}
              height={Math.max(b.height, 1)}
              className={barClass(b.kind)}
              opacity={active && active.i !== b.i ? 0.5 : 1}
            />
          ),
        )}
        {layout.line ? (
          <polyline
            points={layout.line}
            fill="none"
            strokeWidth={2}
            className="stroke-foreground"
          />
        ) : null}
        {refY !== null ? (
          <g>
            <line
              x1={SIZE.left}
              x2={SIZE.width - SIZE.right}
              y1={refY}
              y2={refY}
              strokeDasharray="5 4"
              strokeWidth={1.5}
              className="stroke-info"
            />
          </g>
        ) : null}
        {ic.days.length > 0 ? (
          <>
            <text x={SIZE.left} y={SIZE.height - 8} className="fill-faint text-[10px]">
              {formatDay(ic.days[0]?.day)}
            </text>
            <text
              x={SIZE.width - SIZE.right}
              y={SIZE.height - 8}
              textAnchor="end"
              className="fill-faint text-[10px]"
            >
              {formatDay(ic.days[ic.days.length - 1]?.day)}
            </text>
          </>
        ) : null}
        {active ? (
          <line
            x1={active.x + active.width / 2}
            x2={active.x + active.width / 2}
            y1={SIZE.top}
            y2={SIZE.height - SIZE.bottom}
            className="stroke-border-strong"
          />
        ) : null}
      </svg>
      {day ? (
        <div
          ref={tipRef}
          className="pointer-events-none absolute left-0 top-0 z-30 w-[230px] rounded-lg border border-border-strong bg-surface px-3 py-2 text-xs shadow-elevated"
        >
          <p className="font-medium text-foreground">{formatDay(day.day)}</p>
          <p className="text-faint">{KIND_LABEL[day.kind]}</p>
          <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5">
            <dt className="text-muted">Composite</dt>
            <dd className="font-mono text-foreground">{formatIc(day.composite)}</dd>
            <dt className="text-muted">Running mean</dt>
            <dd className="font-mono text-foreground">{formatIc(run?.mean)}</dd>
            <dt className="text-muted">Top 30 − bottom 30</dt>
            <dd className="font-mono text-foreground">
              {day.spread === null ? EMPTY : formatInr(day.spread, { sign: true })}
            </dd>
            <dt className="text-muted">Variants scored</dt>
            <dd className="font-mono text-foreground">{formatInt(day.n)}</dd>
          </dl>
        </div>
      ) : null}
    </figure>
  );
}

function Legend({ hasReference }: { hasReference: boolean }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
      <li className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-sm bg-series-1" aria-hidden="true" />
        Research day
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-sm bg-series-2" aria-hidden="true" />
        Forward day
      </li>
      <li className="flex items-center gap-1.5">
        <span className="h-0.5 w-4 bg-foreground" aria-hidden="true" />
        Running mean, with its 95% band
      </li>
      {hasReference ? (
        <li className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 border-t-2 border-dashed border-info" aria-hidden="true" />
          Research mean, list A
        </li>
      ) : null}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function band(s: RotationIcSummary): string {
  return s.lo === null || s.hi === null ? EMPTY : `${formatIc(s.lo)} to ${formatIc(s.hi)}`;
}

function CriterionTable({
  active,
  forward,
  mode,
}: { active: RotationIc; forward: RotationIc | null; mode: View }) {
  const rows = icRows(active);
  const fwd = forward ? icRows(forward) : null;
  const ref = active.reference ?? forward?.reference ?? null;
  const spread = active.summary.spread;
  return (
    <Table>
      <THead>
        <Th dense>Criterion</Th>
        <Th
          dense
          align="right"
          title={mode === 'forward' ? 'Mean over forward days' : 'Mean over the days in the window'}
        >
          Mean
        </Th>
        <Th dense align="right" title="Mean ± 1.96 standard errors over days">
          95% band
        </Th>
        {mode === 'research' ? (
          <Th dense align="right" title="Mean over forward days, once there are any">
            Forward
          </Th>
        ) : null}
        <Th
          dense
          align="right"
          title={
            ref
              ? `${ref.source}, list ${ref.list}, ${formatDay(ref.from)} to ${formatDay(ref.to)}, ${ref.variants} variants`
              : 'Only list A has a research reference'
          }
        >
          Research
        </Th>
      </THead>
      <tbody>
        {rows.map((r, i) => (
          <TRow key={r.key} className={r.key === 'composite' ? 'font-medium' : ''}>
            <Td dense className="whitespace-nowrap">
              {r.label}
            </Td>
            <Td
              dense
              align="right"
              numeric
              title={`Above zero on ${formatPct(r.summary.pos, 0)} of ${formatInt(r.summary.n)} days`}
            >
              {formatIc(r.summary.mean)}
            </Td>
            <Td
              dense
              align="right"
              numeric
              className={`whitespace-nowrap ${r.includesZero === false ? 'text-foreground' : 'text-muted'}`}
              title={r.includesZero ? 'The band includes zero' : undefined}
            >
              {band(r.summary)}
            </Td>
            {mode === 'research' ? (
              <Td dense align="right" numeric title={`${fwd?.[i]?.summary.n ?? 0} forward days`}>
                {fwd && (fwd[i]?.summary.n ?? 0) > 0 ? formatIc(fwd[i]?.summary.mean) : EMPTY}
              </Td>
            ) : null}
            <Td dense align="right" numeric className="text-muted">
              {r.reference === null ? EMPTY : formatIc(r.reference)}
            </Td>
          </TRow>
        ))}
        <TRow>
          <Td
            dense
            className="whitespace-nowrap"
            title={`Mean gross per lot of the ${active.spread_n} best-ranked variants minus the ${active.spread_n} worst`}
          >
            Top {active.spread_n} − bottom {active.spread_n}
          </Td>
          <Td
            dense
            align="right"
            numeric
            title={`Per lot, gross. Above zero on ${formatPct(spread.pos, 0)} of ${formatInt(spread.n)} days`}
          >
            {formatInr(spread.mean, { sign: true })}
          </Td>
          <Td dense align="right" numeric className="whitespace-nowrap text-muted">
            {spread.lo === null || spread.hi === null
              ? EMPTY
              : `${formatInr(spread.lo, { sign: true })} to ${formatInr(spread.hi, { sign: true })}`}
          </Td>
          {mode === 'research' ? (
            <Td dense align="right" numeric>
              {forward && forward.summary.spread.n > 0
                ? formatInr(forward.summary.spread.mean, { sign: true })
                : EMPTY}
            </Td>
          ) : null}
          <Td dense align="right" numeric className="text-muted">
            {EMPTY}
          </Td>
        </TRow>
      </tbody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// The widget
// ---------------------------------------------------------------------------

function windowText(ic: RotationIc): string {
  if (ic.n_days === 0) return 'no days';
  return `${formatInt(ic.n_days)} days to ${formatDay(ic.to)}`;
}

export function RotationRankPredicts({
  list,
  onList,
}: {
  list: RotationListKey;
  onList: (list: RotationListKey) => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [span, setSpan] = useState<Window>('63');
  const forward = useRotationIc(list, 'forward');
  const research = useRotationIc(list, 'research', RANGE[span]);

  const forwardHas = (forward.data?.n_days ?? 0) > 0;
  const mode: View = view ?? (forwardHas ? 'forward' : 'research');
  const active = mode === 'forward' ? forward : research;
  const ic = active.data;
  const ref = (research.data ?? forward.data)?.reference ?? null;
  const refComposite = ref?.values.composite ?? null;
  const st = forward.data?.status;

  function refetch(): void {
    forward.refetch();
    research.refetch();
  }

  return (
    <Card>
      <CardHeader
        title="Does rank predict results?"
        description="Each day, the rank correlation between the morning composite over all variants and that day's realised gross per variant."
        actions={
          <SegmentedControl
            value={list}
            options={LIST_OPTIONS}
            onChange={onList}
            ariaLabel="List"
            size="sm"
          />
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          label="Forward days"
          value={st ? formatInt(st.forward_scored) : EMPTY}
          note={
            st
              ? `${formatInt(st.entries)} recorded${st.late > 0 ? `, ${formatInt(st.late)} late` : ''}${st.forward_waiting.length > 0 ? `, ${formatInt(st.forward_waiting.length)} waiting for results` : ''}`
              : undefined
          }
          hint="Days recorded at 09:16 and scored since. Late entries are shown but never counted."
          loading={forward.data === null && !forward.error}
        />
        <StatCard
          label="Forward composite"
          value={forwardHas ? formatIc(forward.data?.summary.composite.mean) : EMPTY}
          note={
            forward.data
              ? forwardHas
                ? `band ${band(forward.data.summary.composite)}`
                : 'no forward day yet'
              : undefined
          }
          hint="Mean over forward days of the daily rank correlation: 0 means the ranking carries no order, positive means higher-ranked variants did better."
          loading={forward.data === null && !forward.error}
        />
        <StatCard
          label="Research window"
          value={research.data ? formatIc(research.data.summary.composite.mean) : EMPTY}
          note={
            research.data
              ? `${windowText(research.data)}${refComposite !== null ? ` · research ${formatIc(refComposite)}` : ''}`
              : undefined
          }
          hint="The same statistic on history: where the ranking comes from, not a test of it."
          loading={research.data === null && !research.error}
        />
      </div>

      <div className="mb-3 mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            value={mode}
            options={VIEW_OPTIONS}
            onChange={setView}
            ariaLabel="Days to chart"
            size="sm"
          />
          {mode === 'research' ? (
            <SegmentedControl
              value={span}
              options={WINDOW_OPTIONS}
              onChange={setSpan}
              ariaLabel="Research window"
              size="sm"
            />
          ) : (
            <Badge tone="primary">Registered test</Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={refetch}
          disabled={forward.loading || research.loading}
          aria-label="Refresh rank correlation"
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${forward.loading || research.loading ? 'animate-spin' : ''}`}
            aria-hidden="true"
          />
        </Button>
      </div>

      {active.error ? (
        <div className="space-y-3">
          <StateMessage
            variant="error"
            title="Could not compute the rank correlation"
            description={active.error}
          />
          <Button size="sm" onClick={active.refetch}>
            Retry
          </Button>
        </div>
      ) : ic === null ? (
        <SkeletonRows rows={5} />
      ) : ic.n_days === 0 ? (
        <StateMessage
          variant="empty"
          title={mode === 'forward' ? 'No forward day to read yet' : 'No days in this window'}
          description={ic.reason ?? undefined}
        />
      ) : (
        <div className="space-y-3">
          <Legend hasReference={refComposite !== null && mode === 'research'} />
          <IcChart ic={ic} reference={mode === 'research' ? refComposite : null} />
          <p className="text-sm text-muted">{icVerdict(ic.summary.composite)}</p>
          {ic.counts.mismatch > 0 ? (
            <StateMessage
              variant="error"
              title="Some days no longer match their entry"
              description={`${formatInt(ic.counts.mismatch)} day(s) rebuild to different picks than the journal recorded: stored results changed after the entry.`}
            />
          ) : null}
          <CriterionTable active={ic} forward={forward.data} mode={mode} />
          <p className="text-xs text-faint">
            Spearman rank correlation per day across {formatInt(ic.n_variants)} variants, gross, one
            value per day. The band is the mean ± 1.96 standard errors over days; consecutive days
            share look-back windows, so it is a little narrower than it should be. A research day is
            scored on what the ranking would have said then, not on a recorded entry.
          </p>
        </div>
      )}
    </Card>
  );
}
