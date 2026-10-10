/**
 * Pure helpers for the Correlation tab's "Today's basket" preset (BL-058 Phase 4, widget 6). The
 * statistics come from the Python package; this file chooses the controls' options and turns the
 * response into short, plain sentences. No `Math.random`, no network.
 */

import type { CorrelationResponse } from '../types/legwise';
import type {
  BasketListKey,
  BasketPick,
  BasketSource,
  BasketWindowId,
  RotationBasketResponse,
} from '../types/rotationBasket';
import { type PairRef, diversificationNote } from './correlationView';

export const BASKET_LIST_OPTIONS: { value: BasketListKey; label: string }[] = [
  { value: 'A', label: 'A' },
  { value: 'B', label: 'B' },
  { value: 'C', label: 'C' },
  { value: 'REF', label: 'REF' },
  { value: 'BASE', label: 'Base' },
];

export const BASKET_WINDOW_OPTIONS: { value: BasketWindowId; label: string }[] = [
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'last63', label: 'Last 63' },
  { value: 'forward', label: 'Forward' },
];

const LISTS: readonly BasketListKey[] = ['A', 'B', 'C', 'REF', 'BASE'];
const WINDOWS: readonly BasketWindowId[] = ['P1', 'P2', 'last63', 'forward'];

export function asBasketList(raw: string | null): BasketListKey {
  return LISTS.find((k) => k === raw) ?? 'A';
}

export function asBasketWindow(raw: string | null): BasketWindowId {
  return WINDOWS.find((k) => k === raw) ?? 'P1';
}

/** Where the picks came from, in words, and a tone for the badge. */
export function sourceBadge(
  source: BasketSource,
  late: boolean,
): { label: string; tone: 'primary' | 'neutral' | 'warning' } {
  if (source === 'base') return { label: 'Fixed base', tone: 'neutral' };
  if (source === 'reconstructed') return { label: 'Reconstructed', tone: 'neutral' };
  return late
    ? { label: 'Recorded late', tone: 'warning' }
    : { label: 'Recorded', tone: 'primary' };
}

export function sourceNote(source: BasketSource, late: boolean): string {
  if (source === 'base')
    return 'The owner’s fixed reference: 2 × Widesl OTM1 09:17 and 1 × Dir ATM 09:24, traded every day with no ranking.';
  if (source === 'reconstructed')
    return 'No entry was recorded for this day. The picks are what the rule gives from the results before it, using the same scoring as the 09:16 job.';
  return late
    ? 'Recorded after 09:17, so it is not a forward day: it is shown, and left out of the Forward window.'
    : 'The picks the 09:16 job recorded in the hash-chained journal.';
}

export function familyWord(p: BasketPick): string {
  if (p.kind === 'wide') return 'Widesl';
  if (p.kind === 'dir') return 'Dir';
  if (p.kind === 'buy') return 'Buy';
  return '';
}

/** One pair's losing days: how often they lost on the same day, out of the days either lost. */
export interface PairLoss {
  a: string;
  b: string;
  both: number;
  either: number;
  /** both / either, or null when neither ever lost. */
  share: number | null;
  r: number | null;
}

/** Indexes of the columns that are their own strategy (not a repeat by construction). */
function distinct(names: readonly string[], duplicates: readonly string[]): number[] {
  return names.flatMap((n, i) => (duplicates.includes(n) ? [] : [i]));
}

export function lossPairs(r: CorrelationResponse, duplicates: readonly string[] = []): PairLoss[] {
  // the diagonal of the both-lose matrix is each strategy's own count of losing days
  const lost = r.names.map((_, i) => r.both_lose_days[i]?.[i] ?? 0);
  const keep = distinct(r.names, duplicates);
  const out: PairLoss[] = [];
  for (const i of keep) {
    for (const j of keep) {
      if (j <= i) continue;
      const both = r.both_lose_days[i]?.[j] ?? 0;
      const either = (lost[i] ?? 0) + (lost[j] ?? 0) - both;
      out.push({
        a: r.names[i] ?? '',
        b: r.names[j] ?? '',
        both,
        either,
        share: either > 0 ? both / either : null,
        r: r.pearson[i]?.[j] ?? null,
      });
    }
  }
  return out;
}

