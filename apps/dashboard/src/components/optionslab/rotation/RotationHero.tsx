/**
 * The hero chart: cumulative gross by list (2 lots per strategy), the fixed base and, behind
 * them, the band of 1,000 random same-shape baskets for the focus list. Hand-drawn SVG, like the
 * Correlation tab's heatmap, so nothing here pulls in a chart library.
 *
 * Follow tooltip below the cursor. A click pins a day; the slider under the chart does the same
 * from the keyboard (arrow keys), and Clear releases it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatDay, formatInr } from '../../../lib/format';
import { tooltipPlacement } from '../../../lib/momentumResult';
import { type HeroPoint, LIST_KEYS, nearestIndex, niceTicks } from '../../../lib/rotationView';
import type { RotationListKey } from '../../../types/rotation';

const W = 860;
const H = 300;
const PAD = { l: 56, r: 14, t: 12, b: 28 };

const STROKE: Record<RotationListKey, string> = {
  A: 'stroke-series-1',
  B: 'stroke-series-2',
  C: 'stroke-series-3',
  REF: 'stroke-series-4',
};
const SWATCH: Record<RotationListKey, string> = {
  A: 'bg-series-1',
  B: 'bg-series-2',
  C: 'bg-series-3',
  REF: 'bg-series-4',
};

export function RotationHero({
  points,
  focus,
  shown,
  onToggle,
  showBase,
  onToggleBase,
}: {
  points: HeroPoint[];
  focus: RotationListKey;
  shown: ReadonlySet<RotationListKey>;
  onToggle: (key: RotationListKey) => void;
  showBase: boolean;
  onToggleBase: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState<number | null>(null);
  const n = points.length;

  const scale = useMemo(() => {
    const vals: number[] = [0];
    for (const p of points) {
      for (const k of LIST_KEYS) {
        const v = p.lists[k];
        if (shown.has(k) && v !== undefined) vals.push(v);
      }
      if (showBase) vals.push(p.base);
      if (p.band) vals.push(p.band.p10, p.band.p90);
    }
    const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 5);
    const lo = Math.min(ticks[0] ?? 0, ...vals);
    const hi = Math.max(ticks.at(-1) ?? 1, ...vals);
    return { ticks, lo, hi };
  }, [points, shown, showBase]);

  const x = useCallback(
    (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1)),
    [n],
  );
  const y = useCallback(
    (v: number) => PAD.t + ((scale.hi - v) / (scale.hi - scale.lo || 1)) * (H - PAD.t - PAD.b),
    [scale],
  );

  if (n === 0) return null;

  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  const onMove = (e: React.MouseEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const svgX = (px / r.width) * W;
      setHover({ i: nearestIndex(svgX, PAD.l, W - PAD.r, n), x: px, y: py });
    });
  };

  const active = pinned ?? hover?.i ?? null;
  const point = active === null ? null : points[active];
  const tipPos = (() => {
    const r = box.current?.getBoundingClientRect();
    if (!hover || !r) return null;
    const t = tip.current?.getBoundingClientRect();
    return tooltipPlacement(
      { x: hover.x, y: hover.y },
      { width: t?.width ?? 192, height: t?.height ?? 110 },
      { left: 0, top: 0, right: r.width, bottom: r.height },
    );
  })();

  const bandPath = (() => {
    if (!points[0]?.band) return '';
    const up = points.map((p, i) => `${x(i)},${y(p.band?.p90 ?? 0)}`);
    const dn = points.map((p, i) => `${x(i)},${y(p.band?.p10 ?? 0)}`).reverse();
    return [...up, ...dn].join(' ');
  })();
  const line = (get: (p: HeroPoint) => number | undefined) =>
    points
      .map((p, i) => {
        const v = get(p);
        return v === undefined ? null : `${x(i)},${y(v)}`;
      })
      .filter((s): s is string => s !== null)
      .join(' ');

  const labelEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {LIST_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={shown.has(k)}
            disabled={k === focus}
            onClick={() => onToggle(k)}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
              shown.has(k) ? 'border-border-strong text-foreground' : 'border-border text-faint'
            } disabled:cursor-default`}
          >
            <span className={`h-2 w-2 rounded-full ${SWATCH[k]}`} />
            {k}
            {k === focus ? <span className="text-faint">focus</span> : null}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={showBase}
          onClick={onToggleBase}
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
            showBase ? 'border-border-strong text-foreground' : 'border-border text-faint'
          }`}
        >
          <span className="h-0.5 w-3 bg-muted" />
          Fixed base
        </button>
        <span className="flex items-center gap-1.5 text-faint">
          <span className="h-2 w-3 rounded-sm bg-faint/25" />
          random baskets, P10 to P90
        </span>
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut for the day slider below, which is the keyboard path to the same pin */}
      <div
        ref={box}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={() => setPinned((p) => (p === null ? (hover?.i ?? null) : null))}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label="Cumulative gross by list, the fixed base and the random-basket band, by day"
          className="h-auto w-full"
        >
          {scale.ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.l}
                x2={W - PAD.r}
                y1={y(t)}
                y2={y(t)}
                className={t === 0 ? 'stroke-border-strong' : 'stroke-border'}
              />
              <text
                x={PAD.l - 6}
                y={y(t)}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-faint text-[10px]"
              >
                {formatInr(t, { compact: true })}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text
                key={p.day}
                x={x(i)}
                y={H - 8}
                textAnchor="middle"
                className="fill-faint text-[10px]"
              >
                {formatDay(p.day).slice(0, 6)}
              </text>
            ) : null,
          )}
          {bandPath ? <polygon points={bandPath} className="fill-faint/20" /> : null}
          {showBase ? (
            <polyline
              points={line((p) => p.base)}
              fill="none"
              strokeWidth={1.5}
              strokeDasharray="2 3"
              className="stroke-muted"
            />
          ) : null}
          {LIST_KEYS.filter((k) => shown.has(k)).map((k) => (
            <polyline
              key={k}
              points={line((p) => p.lists[k])}
              fill="none"
              strokeWidth={k === focus ? 2.4 : 1.6}
              strokeLinejoin="round"
              strokeDasharray={k === 'REF' ? '6 4' : undefined}
              className={STROKE[k]}
            />
          ))}
          {LIST_KEYS.filter((k) => shown.has(k)).map((k) =>
            points.map((p, i) => {
              const v = p.lists[k];
              // every point on a short series (a single session draws no line), the last on a long one
              if (v === undefined || (n > 30 && i !== n - 1)) return null;
              return (
                <circle
                  key={`${k}-${p.day}`}
                  cx={x(i)}
                  cy={y(v)}
                  r={k === focus ? 3.2 : 2.4}
                  className={`${STROKE[k].replace('stroke-', 'fill-')}`}
                />
              );
            }),
          )}
          {active !== null ? (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={PAD.t}
              y2={H - PAD.b}
              className={pinned !== null ? 'stroke-primary' : 'stroke-border-strong'}
            />
          ) : null}
        </svg>
        {hover && pinned === null && point && tipPos ? (
          <div
            ref={tip}
            style={{ left: tipPos.left, top: tipPos.top }}
            className="pointer-events-none absolute z-10 w-48 rounded-md border border-border-strong bg-surface p-2 text-xs shadow-elevated"
          >
            <div className="font-medium text-foreground">{formatDay(point.day)}</div>
            {LIST_KEYS.filter((k) => shown.has(k)).map((k) => (
              <div key={k} className="flex justify-between gap-3 font-mono text-muted">
                <span>{k}</span>
                <span>{formatInr(point.lists[k], { compact: true })}</span>
              </div>
            ))}
            {showBase ? (
              <div className="flex justify-between gap-3 font-mono text-muted">
                <span>Base</span>
                <span>{formatInr(point.base, { compact: true })}</span>
              </div>
            ) : null}
            {point.band ? (
              <div className="flex justify-between gap-3 font-mono text-faint">
                <span>Random P50</span>
                <span>{formatInr(point.band.p50, { compact: true })}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted">
        <label htmlFor="rotation-hero-day" className="shrink-0">
          Inspect a day
        </label>
        <input
          id="rotation-hero-day"
          type="range"
          min={0}
          max={n - 1}
          step={1}
          value={pinned ?? n - 1}
          onChange={(e) => setPinned(Number(e.target.value))}
          className="min-w-0 flex-1"
          aria-valuetext={formatDay(points[pinned ?? n - 1]?.day)}
        />
        {pinned !== null ? (
          <button
            type="button"
            onClick={() => setPinned(null)}
            className="rounded border border-border px-2 py-0.5 text-foreground hover:bg-surface-2"
          >
            Clear
          </button>
        ) : (
          <span className="text-faint">or click the chart</span>
        )}
      </div>
      {pinned !== null && point ? (
        <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
          <span className="font-medium text-foreground">{formatDay(point.day)}</span>
          <div className="mt-1 flex flex-wrap gap-x-5 gap-y-1 font-mono text-muted">
            {LIST_KEYS.filter((k) => point.lists[k] !== undefined).map((k) => (
              <span key={k}>
                {k} {formatInr(point.lists[k], { compact: true })}
              </span>
            ))}
            <span>Base {formatInr(point.base, { compact: true })}</span>
            {point.band ? (
              <span>Random P50 {formatInr(point.band.p50, { compact: true })}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
