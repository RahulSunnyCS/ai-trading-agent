'use client';

/**
 * Rotation page → "Day by day" (owner, 2026-11-04): one candle a day for an Adaptive book or the
 * fixed base, laid on its running total. A candle opens at the total before the day, its wick runs
 * to the best and worst points of the day's minute-by-minute book path, and it closes at the
 * day's result, cut at the book's own stop. Hover a day for each strategy's result and the share
 * of random baskets of the same size it beat.
 *
 * Read through `GET /legwise/rotation/candles` (`rotation/candles.py` does every figure).
 */

import type { ISeriesApi, MouseEventParams, Time } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useChart } from '../../hooks/useChart';
import { useRotationCandles } from '../../hooks/useRotationCandles';
import { getChartTheme, withAlpha } from '../../lib/chartTheme';
import { cn } from '../../lib/cn';
import { formatDay, formatInr, formatNumber } from '../../lib/format';
import { tooltipPlacement } from '../../lib/momentumResult';
import {
  CANDLE_BOOKS,
  CANDLE_LOTS,
  CANDLE_PERIODS,
  type CandlePeriod,
  cutPeriod,
  tipLines,
} from '../../lib/rotationCandlesView';
import type { CandleBook, CandleDay } from '../../types/rotationCandles';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Skeleton } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { pnlClass } from './shared';

const HEIGHT = 340;

function dayOf(time: Time | undefined): string | null {
  if (time === undefined) return null;
  if (typeof time === 'string') return time;
  if (typeof time === 'number') return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

function Tip({ d }: { d: CandleDay }) {
  const { head, picks, foot } = tipLines(d);
  const row = (l: {
    label: string;
    value: string;
    tone: 'pos' | 'neg' | null;
    detail?: string;
  }) => (
    <div key={l.label + l.value} className="flex items-baseline justify-between gap-4">
      <span className="min-w-0 truncate text-muted">
        {l.label}
        {l.detail ? (
          <span className="block truncate text-[10px] text-faint">{l.detail}</span>
        ) : null}
      </span>
      <span
        className={cn(
          'metric whitespace-nowrap',
          l.tone === 'pos' && 'text-positive',
          l.tone === 'neg' && 'text-negative',
        )}
      >
        {l.value}
      </span>
    </div>
  );
  return (
    <div className="space-y-1">
      <p className="font-mono font-medium text-foreground">{formatDay(d.day, { weekday: true })}</p>
      {head.map(row)}
      <div className="border-t border-border pt-1">{picks.map(row)}</div>
      <div className="border-t border-border pt-1">{foot.map(row)}</div>
    </div>
  );
}

function Chart({ days }: { days: CandleDay[] }) {
  const box = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const { chartRef, ready, theme } = useChart(box, false, HEIGHT);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [hover, setHover] = useState<{ day: string; x: number; y: number } | null>(null);
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null) return;
    if (series.current) chart.removeSeries(series.current);
    const t = getChartTheme(theme);
    chart.applyOptions({
      timeScale: { timeVisible: false },
      crosshair: { horzLine: { visible: false, labelVisible: false } },
      localization: { priceFormatter: (v: number) => formatInr(v, { compact: true }) },
    });
    const s = chart.addCandlestickSeries({
      upColor: t.positive,
      downColor: t.negative,
      borderUpColor: t.positive,
      borderDownColor: t.negative,
      wickUpColor: withAlpha(t.positive, 0.8),
      wickDownColor: withAlpha(t.negative, 0.8),
      priceLineVisible: false,
      lastValueVisible: true,
    });
    s.setData(
      days.map((d) => ({
        time: d.day as Time,
        open: d.open,
        high: d.high,
        low: d.low,
        close: d.close,
      })),
    );
    series.current = s;
    chart.timeScale().fitContent();
  }, [chartRef, ready, theme, days]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null) return;
    let frame: number | null = null;
    const onMove = (param: MouseEventParams) => {
      const day = dayOf(param.time);
      const point = param.point;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        setHover(day && point ? { day, x: point.x, y: point.y } : null);
      });
    };
    chart.subscribeCrosshairMove(onMove);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      chart.unsubscribeCrosshairMove(onMove);
    };
  }, [chartRef, ready]);

  const point = hover ? byDay.get(hover.day) : undefined;
  const placement = (() => {
    const r = box.current?.getBoundingClientRect();
    if (!hover || !r) return null;
    const t = tip.current?.getBoundingClientRect();
    return tooltipPlacement(
      { x: hover.x, y: hover.y },
      { width: t?.width ?? 260, height: t?.height ?? 220 },
      { left: 0, top: 0, right: r.width, bottom: r.height },
    );
  })();

  return (
    <div
      className="relative"
      role="img"
      aria-label="Daily candles on the running total; hover a day for each strategy's result"
      onMouseLeave={() => setHover(null)}
    >
      <div ref={box} className="w-full" style={{ height: HEIGHT }} />
      {hover && point && placement ? (
        <div
          ref={tip}
          style={{ left: placement.left, top: placement.top }}
          className="pointer-events-none absolute z-10 w-72 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-xs shadow-elevated"
        >
          <Tip d={point} />
        </div>
      ) : null}
    </div>
  );
}

