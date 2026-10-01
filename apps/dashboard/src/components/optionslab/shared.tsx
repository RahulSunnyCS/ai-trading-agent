/**
 * Pieces shared by the Options Lab's Results and Builder panels: a
 * multi-line cumulative-P&L chart, a trade log, and small form controls.
 */

import { createChart } from 'lightweight-charts';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import { type ReactNode, useEffect, useRef } from 'react';

import { getChartTheme } from '../../lib/chartTheme';
import { formatPnl } from '../../lib/format';
import { useThemeStore } from '../../store/theme';
import type { DayRow, TradeRow } from '../../types/legwise';
import { THead, TRow, Table, Td, Th } from '../ui/Table';

export const SERIES_COLORS = ['#3b82f6', '#f59e0b', '#10b981', '#ef4444', '#8b5cf6', '#ec4899'];

export function pnlClass(value: number): string {
  if (value > 0) return 'text-positive';
  if (value < 0) return 'text-negative';
  return 'text-muted';
}

export interface StrategyStats {
  total: number;
  days: number;
  up: number;
  maxDrawdown: number;
  cumulative: { time: string; value: number }[];
}

export function statsOf(days: Pick<DayRow, 'day' | 'net'>[]): StrategyStats {
  const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const cumulative = sorted.map((d) => {
    running += d.net;
    peak = Math.max(peak, running);
    maxDrawdown = Math.min(maxDrawdown, running - peak);
    return { time: d.day, value: Math.round(running) };
  });
  return {
    total: running,
    days: sorted.length,
    up: sorted.filter((d) => d.net > 0).length,
    maxDrawdown,
    cumulative,
  };
}

/** One line per strategy, theme-aware, keyed by strategy id. */
export function CumulativeLines({
  lines,
}: { lines: { id: string; points: StrategyStats['cumulative'] }[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const theme = useThemeStore((s) => s.theme);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = createChart(container, {
      width: container.clientWidth,
      height: 260,
      layout: { background: { color: 'transparent' }, textColor: '#888' },
      timeScale: { rightOffset: 1 },
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
      layout: { background: { color: 'transparent' }, textColor: t.text },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
  }, [theme]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    for (const s of seriesRef.current) chart.removeSeries(s);
    seriesRef.current = lines.map((line, i) => {
      const series = chart.addLineSeries({
        color: SERIES_COLORS[i % SERIES_COLORS.length] ?? '#3b82f6',
        lineWidth: 2,
        title: line.id,
        priceLineVisible: false,
      });
      series.setData(line.points);
      return series;
    });
    chart.timeScale().fitContent();
  }, [lines]);

  return <div ref={containerRef} className="w-full" style={{ minHeight: 260 }} />;
}

export function TradeLog({ trades }: { trades: TradeRow[] }) {
  if (trades.length === 0) return <p className="text-sm text-muted">No trades that day.</p>;
  return (
    <Table>
      <THead>
        <Th>Leg</Th>
        <Th>Contract</Th>
        <Th align="right">Entry</Th>
        <Th align="right">Exit</Th>
        <Th>Reason</Th>
        <Th align="right">P&L</Th>
      </THead>
      <tbody>
        {trades.map((t, i) => (
          <TRow key={`${t.leg}-${t.entry}-${i}`}>
            <Td>{t.leg}</Td>
            <Td>{t.contract}</Td>
            <Td align="right" numeric>
              {t.entry} @ {t.entry_price.toFixed(2)}
            </Td>
            <Td align="right" numeric>
              {t.exit ?? '--:--'} @ {t.exit_price?.toFixed(2) ?? '—'}
            </Td>
            <Td>{t.reason}</Td>
            <Td align="right" numeric className={pnlClass(t.pnl)}>
              {formatPnl(t.pnl)}
            </Td>
          </TRow>
        ))}
      </tbody>
    </Table>
  );
}

const INPUT =
  'rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-sm text-foreground disabled:opacity-50';

/** A captioned group that can contain multiple controls. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1 text-xs text-muted">
      <legend>{label}</legend>
      {children}
    </fieldset>
  );
}

export function TextInput(props: {
  value: string;
  onChange: (v: string) => void;
  type?: 'text' | 'time' | 'date';
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      className={`${INPUT} ${props.className ?? ''}`}
    />
  );
}

export function NumberInput(props: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  disabled?: boolean;
  step?: number;
  className?: string;
}) {
  return (
    <input
      type="number"
      value={props.value ?? ''}
      step={props.step ?? 1}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      className={`${INPUT} w-24 ${props.className ?? ''}`}
    />
  );
}

export function Select<T extends string>(props: {
  value: T;
  options: readonly (T | { value: T; label: string })[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <select
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value as T)}
      className={INPUT}
    >
      {props.options.map((o) => {
        const value = typeof o === 'string' ? o : o.value;
        const label = typeof o === 'string' ? o : o.label;
        return (
          <option key={value} value={value}>
            {label}
          </option>
        );
      })}
    </select>
  );
}
