/**
 * Pure helpers for the Rotation page's "Live vs paper" card (BL-141). Every figure comes from the
 * Python package (`rotation/live_compare.py`); this file only names, orders and words them. No
 * network, no `Math.random`.
 */

import type { Tone } from '../components/ui/Badge';
import type { LiveDay, LiveShape, RotationLiveResponse } from '../types/rotationLive';
import { EMPTY, formatInr, formatPct } from './format';

const PLATFORM: Record<string, string> = { algotest: 'AlgoTest', quantiply: 'Quantiply' };
const BROKER: Record<string, string> = { finvasia: 'Shoonya', angelone: 'Angel One' };
const BOOK: Record<string, string> = { t1: 'T1', core: 'Core' };

/** "AlgoTest · Shoonya · T1": AlgoTest's own "all" broker is left out. */
export function groupLabel(g: { platform: string; broker: string; book: string | null }): string {
  const platform = PLATFORM[g.platform] ?? g.platform;
  const broker =
    g.platform === 'algotest' && g.broker === 'all' ? null : (BROKER[g.broker] ?? g.broker);
  const book = g.book ? (BOOK[g.book] ?? g.book.toUpperCase()) : null;
  return [platform, broker, book].filter((x) => x !== null).join(' · ');
}

export function platformLabel(platform: string): string {
  return PLATFORM[platform] ?? platform;
}

export function groupKey(g: { platform: string; broker: string; book: string | null }): string {
  return `${g.platform}.${g.broker}.${g.book ?? ''}`;
}

/** Slippage as "+₹1,234" / "−₹56", with the percentage where fills are known. */
export function slippageText(value: number | null, pct: number | null = null): string {
  if (value === null) return EMPTY;
  const inr = formatInr(value, { sign: true });
  return pct === null ? inr : `${inr} (${formatPct(pct, 1, { unit: 'percent', sign: true })})`;
}

/** The chart: one line per group, cumulative slippage; empty before the first compared day. */
export function chartLines(
  r: RotationLiveResponse,
): { id: string; points: { time: string; value: number }[] }[] {
  return r.running
    .filter((g) => g.points.length > 0)
    .map((g) => ({
      id: groupLabel(g),
      points: g.points.map((p) => ({ time: p.day, value: p.slippage })),
    }));
}

/** Words for the empty state, or null once a day is compared. */
export function emptyState(r: RotationLiveResponse): { title: string; description: string } | null {
  if (r.running.length > 0) return null;
  if (r.days.length === 0) {
    return {
      title: 'No live capture yet',
      description:
        'The 15:40 capture writes one file a day. Figures appear once a captured day has a paper result to compare with.',
    };
  }
  return {
    title: 'No day compared yet',
    description:
      'A captured day appears here once a tool strategy traded and has a stored paper result.',
  };
}

export interface DayBadge {
  tone: Tone;
  text: string;
}

/** What to flag on a day: each is left out of the slippage and listed on its own. */
export function dayBadges(d: LiveDay): DayBadge[] {
  if (!d.captured) return [{ tone: 'warning', text: 'Not captured' }];
  const out: DayBadge[] = [];
  for (const s of d.failed_sections) {
    out.push({ tone: 'warning', text: `${platformLabel(s.platform)} not read` });
  }
  if (d.not_traded.length)
    out.push({ tone: 'neutral', text: `${d.not_traded.length} did not trade` });
  if (d.off_slot.length) out.push({ tone: 'info', text: `${d.off_slot.length} off-slot` });
  if (d.open_legs.length)
    out.push({ tone: 'warning', text: `${d.open_legs.length} with legs open` });
  if (d.no_paper.length)
    out.push({ tone: 'neutral', text: `${d.no_paper.length} no paper result` });
  if (d.unrecognised.length)
    out.push({ tone: 'warning', text: `${d.unrecognised.length} unrecognised` });
  return out;
}

/** Days newest first, for the table. */
export function newestFirst(days: LiveDay[]): LiveDay[] {
  return [...days].reverse();
}

const POSITION: Record<string, string> = { sell: 'Sell', buy: 'Buy' };

export function shapeLabel(s: LiveShape): string {
  return `${platformLabel(s.platform)} · ${POSITION[s.position] ?? s.position} · ${s.band}`;
}

/** Shapes with only one or two variant-days are said to be thin, not hidden. */
export function shapeThin(s: LiveShape): boolean {
  return s.variant_days < 5;
}
