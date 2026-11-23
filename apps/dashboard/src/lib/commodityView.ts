/**
 * The Commodity Lab's screens: what each one answers, the BL-218 sweep's recorded verdict, and the
 * small functions that turn the forward test's journal into lines a card shows. Free of React so a
 * test can hold it; every figure the journal or the lake holds comes from the API (never
 * recomputed here), and the sweep rows below are a copy of what BL-218's Log recorded on 2026-11-11.
 */

import type { Tone } from '../components/ui/Badge';
import type {
  CommodityRoot,
  ForwardBlock,
  ForwardEntry,
  SpreadSnapshot,
  WindowState,
} from '../types/commodity';
import { EMPTY, formatDayShort } from './format';

export const COMMODITY_SECTIONS = ['overview', 'forward', 'sweep', 'data'] as const;
export type CommoditySection = (typeof COMMODITY_SECTIONS)[number];
export const COMMODITY_DEFAULT_SECTION: CommoditySection = 'overview';

export interface CommoditySectionMeta {
  workspace: 'Today' | 'Research' | 'Explore data';
  question: string;
  explanation: string;
}

export const COMMODITY_SECTION_META: Readonly<Record<CommoditySection, CommoditySectionMeta>> = {
  overview: {
    workspace: 'Today',
    question: 'What is on the commodity desk today?',
    explanation:
      'The four MCX mini contracts we have studied: when each next expires, how fresh the collected data is, and where the two forward paper tests stand.',
  },
  forward: {
    workspace: 'Today',
    question: 'Are the commodity paper tests earning?',
    explanation:
      'Paper-only tests of two frozen settings: gold Dir in its expiry week (the one setting that passed the sweep) and silver Dir in the week before expiry (a setting the sweep did not clear, tested forward at the owner’s request). Scored every night; no order is ever sent.',
  },
  sweep: {
    workspace: 'Research',
    question: 'Which commodity strategies worked, and which did not?',
    explanation:
      'The recorded verdict of the two-year sweep: Dir, Widesl and Buy families on crude, natural gas, gold and silver. One setting passed; the rest did not.',
  },
  data: {
    workspace: 'Explore data',
    question: 'What commodity data do we hold?',
    explanation:
      'Days of 1-minute option bars collected per contract, and the expiry calendar each root settles on.',
  },
};

/** Where a root's guide page and its contracts' units are described: one place for the labels. */
export const ROOT_UNIT: Readonly<Record<string, string>> = {
  GOLDM: '₹ a point · 100 g contract',
  SILVERM: '₹ a point · 5 kg contract',
  CRUDEOILM: '₹ a point · 10 barrels',
  NATGASMINI: '₹ a point · 250 mmBtu',
};

// ---- the BL-218 verdict (a record, not a computation) ---------------------------------------

export interface SweepRootRow {
  root: string;
  /** What the sellers made before charges, ₹ a session on one lot (fit year). */
  dirGross: number;
  dirCharges: number;
  widGross: number;
  widCharges: number;
  buys: string;
  survivors: string;
}

export const SWEEP_FIT_ROOTS: readonly SweepRootRow[] = [
  {
    root: 'CRUDEOILM',
    dirGross: 40,
    dirCharges: 106,
    widGross: 28,
    widCharges: 96,
    buys: 'All negative after charges; evening Buys lose before charges',
    survivors: 'None — all 12 cohorts killed',
  },
  {
    root: 'NATGASMINI',
    dirGross: 82,
    dirCharges: 112,
    widGross: 50,
    widCharges: 100,
    buys: 'All negative',
    survivors: 'Dir, expiry week',
  },
  {
    root: 'GOLDM',
    dirGross: 596,
    dirCharges: 83,
    widGross: 463,
    widCharges: 73,
    buys: 'Evening breakout, expiry week, survived',
    survivors: 'Dir (both weeks), Widesl (both weeks), evening breakout (expiry week)',
  },
  {
    root: 'SILVERM',
    dirGross: 457,
    dirCharges: 91,
    widGross: 397,
    widCharges: 78,
    buys: 'None survived',
    survivors: 'Dir (both weeks)',
  },
];

export interface SweepFinalistRow {
  name: string;
  setting: string;
  testNet: number;
  perSession: number;
  profitFactor: number;
  lowerBound: number;
  net05: number;
  net0: number;
  /** The pre-registered pass rules it broke, by number; empty = passed. */
  failed: readonly number[];
}

