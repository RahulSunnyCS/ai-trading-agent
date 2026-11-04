'use client';

/**
 * Rotation page → "Day by day" (owner, 2026-11-04): candles for an Adaptive book or the fixed base,
 * one a day or one a week, laid on its running total. A candle opens at the total before the bar,
 * its wick runs to the best and worst points of the minute-by-minute book path, and it closes at
 * the bar's result, cut at the book's own stop. Over them: a dot on each day the accounts traded
 * the list live (green / red by the live result per lot), the fixed base's running total as a thin
 * line, and a drawdown strip with the depths a quarter, a tenth and a twentieth of the days
 * reached. Hover a bar for each strategy, the live accounts and the random-basket share; click a
 * day to pin it and replay its strategies minute by minute.
 *
 * Read through `GET /legwise/rotation/candles` (`rotation/candles.py` does every figure).
 */

import type {
  ISeriesApi,
  MouseEventParams,
  SeriesMarker,
  SeriesType,
  Time,
} from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useChart } from '../../hooks/useChart';
import { useRotationCandles } from '../../hooks/useRotationCandles';
import { getChartTheme, getSeriesPalette, pickSeries, withAlpha } from '../../lib/chartTheme';
import { cn } from '../../lib/cn';
import { formatDay, formatInr, formatNumber } from '../../lib/format';
import { tooltipPlacement } from '../../lib/momentumResult';
import {
  CANDLE_BOOKS,
  CANDLE_LOTS,
  CANDLE_PERIODS,
  CANDLE_SPANS,
  type CandleBar,
  type CandlePeriod,
  type CandleSpan,
  type Tip,
  type TipLine,
  barLines,
  canReplay,
  cutPeriod,
  liveTotal,
  toBars,
} from '../../lib/rotationCandlesView';
import type { CandleBook, CandleDay, RotationCandlesResponse } from '../../types/rotationCandles';
import { Button } from '../ui/Button';
import { Card, CardHeader } from '../ui/Card';
import { RefreshButton } from '../ui/RefreshButton';
import { SegmentedControl } from '../ui/SegmentedControl';
import { Skeleton } from '../ui/Skeleton';
import { StateMessage } from '../ui/StateMessage';
import { DayForensics } from './DayForensics';
import { pnlClass } from './shared';

const HEIGHT = 420;

function dayOf(time: Time | undefined): string | null {
  if (time === undefined) return null;
  if (typeof time === 'string') return time;
  if (typeof time === 'number') return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
}

function Line({ l }: { l: TipLine }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
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
}

function TipBody({ bar, tip }: { bar: CandleBar; tip: Tip }) {
  const last = bar.days[bar.days.length - 1];
  return (
    <div className="space-y-1">
      <p className="font-mono font-medium text-foreground">
        {bar.days.length > 1 && last
          ? `${formatDay(bar.time)} → ${formatDay(last.day)}`
          : formatDay(bar.time, { weekday: true })}
      </p>
      {tip.head.map((l) => (
        <Line key={l.label} l={l} />
      ))}
      {tip.picks.length ? (
        <div className="border-t border-border pt-1">
          {tip.picks.map((l) => (
            <Line key={l.label} l={l} />
          ))}
        </div>
      ) : null}
      <div className="border-t border-border pt-1">
        {tip.foot.map((l) => (
          <Line key={l.label} l={l} />
        ))}
      </div>
    </div>
  );
}

