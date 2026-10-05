/**
 * Shared display for "day anatomy" segment labels (legwise/anatomy.py): the
 * label → badge mapping, and a compact chip strip used in the day grid, the
 * forensics panel and the market-regimes tab.
 */

import { formatMultiple, formatPct } from '../../lib/format';
import type { AnatomySegment, DayAnatomy, SegmentLabel } from '../../types/legwise';
import { Badge, type Tone } from '../ui/Badge';

export const LABEL_TONE: Record<SegmentLabel, Tone> = {
  TREND_UP: 'positive',
  TREND_DOWN: 'negative',
  CHOP: 'warning',
  QUIET: 'neutral',
  UNKNOWN: 'neutral',
};

export const LABEL_TEXT: Record<SegmentLabel, string> = {
  TREND_UP: 'Trend ↑',
  TREND_DOWN: 'Trend ↓',
  CHOP: 'Chop',
  QUIET: 'Quiet',
  UNKNOWN: 'No VIX',
};

/** Short glyph form for tight spaces (heatmap cells, grid rows). */
export const LABEL_GLYPH: Record<SegmentLabel, string> = {
  TREND_UP: '↑',
  TREND_DOWN: '↓',
  CHOP: '≈',
  QUIET: '·',
  UNKNOWN: '?',
};

export function describeSegment(s: AnatomySegment): string {
  const ratio = s.range_over_implied === null ? 'n/a' : formatMultiple(s.range_over_implied, 2);
  return `${s.start}–${s.end}: ${LABEL_TEXT[s.label]} · move ${formatPct(s.ret_pct, 2, { sign: true, unit: 'percent' })} · range ${formatPct(s.range_pct, 2, { unit: 'percent' })} (${ratio} of VIX-implied) · directional strength ${formatMultiple(s.strength, 1)} a random walk`;
}

/** One small chip per segment, in session order. The tooltip carries the numbers. */
export function SegmentChips({ anatomy }: { anatomy: DayAnatomy | undefined }) {
  if (!anatomy) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex gap-1">
      {anatomy.segments.map((s, i) =>
        s ? (
          <Badge
            key={`${anatomy.day}-${s.start}`}
            tone={LABEL_TONE[s.label]}
            className="px-1.5 py-0 text-[11px]"
          >
            <span title={describeSegment(s)}>{LABEL_GLYPH[s.label]}</span>
          </Badge>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: positional placeholder, never reordered
          <span key={i} className="text-faint">
            ·
          </span>
        ),
      )}
    </span>
  );
}
