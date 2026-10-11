'use client';

/**
 * Options Lab › Matrix cell drawer: what a displayed value is made of. The daily values behind
 * the cell, their running total, how they spread, which strategies were pooled with their
 * settings, and the sessions the lists recorded a pick in. Everything is read through
 * `GET /legwise/rotation/matrix/cell`; nothing is computed here but a histogram and a path.
 */

import { type PointerEvent, useMemo, useRef, useState } from 'react';

import { useRotationMatrixCell } from '../../hooks/useRotationMatrix';
import { EMPTY, formatDay, formatInr, formatInt, formatPct } from '../../lib/format';
import { curveGeometry, histogram, stoppedShare, valueText } from '../../lib/rotationMatrixView';
import type { MatrixCellDay, MatrixCellDetail } from '../../types/rotationMatrix';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Drawer } from '../ui/Drawer';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { FollowTip, OverlayStatus } from './RotationMatrixParts';

export interface DrawerRequest {
  title: string;
  subtitle: string;
  /** One section per request: a difference cell opens both periods, each under its own heading. */
  sections: { heading?: string; params: Record<string, string> }[];
}

export function RotationMatrixDrawer({
  request,
  onClose,
}: { request: DrawerRequest | null; onClose: () => void }) {
  return (
    <Drawer
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={request?.title ?? ''}
      subtitle={request?.subtitle}
    >
      {request ? (
        <div className="space-y-8">
          {request.sections.map((section) => (
            <section key={section.heading ?? 'only'} className="space-y-3">
              {section.heading ? (
                <h2 className="text-sm font-semibold text-foreground">{section.heading}</h2>
              ) : null}
              <DrawerBody params={section.params} />
            </section>
          ))}
        </div>
      ) : null}
    </Drawer>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2/60 px-3 py-2">
      <dt className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</dt>
      <dd className="metric mt-0.5 text-sm text-foreground">{value}</dd>
      {note ? <dd className="text-[11px] text-muted">{note}</dd> : null}
    </div>
  );
}

function DrawerBody({ params }: { params: Record<string, string> }) {
  const res = useRotationMatrixCell(params);
  if (res.error && res.data === null) {
    return (
      <div className="space-y-3">
        <StateMessage variant="error" title="Could not open this cell" description={res.error} />
        <Button size="sm" onClick={res.refetch}>
          Retry
        </Button>
      </div>
    );
  }
  if (res.data === null) return <SkeletonRows rows={6} />;
  return <Detail d={res.data} />;
}

const W = 420;
const H = 150;

function Detail({ d }: { d: MatrixCellDetail }) {
  const s = d.stats;
  const empty = d.days.length === 0;
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted">
        Gross per one-lot strategy-day, before costs. {d.pooling}.
      </p>
      {empty ? (
        <StateMessage
          variant="empty"
          title="No days contribute to this cell"
          description="Every result in the period was removed by the filters, or none is stored."
        />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2">
            <Fact
              label="Sessions"
              value={formatInt(s.sessions)}
              note={
                s.all_opportunities
                  ? `of ${formatInt(s.all_opportunities.sessions)} (selected only)`
                  : `${formatInt(s.variant_days)} strategy-days`
              }
            />
            <Fact label="Average" value={valueText(s.avg, 'inr')} note="per strategy-day" />
            <Fact label="Win rate" value={formatPct(s.win_rate, 0)} />
            <Fact label="Stop-hit rate" value={formatPct(s.stop_rate, 0)} />
            <Fact
              label="Worst strategy-day"
              value={formatInr(s.worst, { sign: true })}
              note={s.worst_day ? formatDay(s.worst_day) : undefined}
            />
            <Fact
              label="Best strategy-day"
              value={formatInr(s.best, { sign: true })}
              note={s.best_day ? formatDay(s.best_day) : undefined}
            />
            <Fact
              label="Running total"
              value={formatInr(s.cumulative, { sign: true })}
              note="of the daily values"
            />
            <Fact
              label="Largest drawdown"
              value={formatInr(s.max_drawdown, { sign: true })}
              note="of that running total"
            />
          </dl>
          {s.all_opportunities ? (
            <p className="text-xs text-muted">
              Selected only: {formatInt(s.sessions)} of {formatInt(s.all_opportunities.sessions)}{' '}
              sessions, average {valueText(s.avg, 'inr')}. Over every opportunity the average is{' '}
              {valueText(s.all_opportunities.avg, 'inr')}. The two cover different days.
            </p>
          ) : null}
          {s.zero_trade_days ? (
            <p className="text-xs text-faint">
              {formatInt(s.zero_trade_days)} of these strategy-days had no trades and are counted as
              zero, as the research does.
            </p>
          ) : null}
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-faint">
              Running total by session
            </h3>
            <Curve d={d} />
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-faint">
              Spread of the daily values
            </h3>
            <Histogram days={d.days} />
          </section>
          <section>
            <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-faint">
              Strategies pooled
              <Badge tone="neutral">{formatInt(d.variants_total)}</Badge>
            </h3>
            <Variants d={d} />
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-faint">
              Daily values
            </h3>
            <Days days={d.days} />
          </section>
        </>
      )}
      <OverlayStatus overlay={d.overlay} />
    </div>
  );
}

