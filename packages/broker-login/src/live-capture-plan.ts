import { NAME_PREFIXES } from './strategy-plan.js';

/**
 * BL-141: what the live capture records, decided without a network. Pure functions over what
 * AlgoTest's and Quantiply's own APIs answer (`docs/algotest-execution.md`, "Live results"), the
 * uploaders' ledgers, and the day's previous capture file.
 *
 * One file per day, `TRADING_DATA_ROOT/rotation/live/<day>.jsonl`:
 * - a `section` line per platform + broker read (`ok`, or the error and whether a retry can help),
 * - a `strategy` line per strategy that ran that day on it, the tool's (in its ledger) or the
 *   owner's own (`discretionary`), with its live ₹ (gross, before charges, as the platform shows
 *   it), multiplier, and fills where the platform gives them. One that was deployed but never
 *   filled is a line with `traded: false` and no P&L (did not trade, never a zero).
 * A re-run replaces the sections it read; a section it could not read keeps the earlier lines.
 * Both platforms keep a day's results after its strategies are deleted, so any day can be read
 * again later (back-fill).
 */

export type LivePlatform = 'algotest' | 'quantiply';
export type LiveBroker = 'finvasia' | 'angelone';
export type Source = 'tool' | 'discretionary';

/**
 * Every name prefix the uploaders have ever used, with the list it means. APPEND ONLY: a rename
 * (say `TA · ` / `CA · `) adds its prefixes here beside the old ones, so a day captured before it
 * still reads. Ownership itself comes from the ledgers' ids wherever they have one; the prefix
 * only names the variant and its list.
 */
export const TOOL_PREFIXES: readonly { prefix: string; book: string }[] = [
  { prefix: 'T1 · ', book: 't1' },
  { prefix: 'Core · ', book: 'core' },
];

export interface Fill {
  leg: string;
  symbol: string;
  /** S sold first (short), B bought first */
  side: 'S' | 'B';
  qty: number;
  /** `at` is IST, `YYYY-MM-DD HH:MM:SS` (Quantiply's UTC times are converted) */
  entry: { price: number; at: string } | null;
  exit: { price: number; qty: number; at: string } | null;
}

export interface StrategyLine {
  kind: 'strategy';
  day: string;
  platform: LivePlatform;
  broker: LiveBroker | string;
  name: string;
  /** the rotation variant when the name is the tool's (`T1 · <variant>`), else null */
  variant: string | null;
  book: string | null;
  addon: boolean;
  source: Source;
  /** the platform's id of the deploy (AlgoTest execution) or algo (Quantiply) */
  platform_id: string;
  multiplier: number | null;
  /** false: deployed or enabled but nothing filled; `pnl` is then null */
  traded: boolean;
  /** live P&L in rupees, gross (before brokerage and taxes), for the whole multiplier */
  pnl: number | null;
  status: string | null;
  /** legs still open (or partly exited) when read: their P&L is not in `pnl` */
  open_legs: number;
  /** Quantiply: runs of the algo that day, added up in `pnl` */
  runs?: number;
  fills: Fill[] | null;
  /** where `pnl` came from: `legs` (AlgoTest fills) or `pnl-chart` (Quantiply's account chart) */
  pnl_source: 'legs' | 'pnl-chart' | null;
}

export interface SectionLine {
  kind: 'section';
  day: string;
  platform: LivePlatform;
  broker: LiveBroker | 'all';
  ok: boolean;
  error: string | null;
  /** `config`: a retry cannot help (missing credentials, a held or refused login) */
  error_kind?: 'retry' | 'config' | null;
  strategies: number;
  captured_at: string;
}

export type LiveLine = StrategyLine | SectionLine;

/** `T1 · N_p150-t1s11_0917` / `Core · S_p250_1317 · add-on` -> the variant, its list, add-on. */
export function toolName(name: string): { variant: string; book: string; addon: boolean } | null {
  const trimmed = name.trim();
  const p = TOOL_PREFIXES.find((x) => trimmed.startsWith(x.prefix));
  if (!p) return null;
  const m = /^(\S+?)( · add-on)?$/.exec(trimmed.slice(p.prefix.length));
  if (!m?.[1]) return null;
  return { variant: m[1], book: p.book, addon: Boolean(m[2]) };
}

