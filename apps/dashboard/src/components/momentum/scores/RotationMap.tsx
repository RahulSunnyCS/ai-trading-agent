'use client';

import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { cn } from '../../../lib/cn';
import { formatNumber } from '../../../lib/format';
import { QUADRANT_LABEL, type Quadrant, type RotationEntry } from '../../../lib/momentumScores';

/** Literal class names per quadrant, so Tailwind compiles them (the class test checks each). */
const DOT: Record<Quadrant, string> = {
  leading: 'fill-positive',
  improving: 'fill-info',
  weakening: 'fill-warning',
  lagging: 'fill-negative',
};
const TAIL: Record<Quadrant, string> = {
  leading: 'stroke-positive',
  improving: 'stroke-info',
  weakening: 'stroke-warning',
  lagging: 'stroke-negative',
};
const ZONE: Record<Quadrant, string> = {
  leading: 'fill-positive/5',
  improving: 'fill-info/5',
  weakening: 'fill-warning/5',
  lagging: 'fill-negative/5',
};
const ZONE_TEXT: Record<Quadrant, string> = {
  leading: 'fill-positive',
  improving: 'fill-info',
  weakening: 'fill-warning',
  lagging: 'fill-negative',
};

const MARGIN = { left: 52, right: 16, top: 16, bottom: 40 };
const MIN_RANGE = 20;
const MAX_RANGE = 50;
const LABEL_CHAR_PX = 6.3;

/** Dot radius from the number of scored stocks: area grows with the count, within 5 to 15 px. */
export function dotRadius(scored: number): number {
  return Math.min(15, Math.max(5, 3 + Math.sqrt(Math.max(scored, 1)) * 1.1));
}

interface Placed {
  entry: RotationEntry;
  cx: number;
  cy: number;
  r: number;
}

/**
 * The sector rotation map: each group is a dot at its 26-week score (right is stronger) and how
 * far its 4-week score has moved in 4 weeks (up is improving). Groups tend to go round clockwise:
 * Improving, Leading, Weakening, Lagging. Few dots carry a name at once (the leaders, the one
 * picked or hovered, and every one when there are only a few) so the map stays readable with
 * dozens; the rest are named on hover. A tail shows where a dot has been, for the picked and
 * hovered ones, or for all when `showTails`.
 */
