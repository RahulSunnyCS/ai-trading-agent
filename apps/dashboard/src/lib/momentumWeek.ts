/**
 * Momentum › This week (BL-051): the Friday timeline, what needs a person, and how a favourite's
 * rows are grouped. Pure helpers, tested in `__tests__/momentumWeek.test.ts`; the page is
 * `components/momentum/week/`.
 */
import type {
  MomentumJournalCheck,
  MomentumStockActionReview,
  MomentumWeekCard,
  MomentumWeekRow,
  MomentumWeeklyStatus,
} from '../types/momentum';

type ScheduledRun = MomentumWeeklyStatus['schedule'][number]['run'];

/** The Friday steps in time order (the 14:15 orders step arrives with BL-051 Phase 3). */
export const STEP_LABEL: Record<ScheduledRun, string> = {
  preview: 'ETF preview',
  final: 'ETF final',
  'stock-ingest': 'Stock data + final',
  'journal-check': 'Journal check',
  'live-rules': 'Rules check',
};

export type StepState = 'done' | 'late' | 'waiting' | 'due' | 'missed';

export interface TimelineStep {
  run: ScheduledRun;
  label: string;
  /** "14:40", from the schedule's label. */
  time: string;
  state: StepState;
  /** When it ran (an ISO instant), for "ran 14:41". */
  ranAt: string | null;
  /** Minutes until it is due, while waiting on the Friday itself. */
  minutesToGo: number | null;
  lateBy: number | null;
}

const IST_OFFSET_MS = 330 * 60_000;