const isToolNamed = (name: string) =>
  TOOL_PREFIXES.some((p) => name.startsWith(p.prefix)) ||
  NAME_PREFIXES.some((p) => name.startsWith(p));

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** Money in integer paise: prices have two decimals, so sums of paise are exact. */
const paise = (rupees: number) => Math.round(rupees * 100);

// -- AlgoTest --------------------------------------------------------------------------------

/** AlgoTest's broker enum (`Broker.Finvasia`) as the settings rows name it. */
export function algotestBroker(brokerType: string): LiveBroker | string {
  const b = brokerType.replace(/^Broker\./, '').toLowerCase();
  if (b === 'finvasia' || b === 'shoonya') return 'finvasia';
  if (b === 'angelone') return 'angelone';
  return b || 'unknown';
}

/** A deploy is named `<saved name> (n)`, the n-th deploy of it. */
export function savedName(executionName: string): string {
  return executionName.replace(/ \(\d+\)$/, '');
}

interface AtLeg {
  id?: unknown;
  symbol?: unknown;
  position?: unknown;
  status?: unknown;
  quantity?: unknown;
  entry_trade?: { price?: unknown; quantity?: unknown; exchange_timestamp?: unknown } | null;
  exit_trade?: { price?: unknown; quantity?: unknown; exchange_timestamp?: unknown } | null;
}

export interface AtExecution {
  _id?: unknown;
  name?: unknown;
  broker_type?: unknown;
  status?: unknown;
  strategy_id?: unknown;
  creation_ts?: unknown;
  last_activation_ts?: unknown;
  legs?: unknown;
  config?: { ExecutionConfig?: { LotMultiplier?: unknown } } | null;
}

/**
 * An AlgoTest execution's legs as fills, and its realised P&L (the web app's own sum: sell =
 * (entry − exit) × quantity, buy the other way). A leg exited for less than it entered counts its
 * exited quantity and is open for the rest; one exited for more is counted at its entry quantity
 * and flagged open too, so it is never read as a clean result.
 */
export function algotestLegs(legs: unknown): { fills: Fill[]; pnl: number; open: number } {
  const fills: Fill[] = [];
  let pnl = 0; // paise
  let open = 0;
  for (const raw of Array.isArray(legs) ? (legs as AtLeg[]) : []) {
    const side = str(raw.position) === 'PositionType.Buy' ? 'B' : 'S';
    const entry = raw.entry_trade;
    const exit = raw.exit_trade;
    const eq = num(entry?.quantity);
    if (!entry || !eq) continue; // never filled: nothing traded on this leg
    const xq = num(exit?.quantity);
    const ep = num(entry.price) ?? 0;
    const xp = num(exit?.price);
    const exited = raw.status === 2 && xq !== null && xq > 0 && xp !== null;
    fills.push({
      leg: str(raw.id).replace(/^[0-9a-f]{24}_/i, ''),
      symbol: str(raw.symbol),
      side,
      qty: eq,
      entry: { price: ep, at: str(entry.exchange_timestamp) },
      exit: exited ? { price: xp, qty: xq, at: str(exit?.exchange_timestamp) } : null,
    });
    if (!exited) {
      open += 1;
      continue;
    }
    const closed = Math.min(eq, xq);
    if (closed !== eq || xq !== eq) open += 1;
    const sign = side === 'S' ? 1 : -1;
    pnl += sign * (paise(ep) - paise(xp)) * closed;
  }
  return { fills, pnl: pnl / 100, open };
}

/** Whether an execution traded (or was deployed) on `day` (AlgoTest writes IST, no zone). */
export function algotestOnDay(e: AtExecution, day: string): boolean {
  const legs = Array.isArray(e.legs) ? (e.legs as AtLeg[]) : [];
  const entries = legs.map((l) => str(l.entry_trade?.exchange_timestamp)).filter(Boolean);
  if (entries.length) return entries.some((t) => t.startsWith(day));
  return [e.last_activation_ts, e.creation_ts].some((t) => str(t).startsWith(day));
}

