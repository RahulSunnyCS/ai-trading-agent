'use client';

/**
 * The sheet's rolling ratios (T, U, V, W, Z) as one line chart with a switch. Every value is the
 * API's (`realised/ratios.py`, running from the store's first day as the sheet's do); this only
 * picks the column and formats it. A ratio is blank until its window has 50 or 100 sessions.
 */

import type { Time } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useChart } from '../../hooks/useChart';
import { getChartTheme, getSeriesPalette, pickSeries, withAlpha } from '../../lib/chartTheme';
import { EMPTY, formatDay, formatInr, formatInt, formatPct } from '../../lib/format';
import type { TradeBookDay } from '../../types/tradeBook';
import { SegmentedControl } from '../ui/SegmentedControl';

type RatioKey =
  | 'avg_profit_50'
  | 'avg_profit_100'
  | 'avg_charges_100'
  | 'charge_profit_pct'
  | 'profit_capital_bps';

const RATIOS: ReadonlyArray<{
  key: RatioKey;
  label: string;
  format: (v: number | null) => string;
  axis: (v: number) => string;
  definition: string;
}> = [
  {
    key: 'avg_profit_50',
    label: '50-day avg profit',
    format: (v) => formatInr(v),
    axis: (v) => formatInr(v, { compact: true }),
    definition: 'T: the average net profit of the last 50 sessions with a note.',
  },
  {
    key: 'avg_profit_100',
    label: '100-day avg profit',
    format: (v) => formatInr(v),
    axis: (v) => formatInr(v, { compact: true }),
    definition: 'U: the average net profit of the last 100 sessions with a note.',
  },
  {
    key: 'avg_charges_100',
    label: '100-day avg charge',
    format: (v) => formatInr(v),
    axis: (v) => formatInr(v, { compact: true }),
    definition: 'V: the average charges (notes plus algo fees) of the last 100 sessions.',
  },
  {
    key: 'charge_profit_pct',
    label: 'Charge / profit (W)',
    format: (v) => formatPct(v, 1, { unit: 'percent' }),
    axis: (v) => formatPct(v, 0, { unit: 'percent' }),
    definition: 'W: V ÷ U, charges per rupee of net profit. Lower is better.',
  },
  {
    key: 'profit_capital_bps',
    label: 'Profit / capital (Z)',
    format: (v) => (v === null ? EMPTY : `${formatInt(v)} bps/day`),
    axis: (v) => formatInt(v),
    definition: 'Z: U × 10,000 ÷ the 100-day average capital, basis points of capital a day.',
  },
];

/** W's range is read only where U (the 100-day average profit) is at least this many rupees. */
const W_MIN_U = 100;

export function TradeBookRatios({ rows }: { rows: TradeBookDay[] }) {
  const [key, setKey] = useState<RatioKey>('charge_profit_pct');
  const ratio = RATIOS.find((r) => r.key === key) ?? (RATIOS[0] as (typeof RATIOS)[number]);
  const box = useRef<HTMLDivElement>(null);
  const { chartRef, ready, theme } = useChart(box, false, 240);

  const allPoints = useMemo(
    () =>
      rows.flatMap((r) => {
        const v = r[key];
        return v === null ? [] : [{ day: r.day, value: v, u: r.avg_profit_100 }];
      }),
    [rows, key],
  );
  // W divides by U: on a session where U is near zero it runs to thousands of percent either
  // way, so the chart and the range leave out sessions where U is under ₹100.
  const points = useMemo(
    () =>
      key === 'charge_profit_pct'
        ? allPoints.filter((p) => p.u !== null && p.u >= W_MIN_U)
        : allPoints,
    [allPoints, key],
  );

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || chart === null) return;
    const t = getChartTheme(theme);
    const colour = pickSeries(getSeriesPalette(theme), 0);
    chart.applyOptions({ localization: { priceFormatter: ratio.axis } });
    const area = chart.addAreaSeries({
      lineColor: colour,
      topColor: withAlpha(colour, 0.16),
      bottomColor: withAlpha(colour, 0.02),
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerBorderColor: t.surface,
    });
    area.setData(points.map((p) => ({ time: p.day as Time, value: p.value })));
    chart.timeScale().fitContent();
    return () => {
      if (chartRef.current) chartRef.current.removeSeries(area);
    };
  }, [chartRef, ready, theme, points, ratio]);

  // The latest value is the latest session's, whatever its U.
  const last = allPoints.at(-1);
  const values = points.map((p) => p.value);
  const range = values.length
    ? `range ${ratio.format(Math.min(...values))} to ${ratio.format(Math.max(...values))}`
    : 'no session with U of ₹100 or more';

  return (
    <div className="space-y-2">
      <SegmentedControl
        ariaLabel="Ratio"
        size="sm"
        value={key}
        onChange={setKey}
        options={RATIOS.map((r) => ({ value: r.key, label: r.label }))}
      />
      <p className="flex flex-wrap items-baseline gap-x-3">
        <span className="metric text-2xl font-medium text-foreground">
          {last ? ratio.format(last.value) : EMPTY}
        </span>
        <span className="text-xs text-faint">
          {last
            ? `on ${formatDay(last.day)} · ${range}`
            : 'not enough sessions yet: the window needs 50 or 100'}
        </span>
      </p>
      <div ref={box} className="w-full" style={{ height: 240 }} />
      <p className="text-xs text-faint">{ratio.definition}</p>
      {key === 'charge_profit_pct' ? (
        <p className="text-xs text-faint">
          The chart and the range show only sessions where U is at least {formatInr(W_MIN_U)}: below
          that, W divides by almost nothing and swings to thousands of percent. The latest value is
          the latest session&apos;s, whatever its U.
        </p>
      ) : null}
    </div>
  );
}
