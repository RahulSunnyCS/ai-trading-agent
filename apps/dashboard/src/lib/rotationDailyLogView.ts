/**
 * Pure helpers for Options Lab › Rotation › Daily log. The figures are computed by the Python
 * package (`rotation/daylog.py`); this file only chooses what to ask for and how to read the
 * answer: the window, the calendar grid, the flags on a day, the browsing filters and the
 * plain-words status. No `Math.random`, no network, no clock (the caller passes "today").
 *
 * A day that has no figure shows its reason; nothing here turns a missing value into zero.
 */

import type { RotationReplay } from '../types/legwise';
import type {
  PlacementStatus,
  RotationCounters,
  RotationListBlock,
  RotationListKey,
  RotationLog,
  RotationLogSource,
  RotationPick,
  RotationRow,
  RotationStatus,
} from '../types/rotationDailyLog';
import { formatDay, formatInr } from './format';
import { addDays } from './regimeTags';

export const LIST_KEYS: readonly RotationListKey[] = ['A', 'B', 'C', 'REF'];

/** The longest placement note the server accepts. */
export const NOTE_MAX = 300;

/** An explicit `from` that means "the whole history" (the API's default is the last 180 days). */
export const ALL_FROM = '2000-01-01';

// --- the window -------------------------------------------------------------------------------

export type WindowChoice = 'all' | '126' | '63' | '21';

export const WINDOW_LABEL: Record<WindowChoice, string> = {
  all: 'All',
  '126': '6 months',
  '63': '3 months',
  '21': '1 month',
};