/** What the AlgoTest uploader's ledger says it made: saved-strategy ids, and names with no id. */
export interface AlgotestOwnership {
  ids: Set<string>;
  /** names the tool uploaded before ids were recorded (2026-10-20): matched by name */
  namesWithoutId: Set<string>;
}

export function algotestOwnership(
  ledger: { action?: string; ok?: boolean; name?: string; id?: string }[],
): AlgotestOwnership {
  const out: AlgotestOwnership = { ids: new Set(), namesWithoutId: new Set() };
  const namesWithId = new Set<string>();
  for (const row of ledger) {
    if (row.action !== 'upload' || !row.ok) continue;
    const name = row.name ?? '';
    if (row.id) {
      // an id is the tool's whatever its name says (a later rename of the prefixes changes nothing)
      out.ids.add(row.id);
      namesWithId.add(name);
    } else if (isToolNamed(name)) out.namesWithoutId.add(name);
  }
  for (const n of namesWithId) out.namesWithoutId.delete(n);
  return out;
}

export function algotestSource(e: AtExecution, own: AlgotestOwnership): Source {
  const id = str(e.strategy_id);
  if (id && own.ids.has(id)) return 'tool';
  const name = savedName(str(e.name));
  if (own.namesWithoutId.has(name)) return 'tool';
  return 'discretionary';
}

/**
 * The day's AlgoTest lines from the live list (`/execution/v2/executions`) and the exited list
 * (`/execution/v2/exited-executions`), one line per execution id. `multipliers` is each
 * execution's `LotMultiplier` from `/execution/v2/execution-info/<id>`, where read.
 */
export function algotestLines(
  day: string,
  lists: unknown[],
  own: AlgotestOwnership,
  multipliers: Map<string, number> = new Map(),
): StrategyLine[] {
  const seen = new Map<string, AtExecution>();
  for (const list of lists) {
    if (!Array.isArray(list)) throw new Error('AlgoTest executions: not a list');
    for (const e of list as AtExecution[]) {
      const id = str(e?._id);
      if (!id) throw new Error('AlgoTest executions: an execution without _id');
      if (algotestOnDay(e, day)) seen.set(id, e);
    }
  }
  const out: StrategyLine[] = [];
  for (const [id, e] of seen) {
    const name = savedName(str(e.name));
    const tool = toolName(name);
    const source = algotestSource(e, own);
    const legs = algotestLegs(e.legs);
    const traded = legs.fills.length > 0;
    const fromConfig = num(e.config?.ExecutionConfig?.LotMultiplier);
    out.push({
      kind: 'strategy',
      day,
      platform: 'algotest',
      broker: algotestBroker(str(e.broker_type)),
      name,
      variant: source === 'tool' ? (tool?.variant ?? null) : null,
      book: source === 'tool' ? (tool?.book ?? null) : null,
      addon: source === 'tool' ? Boolean(tool?.addon) : false,
      source,
      platform_id: id,
      multiplier: multipliers.get(id) ?? fromConfig ?? null,
      traded,
      pnl: traded ? legs.pnl : null,
      status: str(e.status).replace(/^StrategyStatus\./, '') || null,
      open_legs: legs.open,
      fills: legs.fills,
      pnl_source: 'legs',
    });
  }
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || a.platform_id.localeCompare(b.platform_id),
  );
}

/** `LotMultiplier` from `/execution/v2/execution-info/<id>`. */
export function algotestMultiplier(info: unknown): number | null {
  return num((info as AtExecution | null)?.config?.ExecutionConfig?.LotMultiplier);
}

// -- Quantiply -------------------------------------------------------------------------------

export interface QSummary {
  id: string;
  name: string;
  day: string;
  enabled: boolean;
  multiplier: number | null;
  status: string;
}

