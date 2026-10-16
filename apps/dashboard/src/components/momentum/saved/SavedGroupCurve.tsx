import { formatDay, formatInr } from '../../../lib/format';

const WIDTH = 420;
const HEIGHT = 140;
const MAX_POINTS = 120;

interface Curve {
  name: string;
  values: Array<number | null>;
}

function thin(values: Array<number | null>): number[] {
  const usable = values.filter((v): v is number => typeof v === 'number' && v > 0);
  const step = Math.max(1, Math.ceil(usable.length / MAX_POINTS));
  const points = usable.filter((_, i) => i % step === 0);
  const last = usable[usable.length - 1];
  if (last !== undefined && points[points.length - 1] !== last) points.push(last);
  return points;
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
  sleeves: Curve[];
}) {
  const main = thin(blend);
  if (main.length < 2) return null;
  const others = sleeves.map((s) => ({ name: s.name, points: thin(s.values) }));
  const all = [main, ...others.map((o) => o.points)].flat().map((v) => Math.log(v));
  const min = Math.min(...all);
  const span = Math.max(...all) - min || 1;
  const path = (points: number[]) =>
    points
      .map((v, i) => {
        const x = ((i / (points.length - 1)) * WIDTH).toFixed(1);
        const y = (2 + (1 - (Math.log(v) - min) / span) * (HEIGHT - 4)).toFixed(1);
        return `${i === 0 ? 'M' : 'L'}${x},${y}`;
      })
      .join(' ');
  const first = dates[0];
  const last = dates[dates.length - 1];
  const label = `${name}: ${formatInr(main[0] ?? 0, { compact: true })} became ${formatInr(main[main.length - 1] ?? 0, { compact: true })}${
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
        {others.map((o) =>
          o.points.length > 1 ? (
            <path
              key={o.name}
              d={path(o.points)}
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
          d={path(main)}
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
