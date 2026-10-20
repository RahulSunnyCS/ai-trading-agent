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

/** IST minutes: the window the loss monitor watches, and when the two checks run. */
export const SESSION_OPEN = 9 * 60 + 15;
export const SESSION_CLOSE = 15 * 60 + 30;
export const MARGIN_AT = 9 * 60 + 5;
/** after the 09:16 pick and deploys and the 09:18-09:21 top-ups */
export const DEPLOY_CHECK_AT = 9 * 60 + 25;
/** the monitor logs in a little before the first entries (09:17) */
export const LOSS_LOGIN_AT = 9 * 60 + 12;

/** A part runs only when its `.env` switch is exactly "on" (any case), like ALGOTEST_UPLOAD. */
export function switchOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name]?.trim().toLowerCase() === 'on';
}

// --- money ---------------------------------------------------------------------------------

/** "₹ -1,23,456.50", "-₹ 1,234", "₹ 0", "− ₹12" -> a number; null when there is no figure. */
export function parseRupees(text: string): number | null {
  const m = /([-−–])?\s*₹\s*([-−–])?\s*(\d[\d,]*(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const value = Number((m[3] ?? '').replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return m[1] || m[2] ? -value : value;
}

/** /live's header "Total MTM" figure (all of today's AlgoTest deploys, open + booked). */
export function parseTotalMtm(text: string): number | null {
  const at = text.indexOf('Total MTM');
  if (at < 0) return null;
  return parseRupees(text.slice(at + 'Total MTM'.length, at + 'Total MTM'.length + 60));
}

/** ₹ in Indian grouping, no decimals: `₹-5,234`, `₹12,50,074`. */
export function inr(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `₹${sign}${Math.round(Math.abs(value)).toLocaleString('en-IN')}`;
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
}

/** An AlgoTest `.algtst` (the export's file): `strategy.Ticker`, each leg's side and lots. */
export function legsFromAlgtst(doc: unknown): LegNeed[] {
  const s = (doc as { strategy?: Record<string, unknown> }).strategy ?? {};
  const underlying = String(s.Ticker ?? '');
  const legs = (s.ListOfLegConfigs ?? []) as Record<string, unknown>[];
  return legs.map((leg) => ({
    underlying,
    sell: leg.PositionType === 'PositionType.Sell',
    lots: Number((leg.LotConfig as { Value?: unknown } | undefined)?.Value ?? 1),
  }));
}

/** A Quantiply create body (the export's file): each leg's `base`, `transactionType`, `quantity`. */
export function legsFromQuantiply(body: unknown): LegNeed[] {
  const conf = ((body as { configurations?: unknown }).configurations ?? {}) as {
    legs?: Record<string, unknown>[];
  };
  return (conf.legs ?? []).map((leg) => ({
    underlying: String(leg.base ?? ''),
    sell: leg.transactionType === 'S',
    lots: Number(leg.quantity ?? 1),
  }));
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

/** A bought option needs only its premium, unknown before entry: a flat allowance per lot. */
export const BUY_LEG_ALLOWANCE_INR = 5000;

export interface PickNeed {
  name: string;
  inr: number;
  /** an underlying without its own row in margin.csv borrows NIFTY's figure */
  borrowed: string[];
}

/**
 * The documented estimate (BL-143): every short leg-lot needs half the underlying's
 * short-straddle figure from margin.csv (NIFTY's when the underlying has none); every bought
 * leg-lot a flat allowance. No hedge benefit and every pick counted at once, so it errs high.
 */
export function pickNeed(
  name: string,
  legs: LegNeed[],
  perStraddle: Map<string, number>,
): PickNeed {
  let total = 0;
  const borrowed = new Set<string>();
  for (const leg of legs) {
    if (!leg.sell) {
      total += BUY_LEG_ALLOWANCE_INR * leg.lots;
      continue;
    }
    let straddle = perStraddle.get(leg.underlying);
    if (straddle === undefined) {
      straddle = perStraddle.get('NIFTY') ?? 0;
      borrowed.add(leg.underlying);
    }
    total += (straddle / 2) * leg.lots;
  }
  return { name, inr: total, borrowed: [...borrowed] };
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
    const v = a.picksMissing ? 'unknown' : marginVerdict(a.free, need);
    if (v !== 'ok') ok = false;
    const free = a.free === null ? 'free not read' : `free ${inr(a.free)}`;
    const needText = a.picksMissing
      ? `need not known (picks not read)${a.picks.length ? `, ~${inr(need)} for the ${a.picks.length} read` : ''}`
      : `need ~${inr(need)} for ${a.picks.length} pick${a.picks.length === 1 ? '' : 's'}`;
    lines.push(
      `${MARK[v]} ${a.account} (${a.uses.join(', ')}): ${free}, ${needText}${v === 'short' ? ` — SHORT by ${inr(need - (a.free ?? 0))}` : v === 'tight' ? ' — under a 20% cushion' : ''}`,
    );
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
      'Estimate: half the short-straddle margin per sold leg-lot, ₹5,000 per bought leg-lot, no hedge benefit',
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

/**
 * AlgoTest /live against the day's picks: each pick deployed exactly once (one deploy = one lot
 * at multiplier 1; "2 Deployed" would be two), multiplier 1 where `multipliers` knows it, and no
 * tool strategy deployed that is not a pick. A broker not logged in is a problem: nothing trades.
 */
export function checkAlgoTest(
  label: string,
  picks: string[],
  live: LiveState,
  multipliers: Map<string, number>,
): PlatformCheck {
  const out: PlatformCheck = {
    label,
    expected: picks.length,
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
  const rows = new Map(live.rows.map((r) => [r.name, r]));
  const wanted = new Set(picks);
  for (const name of picks) {
    const row = rows.get(name);
    const mult = multipliers.get(name);
    if (!row) out.problems.push(`${name}: not in AlgoTest`);
    else if (row.deployed === 0) out.problems.push(`${name}: not deployed`);
    else if (row.deployed > 1) out.problems.push(`${name}: deployed ${row.deployed} times`);
    else if (mult !== undefined && mult !== 1)
      out.problems.push(`${name}: multiplier ${mult}, not 1`);
    else out.good.push(name);
  }
  for (const row of live.rows) {
    if (row.deployed < 1 || wanted.has(row.name)) continue;
    if (isTool(row.name)) out.extra.push(`${row.name} (${row.deployed} Deployed)`);
    else out.notes.push(`also deployed (not the tool's): ${row.name}`);
  }
  return out;
}

/** One algo from Quantiply's `GET /algos/day-wise`, with the fields the check needs. */
export interface QListed {
  id: string;
  name: string;
  day: string;
  enabled: boolean;
  status: string;
  multiplier: number | null;
}

export function parseDayWiseListed(json: unknown): QListed[] {
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) throw new Error('day-wise list: no data array');
  const out: QListed[] = [];
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
 * absent = not read, then only the multiplier is checked), and no tool algo enabled that is not
 * a pick. The owner's own enabled algos are a note, not a problem.
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
export function deployMessage(day: string, checks: PlatformCheck[]): { text: string; ok: boolean } {
  const ok = checks.every((c) => !c.error && !c.problems.length && !c.extra.length);
  const head = checks
    .map((c) => (c.error ? `${c.label} not read` : `${c.label} ${c.good.length}/${c.expected}`))
    .join(' · ');
  const lines = [`${head} ${ok ? '✅' : '⚠️'}`, `Deploy check ${day} 09:25 (read-only)`];
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
  /** null = not readable now */
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
      ? `🛑 LOSS ALERT ${at}: the day is at ${inr(total)} (alert level ${inr(LOSS_ALERT_INR)})`
      : `⚠️ Loss warning ${at}: the day is at ${inr(total)} (warning level ${inr(LOSS_WARNING_INR)})`;
  const lines = parts.map((p) => `${p.label}: ${p.inr === null ? 'not readable' : inr(p.inr)}`);
  const partial = parts.some((p) => p.inr === null)
    ? ['(a platform could not be read: the real figure may be lower)']
    : [];
  return [head, ...lines, ...partial, 'Alert only: nothing was squared off.'].join('\n');
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

/** Quantiply's day MTM: the last figure of each algo listed for today's weekday. */
export function quantiplyMtm(
  algos: QListed[],
  weekday: string,
  pnl: Record<string, number>,
): number {
  return algos.filter((a) => a.day === weekday).reduce((sum, a) => sum + (pnl[a.id] ?? 0), 0);
}

/** Algos for today that are trading but have no MTM figure yet: Quantiply's reading is incomplete. */
export function unreadActive(
  algos: QListed[],
  weekday: string,
  pnl: Record<string, number>,
): string[] {
  return algos
    .filter((a) => a.day === weekday && a.status === 'TRADE_ACTIVE' && pnl[a.id] === undefined)
    .map((a) => a.name);
}

// --- timing ----------------------------------------------------------------------------------

export function inLossWindow(minutes: number): boolean {
  return minutes >= SESSION_OPEN && minutes < SESSION_CLOSE;
}