function Curve({ d }: { d: MatrixCellDetail }) {
  const g = useMemo(() => curveGeometry(d.cumulative, W, H), [d.cumulative]);
  const [at, setAt] = useState<{ i: number; x: number; y: number } | null>(null);
  const box = useRef<SVGSVGElement>(null);
  if (!g) {
    return (
      <p className="text-sm text-muted">Fewer than two sessions: there is no curve to draw.</p>
    );
  }
  const last = d.cumulative.length - 1;
  const xOf = (i: number) => (last === 0 ? 0 : (i * W) / last);
  const yOf = (v: number) => H - ((v - g.min) / (g.max - g.min || 1)) * H;

  function move(event: PointerEvent<SVGSVGElement>) {
    const r = box.current?.getBoundingClientRect();
    if (!r || r.width === 0) return;
    const frac = (event.clientX - r.left) / r.width;
    const i = Math.max(0, Math.min(last, Math.round(frac * last)));
    setAt({ i, x: event.clientX, y: event.clientY });
  }
  const point = at ? d.cumulative[at.i] : undefined;
  const day = at ? d.days[at.i] : undefined;
  return (
    <div>
      <svg
        ref={box}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Running total of the daily gross over ${formatInt(d.cumulative.length)} sessions`}
        className="h-auto w-full cursor-crosshair rounded-md bg-surface-2/40"
        onPointerMove={move}
        onPointerLeave={() => setAt(null)}
      >
        <line
          x1={0}
          x2={W}
          y1={g.zeroY}
          y2={g.zeroY}
          className="stroke-border-strong"
          strokeDasharray="3 3"
        />
        <polyline points={g.path} fill="none" strokeWidth={1.75} className="stroke-series-1" />
        {d.days.map((x, i) =>
          x.picked_by && x.picked_by.length > 0 ? (
            <circle
              key={x.day}
              cx={xOf(i)}
              cy={yOf(d.cumulative[i]?.cum ?? 0)}
              r={3}
              className="fill-foreground"
            />
          ) : null,
        )}
        {at ? (
          <line x1={xOf(at.i)} x2={xOf(at.i)} y1={0} y2={H} className="stroke-border-strong" />
        ) : null}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
        <span>{formatDay(d.cumulative[0]?.day)}</span>
        <span>{formatDay(d.cumulative[last]?.day)}</span>
      </div>
      {d.days.some((x) => x.picked_by?.length) ? (
        <p className="mt-1 text-[11px] text-muted">
          Dots mark sessions a list recorded a pick in this cell.
        </p>
      ) : null}
      <FollowTip cursor={at ? { x: at.x, y: at.y } : null}>
        {point && day ? (
          <div className="space-y-0.5">
            <p className="font-medium">
              {formatDay(day.day)} <span className="text-faint">{day.weekday}</span>
            </p>
            <p className="font-mono">day {valueText(day.gross, 'inr')}</p>
            <p className="font-mono text-muted">total {valueText(point.cum, 'inr')}</p>
            {day.picked_by?.length ? (
              <p className="text-muted">picked by {day.picked_by.join(', ')}</p>
            ) : null}
          </div>
        ) : null}
      </FollowTip>
    </div>
  );
}

function Histogram({ days }: { days: readonly MatrixCellDay[] }) {
  const bins = useMemo(
    () =>
      histogram(
        days.map((d) => d.gross),
        14,
      ),
    [days],
  );
  if (bins.length === 0) return null;
  const top = Math.max(...bins.map((b) => b.count));
  const bw = W / bins.length;
  const share = stoppedShare(days);
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} 90`}
        role="img"
        aria-label="Histogram of the daily values"
        className="h-auto w-full rounded-md bg-surface-2/40"
      >
        {bins.map((b) => {
          const h = top === 0 ? 0 : (b.count / top) * 70;
          const negative = b.hi <= 0;
          return (
            <rect
              key={b.lo}
              x={bins.indexOf(b) * bw + 1}
              y={80 - h}
              width={Math.max(1, bw - 2)}
              height={h}
              rx={1}
              className={
                negative ? 'fill-negative/40' : b.lo >= 0 ? 'fill-positive/40' : 'fill-series-1/40'
              }
            >
              <title>{`${valueText(b.lo, 'inr')} to ${valueText(b.hi, 'inr')}: ${formatInt(b.count)} sessions`}</title>
            </rect>
          );
        })}
        <line x1={0} x2={W} y1={80} y2={80} className="stroke-border-strong" />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-faint">
        <span>{valueText(bins[0]?.lo, 'inr')}</span>
        <span>{valueText(bins[bins.length - 1]?.hi, 'inr')}</span>
      </div>
      {share !== null ? (
        <p className="mt-1 text-[11px] text-muted">
          {formatPct(share, 0)} of the sessions had a strategy end on its stop.
        </p>
      ) : null}
    </div>
  );
}

