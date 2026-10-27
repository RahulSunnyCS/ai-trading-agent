/**
 * The Trade book page's view logic (BL-168): years, account and source labels, the target pace,
 * the headline against a benchmark, the running figures within the picked year, day states, the
 * monthly cells, the inputs dialog's body. Every figure the sheet defines (net, charges, the T / U /
 * V / W / Z ratios, drawdown, the summary block) comes from the API (`realised/ratios.py`); this
 * file only shapes them and never invents one. Pure, so it is unit-tested.
 */

import type {
  TradeBookDay,
  TradeBookDayDetail,
  TradeBookLedgerEvent,
  TradeBookManual,
  TradeBookMonth,
  TradeBookSummaryBlock,
  TradeBookTrip,
} from '../types/tradeBook';

export const TRADE_BOOK_API = '/api/backtest/legwise/contract-notes';

/** The F&O brokers; Zerodha (`kite`) is Momentum's and kept out of the F&O figures. */
export const FNO_BROKERS: readonly string[] = ['finvasia', 'angelone'];

// ---------------------------------------------------------------------------
// Financial years (April to March)
// ---------------------------------------------------------------------------

/** The financial year a day ("YYYY-MM-DD") falls in, by its starting year. */
export function fiscalYearOf(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month >= 4 ? year : year - 1;
}

/** "FY 2025-26". */
export function fyLabel(start: number): string {
  return `FY ${start}-${String(start + 1).slice(2)}`;
}