export const SWEEP_FINALISTS: readonly SweepFinalistRow[] = [
  {
    name: 'GOLDM Dir · expiry week',
    setting: '18:00 · ITM1 · SL 21% · re-enter once at cost · hold to close',
    testNet: 96369,
    perSession: 1606,
    profitFactor: 2.8,
    lowerBound: 653,
    net05: 120279,
    net0: 135980,
    failed: [],
  },
  {
    name: 'GOLDM Dir · week before',
    setting: '19:00 · ATM · SL 21% · hold to close',
    testNet: -26732,
    perSession: -446,
    profitFactor: 0.51,
    lowerBound: -831,
    net05: -7665,
    net0: 11395,
    failed: [1, 3, 4, 5],
  },
  {
    name: 'GOLDM Widesl · expiry week',
    setting: '17:05 · OTM1 · SL 115% · trail 15/10',
    testNet: 32861,
    perSession: 548,
    profitFactor: 1.66,
    lowerBound: -138,
    net05: 41579,
    net0: 50311,
    failed: [1, 3, 4],
  },
  {
    name: 'GOLDM Widesl · week before',
    setting: '17:05 · OTM1 · SL 115% · out 22:00',
    testNet: -61402,
    perSession: -1023,
    profitFactor: 0.32,
    lowerBound: -1779,
    net05: -39944,
    net0: -18484,
    failed: [1, 4, 5],
  },
  {
    name: 'GOLDM evening breakout · expiry week',
    setting: 'OTM1 · range 18:30 + 15 min · SL 25% · target 100% · trail 20/10',
    testNet: -25016,
    perSession: -417,
    profitFactor: 0.7,
    lowerBound: -1081,
    net05: -11967,
    net0: -4888,
    failed: [1, 4, 5],
  },
  {
    name: 'SILVERM Dir · expiry week',
    setting: '17:05 · ITM1 · SL 30% · re-enter once at cost',
    testNet: -37572,
    perSession: -626,
    profitFactor: 0.76,
    lowerBound: -1224,
    net05: -23151,
    net0: -8525,
    failed: [1, 4, 5],
  },
  {
    name: 'SILVERM Dir · week before',
    setting: '17:05 · ATM · SL 21%',
    testNet: 26536,
    perSession: 442,
    profitFactor: 1.39,
    lowerBound: -513,
    net05: 44784,
    net0: 63223,
    failed: [1, 4],
  },
  {
    name: 'NATGASMINI Dir · expiry week',
    setting: '18:00 · ATM · SL 30%',
    testNet: -6966,
    perSession: -116,
    profitFactor: 0.58,
    lowerBound: -260,
    net05: 1764,
    net0: 3425,
    failed: [1, 4],
  },
];

export const SWEEP_RULES: readonly string[] = [
  'The lower bound of ₹ a session (5th percentile over resampled expiries) is above zero',
  'It also made money in the fit year',
  'Its cohort’s chance of overfitting (PBO) is at most 0.5',
  'No single expiry gave more than half of the test-year net',
  'It still made money at 0.5% slippage (the sweep assumed 1%)',
];

export const SWEEP_CAVEATS: readonly string[] = [
  'Both years were a gold bull run, and the test year leans on Jan–Mar 2026 (₹70,895 of ₹96,369).',
  'About 60 sessions a year: a wide lower bound, so “not this” is said far more confidently than “yes”.',
  'One pass among 8 finalists drawn from 48 cohorts.',
  'The real bid-ask spread on gold mini options was not measured; the forward test measures it.',
];

// ---- forward test ---------------------------------------------------------------------------

export const WINDOW_TONE: Readonly<Record<WindowState, Tone>> = {
  journaled: 'positive',
  'ready to score': 'info',
  today: 'accent',
  'to come': 'neutral',
  'waiting for data': 'warning',
};

const ORDINAL: Record<number, string> = { 4: 'fourth', 5: 'fifth', 6: 'sixth', 8: 'eighth' };
const ordinal = (n: number): string => ORDINAL[n] ?? `${n}th`;