/** `GET /algos/day-wise` with the fields the capture needs (a superset of `parseDayWise`). */
export function quantiplySummaries(json: unknown): QSummary[] {
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error('day-wise list: no data array');
  const out: QSummary[] = [];
  for (const day of data as { day?: string; algos?: unknown }[]) {
    if (!Array.isArray(day.algos)) throw new Error(`day-wise list: ${day.day} has no algos array`);
    for (const a of day.algos as Record<string, unknown>[]) {
      if (typeof a._id !== 'string' || typeof a.name !== 'string') {
        throw new Error('day-wise list: an algo without _id or name');
      }
      out.push({
        id: a._id,
        name: a.name,
        day: typeof a.day === 'string' ? a.day : String(day.day),
        enabled: a.enabled === true,
        multiplier: num(a.multiplier),
        status: typeof a.status === 'string' ? a.status : 'UNKNOWN',
      });
    }
  }
  return out;
}

export interface QRuns {
  /** the day's P&L of the algo: every run of it added up */
  pnl: number;
  runs: number;
}

/**
 * Each algo's P&L for the period from the account P&L chart (`GET /pnl-chart/algo?
 * graphLevel=account`): `metaData.lastValues` holds one entry per RUN, keyed by the run's id
 * (`state`), `{algo, c, t}`, `c` that run's closing MTM. An algo that ran twice in a day (a
 * re-run, 2026-10-15) has two entries, and the day's P&L is their sum. Pages (`paging.after`)
 * merge by run id, a later page winning.
 */
export function quantiplyRuns(pages: unknown[]): Map<string, QRuns> {
  const byRun = new Map<string, { algo: string; c: number }>();
  for (const page of pages) {
    const last = (page as { metaData?: { lastValues?: unknown } })?.metaData?.lastValues;
    if (last === undefined || last === null) continue;
    if (typeof last !== 'object') throw new Error('pnl chart: lastValues is not an object');
    for (const [key, v] of Object.entries(
      last as Record<string, { algo?: unknown; c?: unknown; state?: unknown }>,
    )) {
      const algo = str(v?.algo);
      const c = num(v?.c);
      if (!algo || c === null) continue;
      byRun.set(str(v?.state) || key, { algo, c });
    }
  }
  const out = new Map<string, { paise: number; runs: number }>();
  for (const { algo, c } of byRun.values()) {
    const prev = out.get(algo) ?? { paise: 0, runs: 0 };
    out.set(algo, { paise: prev.paise + paise(c), runs: prev.runs + 1 });
  }
  return new Map([...out].map(([k, v]) => [k, { pnl: v.paise / 100, runs: v.runs }]));
}

/** The account chart's total for the period (`metaData.totalMTM`), to check the lines' sum. */
export function quantiplyTotal(pages: unknown[]): number | null {
  for (const page of [...pages].reverse()) {
    const t = num((page as { metaData?: { totalMTM?: unknown } })?.metaData?.totalMTM);
    if (t !== null) return t;
  }
  return null;
}

/**
 * The reason to fail the section when the algos' runs do not add up to the chart's own total
 * (beyond ₹1 of rounding), else null: a P&L that does not reconcile is not recorded as read.
 */
export function quantiplyMismatch(runs: Map<string, QRuns>, total: number | null): string | null {
  if (total === null) return runs.size ? 'pnl chart: no totalMTM to check the algos against' : null;
  const sum = [...runs.values()].reduce((s, r) => s + paise(r.pnl), 0) / 100;
  return Math.abs(sum - total) > 1
    ? `pnl chart: the algos' runs add up to ${sum.toFixed(2)}, its total is ${total}`
    : null;
}

/**
 * The day's Quantiply lines: every algo the account chart has runs for on the day, named from the
 * day-wise list (or, if gone from it, the uploader's ledger). `owned` is every algo id the uploader
 * ever created, whatever its name. With `notTradedOn` (the day's weekday, given only for today,
 * while the list still says what was enabled), an algo enabled for that weekday with no run is a
 * `traded: false` line.
 */
