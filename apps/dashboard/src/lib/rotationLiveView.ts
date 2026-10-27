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

/** The live state of one Daily log day, for one book (dashboard review, 2026-10-28). */
export interface LogLive {
  state: 'before' | 'waiting' | 'not_captured' | 'captured';
  /** Σ slippage ÷ Σ strategies over the book's groups: live − paper per lot-day, after costs. */
  perLotDay: number | null;
  /** One line per platform + broker, and the day's flags, for the tooltip. */
  detail: string;
}

/**
 * Where a Daily log row stands against the 15:40 live capture, for `book` (`core` for Adaptive
 * Classic): before the first captured day, waiting (after the newest one, the evening not read
 * yet), not captured (a gap between captured days), or captured with the book's slippage per
 * lot-day. Both sides are after the same estimated costs, which is why the log shows the gap and
 * not live beside its gross paper figure. A missing figure is a state, never a zero.
 */
export function liveForLog(
  data: RotationLiveResponse | null,
  day: string,
  book = 'core',
): LogLive | null {
  // A response of another shape (an error page, a proxy reply) is no answer, never a crash.
  if (data === null || !Array.isArray(data.captured_days) || !Array.isArray(data.days)) return null;
  const captured = [...data.captured_days].sort();
  const first = captured[0];
  const last = captured[captured.length - 1];
  const entry = data.days.find((d) => d.day === day);
  if (!entry) {
    if (first === undefined || day < first) {
      return { state: 'before', perLotDay: null, detail: 'Before the live capture began' };
    }
    if (last !== undefined && day > last) {
      return { state: 'waiting', perLotDay: null, detail: 'The 15:40 capture has not read it yet' };
    }
    return { state: 'not_captured', perLotDay: null, detail: 'Not captured: no live file' };
  }
  if (!entry.captured) {
    return { state: 'not_captured', perLotDay: null, detail: 'Not captured: no live file' };
  }
  const groups = entry.groups.filter((g) => g.book === book);
  const variants = groups.reduce((n, g) => n + g.variants, 0);
  const slip = groups.reduce((n, g) => n + g.slippage, 0);
  const lines = groups.map(
    (g) =>
      `${groupLabel(g)}: live ${formatInr(g.live, { sign: true })}, paper ${formatInr(g.paper, { sign: true })}, slippage ${slippageText(g.slippage, g.slippage_pct)} over ${g.variants} ${g.variants === 1 ? 'strategy' : 'strategies'} (a lot each, after costs)`,
  );
  const badges = dayBadges(entry).map((b) => b.text);
  const detail = [
    ...(lines.length ? lines : ['None of this book’s strategies was compared that day']),
    ...(badges.length ? [`Day flags: ${badges.join(', ')}`] : []),
  ].join('\n');
  return { state: 'captured', perLotDay: variants > 0 ? slip / variants : null, detail };
}