/** The IST calendar day of an instant, as YYYY-MM-DD. */
export function istDay(instant: Date | string): string {
  const ms = typeof instant === 'string' ? Date.parse(instant) : instant.getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutes since IST midnight of an instant. */
function istMinutes(instant: Date): number {
  const shifted = new Date(instant.getTime() + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function scheduledMinutes(when: string): number | null {
  const match = /(\d{1,2}):(\d{2})/.exec(when);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** A step not run 15 minutes after its time is late to start; after that it counts as missed. */
const DUE_WINDOW_MINUTES = 15;

/**
 * Each scheduled Friday step for the target week: done (or done late), still to come on the
 * Friday itself, due now, or missed. A run on a later day (the laptop was asleep) still counts
 * as done for that Friday.
 */
export function timeline(status: MomentumWeeklyStatus, now: Date): TimelineStep[] {
  const friday = status.target_week;
  const today = istDay(now);
  const nowMinutes = istMinutes(now);
  return status.schedule.map((item) => {
    const at = scheduledMinutes(item.when);
    const time =
      at === null
        ? item.when
        : `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
    const ran = item.last_ran_at !== null && istDay(item.last_ran_at) >= friday;
    let state: StepState;
    let minutesToGo: number | null = null;
    if (ran) {
      state = item.ran_late_by_minutes != null ? 'late' : 'done';
    } else if (today === friday && at !== null && nowMinutes < at) {
      state = 'waiting';
      minutesToGo = at - nowMinutes;
    } else if (today === friday && at !== null && nowMinutes < at + DUE_WINDOW_MINUTES) {
      state = 'due';
    } else {
      state = 'missed';
    }
    return {
      run: item.run,
      label: STEP_LABEL[item.run] ?? item.run,
      time,
      state,
      ranAt: ran ? item.last_ran_at : null,
      minutesToGo,
      lateBy: ran ? (item.ran_late_by_minutes ?? null) : null,
    };
  });
}

/** "2 h 20 min", "45 min" — whole minutes only. */
export function countdown(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

export interface AttentionItem {
  key: string;
  tone: 'warning' | 'negative';
  title: string;
  detail: string;
  /** What the item's button opens. */
  action: { kind: 'review'; symbol: string } | { kind: 'run' } | { kind: 'journal' } | null;
}

/**
 * What needs a person this week, and nothing else: unclassified splits, a dataset that should
 * have reached the week by now but has not, a journal entry still missing once the 21:00 check
 * has run. An empty list hides the card.
 */
export function needsAttention({
  steps,
  status,
  stockActions,
  journal,
}: {
  steps: readonly TimelineStep[];
  status: MomentumWeeklyStatus | null;
  stockActions: MomentumStockActionReview | null;
  journal: MomentumJournalCheck | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const item of stockActions?.items ?? []) {
    const drop = 1 - item.close / item.previous_close;
    items.push({
      key: `split-${item.symbol}-${item.ex_date}`,
      tone: 'warning',
      title: `${item.symbol} fell ${Math.round(drop * 1000) / 10}% on ${item.ex_date}`,
      detail:
        'No matching split or bonus filing was found. Until it is classified, no share adjustment is applied and its scores may be wrong.',
      action: { kind: 'review', symbol: item.symbol },
    });
  }
  const after = (run: ScheduledRun) =>
    steps.some((step) => step.run === run && step.state !== 'waiting' && step.state !== 'due');
  for (const dataset of status?.datasets ?? []) {
    const due = dataset.key === 'stock' ? after('stock-ingest') : after('final');
    if (!dataset.ready && due) {
      items.push({
        key: `data-${dataset.key}`,
        tone: 'negative',
        title: `${dataset.label} not ready for this week`,
        detail: dataset.through
          ? `Data runs only through ${dataset.through}; this week's signal needs ${status?.target_week}.`
          : 'No data has been ingested.',
        action: { kind: 'run' },
      });
    }
  }
  if (journal && journal.week === status?.target_week && after('journal-check')) {
    const missing = journal.items.filter((item) => item.status !== 'recorded');
    if (missing.length) {
      items.push({
        key: 'journal-missing',
        tone: 'negative',
        title: `Journal: ${missing.length} of ${journal.expected} entries missing for this week`,
        detail: missing.map((item) => `${item.name} (${item.run_kind})`).join(', '),
        action: { kind: 'journal' },
      });
    }
  }
  return items;
}

export type RowSection = 'sell' | 'buy' | 'hold';

const SECTION_OF: Record<string, RowSection> = {
  SELL: 'sell',
  TRIM: 'sell',
  'TRIM TO CAP': 'sell',
  BUY: 'buy',
  ADD: 'buy',
  'TOP UP': 'buy',
};

/** A row's place on the card: what is sold or cut, what is bought or added, what is kept. */
export function rowSection(row: MomentumWeekRow): RowSection {
  return SECTION_OF[row.action.toUpperCase()] ?? 'hold';
}

export const SECTION_LABEL: Record<RowSection, string> = {
  sell: 'Sell',
  buy: 'Buy',
  hold: 'Hold',
};

/** Rows split Sell / Buy / Hold, each by rank (unranked last); empty sections left out. */
export function groupRows(
  rows: readonly MomentumWeekRow[],
): Array<{ section: RowSection; rows: MomentumWeekRow[] }> {
  const byRank = (a: MomentumWeekRow, b: MomentumWeekRow) =>
    (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY);
  return (['sell', 'buy', 'hold'] as const)
    .map((section) => ({
      section,
      rows: rows.filter((row) => rowSection(row) === section).sort(byRank),
    }))
    .filter((group) => group.rows.length > 0);
}

/** Places climbed since last week (positive) or lost; null without both ranks. */
export function rankDelta(row: { rank: number | null; rank_prev?: number | null }): number | null {
  return row.rank == null || row.rank_prev == null ? null : row.rank_prev - row.rank;
}

/** How many places a held name has left before its exit rank; null when the strategy has none. */
export function roomToExit(row: MomentumWeekRow, exitRank: number | null): number | null {
  return exitRank == null || row.rank == null ? null : exitRank - row.rank;
}

/** The card to show first: the one asked for, else the headline, else the first. */
export function selectedCard(
  cards: readonly MomentumWeekCard[],
  id: string | null,
): MomentumWeekCard | null {
  return (
    cards.find((card) => card.id === id) ?? cards.find((card) => card.headline) ?? cards[0] ?? null
  );
}

/** "08c4307d (4w, ph1)" for "Phase 6 ensemble 08c4307d (4w, ph1)" inside "Phase 6 ensemble". */
export function sleeveLabel(name: string, groupName: string): string {
  if (!name.startsWith(groupName)) return name;
  const short = name.slice(groupName.length).replace(/^[\s·-]+/, '');
  return short || name;
}
