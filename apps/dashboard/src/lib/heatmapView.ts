/**
 * Pure helpers for Options Lab › Heatmap (BL-094). The P&L is computed by the Python package
 * (`heatmap/grid.py`, stored by `obt heatmap build`); this file only chooses the colour of a cell
 * and the words around it. Profit and loss use the positive / negative tokens, as everywhere else
 * a rupee figure is shown; intensity is the cell's size against the biggest cell on screen.
 */

import type { HeatmapCell, HeatmapMetric, HeatmapResponse } from '../types/heatmap';
import { formatNumber, formatPct } from './format';

export const VIEW_LABEL = {
  time_sl: 'Time vs SL',
  date_time: 'Date vs Time',
  date_sl: 'Date vs SL',
} as const;

const POSITIVE = [
  'bg-positive/10',
  'bg-positive/20',
  'bg-positive/30',
  'bg-positive/45',
  'bg-positive/60',
] as const;
const NEGATIVE = [
  'bg-negative/10',
  'bg-negative/20',
  'bg-negative/30',
  'bg-negative/45',
  'bg-negative/60',
] as const;

/** Tailwind class for a cell: 5 steps of intensity against `maxAbs`, none for a missing cell. */
export function cellClass(value: number | null | undefined, maxAbs: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'bg-surface-2';
  if (value === 0 || maxAbs <= 0) return 'bg-surface-2';
  const step = Math.min(4, Math.floor((Math.abs(value) / maxAbs) * 5));
  return (value > 0 ? POSITIVE : NEGATIVE)[step] ?? 'bg-surface-2';
}

export function maxAbsOf(cells: readonly (readonly (HeatmapCell | null)[])[]): number {
  let max = 0;
  for (const row of cells) for (const c of row) if (c) max = Math.max(max, Math.abs(c.net));
  return max;
}

/** One number in the table's unit: rupees for an index lot, points for a stock, % of premium. */
export function formatCell(value: number, unit: HeatmapResponse['unit']): string {
  if (unit === 'pct_of_premium') return formatPct(value, 1, { unit: 'percent' });
  // no ₹ sign in a cell: the unit is in the heading, and a sign makes a cell wrap
  if (unit === 'inr_per_lot') return formatNumber(value, 0);
  return formatNumber(value, 1);
}

export function unitNote(r: Pick<HeatmapResponse, 'unit' | 'lot' | 'expiry'>): string {
  const expiry = r.expiry === 'weekly' ? 'nearest weekly' : 'monthly';
  if (r.unit === 'pct_of_premium') return `P&L as a share of the premium sold, ${expiry} expiry`;
  if (r.unit === 'inr_per_lot')
    return `Rupees for one lot (${r.lot ?? '?'} units, today's lot size), ${expiry} expiry`;
  return `Points per share (no lot size is held for stock options), ${expiry} expiry`;
}

export function metricLabel(metric: HeatmapMetric): string {
  return metric === 'pct' ? '% of premium' : 'P&L';
}

/** 0 = the expiry week itself; the filter's chips. */
export const WEEK_LABEL: Record<number, string> = {
  0: 'Expiry week',
  1: '1 week out',
  2: '2 weeks out',
  3: '3 weeks out',
  4: '4 weeks out',
  5: '5 weeks out',
};