export function RotationMap({
  entries,
  sizeOf,
  hover,
  selected,
  showTails,
  labelAll,
  onHover,
  onSelect,
  tooltip,
  height = 520,
  ariaLabel,
}: {
  entries: readonly RotationEntry[];
  sizeOf: (entry: RotationEntry) => number;
  hover: string | null;
  selected: string | null;
  showTails: boolean;
  /** Name every dot, not only the leaders. */
  labelAll: boolean;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
  tooltip: (entry: RotationEntry) => ReactNode;
  height?: number;
  ariaLabel: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const node = boxRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.round(entry?.contentRect.width ?? 0);
      if (next > 0) setWidth(next);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const placeable = useMemo(
    () =>
      entries.filter(
        (entry): entry is RotationEntry & { now: NonNullable<RotationEntry['now']> } =>
          entry.now !== null,
      ),
    [entries],
  );
  const range = useMemo(() => {
    let widest = 0;
    for (const entry of placeable)
      for (const point of [...entry.tail, entry.now]) widest = Math.max(widest, Math.abs(point.y));
    return Math.min(MAX_RANGE, Math.max(MIN_RANGE, Math.ceil(widest / 10) * 10));
  }, [placeable]);

  const plotW = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  // The scales depend only on the plot size and range, so the dots and labels below are not
  // laid out again for a hover.
  const x = useCallback(
    (value: number): number => MARGIN.left + (Math.min(100, Math.max(0, value)) / 100) * plotW,
    [plotW],
  );
  const y = useCallback(
    (value: number): number =>
      MARGIN.top + (1 - (Math.min(range, Math.max(-range, value)) + range) / (2 * range)) * plotH,
    [range, plotH],
  );

  const placed: Placed[] = useMemo(
    () =>
      placeable.map((entry) => ({
        entry,
        cx: x(entry.now.x),
        cy: y(entry.now.y),
        r: dotRadius(sizeOf(entry)),
      })),
    [placeable, x, y, sizeOf],
  );

  // Names: the picked and hovered first, then the leaders and the improving (the ones worth
  // reading), biggest first; one is dropped if it would sit on a name already placed.
  const labels = useMemo(() => {
    const priority = (p: Placed): number =>
      p.entry.key === selected
        ? 0
        : p.entry.key === hover
          ? 1
          : labelAll
            ? 2
            : p.entry.quadrant === 'leading' || p.entry.quadrant === 'improving'
              ? 3
              : 9;
    const order = [...placed]
      .filter((p) => priority(p) < 9)
      .sort((a, b) => priority(a) - priority(b) || b.r - a.r);
    const boxes: Array<{ left: number; top: number; right: number; bottom: number }> = [];
    const out = new Map<string, { x: number; y: number; anchor: 'start' | 'end' }>();
    for (const p of order) {
      const w = p.entry.label.length * LABEL_CHAR_PX + 4;
      const toLeft = p.cx + p.r + 6 + w > width - MARGIN.right;
      const left = toLeft ? p.cx - p.r - 6 - w : p.cx + p.r + 6;
      const box = { left, top: p.cy - 8, right: left + w, bottom: p.cy + 8 };
      const clash = boxes.some(
        (b) => box.left < b.right && box.right > b.left && box.top < b.bottom && box.bottom > b.top,
      );
      if (clash && priority(p) > 1) continue;
      boxes.push(box);
      out.set(p.entry.key, {
        x: toLeft ? p.cx - p.r - 6 : p.cx + p.r + 6,
        y: p.cy + 4,
        anchor: toLeft ? 'end' : 'start',
      });
    }
    return out;
  }, [placed, width, hover, selected, labelAll]);

  const hovered = placed.find((p) => p.entry.key === hover) ?? null;
  const cx0 = x(50);
  const cy0 = y(0);

  return (
    <div ref={boxRef} className="relative w-full" style={{ height }}>
      {/* biome-ignore lint/a11y/useSemanticElements: the map is an SVG, not a form group */}
      <svg
        role="group"
        aria-label={ariaLabel}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className="block select-none"
      >
        {/* The four quadrants, tinted, with the centre lines. */}
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={cx0 - MARGIN.left}
          height={cy0 - MARGIN.top}
          className={ZONE.improving}
        />
        <rect
          x={cx0}
          y={MARGIN.top}
          width={MARGIN.left + plotW - cx0}
          height={cy0 - MARGIN.top}
          className={ZONE.leading}
        />
        <rect
          x={MARGIN.left}
          y={cy0}
          width={cx0 - MARGIN.left}
          height={MARGIN.top + plotH - cy0}
          className={ZONE.lagging}
        />
        <rect
          x={cx0}
          y={cy0}
          width={MARGIN.left + plotW - cx0}
          height={MARGIN.top + plotH - cy0}
          className={ZONE.weakening}
        />
        <line
          x1={cx0}
          x2={cx0}
          y1={MARGIN.top}
          y2={MARGIN.top + plotH}
          className="stroke-border-strong"
        />
        <line
          x1={MARGIN.left}
          x2={MARGIN.left + plotW}
          y1={cy0}
          y2={cy0}
          className="stroke-border-strong"
        />
        {(
          [
            ['improving', MARGIN.left + 8, MARGIN.top + 16, 'start'],
            ['leading', MARGIN.left + plotW - 8, MARGIN.top + 16, 'end'],
            ['lagging', MARGIN.left + 8, MARGIN.top + plotH - 8, 'start'],
            ['weakening', MARGIN.left + plotW - 8, MARGIN.top + plotH - 8, 'end'],
          ] as const
        ).map(([quadrant, tx, ty, anchor]) => (
          <text
            key={quadrant}
            x={tx}
            y={ty}
            textAnchor={anchor}
            className={cn(
              'text-[11px] font-semibold uppercase tracking-wider',
              ZONE_TEXT[quadrant],
            )}
          >
            {QUADRANT_LABEL[quadrant]}
          </text>
        ))}
        {[0, 25, 50, 75, 100].map((tick) => (
          <text
            key={`x${tick}`}
            x={x(tick)}
            y={MARGIN.top + plotH + 16}
            textAnchor="middle"
            className="fill-faint font-mono text-[10px]"
          >
            {tick}
          </text>
        ))}
        {[-range, -range / 2, 0, range / 2, range].map((tick) => (
          <text
            key={`y${tick}`}
            x={MARGIN.left - 8}
            y={y(tick) + 3}
            textAnchor="end"
            className="fill-faint font-mono text-[10px]"
          >
            {tick > 0 ? `+${formatNumber(tick, 0)}` : formatNumber(tick, 0)}
          </text>
        ))}
        <text
          x={MARGIN.left + plotW / 2}
          y={height - 6}
          textAnchor="middle"
          className="fill-muted text-[11px]"
        >
          Strength: 26-week score, 0 to 100 (right is stronger)
        </text>
        <text
          transform={`translate(12 ${MARGIN.top + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          className="fill-muted text-[11px]"
        >
          Direction: change in the 4-week score over 4 weeks
        </text>

        {/* Tails first, so the dots sit on top of them. */}
        {placed.map((p) => {
          if (!(showTails || p.entry.key === hover || p.entry.key === selected)) return null;
          if (p.entry.tail.length < 2 || !p.entry.quadrant) return null;
          return (
            <g key={`tail-${p.entry.key}`} className={TAIL[p.entry.quadrant]} fill="none">
              <polyline
                points={p.entry.tail.map((point) => `${x(point.x)},${y(point.y)}`).join(' ')}
                strokeWidth={1.5}
                strokeOpacity={0.6}
                strokeLinejoin="round"
                strokeDasharray={p.entry.changed ? undefined : '3 3'}
              />
            </g>
          );
        })}

        {placed.map((p) => {
          const { entry } = p;
          const active = entry.key === hover || entry.key === selected;
          const dim = (hover !== null || selected !== null) && !active;
          const quadrant = entry.quadrant ?? 'lagging';
          const label = labels.get(entry.key);
          return (
            <g
              key={entry.key}
              // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
              role="button"
              tabIndex={0}
              aria-label={`${entry.label}: ${QUADRANT_LABEL[quadrant]}${entry.changed && entry.before ? `, was ${QUADRANT_LABEL[entry.before]}` : ''}`}
              aria-pressed={entry.key === selected}
              className="cursor-pointer outline-none focus-visible:[&>circle:first-child]:stroke-ring"
              onMouseEnter={() => onHover(entry.key)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(entry.key)}
              onBlur={() => onHover(null)}
              onClick={() => onSelect(entry.key)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(entry.key);
                }
              }}
            >
              <circle
                cx={p.cx}
                cy={p.cy}
                r={p.r}
                strokeWidth={active ? 2.5 : 1}
                className={cn(
                  DOT[quadrant],
                  'stroke-background',
                  dim ? 'opacity-40' : 'opacity-90',
                  active && 'stroke-foreground',
                )}
              />
              {label ? (
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor={label.anchor}
                  className={cn(
                    'pointer-events-none fill-foreground text-[11.5px]',
                    active && 'font-semibold',
                  )}
                >
                  {entry.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hovered ? (
        <div
          className="pointer-events-none absolute z-10 w-64 rounded-lg border border-border-strong bg-surface p-3 text-xs shadow-elevated"
          style={{
            left:
              hovered.cx > width / 2
                ? Math.max(8, hovered.cx - hovered.r - 12 - 256)
                : Math.min(width - 264, hovered.cx + hovered.r + 12),
            top: Math.min(Math.max(8, hovered.cy - 40), height - 190),
          }}
        >
          {tooltip(hovered.entry)}
        </div>
      ) : null}
      {placed.length === 0 ? (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted">
          Nothing to place: no group has enough scored stocks with these settings.
        </p>
      ) : null}
    </div>
  );
}
