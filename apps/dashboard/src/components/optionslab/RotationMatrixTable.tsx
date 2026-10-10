'use client';

import { type KeyboardEvent, memo, useCallback, useMemo, useRef, useState } from 'react';

import { cn } from '../../lib/cn';
import {
  type CellKind,
  cellKind,
  cellText,
  toneClass,
  valueText,
} from '../../lib/rotationMatrixView';
import type {
  MatrixAxisItem,
  MatrixCell,
  MatrixDiffCell,
  MatrixListId,
  MatrixScale,
  MatrixUnit,
} from '../../types/rotationMatrix';
import { CellReadout, FollowTip, colHeader } from './RotationMatrixParts';

type AnyCell = MatrixCell | MatrixDiffCell;

interface Props {
  rows: readonly MatrixAxisItem[];
  cols: readonly MatrixAxisItem[];
  cells: readonly (readonly AnyCell[])[];
  rowSummary?: readonly (MatrixCell | null)[] | null | undefined;
  colSummary?: readonly (MatrixCell | null)[] | null | undefined;
  scale: MatrixScale | null;
  unit: MatrixUnit;
  /** The list whose recorded picks are marked on aggregate cells. */
  overlayList: MatrixListId | null;
  /** The date view's picks: {date: {late, cells: {slot: lists}}}. */
  datePicks?: Record<string, { late: boolean; cells: Record<string, MatrixListId[]> }> | null;
  difference?: boolean;
  /** Names the period pair of a difference table. */
  periods?: [string, string];
  caption: string;
  onOpen: (rowKey: string, colKey: string) => void;
  /** Scroll inside the table once it has this many rows (the date view). */
  scrollRows?: number;
}

interface CellProps {
  r: number;
  c: number;
  cell: AnyCell;
  scale: MatrixScale | null;
  unit: MatrixUnit;
  difference: boolean;
  marker: string | null;
  active: boolean;
  label: string;
}

/** One cell. Memoised: the table re-renders on every tooltip move, the cells must not. */
const Cell = memo(function Cell({
  r,
  c,
  cell,
  scale,
  unit,
  difference,
  marker,
  active,
  label,
}: CellProps) {
  const kind: CellKind = cellKind(cell);
  const thin = kind === 'value' && cell.thin === true;
  const text = kind === 'value' ? cellText(cell.v, unit, difference) : kind === 'na' ? '' : '—';
  return (
    <td className="p-px">
      <button
        type="button"
        data-r={r}
        data-c={c}
        tabIndex={active ? 0 : -1}
        disabled={kind === 'na'}
        aria-label={label}
        className={cn(
          'relative block h-7 w-full min-w-[2.75rem] rounded-sm px-1 text-center font-mono text-[11px] tabular-nums text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
          kind === 'value'
            ? toneClass(cell.v, scale, unit, difference)
            : kind === 'na'
              ? 'cursor-default bg-transparent text-faint'
              : 'border border-dashed border-border bg-transparent text-faint',
          thin && 'opacity-50',
        )}
      >
        {text}
        {marker ? (
          <span className="pointer-events-none absolute right-0.5 top-0 text-[8px] font-semibold leading-none text-foreground">
            {marker}
          </span>
        ) : null}
      </button>
    </td>
  );
});

function markerFor(
  cell: AnyCell,
  overlayList: MatrixListId | null,
  picks: MatrixListId[] | undefined,
): string | null {
  if (picks && picks.length > 0) return picks.join('');
  const sel = (cell as MatrixCell).sel;
  if (overlayList && sel?.[overlayList]) {
    const n = sel[overlayList] ?? 0;
    return n > 1 ? `●${n}` : '●';
  }
  return null;
}

/**
 * The matrix as a table of tinted, signed values (DOM, not canvas: a cell is a button, so it
 * reads, tabs and opens by keyboard). Rows are labelled on the left, start times or families
 * across the top; the last column and row are pooled means, never sums. A thin cell is muted, a
 * missing or filtered one is dashed. Arrow keys move between cells, Enter opens one.
 */
