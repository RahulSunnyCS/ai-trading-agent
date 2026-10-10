'use client';

/**
 * Small pieces of Options Lab › Matrix: the follow tooltip, the colour legend, the cell readout
 * and the recorded-picks status line. Kept apart from the table so each stays short.
 */

import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { formatDay, formatInt } from '../../lib/format';
import { tooltipPlacement } from '../../lib/momentumResult';
import {
  cellKind,
  legendSwatches,
  slotLabel,
  thinnest,
  valueText,
} from '../../lib/rotationMatrixView';
import type {
  MatrixCell,
  MatrixDiffCell,
  MatrixListId,
  MatrixOverlay,
  MatrixScale,
  MatrixUnit,
} from '../../types/rotationMatrix';
import { Badge } from '../ui/Badge';

// ---------------------------------------------------------------------------
// Follow tooltip
// ---------------------------------------------------------------------------

/**
 * The analytics pages' follow tooltip: about 1 cm below the cursor, flipped above near the
 * bottom edge, clamped at the sides, ignoring the mouse. Portalled to the body so a transformed
 * ancestor (the drawer's slide-in) cannot become its containing block.
 */
export function FollowTip({
  cursor,
  children,
}: { cursor: { x: number; y: number } | null; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !cursor) return;
    const box = el.getBoundingClientRect();
    setPlace(
      tooltipPlacement(
        cursor,
        { width: box.width, height: box.height },
        { left: 8, top: 8, right: window.innerWidth - 8, bottom: window.innerHeight - 8 },
      ),
    );
  }, [cursor]);
  if (!cursor || typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      style={{
        left: place?.left ?? cursor.x,
        top: place?.top ?? cursor.y,
        visibility: place ? 'visible' : 'hidden',
      }}
      className="pointer-events-none fixed z-[60] max-w-xs rounded-lg border border-border-strong bg-surface px-3 py-2 text-xs text-foreground shadow-elevated"
    >
      {children}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

export function Legend({
  scale,
  unit,
  difference = false,
  shared,
  notes = [],
}: {
  scale: MatrixScale | null;
  unit: MatrixUnit;
  difference?: boolean;
  /** "Both periods use this scale". */
  shared?: boolean;
  /** What did not set the scale, what is clipped: stated, never silent. */
  notes?: string[];
}) {
  const swatches = legendSwatches(scale, unit, difference);
  if (swatches.length === 0) return null;
  const diverging = scale?.kind === 'diverging' || difference;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
      <div className="flex items-center gap-2">
        <span className="font-mono text-faint">
          {diverging
            ? `≤ ${valueText(scale?.min, unit, difference)}`
            : valueText(0, unit, difference)}
        </span>
        <span className="flex overflow-hidden rounded-sm border border-border">
          {swatches.map((s) => (
            <span key={s.edge} className={`h-3 w-6 ${s.className}`} aria-hidden="true" />
          ))}
        </span>
        <span className="font-mono text-faint">
          {`≥ ${valueText(scale?.max, unit, difference)}`}
        </span>
        {shared ? <span className="text-faint">· one scale for both periods</span> : null}
      </div>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-5 rounded-sm bg-surface-2 opacity-50"
            aria-hidden="true"
          />
          muted: under the minimum sample
        </li>
        <li className="flex items-center gap-1.5">
          <span
            className="inline-block h-3 w-5 rounded-sm border border-dashed border-border"
            aria-hidden="true"
          />
          no result, or filtered out
        </li>
      </ul>
      {notes.length > 0 ? (
        <ul className="basis-full space-y-0.5 text-faint">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The cell readout (tooltip body)
// ---------------------------------------------------------------------------

const LIST_ORDER: MatrixListId[] = ['A', 'B', 'C', 'REF'];

export function CellReadout({
  rowLabel,
  colLabel,
  cell,
  unit,
  difference = false,
  periods,
  picks,
}: {
  rowLabel: string;
  colLabel: string;
  cell: MatrixCell | MatrixDiffCell | null;
  unit: MatrixUnit;
  difference?: boolean;
  periods?: [string, string];
  /** Lists that picked this cell on its date (the date view). */
  picks?: MatrixListId[] | undefined;
}) {
  const kind = cellKind(cell);
  const c = cell as MatrixCell | null;
  const d = cell as MatrixDiffCell | null;
  return (
    <div className="space-y-1">
      <p className="font-medium">
        {rowLabel} <span className="text-faint">·</span> {colLabel}
      </p>
      {kind === 'value' && cell ? (
        <>
          <p className="font-mono text-sm">{valueText(cell.v, unit, difference)}</p>
          {difference && d?.n ? (
            <p className="text-muted">
              {periods?.[0]} {formatInt(d.n[0])} sessions, {periods?.[1]} {formatInt(d.n[1])}{' '}
              sessions
            </p>
          ) : (
            <p className="text-muted">
              {formatInt(c?.n)} session{c?.n === 1 ? '' : 's'}
              {c && c.nv !== undefined && c.nv !== c.n ? `, ${formatInt(c.nv)} strategy-days` : ''}
            </p>
          )}
          {c?.m && c.m.win_rate !== undefined ? (
            <p className="font-mono text-muted">
              avg {valueText(c.m.avg, 'inr')} · win {valueText(c.m.win_rate, 'fraction')} · stop{' '}
              {valueText(c.m.stop_rate, 'fraction')} · worst {valueText(c.m.worst, 'inr')}
            </p>
          ) : null}
          {c?.all ? (
            <p className="text-muted">
              Selected only: {formatInt(c.n)} of {formatInt(c.all.n)} sessions. All opportunities{' '}
              {valueText(c.all.v, unit)} over {formatInt(c.all.n)} sessions.
            </p>
          ) : null}
          {c?.zt ? (
            <p className="text-faint">
              {formatInt(c.zt)} strategy-day{c.zt === 1 ? '' : 's'} with no trades, counted as zero.
            </p>
          ) : null}
          {c?.sel ? (
            <p className="text-muted">
              Picked:{' '}
              {LIST_ORDER.filter((k) => c.sel?.[k])
                .map((k) => `${k} ${c.sel?.[k]}×`)
                .join(', ')}{' '}
              of {formatInt(c.rec)} recorded strategy-days
            </p>
          ) : null}
          {picks && picks.length > 0 ? (
            <p className="text-muted">Picked by {picks.join(', ')} (recorded)</p>
          ) : null}
          {cell.thin ? (
            <p className="text-warning">
              Thin:{' '}
              {difference
                ? `${thinnest(d?.n)} sessions in the smaller period`
                : `only ${formatInt(c?.n)} sessions`}
            </p>
          ) : null}
        </>
      ) : (
        <p className="text-muted">
          {kind === 'na'
            ? 'Not applicable: this strategy does not exist here.'
            : kind === 'excluded'
              ? `Excluded: ${cell?.reason ?? 'removed by the filters'}.`
              : `Missing: ${cell?.reason ?? 'no stored result'}.`}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recorded picks status
// ---------------------------------------------------------------------------

/** What the overlay can say today: how many entries, how many count, what is waiting. */
export function OverlayStatus({ overlay }: { overlay: MatrixOverlay }) {
  if (!overlay.available) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Badge tone="neutral">Recorded picks</Badge>
        <span>
          Not available: {overlay.reason ?? 'no entry recorded'}. Nothing is reconstructed here, so
          there is no selection overlay until the journal has entries.
        </span>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted">
      <Badge tone="primary">Recorded picks</Badge>
      <span>
        {formatInt(overlay.on_time)} on-time {overlay.on_time === 1 ? 'entry' : 'entries'},{' '}
        {formatInt(overlay.scored)} scored
      </span>
      {overlay.waiting_on_results.length > 0 ? (
        <span>
          waiting on results: {overlay.waiting_on_results.map((d) => formatDay(d)).join(', ')}
        </span>
      ) : null}
      {overlay.late.length > 0 ? (
        <span className="text-warning">
          {formatInt(overlay.late.length)} late (not forward, excluded from selection statistics):{' '}
          {overlay.late.map((d) => formatDay(d)).join(', ')}
        </span>
      ) : null}
      <span className="text-faint">Reconstructed picks are not shown.</span>
    </div>
  );
}

/** "09:17" for the slot key of a column, or the label the API sent. */
export function colHeader(key: string, label: string): string {
  return /^\d{4}$/.test(key) ? slotLabel(key) : label;
}
