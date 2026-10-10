'use client';

import { type KeyboardEvent, useRef } from 'react';

import { BAND_BG, BAND_FILL, LEGEND, bandOf } from '../../../lib/correlationView';
import { formatNumber } from '../../../lib/format';

/** Labels and cell numbers are drawn only while they stay readable; past that the grid is a
 * picture and the readout above it names the cell under the pointer. */
const LABEL_MAX_K = 40;
const NUMBER_MIN_CELL = 30;
const TARGET_WIDTH = 600;
const LABEL_W = 156;
const TOP_H = 20;

export type Cell = readonly [number, number];

interface Props {
  names: readonly string[];
  /** k x k, already in display order. */
  matrix: readonly (readonly (number | null)[])[];
  hover: Cell | null;
  pinned: Cell | null;
  onHover: (cell: Cell | null) => void;
  onPin: (cell: Cell | null) => void;
  ariaLabel: string;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * The correlation matrix as a grid of tinted cells (one SVG, so 80 x 80 stays light). Alike is the
 * primary tint, opposite series-2; the diagonal is the strategy against itself. Pointer or arrow
 * keys read a cell, a click or Enter pins it. The table below is the accessible twin of the numbers.
 */
export function CorrelationHeatmap({
  names,
  matrix,
  hover,
  pinned,
  onHover,
  onPin,
  ariaLabel,
}: Props) {
  const ref = useRef<SVGSVGElement>(null);
  const k = names.length;
  const labelled = k <= LABEL_MAX_K;
  const cell = Math.max(8, Math.min(44, Math.floor(TARGET_WIDTH / Math.max(k, 1))));
  const left = labelled ? LABEL_W : 0;
  const top = labelled ? TOP_H : 0;
  const width = left + k * cell;
  const height = top + k * cell;
  const showNumbers = cell >= NUMBER_MIN_CELL;
  const active = hover ?? pinned;

  function cellAt(event: { clientX: number; clientY: number }): Cell | null {
    const box = ref.current?.getBoundingClientRect();
    if (!box || box.width === 0) return null;
    const scale = width / box.width;
    const j = Math.floor(((event.clientX - box.left) * scale - left) / cell);
    const i = Math.floor(((event.clientY - box.top) * scale - top) / cell);
    return i >= 0 && j >= 0 && i < k && j < k ? [i, j] : null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const from = active ?? [0, 1 < k ? 1 : 0];
    const step: Record<string, readonly [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const d = step[event.key];
    if (d) {
      event.preventDefault();
      const next: Cell = [
        Math.min(k - 1, Math.max(0, from[0] + d[0])),
        Math.min(k - 1, Math.max(0, from[1] + d[1])),
      ];
      onHover(next);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onPin(active && pinned && active[0] === pinned[0] && active[1] === pinned[1] ? null : active);
    } else if (event.key === 'Escape') {
      onHover(null);
      onPin(null);
    }
  }

  return (
    <div>
      <div className="overflow-x-auto">
        {/* One focus stop for the whole grid (arrows read a cell, Enter keeps it); the strategy
            table beside it carries the same numbers for assistive tech. */}
        <button
          type="button"
          aria-label={ariaLabel}
          onKeyDown={onKeyDown}
          onPointerMove={(event) => onHover(cellAt(event))}
          onPointerLeave={() => onHover(null)}
          onClick={(event) => {
            const at = cellAt(event);
            onPin(at && pinned && at[0] === pinned[0] && at[1] === pinned[1] ? null : at);
          }}
          className="block w-fit max-w-full cursor-crosshair rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <svg
            ref={ref}
            aria-hidden="true"
            viewBox={`0 0 ${width} ${height}`}
            width={width}
            height={height}
            className="block max-w-full select-none"
          >
            {labelled &&
              names.map((name, j) => (
                <text
                  key={`c-${name}`}
                  x={left + j * cell + cell / 2}
                  y={TOP_H - 6}
                  textAnchor="middle"
                  className="fill-faint text-[10px]"
                >
                  {j + 1}
                </text>
              ))}
            {labelled &&
              names.map((name, i) => (
                <text
                  key={`r-${name}`}
                  x={LABEL_W - 6}
                  y={top + i * cell + cell / 2}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className={
                    active && (active[0] === i || active[1] === i)
                      ? 'fill-foreground font-mono text-[10.5px]'
                      : 'fill-muted font-mono text-[10.5px]'
                  }
                >
                  {`${i + 1}. ${truncate(name, 20)}`}
                </text>
              ))}
            {matrix.flatMap((row, i) =>
              row.map((value, j) => {
                const x = left + j * cell;
                const y = top + i * cell;
                const diagonal = i === j;
                const band = bandOf(value);
                const isActive = active !== null && active[0] === i && active[1] === j;
                return (
                  <g key={`${names[i]}-${names[j]}`}>
                    <rect
                      x={x + 0.5}
                      y={y + 0.5}
                      width={cell - 1}
                      height={cell - 1}
                      rx={2}
                      className={`${
                        diagonal ? 'fill-border' : (BAND_FILL[String(band)] ?? 'fill-surface-2')
                      }${isActive ? ' stroke-foreground' : ''}`}
                      strokeWidth={isActive ? 2 : 0}
                    />
                    {showNumbers && !diagonal && (
                      <text
                        x={x + cell / 2}
                        y={y + cell / 2}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className={
                          typeof band === 'number' && band >= 3
                            ? 'fill-primary-foreground font-mono text-[11px]'
                            : 'fill-foreground font-mono text-[11px]'
                        }
                      >
                        {formatNumber(value, 2)}
                      </text>
                    )}
                  </g>
                );
              }),
            )}
          </svg>
        </button>
      </div>
      <ul className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted">
        {LEGEND.map((item) => (
          <li key={item.label} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block h-3 w-5 rounded-sm ${BAND_BG[String(item.band)] ?? ''}`}
            />
            {item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
