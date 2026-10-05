/**
 * One vocabulary for every regime / day-type key the dashboard shows, so the same key reads
 * the same (label, badge tone, glyph, definition) on every tab:
 *
 *   - Options Lab day anatomy (legwise/anatomy.py): QUIET / CHOP / TREND_UP / TREND_DOWN / UNKNOWN
 *   - the live regime tagger, T-33 (apps/server regime-tagging.ts), which is also what the
 *     YAML backtest's `regime_buckets` are keyed by: RANGING / TRENDING_STRONG /
 *     VOLATILE_REVERTING / EVENT_DAY / UNCLASSIFIED
 *
 * Usage: `regimeMeta(key)` for the full entry, `regimeBadge(key)` for what a `<Badge>` needs,
 * or the ready-made `<RegimeBadge regime={key} />` (components/optionslab/regimes).
 *
 * Tone rule (docs/dashboard-design-tokens.md): green and red carry direction or profit/loss
 * and nothing else, so only TREND_UP / TREND_DOWN use them. A non-directional "strong trend"
 * is `primary`, not green. Every entry also has a glyph, so nothing relies on colour alone.
 * The day-anatomy glyphs match the compact chips in components/optionslab/anatomy.tsx.
 */

import type { Tone } from '../components/ui/Badge';

export interface RegimeMeta {
  /** The canonical key (upper snake case). */
  key: string;
  /** Sentence-case label, without the glyph. */
  label: string;
  /** Badge tone (components/ui/Badge). */
  tone: Tone;
  /** One character that carries the meaning without colour. */
  glyph: string;
  /** One or two plain sentences: what makes a day (or part of a day) this regime. */
  definition: string;
}

/** Day-anatomy labels, in the order tables list them. */
export const SEGMENT_REGIMES = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'QUIET'] as const;
/** The live tagger's regimes, in its precedence order. */
export const TRADING_REGIMES = [
  'EVENT_DAY',
  'VOLATILE_REVERTING',
  'TRENDING_STRONG',
  'RANGING',
] as const;

export type RegimeKey =
  | (typeof SEGMENT_REGIMES)[number]
  | (typeof TRADING_REGIMES)[number]
  | 'UNKNOWN'
  | 'UNCLASSIFIED';

function entry(
  key: RegimeKey,
  label: string,
  tone: Tone,
  glyph: string,
  definition: string,
): RegimeMeta {
  return { key, label, tone, glyph, definition };
}

export const REGIME_META: Readonly<Record<RegimeKey, RegimeMeta>> = {
  TREND_UP: entry(
    'TREND_UP',
    'Trend up',
    'positive',
    '↑',
    'The index moved up far more cleanly than a random walk would, and covered a meaningful share of the range India VIX implied.',
  ),
  TREND_DOWN: entry(
    'TREND_DOWN',
    'Trend down',
    'negative',
    '↓',
    'The index moved down far more cleanly than a random walk would, and covered a meaningful share of the range India VIX implied.',
  ),
  CHOP: entry(
    'CHOP',
    'Chop',
    'warning',
    '≈',
    'The index covered a meaningful share of the range India VIX implied, but back and forth, without a clean direction.',
  ),
  QUIET: entry(
    'QUIET',
    'Quiet',
    'neutral',
    '○',
    'The index range stayed well under what India VIX implied for that stretch of the session.',
  ),
  UNKNOWN: entry(
    'UNKNOWN',
    'No VIX',
    'neutral',
    '?',
    'There was no India VIX reading for this stretch, so the move could not be compared with what was implied.',
  ),
  RANGING: entry(
    'RANGING',
    'Ranging',
    'info',
    '↔',
    'Live tagger: a small directional move and little straddle expansion up to 14:30 IST.',
  ),
  TRENDING_STRONG: entry(
    'TRENDING_STRONG',
    'Strong trend',
    'primary',
    '↕',
    'Live tagger: a sustained directional index move (either way) above its threshold, up to 14:30 IST.',
  ),
  VOLATILE_REVERTING: entry(
    'VOLATILE_REVERTING',
    'Volatile, reverting',
    'warning',
    '↺',
    'Live tagger: the straddle whipsawed and then reverted; this takes precedence over a strong trend when both apply.',
  ),
  EVENT_DAY: entry(
    'EVENT_DAY',
    'Event day',
    'accent',
    '◆',
    'Live tagger: the date is in the event calendar (RBI policy, budget and similar); this takes precedence over every other regime.',
  ),
  UNCLASSIFIED: entry(
    'UNCLASSIFIED',
    'Unclassified',
    'neutral',
    '?',
    'Live tagger: too much of the day’s data was missing to classify it reliably.',
  ),
};

/** Every key with a definition, for legends and glossaries. */
export const REGIME_KEYS = Object.keys(REGIME_META) as RegimeKey[];

/** 'trending-strong', ' Trend_Up ' → 'TRENDING_STRONG', 'TREND_UP'. */
export function normaliseRegimeKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .trim()
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
}

export function isKnownRegime(raw: string | null | undefined): boolean {
  return Object.hasOwn(REGIME_META, normaliseRegimeKey(raw));
}

function humanise(key: string): string {
  const words = key.replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The entry for a key, in any casing. A key this map does not know (a new server tag) still
 * renders: neutral tone, a humanised label, and a definition that says it is not documented.
 * A missing key (null / empty) reads as "Not tagged".
 */
export function regimeMeta(raw: string | null | undefined): RegimeMeta {
  const key = normaliseRegimeKey(raw);
  if (key === '') {
    return {
      key: '',
      label: 'Not tagged',
      tone: 'neutral',
      glyph: '·',
      definition: 'No regime was recorded for this day.',
    };
  }
  if (Object.hasOwn(REGIME_META, key)) return REGIME_META[key as RegimeKey];
  return {
    key,
    label: humanise(key),
    tone: 'neutral',
    glyph: '□',
    definition: 'This regime tag has no definition in the dashboard yet.',
  };
}

export interface RegimeBadgeProps {
  tone: Tone;
  /** Label without the glyph ("Trend up"). */
  label: string;
  glyph: string;
  /** Glyph + label, the text a badge shows ("▲ Trend up"). */
  text: string;
  /** The definition, for a `title` or tooltip. */
  title: string;
}

/** What a `<Badge>` needs to show a regime: `<Badge tone={b.tone} title…>{b.text}</Badge>`. */
export function regimeBadge(raw: string | null | undefined): RegimeBadgeProps {
  const meta = regimeMeta(raw);
  return {
    tone: meta.tone,
    label: meta.label,
    glyph: meta.glyph,
    text: `${meta.glyph} ${meta.label}`,
    title: meta.definition,
  };
}