export function RotationCandles() {
  const [book, setBook] = useState<CandleBook>('t1');
  const [period, setPeriod] = useState<CandlePeriod>('3m');
  const [lots, setLots] = useState<string>('1');
  const res = useRotationCandles(book, Number(lots));
  const data =
    res.data && res.data.book === book && res.data.lots === Number(lots) ? res.data : null;
  const shown = useMemo(() => (data ? cutPeriod(data.days, period) : []), [data, period]);
  const last = shown[shown.length - 1];
  const first = shown[0];

  return (
    <Card>
      <CardHeader
        title="Candles on the running total"
        description="One candle a day on the running total: the wick is the day's best and worst point, the body its result after the book stop. Hover a day for each strategy and the share of random baskets it beat."
        actions={<RefreshButton onClick={res.refetch} loading={res.loading} />}
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SegmentedControl
          ariaLabel="Book"
          size="sm"
          value={book}
          options={CANDLE_BOOKS}
          onChange={setBook}
        />
        <SegmentedControl
          ariaLabel="Period"
          size="sm"
          value={period}
          options={CANDLE_PERIODS}
          onChange={setPeriod}
        />
        <SegmentedControl
          ariaLabel="Lots per strategy"
          size="sm"
          value={lots}
          options={CANDLE_LOTS.map((n) => ({
            value: String(n),
            label: `${n} lot${n > 1 ? 's' : ''}`,
          }))}
          onChange={setLots}
        />
      </div>
      {res.error && !data ? (
        <StateMessage variant="error" title="The candles did not load" description={res.error} />
      ) : !data ? (
        <div className="space-y-2">
          <Skeleton className="h-[340px] w-full" />
          {res.warming ? (
            <p className="text-xs text-muted">
              Replaying the book's days for the first time; this takes a minute.
            </p>
          ) : null}
        </div>
      ) : shown.length === 0 ? (
        <StateMessage variant="empty" title="No scored days in this period" />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
            <span>
              {formatDay(first?.day)} → {formatDay(last?.day)} · {formatNumber(shown.length, 0)}{' '}
              days
            </span>
            <span>
              Period{' '}
              <span className={cn('metric', pnlClass((last?.close ?? 0) - (first?.open ?? 0)))}>
                {formatInr((last?.close ?? 0) - (first?.open ?? 0), { sign: true })}
              </span>
            </span>
            <span>
              Book stop{' '}
              <span className="metric text-foreground">
                {data.stop === null ? 'none' : formatInr(data.stop)}
              </span>
            </span>
            <span>
              Drawdown now{' '}
              <span className="metric text-foreground">{formatInr(-data.totals.drawdown_now)}</span>{' '}
              · deepest {formatInr(-data.totals.max_drawdown)} since {formatDay(data.days[0]?.day)}
            </span>
          </div>
          <Chart days={shown} />
          <p className="mt-2 text-xs text-faint">
            Paper, {data.lots} lot{data.lots > 1 ? 's' : ''} per strategy
            {data.slippage_pct ? `, ${data.slippage_pct}% slippage on every fill` : ', no slippage'}
            , before charges. The random baskets are {formatNumber(data.draws, 0)} draws a day of
            the same number of strategies from the book's ranked pool, without a stop.
            {data.book === 'base'
              ? ' The base holds the same three strategies every day.'
              : ' Picks before the journal began are re-derived by the ranking.'}
            {data.left_out.length
              ? ` ${data.left_out.length} day${data.left_out.length > 1 ? 's' : ''} could not be replayed and ${data.left_out.length > 1 ? 'are' : 'is'} left out.`
              : ''}
          </p>
        </>
      )}
    </Card>
  );
}
