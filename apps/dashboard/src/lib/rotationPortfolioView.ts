/**
 * Laying the portfolio stop's figures over the daily log's rows (BL-092). The table and the
 * calendar read `gross` and `per_lot_day` off a list block; this returns the same rows with those
 * two replaced by the stopped ones (and `pf` saying what the log showed and where the book
 * stopped), so neither component needs a second code path. A row or list the stop run could not
 * replay is left exactly as the log has it.
 */

import type { RotationListKey, RotationRow } from '../types/rotationDailyLog';
import type { PortfolioDays } from '../types/rotationPortfolio';
import { LIST_KEYS } from './rotationDailyLogView';

export function overlayBook(
  rows: readonly RotationRow[],
  book: PortfolioDays | null,
): readonly RotationRow[] {
  if (book === null) return rows;
  const byDay = new Map(book.rows.map((r) => [r.day, r.lists]));
  return rows.map((row) => {
    const lists = byDay.get(row.day);
    if (lists === undefined) return row;
    const next = { ...row.lists };
    let changed = false;
    for (const key of LIST_KEYS) {
      const block = row.lists[key];
      const figure = lists[key];
      if (block === undefined || figure === undefined || block.lots <= 0) continue;
      if (block.gross === null || block.per_lot_day === null) continue;
      next[key] = {
        ...block,
        gross: figure.gross_with,
        per_lot_day: figure.gross_with / block.lots,
        pf: {
          gross_without: block.gross,
          per_lot_day_without: block.per_lot_day,
          stop_label: figure.stop_label,
          fired_by: figure.fired_by,
        },
      };
      changed = true;
    }
    return changed ? { ...row, lists: next } : row;
  });
}

/** Where the focus list's book stopped that day (else the first list that did), for the flag. */
export function stopFlag(
  row: RotationRow,
  focus: RotationListKey,
): { label: string; title: string } | null {
  const fired = LIST_KEYS.filter((k) => row.lists[k]?.pf?.stop_label);
  if (fired.length === 0) return null;
  const key = row.lists[focus]?.pf?.stop_label ? focus : fired[0];
  const pf = key ? row.lists[key]?.pf : undefined;
  if (!pf?.stop_label) return null;
  const kind = pf.fired_by === 'lock' ? 'profit lock' : 'portfolio stop';
  const title = fired
    .map((k) => `${k}: ${kind} at ${row.lists[k]?.pf?.stop_label ?? ''}`)
    .join('\n');
  return { label: `PF stop ${pf.stop_label}`, title };
}

/** Whether any list in the rows carries stopped figures (the table's note and legend). */
export function hasOverlay(rows: readonly RotationRow[]): boolean {
  return rows.some((r) => LIST_KEYS.some((k) => r.lists[k]?.pf !== undefined));
}