/** "2 of 6 expiries finished…" lines for the pass-rule card. */
export function passRuleLines(d: ForwardBlock): string[] {
  const { summary, pass_rule: rule } = d;
  const lines = [
    `${summary.sessions} session${summary.sessions === 1 ? '' : 's'} scored across ${summary.expiries} of ${rule.expiries} expiries.`,
    `Pass = net above zero after charges and ${rule.slippage_pct}% slippage, with at least ${rule.expiries_up} of the ${rule.expiries} expiries up. ${summary.expiries_up} up so far.`,
  ];
  if (summary.expiries < rule.expiries) {
    lines.push(
      `Not decided yet: the rule is read only after the ${ordinal(rule.expiries)} expiry (${d.rule.key === 'goldm-dir' ? 'April 2027' : 'May 2027'}).`,
    );
  } else {
    lines.push(
      summary.pass_rule_met ? 'The registered rule is met.' : 'The registered rule is not met.',
    );
  }
  return lines;
}

/** The running net after each journaled session at 1%, 0.5% and 0% slippage, oldest first. */
export function cumulativeLines(
  entries: readonly ForwardEntry[],
): { id: string; points: { time: string; value: number }[] }[] {
  const series: { id: string; pick: (e: ForwardEntry) => number }[] = [
    { id: 'After 1% slippage (the rule)', pick: (e) => e.net },
    { id: 'After 0.5%', pick: (e) => e['net_0.5pct'] ?? e.net },
    { id: 'Before slippage', pick: (e) => e.net_0pct ?? e.net },
  ];
  return series.map(({ id, pick }) => {
    let total = 0;
    return {
      id,
      points: entries.map((e) => {
        total += pick(e);
        return { time: e.day, value: Math.round(total * 100) / 100 };
      }),
    };
  });
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 ? hi : ((sorted[mid - 1] ?? 0) + hi) / 2;
}

/**
 * The median half-spread of the two entry contracts (`keys`: the rule's strike, CE and PE) across the snapshots, in
 * percent of the mid price, to set beside the 1% a fill the backtest charged. Null before any
 * snapshot has a bid and an ask.
 */
export function medianHalfSpreadPct(
  spreads: readonly SpreadSnapshot[],
  keys: readonly string[] = ['ITM1_CE', 'ITM1_PE'],
): number | null {
  const full: number[] = [];
  for (const s of spreads) {
    for (const key of keys) {
      const v = s.contracts?.[key]?.spread_pct_of_mid;
      if (typeof v === 'number') full.push(v);
    }
  }
  const m = median(full);
  return m === null ? null : m / 2;
}

/** A trade's one-line reading for the journal table. */
export function tradeText(t: ForwardEntry['trades'][number]): string {
  const out = t.out_price === null ? 'open' : `${t.out_price}`;
  return `${t.contract} ${t.in_price ?? EMPTY} → ${out} (${t.reason ?? 'open'})`;
}

// ---- overview -------------------------------------------------------------------------------

export function expiryText(root: CommodityRoot): string {
  if (!root.nearest_expiry) {
    return root.calendar_ends
      ? `Calendar ends ${formatDayShort(root.calendar_ends)}`
      : 'No calendar';
  }
  const n = root.weekdays_to_expiry;
  const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} weekdays`;
  return `${formatDayShort(root.nearest_expiry, { weekday: true })} · ${when}`;
}

/** How stale a root's collection is: the weekdays since its last collected day. */
export function staleWeekdays(root: CommodityRoot, asOf: string): number | null {
  if (!root.last_day) return null;
  const end = new Date(`${asOf}T00:00:00Z`);
  const day = new Date(`${root.last_day}T00:00:00Z`);
  let n = 0;
  while (day < end) {
    day.setUTCDate(day.getUTCDate() + 1);
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) n += 1;
  }
  return n;
}

/** The rule in one plain sentence, from the API's own fields. */
export function ruleSentence(d: ForwardBlock): string {
  const r = d.rule;
  const metal = r.root === 'GOLDM' ? 'gold' : r.root === 'SILVERM' ? 'silver' : r.root;
  const exits = Object.entries(r.exits)
    .map(([season, time]) => `${time} ${season}`)
    .join(', ');
  return `Sell the ${r.strike === 'ATM' ? 'at-the-money' : 'in-the-money'} ${metal} call and put at ${r.entry} · ${r.sl}% stop on each leg · ${r.reentry ? 're-enter once at cost' : 'no re-entry'} · hold to 15 minutes before the close (${exits}) · 1 lot · ${r.week} only`;
}
