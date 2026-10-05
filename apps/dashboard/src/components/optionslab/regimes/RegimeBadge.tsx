/**
 * The one badge for a regime / day-type key, on every tab. Label, tone, glyph and definition
 * come from lib/regimeMeta.ts, so the same key always renders the same badge.
 */

import { regimeBadge } from '../../../lib/regimeMeta';
import { Badge } from '../../ui/Badge';

export function RegimeBadge({
  regime,
  compact = false,
  className,
}: {
  /** Any regime key ('TREND_UP', 'RANGING', …), in any casing; null renders "Not tagged". */
  regime: string | null | undefined;
  /** Glyph only, for tight rows; the label stays available to screen readers and on hover. */
  compact?: boolean;
  className?: string;
}) {
  const badge = regimeBadge(regime);
  return (
    <Badge tone={badge.tone} {...(className === undefined ? {} : { className })}>
      {compact ? (
        <span title={`${badge.label}: ${badge.title}`}>
          <span aria-hidden="true">{badge.glyph}</span>
          <span className="sr-only">{badge.label}</span>
        </span>
      ) : (
        <span title={badge.title}>
          <span aria-hidden="true">{badge.glyph}</span> {badge.label}
        </span>
      )}
    </Badge>
  );
}
