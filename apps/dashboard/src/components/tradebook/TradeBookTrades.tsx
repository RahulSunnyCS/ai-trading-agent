'use client';

/**
 * The Trades view: every round trip of the year by source (cards), the best and worst point of
 * each trade (a scatter), and the trips table. Filters (source, index, days to expiry) live in
 * the URL query and apply to all three.
 */

import { Download } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useQueryState } from '../../hooks/useQueryState';
import { useTradeBookTrips } from '../../hooks/useTradeBook';
import type { TradeBookRange } from '../../hooks/useTradeBook';
import { cn } from '../../lib/cn';
import { downloadCsv } from '../../lib/csv';
import {
  EMPTY,
  formatDay,
  formatDayShort,
  formatInr,
  formatInt,
  formatNumber,
  formatPct,
} from '../../lib/format';
import {
  type ScatterPoint,
  accountLabel,
  contractLabel,
  filterTrips,
  heldLabel,
  monthLabel,
  monthRange,
  orderSources,
  scatterPoints,
  sourceCards,
  sourceMeta,
  tripMonths,
} from '../../lib/tradeBookView';
import type { TradeBookTrip } from '../../types/tradeBook';
import { Button } from '../ui/Button';
import { RadioMenu } from '../ui/RadioMenu';
import { SkeletonRows } from '../ui/Skeleton';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { Inr, LoadError, Loaded, SourceBadge, TradeBookWidget } from './parts';

const DTE_OPTIONS = [
  { value: '', label: 'Any' },
  { value: '0', label: '0 (expiry day)' },
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3+', label: '3 or more' },
];

const W = 640;
const H = 300;
const PAD = { l: 52, r: 12, t: 12, b: 30 };

function Scatter({ points, onOpen }: { points: ScatterPoint[]; onOpen: (day: string) => void }) {
  const [hover, setHover] = useState<ScatterPoint | null>(null);
  const minMae = Math.min(0, ...points.map((p) => p.mae));
  const x = (v: number) => PAD.l + ((0 - v) / (0 - minMae || 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((100 - v) / 200) * (H - PAD.t - PAD.b);
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => minMae * f);
  const sources = orderSources(points.map((p) => p.source));
  return (
    <div className="space-y-2">
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label="Each trade's worst point against it (across) and the share of its best point it kept (up)"
        >
          {[-100, -50, 0, 50, 100].map((v) => (
            <g key={v}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(v)}
                y2={y(v)}
                className={v === 0 ? 'stroke-border-strong' : 'stroke-border'}
              />
              <text
                x={PAD.l - 6}
                y={y(v)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-faint text-[10px]"
              >
                {formatPct(v, 0, { unit: 'percent' })}
              </text>
            </g>
          ))}
          {xTicks.map((v) => (
            <text
              key={v}
              x={x(v)}
              y={H - 10}
              textAnchor="middle"
              className="fill-faint text-[10px]"
            >
              {formatInr(v, { compact: true })}
            </text>
          ))}
          {points.map((p) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the trips table below is the keyboard path to the same day
            <circle
              key={p.key}
              cx={x(p.mae)}
              cy={y(p.kept)}
              r={hover?.key === p.key ? 5 : 3.5}
              className={cn(sourceMeta(p.source).fill, 'cursor-pointer opacity-80')}
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onOpen(p.trip.day)}
            />
          ))}
        </svg>
        {hover ? (
          <div className="pointer-events-none absolute right-2 top-2 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-xs shadow-elevated">
            <p className="font-medium text-foreground">{contractLabel(hover.trip)}</p>
            <p className="text-muted">
              {formatDay(hover.trip.day, { weekday: true })} · {sourceMeta(hover.source).label}
            </p>
            <p className="metric text-muted">
              worst {formatInr(hover.mae)} · best {formatInr(hover.trip.mfe)} · P&amp;L{' '}
              {formatInr(hover.trip.pnl)}
            </p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {sources.map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={cn('h-2 w-2 rounded-sm', sourceMeta(s).swatch)} />
            {sourceMeta(s).label}
          </span>
        ))}
        <span className="text-faint">
          across: worst point against you · up: share of the best point kept
        </span>
      </div>
    </div>
  );
}

