import { NAME_PREFIXES } from './strategy-plan.js';

/**
 * BL-141: what the 15:40 live capture records, decided without a network. Pure functions over
 * what AlgoTest's and Quantiply's own APIs answer (`docs/algotest-execution.md`, "Live results"),
 * the uploaders' ledgers, and the day's previous capture file.
 *
 * One file per day, `TRADING_DATA_ROOT/rotation/live/<day>.jsonl`:
 * - a `section` line per platform + broker read (`ok`, or the error), and
 * - a `strategy` line per strategy that ran that day on it, the tool's (in its ledger) or the
 *   owner's own (`discretionary`), with its live ₹ (gross, before charges, as the platform shows
 *   it), multiplier, and fills where the platform gives them.
 * A re-run replaces the sections it read; a section it could not read keeps the earlier lines.
 */

export type LivePlatform = 'algotest' | 'quantiply';
export type LiveBroker = 'finvasia' | 'angelone';
export type Source = 'tool' | 'discretionary';

export interface Fill {
  leg: string;
  symbol: string;
  /** S sold first (short), B bought first */
  side: 'S' | 'B';
  qty: number;
  entry: { price: number; at: string } | null;
  exit: { price: number; at: string } | null;
}

export interface StrategyLine {
  kind: 'strategy';
  day: string;
  platform: LivePlatform;
  broker: LiveBroker | string;
  name: string;
  /** the rotation variant when the name is the tool's (`T1 · <variant>`), else null */
  variant: string | null;
  book: 'core' | 't1' | null;
  addon: boolean;
  source: Source;
  /** the platform's id of the deploy (AlgoTest execution) or algo (Quantiply) */
  platform_id: string;
  multiplier: number | null;
  /** live P&L in rupees, gross (before brokerage and taxes), for the whole multiplier */
  pnl: number | null;
  status: string | null;
  /** legs still open when read (their P&L is not in `pnl`) */
  open_legs: number;
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
  strategies: number;
  captured_at: string;
}

export type LiveLine = StrategyLine | SectionLine;

/** `T1 · N_p150-t1s11_0917` / `Core · S_p250_1317 · add-on` -> the variant, its list, add-on. */
export function toolName(
  name: string,
): { variant: string; book: 'core' | 't1'; addon: boolean } | null {
  const m = /^(T1|Core) · (\S+?)( · add-on)?$/.exec(name.trim());
  if (!m?.[2]) return null;
  return { variant: m[2], book: m[1] === 'T1' ? 't1' : 'core', addon: Boolean(m[3]) };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

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

/** An AlgoTest execution's legs as fills, and its realised P&L (the web app's own sum). */
export function algotestLegs(legs: unknown): { fills: Fill[]; pnl: number; open: number } {
  const fills: Fill[] = [];
  let pnl = 0;
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
    const exited = raw.status === 2 && xq !== null && xp !== null;
    fills.push({
      leg: str(raw.id).replace(/^[0-9a-f]{24}_/i, ''),
      symbol: str(raw.symbol),
      side,
      qty: eq,
      entry: { price: ep, at: str(entry.exchange_timestamp) },
      exit: exited ? { price: xp, at: str(exit?.exchange_timestamp) } : null,
    });
    if (!exited) {
      open += 1;
      continue;
    }
    const sign = side === 'S' ? 1 : -1;
    pnl += sign * (ep * eq - xp * xq);
  }
  return { fills, pnl: Math.round(pnl * 100) / 100, open };
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
  /** names the tool has an id for: a deploy of that name under another id is the owner's copy */
  namesWithId: Set<string>;
}

export function algotestOwnership(
  ledger: { action?: string; ok?: boolean; name?: string; id?: string }[],
): AlgotestOwnership {
  const out: AlgotestOwnership = {
    ids: new Set(),
    namesWithoutId: new Set(),
    namesWithId: new Set(),
  };
  for (const row of ledger) {
    const name = row.name ?? '';
    if (row.action !== 'upload' || !row.ok || !NAME_PREFIXES.some((p) => name.startsWith(p))) {
      continue;
    }
    if (row.id) {
      out.ids.add(row.id);
      out.namesWithId.add(name);
    } else out.namesWithoutId.add(name);
  }
  for (const n of out.namesWithId) out.namesWithoutId.delete(n);
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
      pnl: legs.fills.length ? legs.pnl : 0,
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
  multiplier: number | null;
  status: string;
  /** the day-wise list's own `pnl`, when it carries one (a running or closed algo) */
  pnl: number | null;
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
        multiplier: num(a.multiplier),
        status: typeof a.status === 'string' ? a.status : 'UNKNOWN',
        pnl: num(a.pnl),
      });
    }
  }
  return out;
}

