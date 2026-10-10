/**
 * Pure helpers for the "Selection drift" card (BL-058 Phase 4, widget 9). The shares, bands and
 * flags come from the Python package; this file only lays them out and words them. No
 * `Math.random`, no network.
 */

import type {
  DriftFlag,
  DriftMeasure,
  DriftWindowId,
  RotationDriftResponse,
} from '../types/rotationDrift';
import { formatDay, formatInt, formatPct } from './format';

export const ROW_LABEL: Record<DriftWindowId, string> = {
  history: 'P1',
  last63: 'Last 63',
  last21: 'Last 21',
};
export const ROWS: readonly DriftWindowId[] = ['history', 'last63', 'last21'];

/** "0.72 to 0.81" as "72% to 81%". */
export function bandText(b: { p10: number; p90: number } | null): string {
  if (!b) return 'no band yet';
  return `${formatPct(b.p10, 0)} to ${formatPct(b.p90, 0)}`;
}

/** The flag in a sentence: "SENSEX 100% over the last 21, above its usual 38% to 51%". */
export function flagText(f: DriftFlag): string {
  return `${f.label} ${formatPct(f.share, 0)} over the last 21, ${
    f.direction === 'above' ? 'above' : 'below'
  } its usual ${formatPct(f.p10, 0)} to ${formatPct(f.p90, 0)}`;
}

/** A concentration row's value in words (the most-picked row names the variant). */
export function measureValue(m: DriftMeasure): string {
  if (m.last21 === null) return '—';
  const n = formatInt(m.last21);
  return m.key === 'most_picked' && m.name ? `${n} · ${m.name}` : n;
}

export function measureBand(m: DriftMeasure): string {
  return m.band ? `${formatInt(m.band.p10)} to ${formatInt(m.band.p90)}` : '—';
}

/** The reading under the card. */
export function readingLine(d: RotationDriftResponse): string {
  if (!d.enough) {
    return `Fewer than ${d.short} sessions, or too little history for a band: the card shows what the list held, and flags nothing.`;
  }
  const flags = d.dimensions.flatMap((dim) => dim.flags.map((f) => `${dim.label}: ${flagText(f)}`));
  const measures = d.concentration.filter((m) => m.flag).map((m) => `${m.label} (${m.flag})`);
  const parts: string[] = [];
  if (flags.length === 0 && measures.length === 0) {
    parts.push(
      `Over the last ${d.short} sessions nothing sits outside the range this list had in ${d.history_label}.`,
    );
  } else {
    if (flags.length > 0) parts.push(`Outside its own usual range: ${flags.join('; ')}.`);
    if (measures.length > 0)
      parts.push(`Concentration outside its usual range: ${measures.join(', ')}.`);
  }
  parts.push(
    'A flag asks for a look, nothing more: the band is where this list sat in the period its weights were fitted on, so a change is a description, not a fault.',
  );
  return parts.join(' ');
}

/** The span line under a row's label: "202 sessions, all re-scored". */
export function spanText(d: RotationDriftResponse, w: DriftWindowId): string {
  const s = d.windows[w];
  if (s.n_days === 0) return 'no sessions';
  const kind =
    s.recorded === 0
      ? 'all re-scored'
      : s.reconstructed === 0
        ? 'all recorded'
        : `${formatInt(s.recorded)} recorded, ${formatInt(s.reconstructed)} re-scored`;
  const range = s.from && s.to ? `${formatDay(s.from)} – ${formatDay(s.to)}` : '';
  return `${formatInt(s.n_days)} sessions, ${kind}${range ? ` · ${range}` : ''}`;
}
