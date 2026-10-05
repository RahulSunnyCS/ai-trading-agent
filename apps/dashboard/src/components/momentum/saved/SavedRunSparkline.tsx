import { cn } from '../../../lib/cn';
import { formatInr } from '../../../lib/format';
import { seriesEnds, sparklinePath } from '../../../lib/momentumCompare';

const WIDTH = 96;
const HEIGHT = 28;

/**
 * The saved run's own equity line (every saved run stores its weekly portfolio values), drawn
 * small. Green when the run ended above where it started, red when below.
 */
export function SavedRunSparkline({
  values,
  name,
}: {
  values: Array<number | null>;
  name: string;
}) {
  const path = sparklinePath(values, WIDTH, HEIGHT);
  const ends = seriesEnds(values);
  if (!path || !ends) return <span className="text-xs text-faint">No series</span>;
  const label = `${name}: ${formatInr(ends.first, { compact: true })} became ${formatInr(ends.last, { compact: true })}`;
  return (
    <svg
      role="img"
      aria-label={label}
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className={cn('block', ends.last >= ends.first ? 'text-positive' : 'text-negative')}
    >
      <title>{label}</title>
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