function Chart({
  bars,
  base,
  ladder,
  onPick,
}: {
  bars: CandleBar[];
  base: CandleBar[] | null;
  ladder: RotationCandlesResponse['ladder'];
  onPick: (bar: CandleBar) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const { chartRef, ready, theme } = useChart(box, false, HEIGHT);
  const series = useRef<ISeriesApi<SeriesType>[]>([]);
  const [hover, setHover] = useState<{ time: string; x: number; y: number } | null>(null);
  const byTime = useMemo(() => new Map(bars.map((b) => [b.time, b])), [bars]);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null) return;
    for (const s of series.current) chart.removeSeries(s);
    series.current = [];
    const t = getChartTheme(theme);
    const palette = getSeriesPalette(theme);
    chart.applyOptions({
      timeScale: { timeVisible: false },
      rightPriceScale: { scaleMargins: { top: 0.06, bottom: 0.3 } },
      crosshair: { horzLine: { visible: false, labelVisible: false } },
      localization: { priceFormatter: (v: number) => formatInr(v, { compact: true }) },
    });
    if (base?.length) {
      const line = chart.addLineSeries({
        color: withAlpha(pickSeries(palette, 1), 0.9),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      line.setData(base.map((b) => ({ time: b.time as Time, value: b.close })));
      series.current.push(line);
    }
    const candles = chart.addCandlestickSeries({
      upColor: t.positive,
      downColor: t.negative,
      borderUpColor: t.positive,
      borderDownColor: t.negative,
      wickUpColor: withAlpha(t.positive, 0.8),
      wickDownColor: withAlpha(t.negative, 0.8),
      priceLineVisible: false,
      lastValueVisible: true,
    });
    candles.setData(
      bars.map((b) => ({
        time: b.time as Time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );
    const markers: SeriesMarker<Time>[] = [];
    for (const b of bars) {
      const live = liveTotal(b);
      if (live === null) continue;
      markers.push({
        time: b.time as Time,
        position: 'aboveBar',
        shape: 'circle',
        color: live >= 0 ? t.positive : t.negative,
        size: 0.6,
      });
    }
    candles.setMarkers(markers);
    series.current.push(candles);
    // The drawdown strip: below the candles on its own scale, with the ladder's depths.
    const dd = chart.addBaselineSeries({
      priceScaleId: 'drawdown',
      baseValue: { type: 'price', price: 0 },
      topLineColor: t.negative,
      topFillColor1: withAlpha(t.negative, 0),
      topFillColor2: withAlpha(t.negative, 0),
      bottomLineColor: t.negative,
      bottomFillColor1: withAlpha(t.negative, 0.1),
      bottomFillColor2: withAlpha(t.negative, 0.35),
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.priceScale('drawdown').applyOptions({ scaleMargins: { top: 0.76, bottom: 0 } });
    dd.setData(bars.map((b) => ({ time: b.time as Time, value: -b.drawdown })));
    for (const step of ladder) {
      dd.createPriceLine({
        price: -step.drawdown,
        color: withAlpha(t.text, 0.6),
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: `${step.share}% of days`,
      });
    }
    series.current.push(dd);
    chart.timeScale().fitContent();
  }, [chartRef, ready, theme, bars, base, ladder]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null) return;
    let frame: number | null = null;
    const onMove = (param: MouseEventParams) => {
      const time = dayOf(param.time);
      const point = param.point;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        setHover(time && point ? { time, x: point.x, y: point.y } : null);
      });
    };
    const onClick = (param: MouseEventParams) => {
      const time = dayOf(param.time);
      const bar = time ? byTime.get(time) : undefined;
      if (bar) pick.current(bar);
    };
    chart.subscribeCrosshairMove(onMove);
    chart.subscribeClick(onClick);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      chart.unsubscribeCrosshairMove(onMove);
      chart.unsubscribeClick(onClick);
    };
  }, [chartRef, ready, byTime]);

  const bar = hover ? byTime.get(hover.time) : undefined;
  const placement = (() => {
    const r = box.current?.getBoundingClientRect();
    if (!hover || !r) return null;
    const t = tip.current?.getBoundingClientRect();
    return tooltipPlacement(
      { x: hover.x, y: hover.y },
      { width: t?.width ?? 288, height: t?.height ?? 260 },
      { left: 0, top: 0, right: r.width, bottom: r.height },
    );
  })();

  return (
    <div
      className="relative"
      role="img"
      aria-label="Candles on the running total with a drawdown strip; hover a bar for its strategies, click a day to replay it"
      onMouseLeave={() => setHover(null)}
    >
      <div ref={box} className="w-full cursor-pointer" style={{ height: HEIGHT }} />
      {hover && bar && placement ? (
        <div
          ref={tip}
          style={{ left: placement.left, top: placement.top }}
          className="pointer-events-none absolute z-10 w-72 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-xs shadow-elevated"
        >
          <TipBody bar={bar} tip={barLines(bar)} />
        </div>
      ) : null}
    </div>
  );
}

