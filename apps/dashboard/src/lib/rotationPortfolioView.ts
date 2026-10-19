/**
 * Laying the portfolio stop's figures over the daily log's rows (BL-095). The table and the
 * calendar read `gross` and `per_lot_day` off a list block; this returns the same rows with those
 * two replaced by the stopped ones (and `pf` saying what the log showed and where the book
 * stopped), so neither component needs a second code path. A row or list the stop run could not
 * replay is left exactly as the log has it, and so is a list-day whose replay with no stop does not
 * equal the log's stored figure (`matches_log` false: its bars were repaired after the nightly
 * update). A stopped figure from the new bars beside a struck-through one from the old bars would
 * be two different days; `unmatched` counts those so the page can say so.
 */

import type { RotationDayRow, RotationSummary } from '../types/rotation';
import type { RotationListKey, RotationRow } from '../types/rotationDailyLog';
import type { PortfolioDays } from '../types/rotationPortfolio';
import {
  type PortfolioStopSetting,
  amountOf,
  buttonLabel,
  isOn,
  sameTrail,
  trailParam,
} from './portfolioStop';
import { LIST_KEYS } from './rotationDailyLogView';
import { listName } from './rotationListNames';

/** The replay only when it answers this setting (a stale answer for an earlier one is null). */
export function bookFor(
  data: PortfolioDays | null,
  setting: PortfolioStopSetting,
): PortfolioDays | null {
  return data !== null &&
    data.setting?.amount === amountOf(setting) &&
    sameTrail(data.setting?.trail, trailParam(setting)) &&
    Array.isArray(data.rows)
    ? data
    : null;
}

/**
 * The line under a card's portfolio stop: what the replay changed, that it is still replaying, or
 * why it could not; null when the setting is off or nothing is scored yet.
 */
export function stopNote(opts: {
  setting: PortfolioStopSetting;
  scoredDays: number;
  /** The read-out now carries the stopped figures. */
  stopped: boolean;
  error: string | null;
  /** List-days that no longer replay to their logged figure (`unmatched`). */
  skipped: number;
}): string | null {
  const { setting, scoredDays, stopped, error, skipped } = opts;
  if (!isOn(setting) || scoredDays <= 0) return null;
  if (stopped) {
    const level = buttonLabel(setting).replace('Portfolio stop ', '');
    const left =
      skipped > 0
        ? ` ${skipped} list-day${skipped === 1 ? '' : 's'} no longer replay to their logged figure (bars repaired since the nightly update) and keep the registered one.`
        : '';
    return `With the ${level} portfolio stop replayed over these sessions: cumulative gross, ₹ per lot-day, the drawdowns and the curves. Beats random baskets, the verdict and the read-out stay on the registered basis, without a stop.${left}`;
  }
  return error
    ? `The portfolio stop could not be replayed (${error}); the registered figures are shown.`
    : 'Replaying the sessions under the portfolio stop; the registered figures are shown meanwhile.';
}

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
      if (!figure.matches_log) continue; // the log's own figure stays; see the header
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

/** How many list-days replayed to a figure other than the log's (left out of the overlay). */
export function unmatched(book: PortfolioDays | null): number {
  if (book === null) return 0;
  let n = 0;
  for (const row of book.rows) {
    for (const key of LIST_KEYS) if (row.lists[key]?.matches_log === false) n += 1;
  }
  return n;
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
    .map((k) => `${listName(k)}: ${kind} at ${row.lists[k]?.pf?.stop_label ?? ''}`)
    .join('\n');
  return { label: `PF stop ${pf.stop_label}`, title };
}

/** Whether any list in the rows carries stopped figures (the table's note and legend). */
export function hasOverlay(rows: readonly RotationRow[]): boolean {
  return rows.some((r) => LIST_KEYS.some((k) => r.lists[k]?.pf !== undefined));
}

/** The largest fall of a cumulative series from its running peak, the peak starting at zero
 * (the read-out's own definition; 0 or negative). */
function maxDrawdown(values: readonly number[]): number {
  let cum = 0;
  let peak = 0;
  let worst = 0;
  for (const v of values) {
    cum += v;
    peak = Math.max(peak, cum);
    worst = Math.min(worst, cum - peak);
  }
  return worst;
}

/**
 * The read-out's forward sessions with the portfolio stop laid over them (BL-095): each list's
 * day total and per-lot figure are replaced by the stopped ones, and the figures that follow from
 * them (cumulative gross, ₹ per lot-day, the two max drawdowns) are recomputed from those days.
 * Everything that needs the registered machinery (the random baskets, the intervals, the verdict)
 * is left exactly as the read-out has it, so a caller must label those as the registered basis.
 */
export function overlaySummary(
  summary: RotationSummary,
  book: PortfolioDays | null,
): RotationSummary {
  if (book === null || !summary.days || summary.days.length === 0) return summary;
  const byDay = new Map(book.rows.map((r) => [r.day, r.lists]));
  const keys = LIST_KEYS.filter((k) => summary.lists[k] !== undefined);
  const days: RotationDayRow[] = summary.days.map((row) => {
    const lists = byDay.get(row.day);
    if (!lists) return row;
    const next: RotationDayRow = { ...row };
    for (const k of keys) {
      const f = lists[k];
      if (f === undefined || f.lots <= 0 || !f.matches_log) continue;
      next[`${k}_total`] = f.gross_with;
      next[k] = f.gross_with / f.lots;
    }
    return next;
  });
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const lists = { ...summary.lists };
  for (const k of keys) {
    const stats = summary.lists[k];
    if (stats === undefined) continue;
    const perLot = days.map((r) => num(r[k]));
    const totals = days.map((r) => num(r[`${k}_total`]));
    lists[k] = {
      ...stats,
      total: totals.reduce((a, b) => a + b, 0),
      per_lot_day: perLot.length === 0 ? 0 : perLot.reduce((a, b) => a + b, 0) / perLot.length,
      max_drawdown: maxDrawdown(totals),
      max_drawdown_per_lot: maxDrawdown(perLot),
    };
  }
  return { ...summary, days, lists };
}