export function quantiplyLines(
  day: string,
  broker: LiveBroker,
  summaries: QSummary[],
  runs: Map<string, QRuns>,
  owned: Map<string, string>,
  positions: Map<string, unknown> = new Map(),
  notTradedOn?: string,
): StrategyLine[] {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const line = (id: string, r: QRuns | null): StrategyLine => {
    const s = byId.get(id);
    const mine = owned.has(id);
    const name = s?.name ?? owned.get(id) ?? `(algo ${id.slice(-6)})`;
    const tool = mine ? toolName(name) : null;
    return {
      kind: 'strategy',
      day,
      platform: 'quantiply',
      broker,
      name,
      variant: tool?.variant ?? null,
      book: tool?.book ?? null,
      addon: Boolean(tool?.addon),
      source: mine ? 'tool' : 'discretionary',
      platform_id: id,
      multiplier: s?.multiplier ?? null,
      traded: r !== null,
      pnl: r?.pnl ?? null,
      status: s?.status ?? null,
      open_legs: 0,
      runs: r?.runs ?? 0,
      fills: r ? quantiplyFills(positions.get(id)) : null,
      pnl_source: r ? 'pnl-chart' : null,
    };
  };
  const out = [...runs].map(([id, r]) => line(id, r));
  if (notTradedOn) {
    for (const s of summaries) {
      if (s.day === notTradedOn && s.enabled && !runs.has(s.id)) out.push(line(s.id, null));
    }
  }
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || a.platform_id.localeCompare(b.platform_id),
  );
}

/** An ISO time with a zone (Quantiply writes UTC, `…Z`) as IST `YYYY-MM-DD HH:MM:SS`; else as is. */
export function toIst(at: string): string {
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(at)) return at;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return at;
  return new Date(t + 330 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Fills from `GET /algos/:id`'s `state.positions`, read while the day's state is still there
 * (Quantiply resets it overnight). The shape is not confirmed on a traded day yet (the
 * 2026-10-20 read was a holiday): only fields whose meaning is plain are taken, and anything else
 * gives null, never a guess. Times are converted from UTC to IST.
 */
export function quantiplyFills(algo: unknown): Fill[] | null {
  const data = (algo as { data?: unknown })?.data ?? algo;
  const one = Array.isArray(data) ? data[0] : data;
  const positions = (one as { state?: { positions?: unknown } } | null)?.state?.positions;
  if (!Array.isArray(positions) || !positions.length) return null;
  const out: Fill[] = [];
  for (const p of positions as Record<string, unknown>[]) {
    const side = p.transactionType === 'B' ? 'B' : p.transactionType === 'S' ? 'S' : null;
    const qty = num(p.quantity) ?? num(p.qty);
    const entry = num(p.entryPrice) ?? num(p.avgEntryPrice);
    if (!side || qty === null || entry === null) return null;
    const exit = num(p.exitPrice) ?? num(p.avgExitPrice);
    out.push({
      leg: str(p.legId) || str(p._id),
      symbol: str(p.symbol) || str(p.tradingSymbol),
      side,
      qty,
      entry: { price: entry, at: toIst(str(p.entryTime)) },
      exit: exit === null ? null : { price: exit, qty, at: toIst(str(p.exitTime)) },
    });
  }
  return out;
}

/** Every Quantiply algo id the uploader ever created (ok create rows), with its name. */
export function quantiplyOwned(
  ledger: { action?: string; ok?: boolean; id?: string; name?: string }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of ledger) {
    if (row.action === 'create' && row.ok && row.id && row.name) out.set(row.id, row.name);
  }
  return out;
}

// -- the day's file --------------------------------------------------------------------------

export function parseLiveFile(text: string): LiveLine[] {
  const out: LiveLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as LiveLine;
      if (row && (row.kind === 'section' || row.kind === 'strategy')) out.push(row);
    } catch {
      // a torn line is skipped
    }
  }
  return out;
}

export const sectionKey = (platform: string, broker: string) => `${platform}.${broker}`;

/** The section a strategy line belongs to (AlgoTest is one account read once: `all`). */
export function sectionOf(line: StrategyLine): string {
  return sectionKey(line.platform, line.platform === 'algotest' ? 'all' : String(line.broker));
}

