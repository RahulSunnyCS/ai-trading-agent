import { formatDay, formatInr } from '../../../lib/format';
import { seriesEnds, sharedScalePaths } from '../../../lib/momentumCompare';

const WIDTH = 420;
const HEIGHT = 140;

interface Sleeve {
  name: string;
  dates: string[];
  values: Array<number | null>;
}

/** A sleeve's values on the group's weeks (a week it has no value for stays empty). */
function onWeeks(sleeve: Sleeve, weeks: string[]): Array<number | null> {
  const byDay = new Map(sleeve.dates.map((day, i) => [day, sleeve.values[i] ?? null]));
  return weeks.map((day) => byDay.get(day) ?? null);
}

/**
 * A group's own equity line (its sleeves held as equal capital, restored each April) with each
 * sleeve faint beneath it, on one log scale so the sleeves can be compared with the whole.
 */
export function SavedGroupCurve({
  name,
  dates,
  blend,
  sleeves,
}: {
  name: string;
  dates: string[];
  blend: Array<number | null>;
  sleeves: Sleeve[];
}) {
  const paths = sharedScalePaths([blend, ...sleeves.map((s) => onWeeks(s, dates))], WIDTH, HEIGHT, {
    log: true,
  });
  const main = paths[0];
  const ends = seriesEnds(blend);
  if (!main || !ends) return null;
  const first = dates[0];
  const last = dates[dates.length - 1];
  const label = `${name}: ${formatInr(ends.first, { compact: true })} became ${formatInr(ends.last, { compact: true })}${
    first && last ? `, ${formatDay(first)} to ${formatDay(last)}` : ''
  }`;
  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="block h-36 w-full"
        preserveAspectRatio="none"
      >
        <title>{label}</title>
        {sleeves.map((sleeve, i) =>
          paths[i + 1] ? (
            <path
              key={sleeve.name}
              d={paths[i + 1] ?? ''}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              className="text-faint"
              opacity={0.6}
            />
          ) : null,
        )}
        <path
          d={main}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          className="text-primary"
        />
      </svg>
      <figcaption className="mt-1 flex justify-between text-[11px] text-faint">
        <span>{first ? formatDay(first) : ''}</span>
        <span>All sleeves together (bold) and each sleeve (faint) · log scale</span>
        <span>{last ? formatDay(last) : ''}</span>
      </figcaption>
    </figure>
  );
}
