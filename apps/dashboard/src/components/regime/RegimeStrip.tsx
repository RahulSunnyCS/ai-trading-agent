/**
 * The window as a strip of trading days, one cell per weekday, coloured by the day's regime
 * and carrying its glyph (so colour is never the only cue). The strip is one tab stop: arrow
 * keys move between days, Home / End jump to the ends, and the focused, hovered or tapped day
 * is spelled out in the readout underneath.
 */

import { type KeyboardEvent, useRef, useState } from 'react';

import { cn } from '../../lib/cn';
import { formatDay, formatPct } from '../../lib/format';
import { regimeMeta } from '../../lib/regimeMeta';
import type { StripCell } from '../../lib/regimeTags';
import { RegimeBadge } from '../optionslab/regimes/RegimeBadge';
import type { Tone } from '../ui/Badge';

const CELL_TONE: Record<Tone, string> = {
  positive: 'bg-positive/20 text-positive',
  negative: 'bg-negative/20 text-negative',
  warning: 'bg-warning/20 text-warning',
  info: 'bg-info/20 text-info',
  accent: 'bg-accent/20 text-accent',
  primary: 'bg-primary/20 text-primary',
  neutral: 'bg-surface-2 text-muted',
};

/** "Mon 05 Oct 2026: Ranging, confidence 82.0%" — the cell's spoken label. */
export function describeCell(cell: StripCell): string {
  const head = `${cell.weekday} ${formatDay(cell.day)}`;
  if (cell.tag === null) return `${head}: not tagged`;
  const meta = regimeMeta(cell.tag.regime);
  const confidence =
    cell.tag.confidence === null ? '' : `, confidence ${formatPct(cell.tag.confidence, 1)}`;
  return `${head}: ${meta.label}${confidence}`;
}

export function RegimeStrip({
  cells,
  highlight,
}: {
  cells: readonly StripCell[];
  /** A regime key to emphasise; other days are dimmed. Null shows every day at full strength. */
  highlight: string | null;
}) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [active, setActive] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const lastDay = cells[cells.length - 1]?.day ?? null;
  const tabStop = active !== null && cells.some((c) => c.day === active) ? active : lastDay;
  const shownDay = hovered ?? active ?? lastDay;
  const shown = cells.find((c) => c.day === shownDay) ?? null;

  function focusAt(index: number): void {
    const cell = cells[Math.max(0, Math.min(cells.length - 1, index))];
    if (!cell) return;
    setActive(cell.day);
    buttons.current.get(cell.day)?.focus();
  }

  function onKeyDown(event: KeyboardEvent, index: number): void {
    let target: number;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = index - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = cells.length - 1;
    else return;
    event.preventDefault();
    focusAt(target);
  }

  return (
    <div>
      <fieldset className="m-0 border-0 p-0" onMouseLeave={() => setHovered(null)}>
        <legend className="sr-only">Regime by trading day, oldest first</legend>
        <div className="flex flex-wrap gap-1">
          {cells.map((cell, index) => {
            const meta = cell.tag ? regimeMeta(cell.tag.regime) : null;
            const dimmed = highlight !== null && cell.tag?.regime !== highlight;
            return (
              <button
                key={cell.day}
                ref={(el) => {
                  if (el) buttons.current.set(cell.day, el);
                  else buttons.current.delete(cell.day);
                }}
                type="button"
                tabIndex={cell.day === tabStop ? 0 : -1}
                aria-label={describeCell(cell)}
                aria-pressed={cell.day === active}
                onClick={() => setActive(cell.day)}
                onFocus={() => setActive(cell.day)}
                onMouseEnter={() => setHovered(cell.day)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold transition-opacity',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  meta ? CELL_TONE[meta.tone] : 'border border-dashed border-border text-faint',
                  dimmed && 'opacity-30',
                  cell.day === active && 'ring-2 ring-border-strong',
                )}
              >
                <span aria-hidden="true">{meta ? meta.glyph : '·'}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-3 min-h-12 rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-sm">
        {shown === null ? (
          <span className="text-muted">No day selected.</span>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="metric text-foreground">
                {shown.weekday} {formatDay(shown.day)}
              </span>
              <RegimeBadge regime={shown.tag?.regime ?? null} />
              {shown.tag?.confidence !== null && shown.tag?.confidence !== undefined ? (
                <span className="text-xs text-muted">
                  confidence {formatPct(shown.tag.confidence, 1)}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted">
              {shown.tag
                ? regimeMeta(shown.tag.regime).definition
                : 'No tag for this weekday: an exchange holiday, or a day the EOD tagger did not run.'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