/** The pinned bar under the chart: a day's lines with a replay per strategy, or a week's days. */
function Pinned({
  bar,
  onDay,
  onReplay,
  onClose,
}: {
  bar: CandleBar;
  onDay: (day: CandleDay) => void;
  onReplay: (variant: string, day: string) => void;
  onClose: () => void;
}) {
  const one = bar.days.length === 1 ? bar.days[0] : undefined;
  return (
    <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="font-medium text-foreground">
          {one ? formatDay(one.day, { weekday: true }) : `Week of ${formatDay(bar.time)}`}
        </p>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
      {one ? (
        <div className="space-y-1">
          {one.picks.map((p) => (
            <div key={p.name} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate">
                <span className="text-foreground">
                  {p.label}
                  {p.lots > 1 ? ` ×${p.lots}` : ''}
                </span>{' '}
                <span className="text-faint">{p.params}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className={cn('metric', pnlClass(p.pnl))}>
                  {formatInr(p.pnl, { sign: true })}
                </span>
                {canReplay(p.name) ? (
                  <Button size="sm" onClick={() => onReplay(p.name, one.day)}>
                    Replay
                  </Button>
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {bar.days.map((d) => (
            <button
              type="button"
              key={d.day}
              onClick={() => onDay(d)}
              className="flex w-full items-center justify-between gap-3 rounded px-1 py-0.5 text-left hover:bg-surface"
            >
              <span className="text-foreground">{formatDay(d.day, { weekday: true })}</span>
              <span className={cn('metric', pnlClass(d.pnl))}>
                {formatInr(d.pnl, { sign: true })}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function RotationCandles() {
  const [book, setBook] = useState<CandleBook>('t1');
  const [period, setPeriod] = useState<CandlePeriod>('3m');
  const [span, setSpan] = useState<CandleSpan>('day');
  const [lots, setLots] = useState<string>('1');
  const [pinned, setPinned] = useState<CandleBar | null>(null);
  const [replay, setReplay] = useState<{ variant: string; day: string } | null>(null);
  const res = useRotationCandles(book, Number(lots));
  const baseRes = useRotationCandles('base', Number(lots), book !== 'base');
  const data =
    res.data && res.data.book === book && res.data.lots === Number(lots) ? res.data : null;
  const shown = useMemo(() => (data ? cutPeriod(data.days, period) : []), [data, period]);
  const bars = useMemo(() => toBars(shown, span), [shown, span]);
  const baseBars = useMemo(() => {
    const b = baseRes.data;
    const start = shown[0];
    if (book === 'base' || !b || b.lots !== Number(lots) || !start) return null;
    const days = b.days.filter((d) => d.day >= start.day);
    const anchor = days[0]?.open;
    if (anchor === undefined) return null;
    // From the same starting point as the first candle shown: the two books over the same days.
    const shift = start.open - anchor;
    return toBars(days, span).map((bar) => ({ ...bar, close: bar.close + shift }));
  }, [baseRes.data, book, lots, shown, span]);
  const first = shown[0];
  const last = shown[shown.length - 1];

  return (
    <Card>
      <CardHeader
        title="Candles on the running total"
        description="Each candle opens at the running total; the wick is the best and worst point, the body the result after the book stop. Dots mark days your accounts traded the list live; the thin line is the fixed base from the same start. Hover a bar for its strategies, click a day to replay them."
        actions={<RefreshButton onClick={res.refetch} loading={res.loading} />}
      />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SegmentedControl
          ariaLabel="Book"
          size="sm"
          value={book}
          options={CANDLE_BOOKS}
          onChange={(v) => {
            setBook(v);
            setPinned(null);
            setReplay(null);
          }}
        />
        <SegmentedControl
          ariaLabel="Candle"
          size="sm"
          value={span}
          options={CANDLE_SPANS}
          onChange={setSpan}
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
          onChange={(v) => {
            setLots(v);
            setPinned(null);
          }}
        />
      </div>
      {res.error && !data ? (
        <StateMessage variant="error" title="The candles did not load" description={res.error} />
      ) : !data ? (
        <div className="space-y-2">
          <Skeleton className="h-[420px] w-full" />
          {res.warming ? (
            <p className="text-xs text-muted">
              Replaying the book's days for the first time; this takes a few minutes.
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
            {data.live_days ? (
              <span>
                Live on{' '}
                <span className="metric text-foreground">{formatNumber(data.live_days, 0)}</span>{' '}
                day{data.live_days === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
          <div className="mb-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm bg-positive" />
              <span aria-hidden="true" className="-ml-1 h-2.5 w-2.5 rounded-sm bg-negative" />
              {span === 'day' ? 'Day' : 'Week'}
            </span>
            {baseBars ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="w-3 border-t-2 border-series-2" />
                Fixed base, from the same start
              </span>
            ) : null}
            {data.live_days ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-muted" />
                Traded live
              </span>
            ) : null}
            <span>Strip: drawdown, with the depth 25 / 10 / 5 % of days reached</span>
          </div>
          <Chart
            bars={bars}
            base={baseBars}
            ladder={data.ladder}
            onPick={(b) => {
              setPinned(b);
              setReplay(null);
            }}
          />
          {pinned ? (
            <Pinned
              bar={pinned}
              onDay={(d) => setPinned(toBars([d], 'day')[0] ?? null)}
              onReplay={(variant, day) => setReplay({ variant, day })}
              onClose={() => {
                setPinned(null);
                setReplay(null);
              }}
            />
          ) : null}
          {replay ? (
            <div className="mt-3">
              <DayForensics
                key={`${replay.variant}-${replay.day}`}
                strategy={replay.variant}
                day={replay.day}
                sha={undefined}
                rotationVariant
                onClose={() => setReplay(null)}
                fallback={
                  <p className="text-xs text-muted">
                    The replay needs this day's 1-minute bars on the machine running the API.
                  </p>
                }
              />
            </div>
          ) : null}
          <p className="mt-2 text-xs text-faint">
            Paper, {data.lots} lot{data.lots > 1 ? 's' : ''} per strategy
            {data.slippage_pct ? `, ${data.slippage_pct}% slippage on every fill` : ', no slippage'}
            , before charges. The random baskets are {formatNumber(data.draws, 0)} draws a day of
            the same number of strategies from the book's ranked pool, cut at the same stop when
            they ended below it. Live is each account's own result per lot from the 15:40 capture.
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
