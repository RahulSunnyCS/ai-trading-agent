import type { LiveState } from './deploy-plan.js';
import { NAME_PREFIXES } from './strategy-plan.js';

/**
 * BL-143 Phases 2-3, decided without a browser or network: the 09:05 margin check, the 09:25
 * deploy check and the day's loss levels. `trade-monitor.ts` reads the platforms (read-only) and
 * sends the messages; everything it decides is here, so the tests need neither.
 *
 * Nothing here, or in the monitor, ever changes anything on a platform or a broker: it reads
 * pages and GET answers, and Telegrams. The loss levels alert; they never square off.
 */

/** The owner's levels (2026-10-20): the day's combined MTM, open + booked, both platforms. */
export const LOSS_WARNING_INR = -5000;
export const LOSS_ALERT_INR = -8000;

/** IST minutes. */
export const SESSION_CLOSE = 15 * 60 + 30;
export const MARGIN_AT = 9 * 60 + 5;
/**
 * No login and no open session from 09:10 to 09:25 (review of PR #276): the 09:16 pick and
 * deploy and the 09:18-09:21 top-ups log in then, and neither platform is known to keep two
 * sessions for one user. The margin check must be over by 09:10; the deploy check and the loss
 * readings start at 09:25.
 */
export const QUIET_FROM = 9 * 60 + 10;
export const QUIET_UNTIL = 9 * 60 + 25;
export const DEPLOY_CHECK_AT = QUIET_UNTIL;
export const LOSS_FROM = QUIET_UNTIL;

export function inQuietWindow(minutes: number): boolean {
  return minutes >= QUIET_FROM && minutes < QUIET_UNTIL;
}

export function inLossWindow(minutes: number): boolean {
  return minutes >= LOSS_FROM && minutes < SESSION_CLOSE;
}

/** A part runs only when its `.env` switch is exactly "on" (any case), like ALGOTEST_UPLOAD. */
export function switchOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name]?.trim().toLowerCase() === 'on';
}

// --- logins: the caps and the waits ----------------------------------------------------------

/** Codes typed (or AlgoTest password logins) per platform a day, at most. */
export const LOGIN_CAP = { algotest: 3, quantiply: 2 } as const;
/** After a failed login, no new one for this long. */
export const LOGIN_BACKOFF_MS = 10 * 60_000;
/** A session the platform ended (401 / logged out) is replaced at most this often. */
export const RELOGIN_EVERY_MS = 30 * 60_000;

export interface LoginLog {
  /** codes typed / logins sent today */
  count: number;
  /** ISO time of the last failed login */
  failedAt?: string;
  /** ISO time of the last login that replaced a lost session */
  reloginAt?: string;
}

/**
 * May the monitor log in to a platform now? Never in the quiet window, never past the cap, not
 * within the backoff after a failure, and a replacement for a lost session at most every 30 min.
 * `why` is said in the log; null means go ahead.
 */
export function loginRefusal(
  log: LoginLog,
  cap: number,
  minutes: number,
  nowMs: number,
  replacing: boolean,
): string | null {
  if (inQuietWindow(minutes)) return 'no login between 09:10 and 09:25 (the deploy window)';
  if (log.count >= cap) return `${cap} logins today already`;
  if (log.failedAt && nowMs - Date.parse(log.failedAt) < LOGIN_BACKOFF_MS) {
    return 'a login failed less than 10 minutes ago';
  }
  if (replacing && log.reloginAt && nowMs - Date.parse(log.reloginAt) < RELOGIN_EVERY_MS) {
    return 'the session was already replaced less than 30 minutes ago';
  }
  return null;
}

// --- money ---------------------------------------------------------------------------------