/**
 * The pairs of distinct strategies as correlations: the average, the most alike pair and the
 * least alike, leaving out a column that repeats another by construction (its 1.00 says nothing).
 */
export function pairSummary(
  r: CorrelationResponse,
  duplicates: readonly string[] = [],
): { average: number | null; most: PairRef | null; low: number | null; count: number } {
  const keep = distinct(r.names, duplicates);
  const values: { a: string; b: string; value: number }[] = [];
  for (const i of keep) {
    for (const j of keep) {
      const v = j > i ? r.pearson[i]?.[j] : null;
      if (typeof v === 'number')
        values.push({ a: r.names[i] ?? '', b: r.names[j] ?? '', value: v });
    }
  }
  if (values.length === 0) return { average: null, most: null, low: null, count: 0 };
  const most = values.reduce((m, p) => (p.value > m.value ? p : m));
  return {
    average: values.reduce((s, p) => s + p.value, 0) / values.length,
    most,
    low: Math.min(...values.map((p) => p.value)),
    count: values.length,
  };
}

/**
 * Basket drawdown against the sum of the parts: how many percent shallower (positive) or deeper
 * (negative) holding them together was than running each alone. Null when no part ever drew down.
 */
export function drawdownSaving(r: CorrelationResponse): number | null {
  const parts = r.basket.sum_of_part_dds;
  if (!Number.isFinite(parts) || parts >= -1e-9) return null;
  return (1 - r.basket.max_dd / parts) * 100;
}

/** The one-paragraph reading under the cards: what the numbers say, and what they do not. */
export function readingLine(b: RotationBasketResponse): string {
  const r = b.correlation;
  if (!r) return '';
  const { average, most, low, count } = pairSummary(r, b.duplicates);
  const saving = drawdownSaving(r);
  const sentences: string[] = [];
  if (average !== null && most !== null && low !== null) {
    const closeToIndependent = average < 0.3 && most.value < 0.6;
    if (count === 1) {
      sentences.push(
        `The two strategies' daily P&L correlate ${signed(most.value)}, ${
          most.value < 0.6 ? 'below' : 'at or above'
        } the 0.60 line the tab calls alike.`,
      );
    } else if (closeToIndependent) {
      sentences.push(
        `These picks are close to independent: their correlations run from ${signed(low)} to ${signed(most.value)}, below the 0.60 line the tab calls alike.`,
      );
    } else {
      sentences.push(
        `Some of these picks are look-alikes: the most alike pair is ${signed(most.value)} (${most.a} ~ ${most.b}), at or above the 0.60 line the tab calls alike.`,
      );
    }
  }
  if (saving !== null) {
    sentences.push(
      saving >= 0
        ? `Held together they drew down ${Math.round(saving)}% less than the same strategies run alone.`
        : `Held together they drew down ${Math.round(-saving)}% more than the sum of the parts.`,
    );
  } else {
    sentences.push(diversificationNote(r.basket.dd_ratio));
  }
  sentences.push(
    `This describes ${r.n_days} days that have already happened; it does not forecast the next ones.`,
  );
  return sentences.join(' ');
}

function signed(v: number): string {
  const text = Math.abs(v).toFixed(2);
  if (v > 0) return `+${text}`;
  if (v < 0) return `−${text}`;
  return text;
}

/** The names the Correlation tab's picker can take: a rotation variant, not the base's Dir leg. */
export function customNames(b: RotationBasketResponse): string[] | null {
  if (b.list === 'BASE') return null;
  return b.picks.map((p) => p.name);
}
