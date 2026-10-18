/**
 * Pure helpers for the Rotation page's "Lot plans" card (BL-135). Every figure comes from the
 * Python package (`rotation/lot_plans.py`); this file only orders, shapes and words them. No
 * network, no `Math.random`.
 */

import type { Tone } from '../components/ui/Badge';
import type {
  LotPlanBook,
  LotPlanId,
  LotPlanReadout,
  LotPlanRow,
  LotPlanStatus,
  LotPlanSummary,
  RotationLotPlansResponse,
} from '../types/rotationLotPlans';
import { EMPTY, formatDay, formatInr, formatInt } from './format';

export const PLAN_ORDER: readonly LotPlanId[] = ['as_picked', 'dir_boost', 'duo'];

export const PLAN_LABEL: Record<LotPlanId, string> = {
  as_picked: 'As picked',
  dir_boost: 'Dir Boost',
  duo: 'Duo',
};

/** One line on what each plan places, for the table's tooltip and the legend. */
export const PLAN_RULE: Record<LotPlanId, string> = {
  as_picked: '1 lot on each of the three picks, every day (3 lots).',
  dir_boost:
    'The three picks; the Dir at 2 lots on a non-expiry day (4 lots). No Dir picked: the best unpicked Dir added at 1 lot. Expiry day: as picked.',
  duo: 'The top Widesl and the Dir only: 2 lots each on a non-expiry day, 2 + 1 on an expiry day.',
};

export const BOOK_OPTIONS: ReadonlyArray<{ value: LotPlanBook; label: string }> = [
  { value: 'core', label: 'Core' },
  { value: 't1', label: 'T1' },
];

export const BOOK_LABEL: Record<LotPlanBook, string> = {
  core: 'Core (the live Adaptive)',
  t1: 'T1 track',
};

export const STATUS_LABEL: Record<LotPlanStatus, string> = {
  scored: 'Scored',
  waiting: 'Waiting',
  late: 'Late',
  unverified: 'Unverified',
};

export const STATUS_TONE: Record<LotPlanStatus, Tone> = {
  scored: 'neutral',
  waiting: 'info',
  late: 'warning',
  unverified: 'warning',
};

/** The summaries in the plans' fixed order (the comparator first). */
export function orderedPlans(r: RotationLotPlansResponse): LotPlanSummary[] {
  const by = new Map(r.plans.map((p) => [p.plan, p] as const));
  return PLAN_ORDER.flatMap((id) => {
    const p = by.get(id);
    return p ? [p] : [];
  });
}

/** A plan's net per day minus the comparator's, over the same scored days; null without days. */
export function perDayVsComparator(
  r: RotationLotPlansResponse,
  plan: LotPlanSummary,
): number | null {
  if (plan.plan === r.comparator) return null;
  const ref = r.plans.find((p) => p.plan === r.comparator);
  if (!ref || ref.net_per_day === null || plan.net_per_day === null) return null;
  return plan.net_per_day - ref.net_per_day;
}

/** The cumulative net lines for the chart, one per plan; empty before the first scored day. */
export function chartLines(
  r: RotationLotPlansResponse,
): { id: string; points: { time: string; value: number }[] }[] {
  if (r.cumulative.length === 0) return [];
  return PLAN_ORDER.map((id) => ({
    id: PLAN_LABEL[id],
    points: r.cumulative.map((c) => ({ time: c.day, value: c[id] })),
  }));
}

/** Words for the empty state, or null once a forward day is scored. */
export function emptyState(
  r: RotationLotPlansResponse,
): { title: string; description: string } | null {
  if (r.counts.scored > 0) return null;
  if (r.rows.length === 0 && r.today < r.forward_from) {
    return {
      title: 'Tracking starts Mon 19 Oct',
      description: `The first forward entry is recorded at 09:16 on ${formatDay(r.forward_from)}; its figures appear once that evening's results are stored.`,
    };
  }
  if (r.rows.length === 0) {
    return {
      title: 'No forward entries yet',
      description: r.message ?? 'This book has no entry recorded since tracking started.',
    };
  }
  return {
    title: 'No forward day scored yet',
    description: r.message ?? 'The figures appear once the evening results are stored.',
  };
}