/**
 * The account P&L chart's last value per algo (`GET /pnl-chart/algo?graphLevel=account`,
 * `metaData.lastValues`: one entry per algo run of the period, `{algo, c, t}`, `c` its closing
 * MTM). Several pages (`paging.after`) merge, the later `t` winning.
 */
export function quantiplyLastValues(pages: unknown[]): Map<string, { pnl: number; at: string }> {
  const out = new Map<string, { pnl: number; at: string }>();
  for (const page of pages) {
    const meta = (page as { metaData?: { lastValues?: unknown } })?.metaData;
    const last = meta?.lastValues;
    if (last === undefined || last === null) continue;
    if (typeof last !== 'object') throw new Error('pnl chart: lastValues is not an object');
    for (const v of Object.values(
      last as Record<string, { algo?: unknown; c?: unknown; t?: unknown }>,
    )) {
      const algo = str(v?.algo);
      const c = num(v?.c);
      if (!algo || c === null) continue;
      const at = str(v?.t);
      const prev = out.get(algo);
      if (!prev || at >= prev.at) out.set(algo, { pnl: c, at });
    }
  }
  return out;
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
 * The day's Quantiply lines: every algo the account chart shows a value for on the day, named
 * from the day-wise list (or, if gone from it, from the uploader's ledger). `owned` is every algo
 * id the uploader ever created.
 */
export function quantiplyLines(
  day: string,
  broker: LiveBroker,
  summaries: QSummary[],
  last: Map<string, { pnl: number; at: string }>,
  ledgerNames: Map<string, string>,
  positions: Map<string, unknown> = new Map(),
): StrategyLine[] {
  const byId = new Map(summaries.map((s) => [s.id, s]));
  const out: StrategyLine[] = [];
  for (const [id, v] of last) {
    const s = byId.get(id);
    const owned = ledgerNames.has(id);
    const name = s?.name ?? ledgerNames.get(id) ?? `(algo ${id.slice(-6)})`;
    const tool = owned ? toolName(name) : null;
    out.push({
      kind: 'strategy',
      day,
      platform: 'quantiply',
      broker,
      name,
      variant: tool?.variant ?? null,
      book: tool?.book ?? null,
      addon: Boolean(tool?.addon),
      source: owned ? 'tool' : 'discretionary',
      platform_id: id,
      multiplier: s?.multiplier ?? null,
      pnl: v.pnl,
      status: s?.status ?? null,
      open_legs: 0,
      fills: quantiplyFills(positions.get(id)),
      pnl_source: 'pnl-chart',
    });
  }
  return out.sort(
    (a, b) => a.name.localeCompare(b.name) || a.platform_id.localeCompare(b.platform_id),
  );
}

/**
 * Fills from `GET /algos/:id`'s `state.positions`, read while the day's state is still there
 * (Quantiply resets it overnight). The shape is not confirmed on a traded day yet (the
 * 2026-10-20 read was a holiday): only fields whose meaning is plain are taken, and anything else
 * gives null, never a guess.
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
      entry: { price: entry, at: str(p.entryTime) },
      exit: exit === null ? null : { price: exit, at: str(p.exitTime) },
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

const sectionKey = (platform: string, broker: string) => `${platform}.${broker}`;

/** The section a strategy line belongs to (AlgoTest is one account read once: `all`). */
export function sectionOf(line: StrategyLine): string {
  return sectionKey(line.platform, line.platform === 'algotest' ? 'all' : String(line.broker));
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

/** Short lines for the log and the alert. */
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
  out.push(`${tool} tool, ${strategies.length - tool} discretionary`);
  return out;
}

/**
 * Whether today's capture covers a platform (BL-141 Phase 2: the evening jobs delete nothing on a
 * platform before its strategies' results are recorded). AlgoTest is one section (`all`);
 * Quantiply one per account.
 */
export function captureCovers(
  lines: LiveLine[],
  platform: LivePlatform,
  broker?: LiveBroker,
): boolean {
  const want = sectionKey(platform, platform === 'algotest' ? 'all' : (broker ?? ''));
  return lines.some(
    (l) => l.kind === 'section' && sectionKey(l.platform, l.broker) === want && l.ok,
  );
}
