/**
 * A labelled 100% stacked bar: one segment per category, light to dark, each with its count in a
 * tooltip. Shared by the Rotation page's cards that show a mix (the forward-vs-research-periods
 * regime card, selection drift). The tint carries the alpha, so a number on a light segment stays
 * readable; a segment can be outlined (a flag).
 */

import { formatNumber } from '../../lib/format';
import { shade } from '../../lib/shareTint';

export interface StackedShareProps {
  /** Category keys, in order; also the segment keys. */
  keys: readonly string[];
  /** What each segment is called, in the same order. */
  labels: readonly string[];
  counts: readonly number[];
  shares: readonly number[];
  /** Segments of at least this share carry text (a fraction). */
  minLabel?: number;
  /** Write the category's name before its percentage. */
  named?: boolean;
  /** Keys to outline, with a sentence for the tooltip. */
  ringed?: ReadonlyMap<string, string>;
}

export function StackedShare({
  keys,
  labels,
  counts,
  shares,
  minLabel = 0.09,
  named = false,
  ringed,
}: StackedShareProps) {
  return (
    <div
      className="flex h-5 overflow-hidden rounded border border-border"
      role="img"
      aria-label={labels
        .map((l, i) => `${l} ${formatNumber((shares[i] ?? 0) * 100, 0)}%`)
        .join(', ')}
    >
      {keys.map((k, i) => {
        const f = shares[i] ?? 0;
        if (f === 0) return null;
        const pct = formatNumber(f * 100, 0);
        const note = ringed?.get(k);
        return (
          <i
            key={k}
            title={`${labels[i]}: ${counts[i] ?? 0} (${pct}%)${note ? ` · ${note}` : ''}`}
            className={`flex items-center justify-center overflow-hidden whitespace-nowrap px-1 font-mono text-[10px] not-italic text-foreground ${
              note ? 'ring-2 ring-inset ring-warning' : ''
            }`}
            style={{
              width: `${f * 100}%`,
              backgroundColor: `hsl(var(--primary) / ${shade(i, keys.length)})`,
            }}
          >
            {f >= minLabel ? (named ? `${labels[i]} ${pct}%` : pct) : ''}
          </i>
        );
      })}
    </div>
  );
}
