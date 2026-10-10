/**
 * The hero chart: cumulative gross by list (2 lots per strategy), the fixed base and, behind
 * them, the band of 1,000 random same-shape baskets for the focus list. Hand-drawn SVG, like the
 * Correlation tab's heatmap, so nothing here pulls in a chart library.
 *
 * Follow tooltip below the cursor; a click pins a day (Esc or a second click closes, ← → step).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { formatDay, formatInr } from '../../../lib/format';
import {
  type HeroPoint,
  LIST_KEYS,
  nearestIndex,
  niceTicks,
  tooltipPlacement,
} from '../../../lib/rotationView';
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

  useEffect(() => {
    if (pinned === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(null);
      else if (e.key === 'ArrowLeft') setPinned((i) => (i === null ? i : Math.max(0, i - 1)));
      else if (e.key === 'ArrowRight') setPinned((i) => (i === null ? i : Math.min(n - 1, i + 1)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pinned, n]);

  if (n === 0) return null;

  const onMove = (e: React.MouseEvent) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    const px = e.clientX - r.left;
    const svgX = (px / r.width) * W;
    setHover({ i: nearestIndex(svgX, PAD.l, W - PAD.r, n), x: px, y: e.clientY - r.top });
  };

  const active = pinned ?? hover?.i ?? null;
  const point = active === null ? null : points[active];
  const tipPos = (() => {
    const r = box.current?.getBoundingClientRect();
    if (!hover || !r) return null;
    const t = tip.current?.getBoundingClientRect();
    return tooltipPlacement(
      { x: hover.x, y: hover.y },
      { w: t?.width ?? 180, h: t?.height ?? 110 },
      { w: r.width, h: r.height },
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
      <div
        ref={box}
        className="relative"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={() => setPinned((p) => (p === null ? (hover?.i ?? null) : null))}
        onKeyDown={undefined}
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
      {pinned !== null && point ? (
        <div className="rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
          <span className="font-medium text-foreground">{formatDay(point.day)}</span>
          <span className="ml-2 text-faint">← → step, Esc closes</span>
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