const TRIPS_SHOWN = 100;

function TripsTable({
  trips,
  allAccounts,
  onOpen,
}: {
  trips: TradeBookTrip[];
  allAccounts: string[];
  onOpen: (day: string) => void;
}) {
  const [all, setAll] = useState(false);
  const rows = [...trips].reverse();
  const shown = all ? rows : rows.slice(0, TRIPS_SHOWN);
  return (
    <>
      <Table maxHeight={640}>
        <THead>
          <Th dense>Day</Th>
          <Th dense>Time</Th>
          <Th dense>Contract</Th>
          <Th dense>Account</Th>
          <Th dense>Source</Th>
          <Th dense align="right">
            DTE
          </Th>
          <Th dense align="right">
            From spot
          </Th>
          <Th dense align="right">
            Qty
          </Th>
          <Th dense align="right">
            Held
          </Th>
          <Th dense align="right">
            Worst
          </Th>
          <Th dense align="right">
            Best
          </Th>
          <Th dense align="right">
            P&amp;L
          </Th>
          <Th dense align="right">
            Charges
          </Th>
          <Th dense align="right">
            Net
          </Th>
        </THead>
        <tbody>
          {shown.map((t, i) => (
            <TRow
              key={`${t.day}-${t.account}-${contractLabel(t)}-${i}`}
              onClick={() => onOpen(t.day)}
              className="whitespace-nowrap"
            >
              <Td
                dense
                title={t.entry_day !== t.day ? `opened ${formatDay(t.entry_day)}` : undefined}
              >
                {formatDayShort(t.day, { weekday: true })}
              </Td>
              <Td dense numeric align="right">
                {t.entry_time?.slice(0, 5) ?? <span className="text-faint">{EMPTY}</span>}
              </Td>
              <Td dense>
                {contractLabel(t)}
                {t.status !== 'closed' ? <span className="text-faint"> · {t.status}</span> : null}
              </Td>
              <Td dense className="text-muted">
                {accountLabel(`${t.broker}/${t.account}`, allAccounts)}
              </Td>
              <Td dense>
                <SourceBadge source={t.source} />
              </Td>
              <Td dense numeric align="right">
                {t.dte === null ? EMPTY : formatInt(t.dte)}
              </Td>
              <Td dense numeric align="right">
                {t.strike_from_spot == null
                  ? EMPTY
                  : formatNumber(t.strike_from_spot, 0, { sign: true })}
              </Td>
              <Td dense numeric align="right">
                {formatInt(t.qty)}
              </Td>
              <Td dense numeric align="right">
                {heldLabel(t) ?? EMPTY}
              </Td>
              <Td dense numeric align="right">
                <Inr value={t.mae} />
              </Td>
              <Td dense numeric align="right">
                <Inr value={t.mfe} />
              </Td>
              <Td dense numeric align="right">
                <Inr value={t.pnl} />
              </Td>
              <Td dense numeric align="right">
                {formatInr(t.charges)}
              </Td>
              <Td dense numeric align="right">
                <Inr value={t.net} />
              </Td>
            </TRow>
          ))}
        </tbody>
      </Table>
      {rows.length > TRIPS_SHOWN ? (
        <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${rows.length} trades`}
        </Button>
      ) : null}
    </>
  );
}

export function TradeBookTrades({
  range,
  account,
  allAccounts,
  onOpenDay,
  fileName,
}: {
  range: TradeBookRange;
  account: string | null;
  allAccounts: string[];
  onOpenDay: (day: string) => void;
  fileName: string;
}) {
  // The year without the best and worst points (any range works), to list its months; the
  // picked month with them (the API reads those a month at a time, at most 31 days).
  const year = useTradeBookTrips(range, account);
  const [monthParam, setMonth] = useQueryState('m');
  const months = useMemo(() => tripMonths(year.data?.trips ?? []), [year.data]);
  const month =
    monthParam === 'year'
      ? null
      : monthParam && months.some((m) => m.month === monthParam)
        ? monthParam
        : (months[0]?.month ?? null);
  const monthRead = useTradeBookTrips(month ? monthRange(month) : range, account, {
    extremes: true,
    enabled: month !== null,
  });
  const res = month ? monthRead : year;
  const [source, setSource] = useQueryState('src');
  const [index, setIndex] = useQueryState('ix');
  const [dte, setDte] = useQueryState('dte');
  const all = res.data?.trips ?? [];
  const trips = useMemo(() => filterTrips(all, { source, index, dte }), [all, source, index, dte]);
  const cards = useMemo(() => sourceCards(trips), [trips]);
  const points = useMemo(() => scatterPoints(trips), [trips]);
  const indices = [...new Set(all.map((t) => t.underlying))].sort();
  const sources = orderSources(all.map((t) => t.source));

  const csv = () =>
    downloadCsv(
      month ? `${fileName}-${month}` : fileName,
      [
        ['entry_day', 'Opened'],
        ['day', 'Closed'],
        ['entry_time', 'Entry'],
        ['exit_time', 'Exit'],
        ['contract', 'Contract'],
        ['source', 'Source'],
        ['direction', 'Direction'],
        ['qty', 'Qty'],
        ['dte', 'DTE'],
        ['entry_price', 'Entry price'],
        ['exit_price', 'Exit price'],
        ['mae', 'Worst'],
        ['mfe', 'Best'],
        ['pnl', 'P&L'],
        ['charges', 'Charges'],
        ['net', 'Net'],
        ['status', 'Status'],
      ],
      trips.map((t) => ({ ...t, contract: contractLabel(t), source: sourceMeta(t.source).label })),
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <RadioMenu
          ariaLabel="Period"
          prefix="Period"
          value={month ?? 'year'}
          valueLabel={month ? monthLabel(month) : 'Whole year'}
          options={[
            ...months.map((m) => ({
              value: m.month,
              label: monthLabel(m.month),
              detail: `${formatInt(m.trips)} trades`,
            })),
            { value: 'year', label: 'Whole year', detail: 'no best / worst' },
          ]}
          onChange={(v) => setMonth(v)}
          footer="The best and worst point of each trade is read a month at a time."
        />
        <RadioMenu
          ariaLabel="Source"
          prefix="Source"
          value={source ?? ''}
          valueLabel={source ? sourceMeta(source).label : 'All'}
          options={[
            { value: '', label: 'All' },
            ...sources.map((s) => ({ value: s, label: sourceMeta(s).label })),
          ]}
          onChange={(v) => setSource(v || null)}
        />
        <RadioMenu
          ariaLabel="Index"
          prefix="Index"
          value={index ?? ''}
          valueLabel={index ?? 'All'}
          options={[{ value: '', label: 'All' }, ...indices.map((i) => ({ value: i, label: i }))]}
          onChange={(v) => setIndex(v || null)}
        />
        <RadioMenu
          ariaLabel="Days to expiry"
          prefix="Days to expiry"
          value={dte ?? ''}
          valueLabel={DTE_OPTIONS.find((o) => o.value === (dte ?? ''))?.label ?? 'Any'}
          options={DTE_OPTIONS}
          onChange={(v) => setDte(v || null)}
        />
      </div>
      <Loaded data={res.data} loading={res.loading} error={res.error} retry={res.refetch} rows={6}>
        {(data) =>
          data.trips.length === 0 ? (
            <p className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-muted">
              No round trips in this period: no notes yet, or none whose trades add up to the note.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {cards.map((c) => (
                  <div
                    key={c.source}
                    className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3 shadow-card"
                  >
                    <SourceBadge source={c.source} />
                    <p
                      className={cn(
                        'metric mt-1 text-2xl font-medium',
                        c.net > 0 && 'text-positive',
                        c.net < 0 && 'text-negative',
                      )}
                    >
                      {c.trips ? formatInr(c.net) : EMPTY}
                    </p>
                    <p className="truncate text-xs text-muted">
                      {formatInt(c.trips)} trades · {formatPct(c.winPct, 0, { unit: 'percent' })}{' '}
                      won · avg {formatInr(c.avg)}
                      {c.open ? ` · ${c.open} without P&L` : ''}
                    </p>
                  </div>
                ))}
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <TradeBookWidget
                  title="Best and worst point of each trade"
                  description="How far each trade went against you (across) and how much of its best point you kept (up). Only option contracts the collector stores, and only trades with times."
                >
                  {() =>
                    points.length ? (
                      <Scatter points={points} onOpen={onOpenDay} />
                    ) : month === null ? (
                      <p className="text-xs text-faint">
                        Pick a month under Period: the best and worst points are read a month at a
                        time.
                      </p>
                    ) : (
                      <p className="text-xs text-faint">
                        No trade here has a best and worst point: the lake has no bars for these
                        contracts, or the notes carry no fill times.
                      </p>
                    )
                  }
                </TradeBookWidget>
                <TradeBookWidget
                  title="Turnover and coverage"
                  description="F&O turnover for the year (the sum of each trade's absolute P&L), for your CA: a figure, not tax advice; and how many notes gave trades."
                >
                  {() => {
                    // Always the whole year's read: a picked month is not the year's turnover.
                    const yearData = year.data;
                    if (!yearData) {
                      return year.error ? (
                        <LoadError error={year.error} retry={year.refetch} />
                      ) : (
                        <SkeletonRows rows={3} />
                      );
                    }
                    return (
                      <div className="space-y-3 text-sm">
                        <Table>
                          <THead>
                            <Th dense>Year</Th>
                            <Th dense align="right">
                              Turnover
                            </Th>
                            <Th dense align="right">
                              P&amp;L
                            </Th>
                            <Th dense align="right">
                              Trades
                            </Th>
                          </THead>
                          <tbody>
                            {Object.entries(yearData.turnover).map(([fy, t]) => (
                              <TRow key={fy}>
                                <Td dense>FY {fy}</Td>
                                <Td dense numeric align="right">
                                  {formatInr(t.turnover)}
                                </Td>
                                <Td dense numeric align="right">
                                  <Inr value={t.profit} />
                                </Td>
                                <Td dense numeric align="right">
                                  {formatInt(t.trips)}
                                </Td>
                              </TRow>
                            ))}
                          </tbody>
                        </Table>
                        <p className="text-xs text-muted">
                          Notes read as fills (with times):{' '}
                          <span className="metric text-foreground">
                            {formatInt(yearData.coverage.fills ?? 0)}
                          </span>{' '}
                          · as a summary (no times):{' '}
                          <span className="metric text-foreground">
                            {formatInt(yearData.coverage.summary ?? 0)}
                          </span>{' '}
                          · trades not adding up:{' '}
                          <span className="metric text-foreground">
                            {formatInt(
                              (yearData.coverage.unmatched ?? 0) + (yearData.coverage.none ?? 0),
                            )}
                          </span>
                          {yearData.coverage.before_trades_from ? (
                            <>
                              {' '}
                              · left out:{' '}
                              <span className="metric text-foreground">
                                {formatInt(yearData.coverage.before_trades_from)}
                              </span>{' '}
                              Angel One notes before{' '}
                              {formatDay(yearData.trades_from?.angelone ?? '')} (older layouts;
                              their days still count in the totals, their trades and turnover do
                              not)
                            </>
                          ) : null}
                        </p>
                      </div>
                    );
                  }}
                </TradeBookWidget>
              </div>
              <TradeBookWidget
                title="Round trips"
                badge={`${formatInt(trips.length)} trades`}
                description="Fills paired per contract, account and day. P&L is the fills' own (after their brokerage); charges are the note's other charges shared by turnover."
                actions={
                  <Button size="sm" variant="ghost" onClick={csv}>
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    CSV
                  </Button>
                }
              >
                {() => <TripsTable trips={trips} allAccounts={allAccounts} onOpen={onOpenDay} />}
              </TradeBookWidget>
            </div>
          )
        }
      </Loaded>
    </div>
  );
}