function Variants({ d }: { d: MatrixCellDetail }) {
  const shown = d.variants;
  return (
    <div>
      <Table maxHeight={220}>
        <THead>
          <Th dense>Strategy</Th>
          <Th dense align="right">
            Days
          </Th>
          <Th dense align="right">
            Avg
          </Th>
          <Th dense align="right">
            Win
          </Th>
          <Th dense align="right">
            Worst
          </Th>
        </THead>
        <tbody>
          {shown.map((v) => (
            <TRow key={v.name}>
              <Td dense>
                <span className="font-mono text-xs">{v.name}</span>
                {v.settings?.strike ? (
                  <span className="ml-2 text-[11px] text-muted">
                    {v.settings.entry}-{v.settings.exit} · {v.settings.strike}
                    {v.settings.leg_stop_percent
                      ? ` · leg SL ${formatPct(v.settings.leg_stop_percent, 0, { unit: 'percent' })}`
                      : ''}
                    {v.settings.overall_stop_inr
                      ? ` · overall SL ${formatInr(v.settings.overall_stop_inr)}`
                      : ''}
                  </span>
                ) : null}
              </Td>
              <Td dense align="right" numeric>
                {formatInt(v.n)}
              </Td>
              <Td dense align="right" numeric>
                {valueText(v.avg, 'inr')}
              </Td>
              <Td dense align="right" numeric>
                {v.win_rate === null ? EMPTY : formatPct(v.win_rate, 0)}
              </Td>
              <Td dense align="right" numeric>
                {valueText(v.worst, 'inr')}
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
      {d.variants_total > shown.length ? (
        <p className="mt-1 text-[11px] text-muted">
          Showing {shown.length} of {formatInt(d.variants_total)}.
        </p>
      ) : null}
    </div>
  );
}

function Days({ days }: { days: readonly MatrixCellDay[] }) {
  const single = days.every((d) => d.n_variants === 1);
  return (
    <Table maxHeight={260}>
      <THead>
        <Th dense>Day</Th>
        <Th dense align="right">
          Gross
        </Th>
        <Th dense>{single ? 'Stop' : 'Strategies'}</Th>
        <Th dense>Picked by</Th>
      </THead>
      <tbody>
        {days.map((x) => (
          <TRow key={x.day}>
            <Td dense>
              {formatDay(x.day)} <span className="text-faint">{x.weekday}</span>
            </Td>
            <Td dense align="right" numeric>
              {valueText(x.gross, 'inr')}
            </Td>
            <Td dense>
              <span className="block max-w-[10rem] truncate text-xs text-muted">
                {single
                  ? x.stopped_by || EMPTY
                  : `${formatInt(x.n_variants)}${x.n_stopped ? `, ${formatInt(x.n_stopped)} stopped` : ''}`}
              </span>
            </Td>
            <Td dense>
              <span className="font-mono text-xs">{x.picked_by?.join(' ') ?? ''}</span>
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}
