'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { tooltipPlacement } from '../../lib/momentumResult';
import {
  type ChartPoint,
  chartModel,
  chartTooltip,
  nearestPoint,
} from '../../lib/rotationShadowView';
import type { ShadowSeriesPoint } from '../../types/rotationShadow';

const W = 760;
const H = 250;
const TOOLTIP_W = 300;
const LINE_H = 18;

interface Hover {
  point: ChartPoint;
  left: number;
  top: number;
}

/**
 * The running sum of "Dir at the event minute minus the displaced pick" over the scored days
 * (solid), and the same Dir at the same minute on ordinary days minus that same pick (dashed, the
 * time-matched placebo). A follow tooltip sits 40 px below the cursor and ignores the mouse; the
 * arrow keys step between days. Days without a result are not on the axis: they are in the table
 * below as pending, never as a zero point.
 */
export function RotationShadowChart({ series }: { series: readonly ShadowSeriesPoint[] }) {
  const model = useMemo(() => chartModel(series, W, H), [series]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const frame = useRef(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const place = useCallback((point: ChartPoint, cursor: { x: number; y: number }) => {
    const box = boxRef.current;
    if (!box) return;
    const bounds = { left: 0, top: 0, right: box.clientWidth, bottom: box.clientHeight };
    const lines = chartTooltip(point).length;
    const size = { width: TOOLTIP_W, height: lines * LINE_H + 16 };
    const p = tooltipPlacement(cursor, size, bounds);
    setHover({ point, left: p.left, top: p.top });
  }, []);

  if (model === null) return null;

  function onMove(event: React.MouseEvent<HTMLDivElement>) {
    const box = boxRef.current;
    if (!box || model === null) return;
    const rect = box.getBoundingClientRect();
    const cursor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (frame.current !== 0) return; // one placement per animation frame
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const point = nearestPoint(model, (cursor.x / rect.width) * W);
      if (point) {
        setActive(model.points.indexOf(point));
        place(point, cursor);
      }
    });
  }

  function onKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (model === null || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const box = boxRef.current;
    if (!box) return;
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = Math.min(model.points.length - 1, Math.max(0, (active ?? -step) + step));
    const point = model.points[next];
    if (!point) return;
    setActive(next);
    const scale = box.clientWidth / W;
    place(point, { x: point.x * scale, y: point.y * scale });
  }

  const shown = hover?.point ?? null;
  return (
    <div
      ref={boxRef}
      className="relative"
      onMouseMove={onMove}
      onMouseLeave={() => {
        setHover(null);
        setActive(null);
      }}
      onKeyDown={onKey}
      onBlur={() => setHover(null)}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the chart is stepped with the arrow keys
      tabIndex={0}
      role="img"
      aria-label="Running total of the override minus the displaced pick, by scored day. Arrow keys step between days."
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-hidden="true">
        {model.yTicks.map((t) => (
          <g key={t.label + t.y}>
            <line x1={64} x2={W - 36} y1={t.y} y2={t.y} className="stroke-border" strokeWidth={1} />
            <text
              x={58}
              y={t.y}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-faint text-[10px]"
            >
              {t.label}
            </text>
          </g>
        ))}
        <line
          x1={64}
          x2={W - 36}
          y1={model.zeroY}
          y2={model.zeroY}
          className="stroke-border-strong"
          strokeWidth={1.5}
        />
        {model.controlPath ? (
          <path
            d={model.controlPath}
            fill="none"
            strokeWidth={2}
            strokeDasharray="5 4"
            className="stroke-accent"
          />
        ) : null}
        <path d={model.eventPath} fill="none" strokeWidth={2.5} className="stroke-primary" />
        {model.points.map((p) => (
          <g key={p.day}>
            {p.controlY !== null ? (
              <circle cx={p.x} cy={p.controlY} r={2.5} className="fill-accent" />
            ) : null}
            <circle cx={p.x} cy={p.y} r={shown?.day === p.day ? 5 : 3} className="fill-primary" />
          </g>
        ))}
        {model.xTicks.map((t) => (
          <text
            key={t.label + t.x}
            x={t.x}
            y={H - 8}
            textAnchor="middle"
            className="fill-faint text-[10px]"
          >
            {t.label}
          </text>
        ))}
      </svg>
      {hover ? (
        <div
          className="pointer-events-none absolute left-0 top-0 z-30 rounded-lg border border-border-strong bg-surface px-3 py-2 text-xs shadow-elevated"
          style={{ width: TOOLTIP_W, transform: `translate(${hover.left}px, ${hover.top}px)` }}
        >
          {chartTooltip(hover.point).map((line, i) => (
            <p
              key={line}
              className={i === 0 ? 'font-medium text-foreground' : 'font-mono text-muted'}
            >
              {line}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