/** The wanted sections (`algotest.all`, `quantiply.<broker>`) a day's file does not have as ok. */
export function sectionsToRead(
  lines: LiveLine[] | null,
  wanted: string[],
  force = false,
): string[] {
  if (force || !lines) return [...wanted];
  const ok = new Set(
    lines
      .filter((l): l is SectionLine => l.kind === 'section' && l.ok)
      .map((l) => sectionKey(l.platform, l.broker)),
  );
  return wanted.filter((k) => !ok.has(k));
}

/**
 * Earlier trading days to read again: the last `maxDays` trading days before `today`, from the
 * first day the capture ever wrote (`firstDay`) on, that miss a wanted section (no file, or a
 * section not read). A day the 15:40 run and its retries missed is filled the next evening.
 */
export function backfillDays(
  today: string,
  firstDay: string | null,
  files: Map<string, LiveLine[]>,
  wanted: string[],
  isTradingDay: (day: string) => boolean,
  maxDays = 5,
): string[] {
  if (!firstDay) return [];
  const out: string[] = [];
  let d = new Date(`${today}T00:00:00Z`);
  for (let seen = 0; seen < maxDays; ) {
    d = new Date(d.getTime() - 86_400_000);
    const day = d.toISOString().slice(0, 10);
    if (day < firstDay) break;
    if (!isTradingDay(day)) continue;
    seen += 1;
    if (sectionsToRead(files.get(day) ?? null, wanted).length) out.push(day);
  }
  return out.reverse();
}

/**
 * The new file: each section read now (ok) replaces that section's earlier lines; a section that
 * failed now keeps whatever an earlier run read (marked with its earlier `ok`), and is recorded as
 * failed only when there was nothing earlier.
 */
export function mergeCapture(
  previous: LiveLine[],
  now: { section: SectionLine; strategies: StrategyLine[] }[],
): LiveLine[] {
  const prevSections = new Map<string, SectionLine>();
  const prevStrategies = new Map<string, StrategyLine[]>();
  for (const l of previous) {
    if (l.kind === 'section') prevSections.set(sectionKey(l.platform, l.broker), l);
    else {
      const k = sectionOf(l);
      prevStrategies.set(k, [...(prevStrategies.get(k) ?? []), l]);
    }
  }
  const out: LiveLine[] = [];
  const done = new Set<string>();
  for (const { section, strategies } of now) {
    const k = sectionKey(section.platform, section.broker);
    done.add(k);
    const earlier = prevSections.get(k);
    if (section.ok || !earlier?.ok) {
      out.push(section, ...strategies);
    } else {
      out.push(earlier, ...(prevStrategies.get(k) ?? []));
    }
  }
  for (const [k, s] of prevSections) {
    if (!done.has(k)) out.push(s, ...(prevStrategies.get(k) ?? []));
  }
  return out;
}

export function renderLiveFile(lines: LiveLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '');
}

/** Short lines for the log. */
export function summarizeCapture(lines: LiveLine[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (l.kind === 'section') {
      const where = l.platform === 'algotest' ? 'AlgoTest' : `Quantiply · ${l.broker}`;
      out.push(l.ok ? `${where}: ${l.strategies} strategies` : `${where}: NOT READ (${l.error})`);
    }
  }
  const strategies = lines.filter((l): l is StrategyLine => l.kind === 'strategy');
  const tool = strategies.filter((s) => s.source === 'tool').length;
  const idle = strategies.filter((s) => !s.traded).length;
  out.push(`${tool} tool, ${strategies.length - tool} discretionary, ${idle} did not trade`);
  return out;
}

/**
 * The run's exit code from the sections it tried to read: 0 all read; 1 a retry may help; 3 none
 * can (missing credentials, a held or refused login), so the scheduler alerts once, no retry.
 */
export function exitCodeFor(tried: SectionLine[]): 0 | 1 | 3 {
  const failed = tried.filter((s) => !s.ok);
  if (!failed.length) return 0;
  return failed.some((s) => s.error_kind !== 'config') ? 1 : 3;
}