/** "2025-26" (the API's `fy`) -> 2025; null when it does not read. */
export function parseFy(text: string | null | undefined): number | null {
  const m = /^(\d{4})(?:-\d{2})?$/.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

export function fyRange(start: number): { from: string; to: string } {
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

function dayNumber(day: string): number {
  return Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

/** The same calendar day a year earlier (29 Feb becomes 28 Feb). */
export function yearEarlier(day: string): string {
  const y = Number(day.slice(0, 4)) - 1;
  const md = day.slice(5, 10) === '02-29' ? '02-28' : day.slice(5, 10);
  return `${y}-${md}`;
}

/**
 * The share of the financial year that has passed by the end of `day`: 1 April is 1/365, 31 March
 * is 1. A target pace of R a year is R times this.
 */
export function yearFraction(day: string): number {
  const { from, to } = fyRange(fiscalYearOf(day));
  const length = (dayNumber(to) - dayNumber(from)) / 86_400_000 + 1;
  const elapsed = (dayNumber(day) - dayNumber(from)) / 86_400_000 + 1;
  return Math.min(1, Math.max(0, elapsed / length));
}

/**
 * Years the picker offers, newest first: every year the store has rows for, and the current one
 * (from `today`) even before its first note, so a new year opens on its empty state.
 */
export function fyOptions(storeYears: readonly string[], today: string): number[] {
  const years = new Set<number>([fiscalYearOf(today)]);
  for (const fy of storeYears) {
    const start = parseFy(fy);
    if (start !== null) years.add(start);
  }
  return [...years].sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// Accounts and sources
// ---------------------------------------------------------------------------

const BROKER_NAMES: Record<string, string> = {
  finvasia: 'Finvasia',
  angelone: 'Angel One',
  kite: 'Zerodha',
};

export function brokerName(broker: string): string {
  return BROKER_NAMES[broker] ?? broker;
}

/** An account id shown with its middle hidden: "AB1234" -> "AB··34". */
export function maskAccountId(id: string): string {
  return id.length <= 4 ? id : `${id.slice(0, 2)}··${id.slice(-2)}`;
}

/**
 * "finvasia/AB1234" -> "Finvasia · AB··34"; a second account of the same broker (in `all`'s order)
 * is "Finvasia 2 · …".
 */
export function accountLabel(account: string, all: readonly string[] = []): string {
  const [broker = '', id = ''] = account.split('/');
  const same = all.filter((a) => a.split('/')[0] === broker);
  const n = same.indexOf(account);
  const name = n > 0 ? `${brokerName(broker)} ${n + 1}` : brokerName(broker);
  return id ? `${name} · ${maskAccountId(id)}` : name;
}

export interface SourceMeta {
  label: string;
  /** Token classes for the badge's outline and text. */
  badge: string;
  /** Token classes for a chart dot / swatch (series colours: identity, never profit or loss). */
  fill: string;
  swatch: string;
}

export const SOURCE_ORDER = [
  'adaptive-core',
  't1',
  'own-algo',
  'manual',
  'unattributed',
  'unknown',
] as const;

export const SOURCES: Record<string, SourceMeta> = {
  'adaptive-core': {
    label: 'Core',
    badge: 'border-series-1/60 text-series-1',
    fill: 'fill-series-1',
    swatch: 'bg-series-1',
  },
  t1: {
    label: 'T1',
    badge: 'border-series-3/60 text-series-3',
    fill: 'fill-series-3',
    swatch: 'bg-series-3',
  },
  'own-algo': {
    label: 'Own algo',
    badge: 'border-series-4/60 text-series-4',
    fill: 'fill-series-4',
    swatch: 'bg-series-4',
  },
  manual: {
    label: 'Manual',
    badge: 'border-series-2/60 text-series-2',
    fill: 'fill-series-2',
    swatch: 'bg-series-2',
  },
  unattributed: {
    label: 'Unattributed',
    badge: 'border-border-strong text-muted',
    fill: 'fill-muted',
    swatch: 'bg-muted',
  },
  unknown: {
    label: 'Unknown',
    badge: 'border-border text-faint',
    fill: 'fill-faint',
    swatch: 'bg-faint',
  },
};

export function sourceMeta(source: string): SourceMeta {
  return SOURCES[source] ?? (SOURCES.unknown as SourceMeta);
}

/** Sources in display order, the known ones first. */
export function orderSources(sources: Iterable<string>): string[] {
  const order: readonly string[] = SOURCE_ORDER;
  return [...new Set(sources)].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

// ---------------------------------------------------------------------------
// The sheet's algo fee (shown in the inputs dialog before saving)
// ---------------------------------------------------------------------------

/** The sheet's column O: ROUNDUP((algos − 3) × 12.5 + 62.5); none without algos. Mirrors
 * `ratios.algo_fee`, used only to preview the fee while typing. */
export function algoFee(algos: number | null | undefined): number {
  if (!algos || algos <= 0) return 0;
  return Math.ceil((algos - 3) * 12.5 + 62.5);
}

// ---------------------------------------------------------------------------
// Running figures within the picked range
// ---------------------------------------------------------------------------

export interface BookPoint {
  day: string;
  /** The day's profit (Q); null on a day with no note. */
  profit: number | null;
  /** Running profit from the range's first day. */
  toDate: number;
  /** To date minus its running peak (0 at a new high). */
  drawdown: number;
}

/**
 * To date and drawdown restarted at the range's first day, so a year's chart starts at zero and
 * its drawdown matches the summary's (both from the range's own peak). A day with no note adds
 * nothing and keeps its place.
 */
export function runningBook(rows: readonly TradeBookDay[]): BookPoint[] {
  // Summed in whole paise, so a running figure never picks up a float tail (2023.6799999…).
  let toDate = 0;
  let peak = 0;
  return rows.map((r) => {
    if (r.profit !== null) toDate += Math.round(r.profit * 100);
    peak = Math.max(peak, toDate);
    return { day: r.day, profit: r.profit, toDate: toDate / 100, drawdown: (toDate - peak) / 100 };
  });
}

/**
 * The share of the financial year from `first` (the year's first session, or 1 April if
 * earlier) to the end of `day`. The pace starts there, so a year whose first stored session is
 * late in it is not measured against the months before it.
 */
export function paceFraction(first: string, day: string): number {
  const { from, to } = fyRange(fiscalYearOf(day));
  const start = first > from ? first : from;
  const length = (dayNumber(to) - dayNumber(from)) / 86_400_000 + 1;
  const elapsed = (dayNumber(day) - dayNumber(start)) / 86_400_000 + 1;
  return Math.min(1, Math.max(0, elapsed / length));
}

/** The target pace's running figure for each day: capital × rate × the year passed since the
 * first session. */
export function targetLine(
  days: readonly string[],
  capital: number | null,
  ratePct: number,
): Array<{ day: string; value: number }> {
  const first = days[0];
  if (!capital || first === undefined) return [];
  return days.map((day) => ({
    day,
    value: (capital * ratePct * paceFraction(first, day)) / 100,
  }));
}

/**
 * Last year's running profit laid on this year's days: each of this year's days takes last
 * year's running figure on or before the same calendar day a year earlier.
 */
export function lastYearLine(
  days: readonly string[],
  lastYear: readonly BookPoint[],
): Array<{ day: string; value: number }> {
  const out: Array<{ day: string; value: number }> = [];
  let j = -1;
  for (const day of days) {
    const target = yearEarlier(day);
    while (j + 1 < lastYear.length && (lastYear[j + 1]?.day ?? '') <= target) j += 1;
    if (j >= 0) out.push({ day, value: lastYear[j]?.toDate ?? 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Headline against a benchmark
// ---------------------------------------------------------------------------

export type BenchmarkId = 'pace' | 'lastfy';

export interface Benchmark {
  id: BenchmarkId;
  /** The target pace, % a year. */
  ratePct: number;
}

export const TARGET_RATES = [12, 18, 24, 30, 36] as const;
export const DEFAULT_RATE = 24;
/** The benchmark a bare URL means (`bench` absent). */
export const DEFAULT_BENCHMARK_KEY = `pace${DEFAULT_RATE}`;

/** "pace24" / "lastfy" in the URL; anything else is the default pace. */
export function parseBenchmark(text: string | null): Benchmark {
  if (text === 'lastfy') return { id: 'lastfy', ratePct: DEFAULT_RATE };
  const m = /^pace(\d{1,2})$/.exec(text ?? '');
  const rate = m ? Number(m[1]) : DEFAULT_RATE;
  return {
    id: 'pace',
    ratePct: (TARGET_RATES as readonly number[]).includes(rate) ? rate : DEFAULT_RATE,
  };
}

export function benchmarkKey(b: Benchmark): string {
  return b.id === 'lastfy' ? 'lastfy' : `pace${b.ratePct}`;
}

export type TileTone = 'positive' | 'negative' | 'neutral';

export interface Tile {
  id: 'net' | 'return' | 'drawdown' | 'charges' | 'win';
  label: string;
  /** The value already formatted is the component's job; these are the numbers. */
  value: number | null;
  unit: 'inr' | 'pct';
  tone: TileTone;
  /** The benchmark's figure, or null when it has none ("no target figure"). */
  bench: number | null;
  /** value − bench, in the tile's unit (pp for a percentage). */
  gap: number | null;
  /** Higher is better for this tile (drawdown is negative: closer to zero is better). */
  higherBetter: boolean;
  /** The gap is shown without a good / bad colour. */
  toneless?: boolean;
}

function tone(value: number | null): TileTone {
  if (value === null || value === 0) return 'neutral';
  return value > 0 ? 'positive' : 'negative';
}

function gap(value: number | null, bench: number | null): number | null {
  return value === null || bench === null ? null : value - bench;
}

/**
 * The five headline tiles. A target pace has a figure for net profit and return only; last FY
 * (to the same day a year earlier) has one for every tile.
 */
export function headlineTiles(
  s: TradeBookSummaryBlock,
  benchmark: Benchmark,
  lastYear: TradeBookSummaryBlock | null,
): Tile[] {
  const fraction = s.last_day ? paceFraction(s.first_day ?? s.last_day, s.last_day) : 0;
  const pace = benchmark.id === 'pace';
  const targetPct = benchmark.ratePct * fraction;
  const netBench = pace
    ? s.capital
      ? (s.capital * targetPct) / 100
      : null
    : lastYear && lastYear.sessions > 0
      ? lastYear.net
      : null;
  const ly = !pace && lastYear && lastYear.sessions > 0 ? lastYear : null;
  const returnBench = pace ? (s.capital ? targetPct : null) : (ly?.profit_pct ?? null);
  const tiles: Tile[] = [
    {
      id: 'net',
      label: 'Net profit',
      value: s.net,
      unit: 'inr',
      tone: tone(s.net),
      bench: netBench,
      gap: gap(s.net, netBench),
      higherBetter: true,
    },
    {
      id: 'return',
      label: pace ? 'Return vs target' : 'Return on capital',
      value: s.profit_pct,
      unit: 'pct',
      tone: 'neutral',
      bench: returnBench,
      gap: gap(s.profit_pct, returnBench),
      higherBetter: true,
    },
    {
      id: 'drawdown',
      label: 'Max drawdown',
      value: s.max_drawdown,
      unit: 'inr',
      tone: s.max_drawdown < 0 ? 'negative' : 'neutral',
      bench: ly ? ly.max_drawdown : null,
      gap: ly ? gap(s.max_drawdown, ly.max_drawdown) : null,
      higherBetter: true,
    },
    {
      id: 'charges',
      label: 'Charges / net profit',
      value: s.charge_profit_pct,
      unit: 'pct',
      tone: 'neutral',
      bench: ly?.charge_profit_pct ?? null,
      gap: ly ? gap(s.charge_profit_pct, ly.charge_profit_pct) : null,
      higherBetter: false,
      // With a loss in either year the ratio turns negative and a bigger loss reads smaller:
      // no good-or-bad colour then.
      toneless: s.net <= 0 || (ly !== null && ly.net <= 0),
    },
    {
      id: 'win',
      label: 'Win days',
      value: s.win_pct,
      unit: 'pct',
      tone: 'neutral',
      bench: ly?.win_pct ?? null,
      gap: ly ? gap(s.win_pct, ly.win_pct) : null,
      higherBetter: true,
    },
  ];
  return tiles;
}

/** Whether a gap is good news for the reader (green) or bad (red). */
export function gapTone(tile: Tile): TileTone {
  if (tile.gap === null || tile.gap === 0 || tile.toneless) return 'neutral';
  return tile.gap > 0 === tile.higherBetter ? 'positive' : 'negative';
}

// ---------------------------------------------------------------------------
// Day states
// ---------------------------------------------------------------------------

export type DayStateKind = 'notes' | 'open' | 'no-note';

export interface DayState {
  kind: DayStateKind;
  label: string;
}

/**
 * How a day row reads: its notes, a note that failed to read (the day stays open and is left out
 * of every figure until it is fixed), or no note on any account (no trade that day). Never zero.
 */
export function dayState(row: Pick<TradeBookDay, 'notes' | 'open'>): DayState {
  if (row.open > 0) {
    return {
      kind: 'open',
      label: row.notes > 0 ? `${row.notes} read · ${row.open} failed` : `${row.open} failed`,
    };
  }
  if (row.notes === 0) return { kind: 'no-note', label: 'no note' };
  return { kind: 'notes', label: row.notes === 1 ? '1 note' : `${row.notes} notes` };
}

/** A note line's status as words. */
export function lineStatus(status: string): string {
  switch (status) {
    case 'note':
      return 'note';
    case 'no_trade':
      return 'no trade';
    case 'no_note':
      return 'no note (account quiet)';
    case 'failed':
      return 'failed to read';
    default:
      return status;
  }
}

// ---------------------------------------------------------------------------
// Monthly cells
// ---------------------------------------------------------------------------

export interface MonthCell {
  month: string;
  /** "Apr '25". */
  label: string;
  data: TradeBookMonth | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** April to March of the year, each with its month's row or null (no session yet). */
export function monthCells(start: number, months: readonly TradeBookMonth[]): MonthCell[] {
  const byMonth = new Map(months.map((m) => [m.month, m]));
  return Array.from({ length: 12 }, (_, i) => {
    const m = (3 + i) % 12;
    const year = m >= 3 ? start : start + 1;
    const key = `${year}-${String(m + 1).padStart(2, '0')}`;
    return {
      month: key,
      label: `${MONTHS[m]} '${String(year).slice(2)}`,
      data: byMonth.get(key) ?? null,
    };
  });
}

/** A heat cell's tint: stronger with a larger % (or ₹ relative to the year's largest month). */
export function heatClass(value: number | null, scale: number): string {
  if (value === null || value === 0 || !scale) return 'bg-surface-2';
  const strength = Math.abs(value) / scale;
  const step = strength > 0.66 ? 3 : strength > 0.33 ? 2 : 1;
  if (value > 0) return ['', 'bg-positive/10', 'bg-positive/20', 'bg-positive/30'][step] as string;
  return ['', 'bg-negative/10', 'bg-negative/20', 'bg-negative/30'][step] as string;
}

// ---------------------------------------------------------------------------
// Charges by kind
// ---------------------------------------------------------------------------

export interface ChargePart {
  key: string;
  label: string;
  amount: number;
  swatch: string;
}

const CHARGE_LABELS: Record<string, string> = {
  brokerage: 'Brokerage',
  stt: 'STT',
  exchange: 'Exchange',
  transaction: 'Exchange',
  gst: 'GST',
  sebi: 'SEBI',
  stamp: 'Stamp',
  clearing: 'Clearing',
  ipf: 'IPF',
  other: 'Other',
};

const PART_SWATCHES = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-info',
  'bg-faint',
];

/**
 * The year's charges split as the store can split them for a range: the notes' charges, the
 * algo fees (the sheet's formula) and, shown beside them because the sheet never had them, the
 * collateral interest from the ledger and the estimated other debits (₹1,000 per broker a year).
 */
export function yearChargeParts(s: TradeBookSummaryBlock): ChargePart[] {
  const parts = [
    { key: 'notes', label: 'Contract-note charges', amount: s.note_charges },
    { key: 'algo', label: 'Algo fees', amount: s.algo_fees },
    { key: 'interest', label: 'Collateral interest', amount: s.interest },
    { key: 'debits', label: 'Other debits (est.)', amount: s.other_debits ?? 0 },
  ];
  return parts
    .filter((p) => p.amount > 0)
    .map((p, i) => ({
      ...p,
      swatch:
        p.key === 'algo'
          ? 'bg-accent'
          : p.key === 'interest' || p.key === 'debits'
            ? 'bg-faint'
            : (PART_SWATCHES[i] as string),
    }));
}

/** One day's charges by kind: every note's itemised charges added, the algo fees, the interest. */
export function dayChargeParts(detail: TradeBookDayDetail): ChargePart[] {
  const sums = new Map<string, number>();
  for (const line of detail.lines) {
    if (line.status !== 'note' || !line.charges || line.broker === 'kite') continue;
    for (const [k, v] of Object.entries(line.charges)) {
      const key = k === 'transaction' ? 'exchange' : k;
      if (typeof v === 'number' && v !== 0) sums.set(key, (sums.get(key) ?? 0) + v);
    }
  }
  const order = Object.keys(CHARGE_LABELS);
  const parts: ChargePart[] = [...sums.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([key, amount], i) => ({
      key,
      label: CHARGE_LABELS[key] ?? key,
      amount,
      swatch: PART_SWATCHES[Math.min(i, PART_SWATCHES.length - 1)] as string,
    }));
  const fees = detail.row?.algo_fees ?? 0;
  if (fees > 0) parts.push({ key: 'algo', label: 'Algo fees', amount: fees, swatch: 'bg-accent' });
  const interest = detail.ledger
    .filter((e) => e.kind === 'collateral_interest')
    .reduce((sum, e) => sum + (e.amount ?? 0), 0);
  if (interest > 0) {
    parts.push({
      key: 'interest',
      label: 'Collateral interest',
      amount: interest,
      swatch: 'bg-faint',
    });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Trips
// ---------------------------------------------------------------------------

export interface TripFilter {
  source: string | null;
  index: string | null;
  /** '0', '1', '2', '3+' or null for any. */
  dte: string | null;
}

export function filterTrips(trips: readonly TradeBookTrip[], f: TripFilter): TradeBookTrip[] {
  return trips.filter((t) => {
    if (f.source && t.source !== f.source) return false;
    if (f.index && t.underlying !== f.index) return false;
    if (f.dte) {
      if (t.dte === null) return false;
      if (f.dte === '3+' ? t.dte < 3 : t.dte !== Number(f.dte)) return false;
    }
    return true;
  });
}

export interface SourceCard {
  source: string;
  trips: number;
  net: number;
  won: number;
  winPct: number | null;
  avg: number | null;
  /** Trips with no P&L (still open, or unresolved: the closing note was not read), counted apart. */
  open: number;
}

/** One card per source: closed and expired trips' net, wins and average; trips without a P&L apart. */
export function sourceCards(trips: readonly TradeBookTrip[]): SourceCard[] {
  const by = new Map<string, SourceCard>();
  for (const t of trips) {
    const card = by.get(t.source) ?? {
      source: t.source,
      trips: 0,
      net: 0,
      won: 0,
      winPct: null,
      avg: null,
      open: 0,
    };
    if (t.net === null) card.open += 1;
    else {
      card.trips += 1;
      card.net += t.net;
      if (t.net > 0) card.won += 1;
    }
    by.set(t.source, card);
  }
  return orderSources(by.keys()).map((source) => {
    const c = by.get(source) as SourceCard;
    return {
      ...c,
      winPct: c.trips ? (c.won * 100) / c.trips : null,
      avg: c.trips ? c.net / c.trips : null,
    };
  });
}

export interface ScatterPoint {
  key: string;
  source: string;
  /** Worst point against the position, ₹ (≤ 0). */
  mae: number;
  /** The trip's P&L as a share of its best point, % (capped to ±100 for the chart). */
  kept: number;
  trip: TradeBookTrip;
}

/** Trips with a best and worst point (the lake had the contract's bars) as scatter points. */
export function scatterPoints(trips: readonly TradeBookTrip[]): ScatterPoint[] {
  const out: ScatterPoint[] = [];
  trips.forEach((t, i) => {
    if (t.mae == null || t.mfe == null || t.pnl === null || !(t.mfe > 0)) return;
    const kept = Math.max(-100, Math.min(100, (t.pnl * 100) / t.mfe));
    out.push({ key: `${t.day}-${i}`, source: t.source, mae: t.mae, kept, trip: t });
  });
  return out;
}

/** "SENSEX 29 Oct 81400 CE" (expiry as day and short month). */
export function contractLabel(
  t: Pick<TradeBookTrip, 'underlying' | 'expiry' | 'strike' | 'kind'>,
): string {
  const parts = [t.underlying];
  if (t.expiry) {
    const m = Number(t.expiry.slice(5, 7));
    parts.push(`${Number(t.expiry.slice(8, 10))} ${MONTHS[m - 1] ?? ''}`.trim());
  }
  if (t.strike !== null) parts.push(String(t.strike).replace(/\.0+$/, ''));
  if (t.kind) parts.push(t.kind);
  return parts.join(' ');
}

/** "5h 58m" / "39m"; null without both times. */
export function heldText(minutes: number | null): string | null {
  if (minutes === null || minutes < 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** A month ("YYYY-MM") as a read range: its first and last day (at most 31 days, the most a
 * read with the best and worst points may span). */
export function monthRange(month: string): { from: string; to: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

/** "Oct '26". */
export function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1] ?? ''} '${month.slice(2, 4)}`;
}

/** The months that have trips (by the day they closed), newest first, with their counts. */
export function tripMonths(
  trips: readonly TradeBookTrip[],
): Array<{ month: string; trips: number }> {
  const counts = new Map<string, number>();
  for (const t of trips) counts.set(t.day.slice(0, 7), (counts.get(t.day.slice(0, 7)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, n]) => ({ month, trips: n }));
}

/** How long a trip was held: "1h 45m", or "overnight" when it closed on a later day; null
 * without fill times. */
export function heldLabel(
  t: Pick<TradeBookTrip, 'day' | 'entry_day' | 'holding_minutes'>,
): string | null {
  if (t.entry_day && t.entry_day !== t.day) return 'overnight';
  return heldText(t.holding_minutes);
}

/** "09:17–15:15", "09:17" or null. */
export function tripTimes(t: Pick<TradeBookTrip, 'entry_time' | 'exit_time'>): string | null {
  const a = t.entry_time?.slice(0, 5);
  const b = t.exit_time?.slice(0, 5);
  if (a && b) return `${a}–${b}`;
  return a ?? null;
}

/** The sources seen on each day, in display order (the Days table's Sources column). */
export function sourcesByDay(trips: readonly TradeBookTrip[]): Map<string, string[]> {
  const by = new Map<string, Set<string>>();
  for (const t of trips) {
    const set = by.get(t.day) ?? new Set<string>();
    set.add(t.source);
    by.set(t.day, set);
  }
  return new Map([...by.entries()].map(([day, set]) => [day, orderSources(set)]));
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** Events of the picked account (all of them for all accounts). */
export function eventsFor(
  events: readonly TradeBookLedgerEvent[],
  account: string | null,
): TradeBookLedgerEvent[] {
  // All accounts are the F&O brokers' (as the API's day rows count them); Zerodha's e-mails
  // belong to Momentum.
  if (!account) return events.filter((e) => FNO_BROKERS.includes(e.broker));
  const [broker] = account.split('/');
  return events.filter((e) =>
    e.account ? `${e.broker}/${e.account}` === account : e.broker === broker,
  );
}

export interface MoneyTotals {
  deposits: number;
  depositCount: number;
  withdrawals: number;
  withdrawalCount: number;
  settlements: number;
  interest: number;
  interestDays: number;
  marginWarnings: number;
  /** Margin warnings at or above 95% used. */
  marginHigh: number;
}

export const MARGIN_HIGH_PCT = 95;

export function moneyTotals(events: readonly TradeBookLedgerEvent[]): MoneyTotals {
  const t: MoneyTotals = {
    deposits: 0,
    depositCount: 0,
    withdrawals: 0,
    withdrawalCount: 0,
    settlements: 0,
    interest: 0,
    interestDays: 0,
    marginWarnings: 0,
    marginHigh: 0,
  };
  for (const e of events) {
    const amount = e.amount ?? 0;
    if (e.kind === 'deposit') {
      t.deposits += amount;
      t.depositCount += 1;
    } else if (e.kind === 'withdrawal') {
      t.withdrawals += amount;
      t.withdrawalCount += 1;
    } else if (e.kind === 'settlement') {
      t.settlements += 1;
    } else if (e.kind === 'collateral_interest') {
      t.interest += amount;
      t.interestDays += 1;
    } else if (e.kind === 'margin_warning') {
      t.marginWarnings += 1;
      if ((e.utilisation_pct ?? 0) >= MARGIN_HIGH_PCT) t.marginHigh += 1;
    }
  }
  return t;
}

/** A ledger event in words. */
export function eventLabel(e: TradeBookLedgerEvent): string {
  switch (e.kind) {
    case 'deposit':
      return 'Funds added';
    case 'withdrawal':
      return 'Payout';
    case 'settlement':
      return 'Fund settlement';
    case 'collateral_interest':
      return 'Collateral interest';
    case 'margin_warning':
      return 'Margin shortfall warning';
    default:
      return e.kind;
  }
}

/** The signed effect of an event on the account: money out is negative, a warning has none. */
export function eventAmount(e: TradeBookLedgerEvent): number | null {
  if (e.amount == null) return null;
  if (e.kind === 'deposit') return e.amount;
  if (e.kind === 'withdrawal' || e.kind === 'collateral_interest' || e.kind === 'settlement') {
    return -Math.abs(e.amount);
  }
  return e.amount;
}

// ---------------------------------------------------------------------------
// The inputs dialog
// ---------------------------------------------------------------------------

export interface InputsDraft {
  algos: string;
  capitalTotal: string;
  finvasia: string;
  angelone: string;
}

/** Rupees to the paisa: an imported amount with more decimals is shown and compared rounded. */
function paise(v: number | null | undefined): number | null {
  return v === null || v === undefined ? null : Math.round(v * 100) / 100;
}

export function inputsDraft(manual: TradeBookManual | null | undefined): InputsDraft {
  const text = (v: number | null | undefined) => {
    const r = paise(v);
    return r === null ? '' : String(r);
  };
  return {
    algos: text(manual?.algos),
    capitalTotal: text(manual?.capital_total),
    finvasia: text(manual?.capital?.finvasia),
    angelone: text(manual?.capital?.angelone),
  };
}

/** A typed amount: commas, spaces and ₹ ignored, rounded to the paisa; '' is "none". NaN when
 * it does not read. */
function readNumber(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, '');
  if (clean === '') return null;
  return /^\d+(\.\d+)?$/.test(clean) ? paise(Number(clean)) : Number.NaN;
}

export interface InputsCheck {
  body: Record<string, unknown>;
  errors: Partial<Record<keyof InputsDraft, string>>;
  changed: boolean;
}

const MAX_RUPEES = 100_000_000;

/**
 * The PUT body for what changed against `manual`, and the errors to show. A cleared field that
 * had a value is sent as null (the API removes it); an untouched one is not sent.
 */
export function inputsBody(
  manual: TradeBookManual | null | undefined,
  draft: InputsDraft,
): InputsCheck {
  const errors: InputsCheck['errors'] = {};
  const body: Record<string, unknown> = {};
  const algos = readNumber(draft.algos);
  if (algos !== null && (!Number.isInteger(algos) || algos < 0 || algos > 200)) {
    errors.algos = 'A whole number, 0 to 200';
  }
  const money = (key: keyof InputsDraft): number | null => {
    const v = readNumber(draft[key]);
    if (v !== null && (Number.isNaN(v) || v < 0 || v > MAX_RUPEES)) {
      errors[key] = 'Rupees, 0 to 10 crore';
    }
    return v;
  };
  const total = money('capitalTotal');
  const fin = money('finvasia');
  const ang = money('angelone');
  if ((algos ?? null) !== (manual?.algos ?? null)) body.algos = algos;
  // Compared with the stored amount rounded to the paisa, so an untouched imported figure with
  // more decimals is not sent back.
  if (total !== paise(manual?.capital_total)) body.capital_total = total;
  const cap: Record<string, number | null> = {};
  if (fin !== paise(manual?.capital?.finvasia)) cap.finvasia = fin;
  if (ang !== paise(manual?.capital?.angelone)) cap.angelone = ang;
  if (Object.keys(cap).length) body.capital = cap;
  return { body, errors, changed: Object.keys(body).length > 0 };
}

// ---------------------------------------------------------------------------
// Momentum (the Zerodha notes)
// ---------------------------------------------------------------------------

export interface KiteTotals {
  bought: number;
  buys: number;
  sold: number;
  sells: number;
  charges: number;
  notes: number;
}

export function kiteTotals(
  notes: ReadonlyArray<{
    eq: { total_charges?: number | null } | null;
    trades: ReadonlyArray<{ side: string; value: number }>;
  }>,
): KiteTotals {
  const t: KiteTotals = { bought: 0, buys: 0, sold: 0, sells: 0, charges: 0, notes: notes.length };
  for (const n of notes) {
    t.charges += n.eq?.total_charges ?? 0;
    for (const trade of n.trades) {
      if (trade.side === 'buy') {
        t.bought += Math.abs(trade.value);
        t.buys += 1;
      } else if (trade.side === 'sell') {
        t.sold += Math.abs(trade.value);
        t.sells += 1;
      }
    }
  }
  return t;
}

/** The query string for a read: from / to / account, empty parts left out. */
export function readQuery(params: Record<string, string | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const text = q.toString();
  return text ? `?${text}` : '';
}
