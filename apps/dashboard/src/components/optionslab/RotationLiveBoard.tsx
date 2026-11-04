/**
 * Rotation page → "Live board" (BL-203): today's Adaptive picks, Classic and Tuned, run through the
 * backtest engine on Angel One's 1-minute prices so far. Refreshed every 5 minutes by the scheduler
 * (09:18 to 15:31) and on the Refresh button; the card polls the snapshot every minute. Per lot by
 * default, or at the lots your accounts trade (Settings › Automation). Slippage follows the
 * Rotation pages' switch. Read through `GET /legwise/rotation/live-board`.
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useRotationLiveBoard } from '../../hooks/useRotationLiveBoard';
import { getChartTheme, getSeriesPalette, pickSeries } from '../../lib/chartTheme';
import { formatInr, formatNumber } from '../../lib/format';
import {
  type LotsView,
  STATE_LABEL,
  bookNet,
  chartLines,
  legExit,
  lotsLine,
  pickNet,
  staleError,
  statusLine,
} from '../../lib/rotationLiveBoard';
import { SLIPPAGE_TEXT } from '../../lib/rotationSlippage';
import { useRotationSlippage } from '../../store/rotationSlippage';
import { useThemeStore } from '../../store/theme';
import type { LiveBoardSnapshot, LiveBook, LivePick } from '../../types/rotationLiveBoard';
import { Badge, type Status } from '../ui/Badge';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { SkeletonRows } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { THead, TRow, Table, Td, Th } from '../ui/Table';
import { pnlClass } from './shared';

const VIEW_OPTIONS = [
  { value: 'lot' as const, label: 'A lot each' },
  { value: 'yours' as const, label: 'Your lots' },
];

const STATE_STATUS: Record<LivePick['state'], Status> = {
  waiting: 'queued',
  open: 'open',
  closed: 'closed',
  no_data: 'attention',
};

function money(value: number): string {
  return formatInr(value, { sign: true });
}

function IntradayLines({ lines }: { lines: ReturnType<typeof chartLines> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 220,
      layout: { background: { color: 'transparent' } },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 2 },
    });
    chartRef.current = chart;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      seriesRef.current = [];
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const t = getChartTheme(theme);
    chart.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: t.text, fontFamily: t.fontFamily },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    const palette = getSeriesPalette(theme);
    seriesRef.current = lines.map((line, i) => {
      const series = chart.addLineSeries({
        color: pickSeries(palette, i),
        lineWidth: 2,
        title: line.id,
        priceLineVisible: false,
      });
      series.setData(line.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
      return series;
    });
    chart.timeScale().fitContent();
  }, [lines, theme]);

  return <div ref={containerRef} className="w-full" style={{ minHeight: 220 }} />;
}

function PickRows({
  pick,
  view,
  slippage,
}: {
  pick: LivePick;
  view: LotsView;
  slippage: boolean;
}) {
  const value = pickNet(pick, view, slippage);
  const legs = pick.legs;
  return (
    <>
      <TRow>
        <Td dense className="align-top">
          <div className="font-medium text-foreground">{pick.label}</div>
          <div className="text-[11px] text-faint">
            {pick.variant} · {pick.entry_time}
            {pick.role === 'buy' ? ' · Buy add-on' : ''}
            {view === 'yours' ? ` · ${pick.lots ?? 0} lot${pick.lots === 1 ? '' : 's'}` : ''}
          </div>
        </Td>
        <Td dense className="align-top">
          <Badge status={STATE_STATUS[pick.state]}>
            {pick.state === 'waiting' ? `Enters ${pick.entry_time}` : STATE_LABEL[pick.state]}
          </Badge>
        </Td>
        <Td dense className="align-top text-xs">
          {legs.length === 0 ? (
            <span className="text-faint">—</span>
          ) : (
            <ul className="space-y-0.5">
              {legs.map((leg, i) => (
                <li key={`${leg.leg}-${leg.entry}-${i}`} className="whitespace-nowrap">
                  <span className="text-muted">{leg.side === 'sell' ? 'S' : 'B'}</span>{' '}
                  {leg.contract} {formatNumber(leg.entry_price, 2)}→{formatNumber(leg.price, 2)}{' '}
                  <span className={leg.exit === null ? 'text-info' : 'text-faint'}>
                    {legExit(leg)}
                  </span>{' '}
                  <span className={pnlClass(leg.pnl)}>{money(leg.pnl)}</span>
                </li>
              ))}
            </ul>
          )}
        </Td>
        <Td dense align="right" numeric className={`align-top ${pnlClass(value)}`}>
          {pick.state === 'waiting' ? '—' : money(value)}
        </Td>
      </TRow>
    </>
  );
}

function BookPanel({
  book,
  view,
  slippage,
}: {
  book: LiveBook;
  view: LotsView;
  slippage: boolean;
}) {
  const total = bookNet(book, view, slippage);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{book.name}</h3>
          <p className="text-[11px] text-faint">
            {view === 'yours' ? lotsLine(book) : 'One lot per strategy'}
            {book.expiry_only ? ` · ${book.expiry_only} only (expiry day)` : ''}
            {book.late ? ' · recorded late' : ''}
          </p>
        </div>
        <div className={`text-xl font-semibold tabular-nums ${pnlClass(total)}`}>
          {money(total)}
        </div>
      </div>
      <Table>
        <THead>
          <Th dense>Strategy</Th>
          <Th dense>State</Th>
          <Th dense>
            {slippage
              ? 'Legs (entry → now or exit, before slippage)'
              : 'Legs (entry → now or exit)'}
          </Th>
          <Th dense align="right">
            P&L
          </Th>
        </THead>
        <tbody>
          {book.picks.map((p) => (
            <PickRows key={`${p.variant}-${p.role}`} pick={p} view={view} slippage={slippage} />
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function Spot({ snap }: { snap: LiveBoardSnapshot }) {
  const entries = Object.entries(snap.spot);
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
      {entries.map(([name, s]) => {
        const change = s.last !== null && s.open !== null ? s.last - s.open : null;
        return (
          <span key={name}>
            <span className="font-medium text-foreground">{name}</span> {formatNumber(s.last, 2)}
            {change !== null ? (
              <span className={`ml-1 ${pnlClass(change)}`}>
                {change >= 0 ? '+' : ''}
                {formatNumber(change, 2)}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

export function RotationLiveBoard() {
  const board = useRotationLiveBoard();
  const slippage = useRotationSlippage();
  const [view, setView] = useState<LotsView>('lot');
  const d = board.data;
  const snap = d?.snapshot ?? null;
  const lines = useMemo(() => (snap ? chartLines(snap.day, snap.books, view) : []), [snap, view]);
  const error = d ? staleError(d) : null;
  return (
    <Card>
      <CardHeader
        title="Live board"
        description={
          d
            ? `${statusLine(d)}. Today's picks run through the backtest on Angel One's prices so far${slippage ? `, after ${SLIPPAGE_TEXT} slippage on every fill` : ''}. Paper figures, not your broker's.`
            : "Today's picks run through the backtest on Angel One's prices so far."
        }
        actions={
          <>
            <SegmentedControl
              value={view}
              options={VIEW_OPTIONS}
              onChange={setView}
              ariaLabel="Lots shown"
              size="sm"
            />
            <RefreshButton onClick={() => void board.refresh()} loading={board.refreshing} />
          </>
        }
      />
      {board.refreshError ? (
        <p className="mb-3 text-xs text-negative">
          The refresh was not started: {board.refreshError}
        </p>
      ) : null}
      {board.refreshNote ? <p className="mb-3 text-xs text-muted">{board.refreshNote}</p> : null}
      {error ? <p className="mb-3 text-xs text-warning">Last refresh failed: {error}</p> : null}
      {board.error && !d ? (
        <StateMessage
          variant="error"
          title="Could not read the live board"
          description={board.error}
        />
      ) : d === null ? (
        <SkeletonRows rows={4} />
      ) : snap === null ? (
        <StateMessage
          variant="empty"
          title="No live board yet"
          description={
            d.state.last_note ??
            'It fills from 09:18 on trading days, after the 09:16 picks. Press Refresh to read Angel One now.'
          }
        />
      ) : (
        <div className="space-y-4">
          <Spot snap={snap} />
          <div className="grid gap-6 lg:grid-cols-2">
            {snap.books.map((b) => (
              <BookPanel key={b.book} book={b} view={view} slippage={slippage} />
            ))}
          </div>
          {lines.length > 0 ? (
            <div className="space-y-1">
              <h3 className="text-xs font-medium text-muted">
                Through the day ({view === 'yours' ? 'your lots' : 'a lot each'}, before slippage)
              </h3>
              <IntradayLines lines={lines} />
            </div>
          ) : null}
          {snap.notes.length > 0 ? (
            <ul className="space-y-0.5 text-[11px] text-faint">
              {snap.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </Card>
  );
}