/** "NIFTY expiry", "SENSEX expiry", "Both expire", or null on a non-expiry day. */
export function expiryTag(row: LotPlanRow): string | null {
  if (!row.expiry) return null;
  const n = row.dte.NIFTY === '0';
  const s = row.dte.SENSEX === '0';
  if (n && s) return 'Both expire';
  return n ? 'NIFTY expiry' : 'SENSEX expiry';
}

/** "4 lots" or a dash when the plan's strategies are not known. */
export function lotsText(lots: number | null): string {
  if (lots === null) return EMPTY;
  return `${formatInt(lots)} ${lots === 1 ? 'lot' : 'lots'}`;
}

/** What a plan places on a day, for a tooltip: "N_wide_0917 ×2 · N_dir_0932 ×2 (best unpicked Dir)". */
export function legsText(row: LotPlanRow, plan: LotPlanId): string {
  const p = row.plans[plan];
  if (p.lots.length === 0) {
    return `Not known: ${row.note ?? 'the best unpicked Dir could not be verified'}`;
  }
  return p.lots
    .map((l) => `${l.name} ×${l.lots}${l.runner_up ? ' (best unpicked Dir)' : ''}`)
    .join(' · ');
}

/** A day's net for one plan, or why there is none (never a zero). */
export function dayNetText(row: LotPlanRow, plan: LotPlanId): string {
  const p = row.plans[plan];
  if (p.net === null) return p.status === 'waiting' ? 'waiting' : EMPTY;
  return formatInr(p.net, { sign: true });
}

/** "19 Oct 2026 to 13 Jan 2027", or an empty string without days. */
function spanText(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return '';
  return from === to ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`;
}

/**
 * The read-out in sentences: how far it is from being read, or each plan against As picked over
 * the dates judged, then the days after it (descriptive). The note on what is authoritative is
 * `readout.note`, shown separately.
 */
export function readoutLines(readout: LotPlanReadout): string[] {
  if (readout.status === 'n/a') {
    const span = spanText(readout.from, readout.to);
    return [
      `Read-out at ${formatInt(readout.needed)} forward scored days: ${formatInt(readout.days)} so far${span ? ` (${span})` : ''}.`,
    ];
  }
  const head = `Read-out on the first ${formatInt(readout.judged_days)} scored days, ${spanText(readout.from, readout.to)}:`;
  const after = readout.after_readout;
  const afterLine = after
    ? [
        `After the read-out, ${formatInt(after.days)} more ${after.days === 1 ? 'day' : 'days'} (${spanText(after.from, after.to)}), descriptive only: ${PLAN_ORDER.flatMap(
          (id) => {
            const v = after.diff_per_day[id];
            return v === undefined
              ? []
              : [`${PLAN_LABEL[id]} ${formatInr(v, { sign: true })} a day against As picked`];
          },
        ).join(', ')}.`,
      ]
    : [];
  const verdicts = PLAN_ORDER.flatMap((id) => {
    const p = readout.plans[id];
    if (!p) return [];
    const verdict =
      p.verdict === 'beats'
        ? 'beats As picked'
        : p.verdict === 'costs'
          ? 'costs against As picked'
          : 'inconclusive';
    return [
      `${p.name} minus As picked: ${formatInr(p.diff_per_day, { sign: true })} a day, 90% interval ${formatInr(p.lo90, { sign: true })} to ${formatInr(p.hi90, { sign: true })}; drawdown per lot ${formatInr(p.dd_per_lot)} vs ${formatInr(p.comparator_dd_per_lot)}: ${verdict}.`,
    ];
  });
  return [head, ...verdicts, ...afterLine];
}

/** Counts under the table: "3 scored · 1 waiting · 1 late". Zero counts are left out. */
export function countsText(r: RotationLotPlansResponse): string {
  const parts = (['scored', 'waiting', 'late', 'unverified'] as const)
    .filter((s) => r.counts[s] > 0)
    .map((s) => `${formatInt(r.counts[s])} ${STATUS_LABEL[s].toLowerCase()}`);
  return parts.length > 0 ? parts.join(' · ') : 'No forward entry yet';
}