/** "₹ -1,23,456.50", "-₹ 1,234", "₹ 0", "− ₹12" -> a number; null when there is no figure. */
export function parseRupees(text: string): number | null {
  const m = /^\s*([-−–])?\s*₹\s*([-−–])?\s*(\d[\d,]*(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const value = Number((m[3] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return m[1] || m[2] ? -value : value;
}

/** ₹ in Indian grouping, no decimals: `₹-5,234`, `₹12,50,074`. */
export function inr(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `₹${sign}${Math.round(Math.abs(value)).toLocaleString('en-IN')}`;
}

// --- AlgoTest's Total MTM (/live) -------------------------------------------------------------

/**
 * One MTM card of /live (`[data-testid="broker-mtm"]`, read in the page by
 * `readMtmCardsInPage`): its label (the first line: "Total MTM" or a broker's alias), the text
 * of its figure element (`p.tabular-nums`) and that element's colour class. AlgoTest's bundle
 * (chunk 2331, 2026-10-20) renders the figure `text-green-500` when >= 0 and `text-red-500`
 * when < 0, and a loading dots element instead while it computes.
 */
export interface MtmCard {
  label: string;
  value: string | null;
  red: boolean;
  green: boolean;
}

/**
 * The "Total MTM" card's figure, or why it cannot be read: no such card, no figure element (still
 * loading), a figure that is not exactly one rupee amount, or a colour that disagrees with the
 * sign. A loss shown in red without a minus sign is read as negative.
 */
export function readTotalMtm(cards: MtmCard[]): { inr: number } | { error: string } {
  const total = cards.filter((c) => c.label.trim() === 'Total MTM');
  if (total.length !== 1) return { error: `${total.length} "Total MTM" cards on /live` };
  const card = total[0] as MtmCard;
  if (card.value === null) return { error: 'the Total MTM figure is not shown (still loading?)' };
  const value = parseRupees(card.value);
  if (value === null)
    return { error: `the Total MTM figure "${card.value.slice(0, 30)}" is not a rupee amount` };
  if (card.red === card.green) return { error: 'the Total MTM figure has no profit/loss colour' };
  if (card.red && value > 0) return { inr: -value };
  if (card.green && value < 0) return { error: 'the Total MTM figure is negative but shown green' };
  return { inr: value };
}

/** Runs in the page (`page.evaluate`): the MTM cards as plain data. Reads only. */
export function readMtmCardsInPage(): MtmCard[] {
  return Array.from(document.querySelectorAll('[data-testid="broker-mtm"]')).map((card) => {
    const figure = card.querySelector('p.tabular-nums');
    const text = (card as HTMLElement).innerText ?? card.textContent ?? '';
    return {
      label: text.split('\n')[0]?.trim() ?? '',
      value: figure ? (figure.textContent ?? '').trim() : null,
      red: !!figure?.classList.contains('text-red-500'),
      green: !!figure?.classList.contains('text-green-500'),
    };
  });
}

// --- AlgoTest's broker funds (GET api.algotest.in/brokers) ----------------------------------

export interface BrokerFunds {
  /** AlgoTest's broker id, e.g. `Broker.Finvasia` */
  broker: string;
  available: number | null;
  /** when AlgoTest last read the funds (its broker login), ISO */
  updatedAt: string | null;
  /** until when AlgoTest's broker session lasts, ISO */
  loggedUntil: string | null;
}

/** AlgoTest's timestamps carry no zone and are UTC (`02:47` = AlgoTest's 08:17 IST login). */
export function algotestInstant(ts: string | null): Date | null {
  if (!ts) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function istDayOf(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** `HH:MM` IST of an instant. */
export function istClock(d: Date): string {
  return new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16);
}

/** `GET /brokers`' answer: one entry per linked broker, never its keys (they are not read). */
export function parseAlgotestBrokers(json: unknown): BrokerFunds[] {
  const list = (json as { brokers?: unknown }).brokers;
  if (!Array.isArray(list)) throw new Error('AlgoTest /brokers: no brokers list');
  return (list as Record<string, unknown>[])
    .filter((b) => b.deleted !== true)
    .map((b) => {
      const margin = (b.margin ?? {}) as Record<string, unknown>;
      return {
        broker: String(b.broker ?? ''),
        available: typeof margin.available === 'number' ? margin.available : null,
        updatedAt: typeof margin.updated_ts === 'string' ? margin.updated_ts : null,
        loggedUntil: typeof b.logged_until === 'string' ? b.logged_until : null,
      };
    });
}

/** AlgoTest's broker id for one of the repo's brokers. */
export const ALGOTEST_BROKER_ID = { finvasia: 'Broker.Finvasia', angelone: 'Broker.AngelOne' };

// --- margin need -----------------------------------------------------------------------------

export interface LegNeed {
  underlying: string;
  sell: boolean;
  lots: number;
  /** the closest-premium target when the leg is chosen by premium (₹ per unit), else null */
  premium: number | null;
}

/** An AlgoTest `.algtst` (the export's file): `strategy.Ticker`, each leg's side, lots, premium. */
export function legsFromAlgtst(doc: unknown): LegNeed[] {
  const s = (doc as { strategy?: Record<string, unknown> }).strategy ?? {};
  const underlying = String(s.Ticker ?? '');
  const legs = (s.ListOfLegConfigs ?? []) as Record<string, unknown>[];
  return legs.map((leg) => ({
    underlying,
    sell: leg.PositionType === 'PositionType.Sell',
    lots: Number((leg.LotConfig as { Value?: unknown } | undefined)?.Value ?? 1),
    premium:
      leg.EntryType === 'EntryType.EntryByPremium' && typeof leg.StrikeParameter === 'number'
        ? leg.StrikeParameter
        : null,
  }));
}

/** A Quantiply create body (the export's file): each leg's `base`, side, `quantity`, premium. */
export function legsFromQuantiply(body: unknown): LegNeed[] {
  const conf = ((body as { configurations?: unknown }).configurations ?? {}) as {
    legs?: Record<string, unknown>[];
  };
  return (conf.legs ?? []).map((leg) => {
    const p = (leg.premium ?? {}) as { value?: unknown };
    return {
      underlying: String(leg.base ?? ''),
      sell: leg.transactionType === 'S',
      lots: Number(leg.quantity ?? 1),
      premium: leg.selectionType === 'PREMIUM' && typeof p.value === 'number' ? p.value : null,
    };
  });
}

/**
 * `margin.csv` (option-backtesting's reference data): the latest per-lot figure of each
 * underlying's short straddle. The file is the repo's one margin model (engine/margin.py).
 */
export function parseMarginCsv(text: string): Map<string, number> {
  const best = new Map<string, { month: string; inr: number }>();
  for (const line of text.split('\n').slice(1)) {
    const [underlying = '', type = '', month = '', value = ''] = line.trim().split(',');
    if (type !== 'short-straddle' || !underlying) continue;
    const inr = Number(value);
    const seen = best.get(underlying);
    if (Number.isFinite(inr) && (!seen || month > seen.month)) best.set(underlying, { month, inr });
  }
  return new Map([...best].map(([u, v]) => [u, v.inr]));
}

export interface PickNeed {
  name: string;
  inr: number;
  /** an underlying without its own row in margin.csv borrows NIFTY's figure */
  borrowed: string[];
  /** a bought leg whose premium is not known before entry (chosen by strike): need not estimated */
  unestimated: boolean;
}

/**
 * The documented estimate (BL-143): every sold leg-lot needs half the underlying's short-straddle
 * figure from margin.csv (NIFTY's when the underlying has none); every bought leg-lot its premium
 * x the lot size, known only for a leg chosen by closest premium. A bought leg chosen by strike
 * is "not estimated". No hedge benefit and every pick counted at once.
 */
export function pickNeed(
  name: string,
  legs: LegNeed[],
  perStraddle: Map<string, number>,
  lotOf: (underlying: string) => number | null,
): PickNeed {
  let total = 0;
  let unestimated = false;
  const borrowed = new Set<string>();
  for (const leg of legs) {
    if (!leg.sell) {
      const lot = lotOf(leg.underlying);
      if (leg.premium === null || lot === null) unestimated = true;
      else total += leg.premium * lot * leg.lots;
      continue;
    }
    let straddle = perStraddle.get(leg.underlying);
    if (straddle === undefined) {
      straddle = perStraddle.get('NIFTY') ?? 0;
      borrowed.add(leg.underlying);
    }
    total += (straddle / 2) * leg.lots;
  }
  return { name, inr: total, borrowed: [...borrowed], unestimated };
}

export type MarginVerdict = 'ok' | 'tight' | 'short' | 'unknown';

/** Enough with a 20% cushion = ok; enough but within it = tight; less = short. */
export function marginVerdict(free: number | null, need: number): MarginVerdict {
  if (free === null) return 'unknown';
  if (free >= need * 1.2) return 'ok';
  if (free >= need) return 'tight';
  return 'short';
}

export interface AccountMargin {
  /** `Finvasia`, `Angel One` */
  account: string;
  /** what the picks are for, e.g. `AlgoTest T1` */
  uses: string[];
  picks: PickNeed[];
  free: number | null;
  /** where the free figure came from, or why there is none */
  source: string;
  /** a list whose picks for today could not be read: the need is then unknown */
  picksMissing?: boolean;
}

const MARK: Record<MarginVerdict, string> = { ok: '✅', tight: '⚠️', short: '❌', unknown: '❔' };

export function marginMessage(
  day: string,
  accounts: AccountMargin[],
): { text: string; ok: boolean } {
  const lines: string[] = [];
  let ok = true;
  for (const a of accounts) {
    const need = a.picks.reduce((s, p) => s + p.inr, 0);
    const unest = a.picks.filter((p) => p.unestimated).map((p) => p.name);
    const short = marginVerdict(a.free, need) === 'short';
    // a known shortfall stands even when part of the need is unknown
    const v: MarginVerdict = short
      ? 'short'
      : a.picksMissing || unest.length
        ? 'unknown'
        : marginVerdict(a.free, need);
    if (v !== 'ok') ok = false;
    const free = a.free === null ? 'free not read' : `free ${inr(a.free)}`;
    const count = `${a.picks.length} pick${a.picks.length === 1 ? '' : 's'}`;
    const needText = a.picksMissing
      ? `need not known (picks not read)${a.picks.length ? `, ~${inr(need)} for the ${count} read` : ''}`
      : unest.length
        ? `need at least ~${inr(need)} for ${count} (${unest.join(', ')}: bought by strike, premium not estimated)`
        : `need ~${inr(need)} for ${count}`;
    const tail =
      v === 'short'
        ? ` — SHORT by ${inr(need - (a.free ?? 0))}`
        : v === 'tight'
          ? ' — under a 20% cushion'
          : '';
    lines.push(`${MARK[v]} ${a.account} (${a.uses.join(', ')}): ${free}, ${needText}${tail}`);
    lines.push(`   ${a.source}`);
    const borrowed = [...new Set(a.picks.flatMap((p) => p.borrowed))];
    if (borrowed.length)
      lines.push(`   ${borrowed.join(', ')} estimated with NIFTY's per-lot margin`);
  }
  const head = ok ? `✅ Margin check ${day}` : `⚠️ Margin check ${day}: look before 09:16`;
  return {
    text: [
      head,
      ...lines,
      'Estimate: half the short-straddle margin per sold leg-lot, the premium x lot per bought leg-lot, no hedge benefit',
    ].join('\n'),
    ok,
  };
}

// --- deploy check ----------------------------------------------------------------------------

export interface PlatformCheck {
  /** `AlgoTest T1`, `Quantiply Core` */
  label: string;
  expected: number;
  good: string[];
  /** a pick that is missing, not deployed, or not at 1 lot: what is wrong */
  problems: string[];
  /** a tool strategy deployed / enabled today that is not a pick */
  extra: string[];
  /** anything else worth a line (the owner's own strategies, a stale export) */
  notes: string[];
  /** the platform could not be read at all */
  error?: string;
}

const isTool = (name: string) => NAME_PREFIXES.some((p) => name.startsWith(p));

export type BrokerKey = 'finvasia' | 'angelone';

/** One deployed card of /live's "Deployed Strategies": its name (maybe cut) and its broker. */
export interface DeployedOn {
  name: string;
  broker: BrokerKey | null;
}

/**
 * The "Deployed Strategies" section of /live's text, one block per card. Each card starts with
 * "Deployed on <date>" and carries its name and "<broker - account>"
 * (docs/algotest-execution.md §7); a block that names neither Finvasia/Shoonya nor Angel has an
 * unknown broker.
 */
export function parseDeployedOn(text: string, names: string[]): DeployedOn[] {
  const start = text.indexOf('Deployed Strategies');
  const end = text.indexOf('\nActivation\n');
  if (start < 0) return [];
  const body = text.slice(start, end > start ? end : undefined);
  const blocks = body.split(/\n(?=Deployed on )/).slice(1);
  const out: DeployedOn[] = [];
  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const name =
      names.find((n) =>
        lines.some((l) => l === n || (l.endsWith('...') && n.startsWith(l.slice(0, -3)))),
      ) ?? '';
    const broker = /finvasia|shoonya/i.test(block)
      ? 'finvasia'
      : /angel/i.test(block)
        ? 'angelone'
        : null;
    if (name) out.push({ name, broker });
  }
  return out;
}

/** One AlgoTest row of BL-140 that uploads a list: its broker and today's picks. */
export interface AlgoTestRowPicks {
  broker: BrokerKey;
  picks: string[];
}

/**
 * AlgoTest /live against the day's picks, per BL-140 row: each pick deployed once per row that
 * holds it (a pick in both rows' lists is two deploys), on that row's broker where /live names
 * it, at multiplier 1 (`multipliers`; a deployed pick missing from it is said, never passed
 * silently), and no tool strategy deployed that is not a pick. No broker logged in is a problem.
 */
export function checkAlgoTest(
  label: string,
  rows: AlgoTestRowPicks[],
  live: LiveState,
  multipliers: Map<string, number> | null,
  deployedOn: DeployedOn[],
): PlatformCheck {
  const wantedCount = new Map<string, BrokerKey[]>();
  for (const row of rows) {
    for (const name of row.picks)
      wantedCount.set(name, [...(wantedCount.get(name) ?? []), row.broker]);
  }
  const out: PlatformCheck = {
    label,
    expected: wantedCount.size,
    good: [],
    problems: [],
    extra: [],
    notes: [],
  };
  if (live.brokersLoggedIn < 1) {
    out.problems.push(
      `no broker logged in on AlgoTest (Broker Login ${live.brokersLoggedIn}/${live.brokersTotal})`,
    );
  }
  const liveRows = new Map(live.rows.map((r) => [r.name, r]));
  const brokerUnread = new Set<string>();
  const multUnread: string[] = [];
  for (const [name, brokers] of wantedCount) {
    const row = liveRows.get(name);
    const mult = multipliers?.get(name);
    if (!row) {
      out.problems.push(`${name}: not in AlgoTest`);
      continue;
    }
    if (row.deployed === 0) {
      out.problems.push(`${name}: not deployed`);
      continue;
    }
    if (row.deployed !== brokers.length) {
      out.problems.push(`${name}: deployed ${row.deployed} times, expected ${brokers.length}`);
      continue;
    }
    if (mult !== undefined && mult !== 1) {
      out.problems.push(`${name}: multiplier ${mult}, not 1`);
      continue;
    }
    if (mult === undefined) multUnread.push(name);
    const cards = deployedOn.filter((d) => d.name === name);
    const missing = brokers.filter((b) => !cards.some((c) => c.broker === b));
    if (cards.length && cards.every((c) => c.broker !== null) && missing.length) {
      out.problems.push(`${name}: not deployed on ${missing.join(', ')}`);
      continue;
    }
    if (!cards.length || cards.some((c) => c.broker === null)) brokerUnread.add(name);
    out.good.push(name);
  }
  if (multipliers === null) out.notes.push('multipliers could not be read: deploy counts only');
  else if (multUnread.length) out.notes.push(`multiplier not read for ${multUnread.join(', ')}`);
  if (brokerUnread.size) {
    out.notes.push(
      `which broker /live deployed it on was not read for ${[...brokerUnread].join(', ')}`,
    );
  }
  for (const row of live.rows) {
    if (row.deployed < 1 || wantedCount.has(row.name)) continue;
    if (isTool(row.name)) out.extra.push(`${row.name} (${row.deployed} Deployed)`);
    else out.notes.push(`also deployed (not the tool's): ${row.name}`);
  }
  return out;
}

/** One algo from Quantiply's `GET /algos/day-wise`, with the fields the checks need. */
export interface QListed {
  id: string;
  name: string;
  day: string;
  enabled: boolean;
  status: string;
  multiplier: number | null;
  /** `HH:MM:SS`, or null */
  startTime: string | null;
  endTime: string | null;
}

export function parseDayWiseListed(json: unknown): QListed[] {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('day-wise list: no data array');
  const out: QListed[] = [];
  const time = (v: unknown) => (typeof v === 'string' && /^\d\d:\d\d(:\d\d)?$/.test(v) ? v : null);
  for (const day of data as { day?: string; algos?: unknown }[]) {
    if (!Array.isArray(day.algos)) continue;
    for (const a of day.algos as Record<string, unknown>[]) {
      if (typeof a._id !== 'string' || typeof a.name !== 'string') continue;
      out.push({
        id: a._id,
        name: a.name,
        day: typeof a.day === 'string' ? a.day : String(day.day),
        enabled: a.enabled === true,
        status: typeof a.status === 'string' ? a.status : 'UNKNOWN',
        multiplier: typeof a.multiplier === 'number' ? a.multiplier : null,
        startTime: time(a.startTime),
        endTime: time(a.endTime),
      });
    }
  }
  return out;
}

/** Each leg's `quantity` (lots) of a full algo (`GET /algos/:id`) or a create body. */
export function legLots(algo: unknown): number[] {
  const conf = ((algo as { configurations?: unknown }).configurations ?? {}) as {
    legs?: { quantity?: unknown }[];
  };
  return (conf.legs ?? []).map((l) => Number(l.quantity));
}

/**
 * Quantiply's list for today's weekday against the day's picks: each pick enabled once, at
 * multiplier 1 and with the export's lots on every leg (`lots` by algo id, from `GET /algos/:id`;
 * absent = not read, said in a note), and no tool algo enabled that is not a pick. The owner's
 * own enabled algos are a note, not a problem.
 */
export function checkQuantiply(
  label: string,
  picks: { name: string; lots: number[] }[],
  algos: QListed[],
  weekday: string,
  lots: Map<string, number[]>,
): PlatformCheck {
  const out: PlatformCheck = {
    label,
    expected: picks.length,
    good: [],
    problems: [],
    extra: [],
    notes: [],
  };
  const today = algos.filter((a) => a.day === weekday);
  const wanted = new Set(picks.map((p) => p.name));
  for (const pick of picks) {
    const same = today.filter((a) => a.name === pick.name);
    const on = same.filter((a) => a.enabled);
    if (!same.length) {
      out.problems.push(`${pick.name}: not in Quantiply for ${weekday}`);
      continue;
    }
    if (!on.length) {
      out.problems.push(`${pick.name}: not enabled`);
      continue;
    }
    if (on.length > 1) {
      out.problems.push(`${pick.name}: enabled ${on.length} times`);
      continue;
    }
    const algo = on[0] as QListed;
    if (algo.multiplier !== null && algo.multiplier !== 1) {
      out.problems.push(`${pick.name}: multiplier ${algo.multiplier}, not 1`);
      continue;
    }
    const got = lots.get(algo.id);
    if (got && got.join('/') !== pick.lots.join('/')) {
      out.problems.push(
        `${pick.name}: lots ${got.join('/')}, the export says ${pick.lots.join('/')}`,
      );
      continue;
    }
    if (!got) out.notes.push(`${pick.name}: lots not read`);
    if (algo.multiplier === null) out.notes.push(`${pick.name}: multiplier not read`);
    out.good.push(pick.name);
  }
  for (const a of today) {
    if (!a.enabled || wanted.has(a.name)) continue;
    if (isTool(a.name)) out.extra.push(`${a.name} (enabled)`);
    else out.notes.push(`also enabled for ${weekday} (not the tool's): ${a.name}`);
  }
  return out;
}

/** The headline: "AlgoTest T1 3/3 · Quantiply Core 3/3 ✅", then what is missing or extra. */
export function deployMessage(
  day: string,
  at: string,
  checks: PlatformCheck[],
): { text: string; ok: boolean } {
  const ok = checks.every((c) => !c.error && !c.problems.length && !c.extra.length);
  const head = checks
    .map((c) => (c.error ? `${c.label} not read` : `${c.label} ${c.good.length}/${c.expected}`))
    .join(' · ');
  const lines = [`${head} ${ok ? '✅' : '⚠️'}`, `Deploy check ${day} ${at} (read-only)`];
  for (const c of checks) {
    if (c.error) lines.push(`❌ ${c.label}: ${c.error}`);
    for (const p of c.problems) lines.push(`❌ ${c.label}: ${p}`);
    for (const e of c.extra) lines.push(`➕ ${c.label} extra: ${e}`);
    for (const n of c.notes) lines.push(`· ${c.label}: ${n}`);
  }
  return { text: lines.join('\n'), ok };
}

// --- loss levels -----------------------------------------------------------------------------

export interface LossState {
  warned: boolean;
  alerted: boolean;
}

/** The levels `total` reaches that have not been sent today, deepest last. Each goes once a day. */
export function lossCrossings(total: number, state: LossState): Array<'warning' | 'alert'> {
  const out: Array<'warning' | 'alert'> = [];
  if (total <= LOSS_WARNING_INR && !state.warned && !state.alerted) out.push('warning');
  if (total <= LOSS_ALERT_INR && !state.alerted) out.push('alert');
  // past the alert level at the first reading: the alert alone says it
  return out.includes('alert') ? ['alert'] : out;
}

export interface MtmPart {
  /** `AlgoTest`, `Quantiply Angel One` */
  label: string;
  /** null = cannot be read now */
  inr: number | null;
}

export function lossMessage(
  level: 'warning' | 'alert',
  total: number,
  parts: MtmPart[],
  at: string,
): string {
  const head =
    level === 'alert'
      ? `🛑 LOSS ALERT ${at}: the tool's platforms are at ${inr(total)} today (alert level ${inr(LOSS_ALERT_INR)})`
      : `⚠️ Loss warning ${at}: the tool's platforms are at ${inr(total)} today (warning level ${inr(LOSS_WARNING_INR)})`;
  const lines = parts.map((p) => `${p.label}: ${p.inr === null ? 'cannot read' : inr(p.inr)}`);
  const partial = parts.some((p) => p.inr === null)
    ? ['(a platform cannot be read: the real figure may be lower)']
    : [];
  return [
    head,
    ...lines,
    ...partial,
    'AlgoTest + Quantiply only, open + booked; trades placed elsewhere are not counted.',
    'Alert only: nothing was squared off.',
  ].join('\n');
}

// --- Quantiply's live MTM (its web app's socket) ---------------------------------------------

/**
 * Quantiply's web app gets each algo's live MTM over its socket.io connection as a CSV string,
 * `<algo id>,,,,<pnl>,<error flags>,,<waiting>,<waitingWT>` (read from the app's bundle,
 * main.c34824e5.js, 2026-10-20: the reducer of SUBSCRIBE_LITE_POSITION_UPDATES does
 * `data.split(",")` and takes the 5th field as `pnl`, the MTM column). The monitor keeps the
 * app open on /algos and reads those frames as they arrive; it never sends one.
 */
export function pnlFromSocketFrame(payload: string): Array<{ id: string; pnl: number }> {
  const strings: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  const body = payload.replace(/^\d+/, '');
  try {
    walk(JSON.parse(body));
  } catch {
    strings.push(payload);
  }
  const out: Array<{ id: string; pnl: number }> = [];
  for (const s of strings) {
    const parts = s.split(',');
    const id = parts[0] ?? '';
    const pnl = parts[4] ?? '';
    if (/^[0-9a-f]{24}$/i.test(id) && parts.length >= 5 && /^-?\d+(\.\d+)?$/.test(pnl.trim())) {
      out.push({ id, pnl: Number(pnl) });
    }
  }
  return out;
}

/** An algo's last MTM figure and when its frame arrived (ms). */
export interface PnlSeen {
  pnl: number;
  at: number;
}

/** A running algo's figure older than this is stale (the socket may be gone). */
export const PNL_STALE_MS = 3 * 60_000;

const secondsOf = (hms: string) => {
  const [h = '0', m = '0', s = '0'] = hms.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
};

/**
 * Quantiply's day MTM, or which algos make it unreadable. An algo of today's weekday counts if
 * it is enabled or its status is anything but NOT_RUNNING (whatever Quantiply calls running).
 * - Not started yet (NOT_RUNNING, before its start + 2 min): 0, no figure expected.
 * - Finished (TRADE_CLOSED, or NOT_RUNNING past its end): its last figure, of any age; none = unread.
 * - Otherwise (started or trading): a figure no older than `PNL_STALE_MS`, else unread.
 */
export function quantiplyReading(
  algos: QListed[],
  weekday: string,
  pnl: Record<string, PnlSeen>,
  nowMs: number,
  istSeconds: number,
): { inr: number | null; unread: string[] } {
  let total = 0;
  const unread: string[] = [];
  for (const a of algos) {
    if (a.day !== weekday || (!a.enabled && a.status === 'NOT_RUNNING')) continue;
    const seen = pnl[a.id];
    const startAt = a.startTime ? secondsOf(a.startTime) + 120 : 0;
    const endAt = a.endTime ? secondsOf(a.endTime) : Number.POSITIVE_INFINITY;
    const waiting = a.status === 'NOT_RUNNING' && istSeconds < startAt;
    const finished =
      a.status === 'TRADE_CLOSED' || (a.status === 'NOT_RUNNING' && istSeconds >= endAt);
    if (waiting && !seen) continue;
    if (finished) {
      if (seen) total += seen.pnl;
      else unread.push(a.name);
      continue;
    }
    if (!seen || nowMs - seen.at > PNL_STALE_MS) unread.push(a.name);
    else total += seen.pnl;
  }
  return unread.length ? { inr: null, unread } : { inr: total, unread };
}