export function RotationMatrixTable({
  rows,
  cols,
  cells,
  rowSummary,
  colSummary,
  scale,
  unit,
  overlayList,
  datePicks,
  difference = false,
  periods,
  caption,
  onOpen,
  scrollRows = 24,
}: Props) {
  const [active, setActive] = useState<[number, number]>([0, 0]);
  const [hover, setHover] = useState<{ r: number; c: number; x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);
  const root = useRef<HTMLTableElement>(null);
  const withSummary = rowSummary !== undefined && rowSummary !== null && !difference;

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLTableElement>) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-r]');
    const x = event.clientX;
    const y = event.clientY;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!target) return setHover(null);
      setHover({ r: Number(target.dataset.r), c: Number(target.dataset.c), x, y });
    });
  }, []);

  const body = useMemo(
    () =>
      rows.map((row, r) => {
        const line = cells[r] ?? [];
        const picks = datePicks?.[row.key];
        return (
          <tr key={row.key} className="h-8">
            <th
              scope="row"
              className="sticky left-0 z-[1] whitespace-nowrap bg-surface pr-3 text-left text-xs font-medium text-foreground"
            >
              <span className="block max-w-[14rem] truncate" title={row.label}>
                {row.label}
              </span>
              {picks ? (
                <span className="sr-only">
                  {picks.late ? 'late entry recorded' : 'entry recorded'}
                </span>
              ) : null}
            </th>
            {withSummary ? (
              <SummaryCell cell={rowSummary?.[r] ?? null} scale={scale} unit={unit} lead />
            ) : null}
            {cols.map((col, c) => {
              const cell = line[c] ?? { st: 'na' as const };
              const slotPicks = picks?.cells[col.key];
              return (
                <Cell
                  key={col.key}
                  r={r}
                  c={c}
                  cell={cell}
                  scale={scale}
                  unit={unit}
                  difference={difference}
                  marker={markerFor(cell, overlayList, slotPicks)}
                  active={active[0] === r && active[1] === c}
                  label={`${row.label}, ${colHeader(col.key, col.label)}: ${
                    cellKind(cell) === 'value'
                      ? valueText(cell.v, unit, difference)
                      : (cell.reason ?? 'no value')
                  }`}
                />
              );
            })}
          </tr>
        );
      }),
    [
      rows,
      cols,
      cells,
      scale,
      unit,
      overlayList,
      datePicks,
      difference,
      active,
      withSummary,
      rowSummary,
    ],
  );

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    const d = step[event.key];
    if (!d) return;
    const here = (event.target as HTMLElement).closest<HTMLElement>('[data-r]');
    if (!here) return;
    event.preventDefault();
    const r = Math.min(rows.length - 1, Math.max(0, Number(here.dataset.r) + d[0]));
    const c = Math.min(cols.length - 1, Math.max(0, Number(here.dataset.c) + d[1]));
    setActive([r, c]);
    requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)?.focus(),
    );
  }

  const hoverCell = hover ? (cells[hover.r]?.[hover.c] ?? null) : null;
  const hoverRow = hover ? rows[hover.r] : undefined;
  const hoverCol = hover ? cols[hover.c] : undefined;

  return (
    <div
      className={cn('overflow-x-auto', rows.length > scrollRows && 'max-h-[34rem] overflow-y-auto')}
    >
      <table
        ref={root}
        aria-label={caption}
        className="border-separate border-spacing-0"
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHover(null)}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          const t = (event.target as HTMLElement).closest<HTMLElement>('[data-r]');
          if (!t) return;
          const row = rows[Number(t.dataset.r)];
          const col = cols[Number(t.dataset.c)];
          const cell = cells[Number(t.dataset.r)]?.[Number(t.dataset.c)];
          if (row && col && cellKind(cell) !== 'na') onOpen(row.key, col.key);
        }}
      >
        <thead className="sticky top-0 z-[2] bg-surface">
          <tr className="h-8">
            <th className="sticky left-0 z-[3] bg-surface" />
            {withSummary ? (
              <th
                scope="col"
                className="whitespace-nowrap px-1 pr-3 text-center text-[10px] font-semibold uppercase tracking-wider text-faint"
                title="The mean of the row's strategy-days (a pooled average, not a sum)"
              >
                Row mean
              </th>
            ) : null}
            {cols.map((col) => (
              <th
                key={col.key}
                scope="col"
                className="whitespace-nowrap px-1 text-center font-mono text-[11px] font-medium text-faint"
              >
                {colHeader(col.key, col.label)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body}
          {withSummary && colSummary ? (
            <tr className="h-9">
              <th
                scope="row"
                className="sticky left-0 z-[1] bg-surface pr-3 pt-1 text-left text-[11px] font-semibold uppercase tracking-wider text-faint"
                title="The mean of the column's strategy-days across the rows above (a pooled average, not a sum)"
              >
                Column mean
              </th>
              <td />
              {cols.map((col, c) => (
                <SummaryCell
                  key={col.key}
                  cell={colSummary[c] ?? null}
                  scale={scale}
                  unit={unit}
                  top
                />
              ))}
            </tr>
          ) : null}
        </tbody>
      </table>
      <FollowTip cursor={hover ? { x: hover.x, y: hover.y } : null}>
        {hoverRow && hoverCol ? (
          <CellReadout
            rowLabel={hoverRow.label}
            colLabel={colHeader(hoverCol.key, hoverCol.label)}
            cell={hoverCell}
            unit={unit}
            difference={difference}
            {...(periods ? { periods } : {})}
            picks={datePicks?.[hoverRow.key]?.cells[hoverCol.key]}
          />
        ) : null}
      </FollowTip>
    </div>
  );
}

/** A pooled mean beside a row or under a column: smaller and plainer than a cell, never a button. */
function SummaryCell({
  cell,
  scale,
  unit,
  top = false,
  lead = false,
}: {
  cell: MatrixCell | null;
  scale: MatrixScale | null;
  unit: MatrixUnit;
  top?: boolean;
  /** The row mean that sits before the first column. */
  lead?: boolean;
}) {
  const kind = cellKind(cell);
  const thin = kind === 'value' && cell?.thin === true;
  return (
    <td className={cn('p-px', top && 'pt-1.5', lead && 'pr-3')}>
      <span
        title={
          kind === 'value'
            ? `${valueText(cell?.v, unit)} over ${cell?.n ?? 0} sessions, ${cell?.nv ?? 0} strategy-days`
            : (cell?.reason ?? 'no value')
        }
        className={cn(
          'flex h-7 min-w-[2.75rem] items-center justify-center rounded-sm border border-border px-1 font-mono text-[11px] tabular-nums text-foreground',
          kind === 'value'
            ? toneClass(cell?.v, scale, unit)
            : 'border-dashed bg-transparent text-faint',
          thin && 'opacity-50',
        )}
      >
        {kind === 'value' ? cellText(cell?.v, unit) : '—'}
      </span>
    </td>
  );
}
