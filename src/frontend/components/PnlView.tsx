/**
 * PnlView — realized P&L aggregates and cumulative chart for the P&L tab.
 *
 * Data source: the shared usePaperTrades hook (polled from GET /api/trades) —
 * TradesView and PnlView consume the same hook to avoid duplicate fetches.
 *
 * Honesty constraints: the headline is "Realized P&L (closed trades)"; open
 * positions are a separate count (we never invent an unrealized number); the
 * error state never renders as flat 0.00 (it hides the metrics so a fetch
 * failure can't be misread as a no-activity day).
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { useEffect, useMemo, useRef } from 'react';

import { usePaperTrades } from '../hooks/usePaperTrades.js';
import { getChartTheme } from '../lib/chartTheme';
import { formatPnl } from '../lib/format.js';
import { type PnlSeriesPoint, computePnlSummary } from '../lib/pnl.js';
import { useThemeStore } from '../store/theme';
import { Card, CardHeader } from './ui/Card';
import { SkeletonRows } from './ui/Skeleton';
import { StatCard } from './ui/StatCard';
import { StateMessage } from './ui/StateMessage';

function pnlTone(value: number): 'positive' | 'negative' | 'muted' {
  if (value > 0) return 'positive';
  if (value < 0) return 'negative';
  return 'muted';
}

/** Cumulative realized-P&L line, theme-aware (recolors on theme toggle). */
function CumulativeChart({ series }: { series: PnlSeriesPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const theme = useThemeStore((s) => s.theme);

  // Create the chart + series + ResizeObserver once on mount.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const chart = createChart(container, {
      width: container.clientWidth,
      height: 220,
      layout: { background: { color: 'transparent' }, textColor: '#888' },
      grid: { vertLines: { color: 'transparent' }, horzLines: { color: 'transparent' } },
      timeScale: { rightOffset: 2 },
    });
    const lineSeries = chart.addLineSeries({
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
    });
    chartRef.current = chart;
    seriesRef.current = lineSeries;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(container);

    return () => {
      seriesRef.current = null;
      chartRef.current = null;
      observer.disconnect();
      chart.remove();
    };
  }, []);

  // Apply theme colors on mount and whenever the theme flips.
  useEffect(() => {
    const chart = chartRef.current;
    const lineSeries = seriesRef.current;
    if (chart === null || lineSeries === null) return;
    const t = getChartTheme(theme);
    chart.applyOptions({
      layout: { background: { color: 'transparent' }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
    lineSeries.applyOptions({ color: t.positive });
  }, [theme]);

  // Push data into the existing series whenever it changes.
  useEffect(() => {
    const lineSeries = seriesRef.current;
    if (lineSeries === null) return;
    if (series.length > 0) {
      lineSeries.setData(series);
      chartRef.current?.timeScale().fitContent();
    }
  }, [series]);

  return (
    <div
      ref={containerRef}
      className="w-full"
      style={{ minHeight: 220 }}
      aria-label="Cumulative P&L chart"
    />
  );
}

export function PnlView() {
  const { trades, loading, error } = usePaperTrades();
  const summary = useMemo(() => computePnlSummary(trades), [trades]);
  const hasClosed = summary.closedCount > 0;

  return (
    <div className="space-y-5">
      {loading && trades.length === 0 && (
        <Card>
          <CardHeader title="P&L Summary" />
          <SkeletonRows rows={4} />
        </Card>
      )}

      {error !== null && (
        <StateMessage
          variant="error"
          title="Couldn't load P&L data — retrying…"
          description={error}
        />
      )}

      {!loading && error === null && !hasClosed && (
        <Card>
          <CardHeader title="P&L Summary" />
          <StateMessage
            variant="empty"
            title="No closed trades yet"
            description={
              summary.openCount > 0
                ? `Realized P&L appears once a position closes. ${summary.openCount} open position${summary.openCount !== 1 ? 's' : ''} currently running.`
                : 'Realized P&L will appear once the first position is closed.'
            }
          />
        </Card>
      )}

      {hasClosed && (
        <>
          {/* Hero realized P&L */}
          <Card>
            <p className="text-xs font-medium uppercase tracking-wider text-faint">
              Realized P&L · closed trades
            </p>
            <p
              className={`metric mt-1 text-4xl font-semibold tracking-tight ${
                summary.totalRealizedPnl > 0
                  ? 'text-positive'
                  : summary.totalRealizedPnl < 0
                    ? 'text-negative'
                    : 'text-foreground'
              }`}
            >
              {formatPnl(summary.totalRealizedPnl)}
            </p>
            <p className="mt-1 text-sm text-muted">
              Across {summary.closedCount} closed trade{summary.closedCount !== 1 ? 's' : ''} ·{' '}
              {(summary.winRate * 100).toFixed(1)}% win rate
            </p>
          </Card>

          {/* Secondary metrics */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="Today's P&L (IST)"
              value={formatPnl(summary.todayRealizedPnl)}
              tone={pnlTone(summary.todayRealizedPnl)}
            />
            <StatCard label="Win Rate" value={`${(summary.winRate * 100).toFixed(1)}%`} />
            <StatCard label="Closed Trades" value={summary.closedCount} />
            <StatCard
              label="Open Positions"
              value={summary.openCount}
              note="Unrealized P&L not shown"
              tone="muted"
            />
          </div>

          {/* Cumulative chart */}
          <Card>
            <CardHeader
              title="Cumulative Realized P&L"
              description="Running net across closed trades"
            />
            <CumulativeChart series={summary.cumulativeSeries} />
          </Card>
        </>
      )}
    </div>
  );
}
