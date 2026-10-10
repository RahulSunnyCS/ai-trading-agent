/**
 * Pure helpers for the "Forward days vs research periods" card (BL-058 Phase 4, widget 7). The
 * mixes and distances come from the Python package; this file shapes them for reading: shares,
 * shades, quantile text and the plain-words reading. No `Math.random`, no network.
 */

import type {
  RegimeMix,
  RegimeQuantiles,
  RegimeRowKey,
  RotationRegimeResponse,
} from '../types/rotationRegime';
import { formatNumber } from './format';

export const PERIOD_SHORT: Record<string, string> = {
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
  forward: 'Forward',
};

/** Each category's share of the sessions, in order; all zero for an empty period. */
export function shares(mix: RegimeMix): number[] {
  const total = mix.counts.reduce((s, c) => s + c, 0);
  return mix.counts.map((c) => (total > 0 ? c / total : 0));
}

/** An opacity for the i-th of n categories: light to dark, never fully transparent. */
export function shade(i: number, n: number): number {
  return n <= 1 ? 0.6 : 0.18 + (0.72 * i) / (n - 1);
}

/** "P10 · median · P90", or an em dash when there is nothing to show. */
export function quantileText(q: RegimeQuantiles | null, dp: number, unit = ''): string {
  if (!q || q.n === 0 || q.p10 === null || q.p50 === null || q.p90 === null) return '—';
  const f = (v: number) => `${formatNumber(v, dp)}${unit}`;
  return `${f(q.p10)} · ${f(q.p50)} · ${f(q.p90)}`;
}

/** Which period a row is nearest to, in words. */
export function closerText(closer: string | null): string {
  if (closer === null) return '—';
  if (closer === 'neither') return 'neither';
  return PERIOD_SHORT[closer] ?? closer;
}

/** The label of a row's category with its count, for a bar segment's tooltip. */
export function segmentTitle(category: string, count: number, share: number): string {
  return `${category}: ${count} sessions (${formatNumber(share * 100, 0)}%)`;
}

const ROW_SHORT: Record<RegimeRowKey, string> = {
  vix_band: 'VIX band',
  dte_n: 'NIFTY days to expiry',
  dte_s: 'SENSEX days to expiry',
  weekday: 'weekday',
};

/**
 * The one-paragraph reading under the card: the overall nearer period and which rows disagree
 * with it, and what a distance is and is not.
 */
export function readingLine(d: RotationRegimeResponse): string {
  if (d.distances === null) return '';
  const { overall, closer, rows, tie } = d.distances;
  const parts: string[] = [];
  const figures = Object.entries(overall)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${PERIOD_SHORT[k] ?? k} ${formatNumber(v, 2)}`)
    .join(', ');
  if (closer === 'neither') {
    parts.push(
      `The forward mix is not clearly nearer either period (average distance ${figures}; a gap under ${formatNumber(tie, 2)} is not called a difference).`,
    );
  } else if (closer !== null) {
    parts.push(
      `On average the forward mix is nearer ${PERIOD_SHORT[closer] ?? closer} (average distance ${figures}).`,
    );
  }
  const split = rows.filter((r) => r.closer && r.closer !== 'neither' && r.closer !== closer);
  if (split.length > 0 && closer !== null) {
    parts.push(
      `By row it differs: ${split
        .map((r) => `${ROW_SHORT[r.key]} is nearer ${PERIOD_SHORT[r.closer ?? ''] ?? r.closer}`)
        .join('; ')}.`,
    );
  }
  parts.push(
    d.thin
      ? `With ${d.forward_days} forward sessions the forward mix is itself noisy: this describes the window so far, it is not evidence about the lists.`
      : 'A distance describes the markets; it does not test the lists.',
  );
  return parts.join(' ');
}