function toUtc(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The `from` / `to` to ask for. The recorded journal is short, so it defaults to all of it; the
 * reconstructed history is long, so it defaults to the last 6 months. A choice is a count of
 * trading days, converted to calendar days back from `today` (63 trading days is 89). */
export function windowRange(
  choice: WindowChoice,
  today: string,
  source: RotationLogSource,
): { from: string | undefined; to: string | undefined } {
  if (choice === 'all')
    return { from: source === 'recorded' ? undefined : ALL_FROM, to: undefined };
  const trading = Number(choice);
  return { from: addDays(today, -Math.ceil((trading * 7) / 5)), to: undefined };
}

/** Is `log` the answer to THIS request? `usePolledResource` keeps the previous response while a
 * new URL loads, so after a switch of source or window the old rows would sit under the new
 * label. A reconstructed row read as a forward day is the one mistake this screen must not make. */
export function logMatches(
  log: Pick<RotationLog, 'source' | 'from' | 'to'>,
  source: RotationLogSource,
  range: { from?: string | undefined; to?: string | undefined },
): boolean {
  return (
    log.source === source && log.from === (range.from ?? null) && log.to === (range.to ?? null)
  );
}

export function defaultWindow(source: RotationLogSource): WindowChoice {
  return source === 'recorded' ? 'all' : '126';
}

// --- naming picks -----------------------------------------------------------------------------

const FAMILY_SHORT: Record<string, string> = {
  wide: 'Widesl OTM1',
  dir: 'Dir ATM',
  ditm1: 'Dir ITM1',
  buy: 'Buy',
};

/** `wide` -> "Widesl OTM1", `p80` -> "Widesl p80" (closest premium 80), `buy` -> "Buy". */
export function familyShort(family: string | null): string {
  if (!family) return '—';
  const fixed = FAMILY_SHORT[family];
  if (fixed) return fixed;
  const premium = /^p(\d+)$/.exec(family);
  return premium ? `Widesl p${premium[1]}` : family;
}

/** "NIFTY Widesl OTM1 09:17" from the parts the API parsed out of the name. */
export function pickLabel(p: RotationPick): string {
  if (!p.index || !p.family || !p.start) return p.name;
  return `${p.index} ${familyShort(p.family)} ${p.start}`;
}

// --- the badges on a day ----------------------------------------------------------------------

export type FlagTone = 'negative' | 'warning' | 'info' | 'neutral';

export interface RowFlag {
  id: string;
  label: string;
  tone: FlagTone;
  /** The sentence behind the badge. */
  title: string;
}

function listsWhere(row: RotationRow, pred: (b: RotationListBlock) => boolean): RotationListKey[] {
  return LIST_KEYS.filter((k) => {
    const block = row.lists[k];
    return block !== undefined && pred(block);
  });
}

/** The small badges a day carries: what makes it different from an ordinary recorded day. The
 * structural facts that are true of most days (the Widesl minimum applied, a Buy qualified) are
 * markers on each list's figure instead, so a badge always means something unusual. */
export function rowFlags(row: RotationRow): RowFlag[] {
  const flags: RowFlag[] = [];
  if (row.source === 'reconstructed') {
    flags.push({
      id: 'reconstructed',
      label: 'Reconstructed',
      tone: 'neutral',
      title:
        'Re-scored afterwards with the rule from the results before this day: what it would have picked, not what was recorded.',
    });
  }
  if (row.status === 'late') {
    flags.push({
      id: 'late',
      label: 'Late',
      tone: 'warning',
      title: row.status_detail || 'Recorded after 09:17: not a forward entry.',
    });
  }
  if (row.vix && row.source === 'recorded') {
    if (row.vix.open === null) {
      flags.push({
        id: 'vix_missing',
        label: 'No VIX',
        tone: 'warning',
        title: 'The 09:15 VIX open is not in this entry.',
      });
    } else if (row.vix.source === 'angelone') {
      flags.push({
        id: 'vix_angelone',
        label: 'VIX: Angel One',
        tone: 'info',
        title: 'The 09:15 VIX open came from Angel One (no usable Fyers login that morning).',
      });
    } else if (row.vix.source === 'given') {
      flags.push({
        id: 'vix_given',
        label: 'VIX: given',
        tone: 'warning',
        title: 'The VIX open was supplied by hand (--vix-open), not read from a broker.',
      });
    }
  }
  if (row.dte?.source === 'calendar') {
    flags.push({
      id: 'dte_calendar',
      label: 'DTE: calendar',
      tone: 'warning',
      title:
        "Days to expiry came from the reference calendar, which lags real expiries around holidays, not from the exchange's listed contracts.",
    });
  }
  const stopped = listsWhere(row, (b) => b.stops > 0);
  if (stopped.length > 0) {
    flags.push({
      id: 'stop',
      label: 'Stop',
      tone: 'negative',
      title: `An overall stop-loss fired in: ${stopped.join(', ')}.`,
    });
  }
  return flags;
}

/** Flags that say the RECORD of a day is not the normal one (as opposed to what its picks did). */
const RECORD_FLAGS = new Set(['late', 'vix_missing', 'vix_given', 'dte_calendar']);

/** A day whose record is not the ordinary one: the entry was late or missing, or an input it was
 * scored on did not come from the primary source. A stop is a result, not a record problem: the
 * loss shading and the "Stops" filter carry it. */
export function isFlagged(row: RotationRow | null): boolean {
  if (row === null) return false;
  return row.status === 'not_recorded' || rowFlags(row).some((f) => RECORD_FLAGS.has(f.id));
}

/** The focus list had an overall stop-loss fire on this day (null when it has no figure yet). */
export function focusStopped(row: RotationRow | null, focus: RotationListKey): boolean {
  const block = row?.lists[focus];
  return block !== undefined && block.stops > 0;
}

// --- browsing filters (not evaluation) --------------------------------------------------------

export type RowFilter = 'all' | 'losing' | 'stops' | 'differ';

export const FILTER_LABEL: Record<RowFilter, string> = {
  all: 'All',
  losing: 'Losing',
  stops: 'Stops',
  differ: 'Lists disagree',
};

export const FILTER_HELP: Record<RowFilter, string> = {
  all: 'Every day in the window.',
  losing: 'Days the focus list lost money (gross).',
  stops: 'Days an overall stop-loss fired on any pick of any list.',
  differ: 'Days the four lists did not all pick the same strategies.',
};

/** A browsing aid, not a result: a filtered view is selected by its outcome, so any figure read
 * off it is biased. The page says so next to the chips. */
export function matchesFilter(
  row: RotationRow,
  filter: RowFilter,
  focus: RotationListKey,
): boolean {
  if (filter === 'all') return true;
  if (row.source === 'missing') return false;
  if (filter === 'losing') {
    const v = row.lists[focus]?.per_lot_day;
    return typeof v === 'number' && v < 0;
  }
  if (filter === 'stops') return Object.values(row.lists).some((b) => (b?.stops ?? 0) > 0);
  return row.all_identical === false;
}

export function applyFilter(
  rows: readonly RotationRow[],
  filter: RowFilter,
  focus: RotationListKey,
): RotationRow[] {
  return rows.filter((r) => matchesFilter(r, filter, focus));
}

// --- the status in words ----------------------------------------------------------------------

export const STATUS_LABEL: Record<RotationStatus, string> = {
  scored: 'Scored',
  waiting: 'Waiting',
  late: 'Late',
  not_recorded: 'Not recorded',
};

export type StatusTone = 'positive' | 'info' | 'warning' | 'negative' | 'neutral';

export const STATUS_TONE: Record<RotationStatus, StatusTone> = {
  scored: 'positive',
  waiting: 'info',
  late: 'warning',
  not_recorded: 'negative',
};

// --- the placement record ---------------------------------------------------------------------

export const PLACEMENT_LABEL: Record<PlacementStatus, string> = {
  placed: 'Placed',
  changed: 'Changed',
  not_placed: 'Not placed',
};

export interface PlacementTally {
  marked: number;
  of: number;
  placed: number;
  changed: number;
  notPlaced: number;
}

/** How many of the day's lists the owner has marked, and how. */
export function placementTally(row: RotationRow): PlacementTally {
  const keys = Object.keys(row.lists);
  const t: PlacementTally = { marked: 0, of: keys.length, placed: 0, changed: 0, notPlaced: 0 };
  for (const k of keys) {
    const p = row.placement[k as RotationListKey];
    if (!p) continue;
    t.marked += 1;
    if (p.status === 'placed') t.placed += 1;
    else if (p.status === 'changed') t.changed += 1;
    else t.notPlaced += 1;
  }
  return t;
}

/** A placement draft is valid when its status is set and a "changed" says what changed. */
export function placementProblem(status: PlacementStatus | '', note: string): string | null {
  if (status === '') return 'Choose placed, changed or not placed.';
  const text = note.trim();
  if (text.length > NOTE_MAX) return `The note is ${text.length} characters; at most ${NOTE_MAX}.`;
  if (status === 'changed' && text === '') return 'Say what was changed in the note.';
  return null;
}

// --- the calendar -----------------------------------------------------------------------------

export type CellKind =
  | 'scored'
  | 'waiting'
  | 'late'
  | 'not_recorded'
  | 'holiday'
  | 'future'
  | 'none'
  | 'outside';

export interface CalendarCell {
  day: string;
  /** Day of the month, for the label. */
  date: number;
  kind: CellKind;
  row: RotationRow | null;
  /** The focus list's gross per lot-day on this day, when scored. */
  value: number | null;
  holiday: string | null;
}

export interface Month {
  year: number;
  /** 1..12 */
  month: number;
}

export function monthOf(day: string): Month {
  const d = toUtc(day);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

export function shiftMonth(m: Month, by: number): Month {
  const index = m.year * 12 + (m.month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function monthKey(m: Month): string {
  return `${m.year}-${String(m.month).padStart(2, '0')}`;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthTitle(m: Month): string {
  return `${MONTH_NAMES[m.month - 1]} ${m.year}`;
}

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

/** The weeks of a month as Monday..Friday rows. Days of the neighbouring months that fall in a
 * shown week are `outside`. Weekends are not drawn: the exchange is shut. */
export function monthGrid(
  m: Month,
  rows: readonly RotationRow[],
  holidays: readonly { day: string; name: string }[],
  focus: RotationListKey,
  today: string,
): CalendarCell[][] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const holiday = new Map(holidays.map((h) => [h.day, h.name]));
  const first = new Date(Date.UTC(m.year, m.month - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7; // Monday = 0
  const start = new Date(first);
  start.setUTCDate(1 - offset);
  const weeks: CalendarCell[][] = [];
  for (let w = 0; w < 6; w++) {
    const week: CalendarCell[] = [];
    for (let d = 0; d < 5; d++) {
      const cell = new Date(start);
      cell.setUTCDate(start.getUTCDate() + w * 7 + d);
      const day = iso(cell);
      const inMonth = cell.getUTCMonth() === m.month - 1;
      const row = byDay.get(day) ?? null;
      const name = holiday.get(day) ?? null;
      let kind: CellKind;
      if (!inMonth) kind = 'outside';
      else if (row) kind = row.status;
      else if (name !== null) kind = 'holiday';
      else if (day > today) kind = 'future';
      else kind = 'none';
      week.push({
        day,
        date: cell.getUTCDate(),
        kind,
        row,
        value: row?.lists[focus]?.per_lot_day ?? null,
        holiday: name,
      });
    }
    if (week.some((c) => c.kind !== 'outside')) weeks.push(week);
  }
  return weeks;
}

/** Shade steps for the focus list's gross: 1 (faint) to 3 (strong), by size against the window's
 * largest absolute day. 0 is "no figure"; a flat day (exactly zero) is not shaded. */
export function shadeStep(value: number | null, scale: number): 0 | 1 | 2 | 3 {
  if (value === null || !Number.isFinite(value) || value === 0 || scale <= 0) return 0;
  const r = Math.abs(value) / scale;
  return r > 2 / 3 ? 3 : r > 1 / 3 ? 2 : 1;
}

/** The largest absolute focus-list value among the scored days in view. */
export function shadeScale(rows: readonly RotationRow[], focus: RotationListKey): number {
  let max = 0;
  for (const r of rows) {
    const v = r.lists[focus]?.per_lot_day;
    if (typeof v === 'number' && Number.isFinite(v)) max = Math.max(max, Math.abs(v));
  }
  return max;
}

/** Literal class names (Tailwind must see them in the source). Profit is positive, loss negative. */
export const SHADE_CLASS = {
  positive: ['', 'bg-positive/10', 'bg-positive/20', 'bg-positive/30'],
  negative: ['', 'bg-negative/10', 'bg-negative/20', 'bg-negative/30'],
} as const;

export function shadeClass(value: number | null, scale: number): string {
  const step = shadeStep(value, scale);
  if (step === 0 || value === null) return '';
  return SHADE_CLASS[value > 0 ? 'positive' : 'negative'][step];
}

/** A diagonal hatch from the border token: holidays and (lighter) days with no data. */
export const HATCH_STYLE = {
  backgroundImage:
    'repeating-linear-gradient(135deg, hsl(var(--border)) 0, hsl(var(--border)) 1px, transparent 1px, transparent 7px)',
} as const;

/** The month to open on: the latest day with a row, else today's. */
export function initialMonth(rows: readonly RotationRow[], today: string): Month {
  const last = rows.length > 0 ? rows[rows.length - 1]?.day : undefined;
  return monthOf(last ?? today);
}

// --- counters and the empty state -------------------------------------------------------------

export interface CounterPart {
  id: string;
  label: string;
  value: string;
  title: string;
}

function perList(values: Record<RotationListKey, number>, of: number): string {
  return LIST_KEYS.map((k) => `${k} ${values[k] ?? 0}/${of}`).join(' · ');
}

/** The footer line: how often each structural thing happened, over the days counted. */
export function counterParts(c: RotationCounters, source: RotationLogSource): CounterPart[] {
  const what = source === 'reconstructed' ? 'reconstructed days' : 'forward days';
  const parts: CounterPart[] = [
    {
      id: 'days',
      label: source === 'reconstructed' ? 'Days' : 'Recorded',
      value: `${c.days}`,
      title: `${c.days} ${what} counted (a late entry is not one).`,
    },
    {
      id: 'scored',
      label: 'Scored',
      value: `${c.scored}`,
      title: `${c.scored} of the ${c.days} have a stored result for every pick; ${c.waiting} are waiting.`,
    },
  ];
  if (source !== 'reconstructed') {
    parts.push(
      {
        id: 'late',
        label: 'Late',
        value: `${c.late}`,
        title: 'Entries written after 09:17: shown, not counted as forward.',
      },
      {
        id: 'not_recorded',
        label: 'Not recorded',
        value: `${c.not_recorded}`,
        title: 'Trading days from the first registered day with no journal entry.',
      },
    );
  }
  parts.push(
    {
      id: 'buy',
      label: 'Buy qualified',
      value: perList(c.buy_qualified, c.days),
      title: `Days a Buy strategy ranked in the overall top 10, per list, of ${c.days} ${what}.`,
    },
    {
      id: 'override',
      label: 'Widesl min applied',
      value: perList(c.widesl_minimum_applied, c.days),
      title: `Days the Widesl minimum replaced a top-ranked Dir, per list, of ${c.days} ${what}.`,
    },
    {
      id: 'identical',
      label: 'All four identical',
      value: `${c.all_lists_identical}/${c.days}`,
      title: 'Days the four lists picked the same strategies.',
    },
    {
      id: 'stops',
      label: 'Stop fired',
      value: `${c.days_with_stop}/${c.days}`,
      title: 'Days an overall stop-loss fired on any pick of any list.',
    },
  );
  return parts;
}

/** What the registered start says when there is nothing to show yet. */
export function emptyHeadline(log: Pick<RotationLog, 'registered' | 'today'>): string {
  const { first_day: first, record_time: at } = log.registered;
  const date = toUtc(first);
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    date.getUTCDay()
  ];
  const label = `${weekday} ${date.getUTCDate()} ${MONTH_NAMES[date.getUTCMonth()]}`;
  return log.today < first
    ? `First entry ${label}, ${at}`
    : `The first entry was due ${label}, ${at}, and none is recorded`;
}

// --- what a calendar cell says in words (also its accessible name) -----------------------------

/** One sentence for a cell: the day, its state, the focus list's figure, a stop, a late entry.
 * Colour is never the only carrier of any of it. */
export function cellDescription(cell: CalendarCell, focus: RotationListKey): string {
  const when = formatDay(cell.day);
  if (cell.kind === 'outside') return when;
  if (cell.kind === 'holiday')
    return `${when}: exchange holiday${cell.holiday ? `, ${cell.holiday}` : ''}`;
  if (cell.kind === 'future') return `${when}: not yet`;
  const row = cell.row;
  if (row === null) return `${when}: no entry in this view`;
  const parts: string[] = [];
  if (row.status === 'late') parts.push('late entry, not a forward day');
  else if (row.status === 'not_recorded') parts.push('not recorded');
  else if (row.status === 'waiting') parts.push('waiting for results');
  else parts.push('scored');
  if (row.source === 'reconstructed') parts.push('reconstructed, not recorded');
  if (cell.value !== null) {
    parts.push(`list ${focus} ${formatInr(cell.value, { sign: true })} gross per lot-day`);
  }
  if (focusStopped(row, focus)) parts.push(`overall stop-loss fired in list ${focus}`);
  const flags = rowFlags(row).filter((f) => f.id !== 'late' && f.id !== 'reconstructed');
  for (const f of flags) if (f.id !== 'stop') parts.push(f.label);
  if (row.status !== 'scored' && row.status_detail) parts.push(row.status_detail);
  return `${when}: ${parts.join('; ')}`;
}

// --- the replay against the stored result ------------------------------------------------------

export interface ReplayStatus {
  matches: boolean;
  text: string;
}

/** Does the replayed gross equal the stored one? A mismatch means the day's data was repaired
 * after the nightly update or the strategy file was edited: say so, with both figures. */
export function replayStatus(r: RotationReplay): ReplayStatus {
  if (r.stored_gross === null) {
    return { matches: false, text: 'No stored result for this day to compare the replay with.' };
  }
  if (r.matches_stored) return { matches: true, text: 'Matches the stored result.' };
  return {
    matches: false,
    text: `Differs from the stored result (${formatInr(r.stored_gross, { sign: true })} stored, ${formatInr(r.simulated_gross, { sign: true })} replayed): the day's data was repaired or the strategy file was edited since.`,
  };
}
