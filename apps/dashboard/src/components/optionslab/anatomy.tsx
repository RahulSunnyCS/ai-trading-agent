/**
 * Shared display for "day anatomy" segment labels (legwise/anatomy.py): the
 * label → badge mapping, and a compact chip strip used in the day grid, the
 * forensics panel and the market-regimes tab.
 */

import { cn } from '../../lib/cn';
import { EMPTY, formatMultiple, formatPct } from '../../lib/format';
import { REGIME_META } from '../../lib/regimeMeta';
import type { AnatomySegment, DayAnatomy, SegmentLabel } from '../../types/legwise';
import { Badge, type Tone } from '../ui/Badge';

const LABELS: SegmentLabel[] = ['TREND_UP', 'TREND_DOWN', 'CHOP', 'QUIET', 'UNKNOWN'];

function fromMeta<T>(pick: (label: SegmentLabel) => T): Record<SegmentLabel, T> {
  return Object.fromEntries(LABELS.map((l) => [l, pick(l)])) as Record<SegmentLabel, T>;
}

// Tone, text and glyph all come from lib/regimeMeta.ts, the one vocabulary every tab uses,
// so a label reads the same here as on the Market regimes tab.
export const LABEL_TONE: Record<SegmentLabel, Tone> = fromMeta((l) => REGIME_META[l].tone);

export const LABEL_TEXT: Record<SegmentLabel, string> = fromMeta((l) => REGIME_META[l].label);

/**
 * Short glyph form for tight spaces (grid rows). Every label has its own glyph and none of
 * them is NO_SEGMENT, so "quiet" never reads as "no data".
 */
export const LABEL_GLYPH: Record<SegmentLabel, string> = fromMeta((l) => REGIME_META[l].glyph);

/** What a segment with no index data renders as. */
export const NO_SEGMENT = '·';

/** The one legend for the day-type glyphs and colours, shown near anything that uses them. */
export function DayTypeLegend({ className }: { className?: string }) {
  return (
    <ul
      aria-label="Day type legend"
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted', className)}
    >
      {LABELS.map((label) => (
        <li
          key={label}
          className="inline-flex items-center gap-1.5"
          title={REGIME_META[label].definition}
        >
          <Badge tone={LABEL_TONE[label]} className="px-1.5 py-0 text-[11px]">
            <span aria-hidden="true">{LABEL_GLYPH[label]}</span>
          </Badge>
          {LABEL_TEXT[label]}
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <span className="px-1.5 text-faint" aria-hidden="true">
          {NO_SEGMENT}
        </span>
        No data
      </li>
    </ul>
  );
}

export function describeSegment(s: AnatomySegment): string {
  const ratio = s.range_over_implied === null ? 'n/a' : formatMultiple(s.range_over_implied, 2);
  return `${s.start}–${s.end}: ${LABEL_TEXT[s.label]} · move ${formatPct(s.ret_pct, 2, { sign: true, unit: 'percent' })} · range ${formatPct(s.range_pct, 2, { unit: 'percent' })} (${ratio} of VIX-implied) · directional strength ${formatMultiple(s.strength, 1)} a random walk`;
}

/** One small chip per segment, in session order. The tooltip carries the numbers. */
export function SegmentChips({ anatomy }: { anatomy: DayAnatomy | undefined }) {
  if (!anatomy) return <span className="text-faint">{EMPTY}</span>;
  return (
    <span className="inline-flex gap-1">
      {anatomy.segments.map((s, i) =>
        s ? (
          <Badge
            key={`${anatomy.day}-${s.start}`}
            tone={LABEL_TONE[s.label]}
            className="px-1.5 py-0 text-[11px]"
          >
            <span role="img" title={describeSegment(s)} aria-label={LABEL_TEXT[s.label]}>
              {LABEL_GLYPH[s.label]}
            </span>
          </Badge>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional placeholder, never reordered
          <span key={i} className="px-1.5 text-faint" title="No index data for this segment">
            {NO_SEGMENT}
          </span>
        ),
      )}
    </span>
  );
}
