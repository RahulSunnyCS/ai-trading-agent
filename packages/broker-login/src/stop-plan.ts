import { FINISHED, type QAlgo, type QLedgerRow, WEEKDAYS, ownedIds } from './quantiply-plan.js';
import { type LedgerRow, NAME_PREFIXES } from './strategy-plan.js';

/**
 * BL-143 Phase 4, the stop button: what a confirmed stop does on each platform, decided without a
 * network (`stop-button.ts` makes the calls, `stop-run.ts` runs them in passes). The owner's answer
 * (2026-10-20): switch off AND square off, only after a second confirm tap.
 *
 * Quantiply (each account; only the tool's algos: ids in that account's uploader ledger):
 * - `TRADE_ACTIVE` (the only status the web app offers its square-off for): square off all
 *   positions and terminate the algo, Quantiply's own `PUT /algos/:id/action/SQ_OFF_TERMINATE`.
 * - enabled and `READY`, `NOT_RUNNING` or `TRADE_CLOSED`: switched off (`PUT /algos/:id/disable`),
 *   whatever its weekday and whether today's session is over (the emergency stop).
 * - enabled in any other status: nothing the tool knows to send; "check by hand".
 * - squared off ones are switched off as well once Quantiply shows them finished, and an algo
 *   that entered meanwhile is squared off on the next pass.
 *
 * AlgoTest (/live; the tool's deploys: `toolMatcher`):
 * - `StrategyStatus.Live` or `StrategyStatus.Error` and `active_on_server` (the web app's
 *   `canSquareOff`): `PUT /execution/v2/square-off/<execution id>`, AlgoTest's own square-off.
 * - `pending_square_off`: AlgoTest is squaring it off; wait, never "by hand".
 * - `StrategyStatus.Stopped` (switched to manual) today: its legs may be open: "check".
 * - Live or Error but not active on its server (the app offers only "Restart"), or paused: no
 *   square-off the platform offers; "square off by hand".
 * - squared off: done.
 *
 * Everything else (the owner's own algos and deploys) is left alone and named in the report. No
 * order is ever sent to a broker directly.
 */

/** Quantiply statuses, as `GET /algos/day-wise` gives them. */
export const Q_ACTIVE = 'TRADE_ACTIVE';
export const Q_READY = 'READY';

export interface QuantiplyStopPlan {
  /** the tool's algos with a trade open: square off and terminate */
  sqOff: QAlgo[];
  /** the tool's enabled algos with nothing open (or waiting for entry): switch off */
  disable: QAlgo[];
  /** the tool's enabled algos in a status this tool knows nothing to send for */
  byHand: QAlgo[];
  /** not the tool's, active or enabled: left alone, named in the report */
  notMine: QAlgo[];
  /** the tool's algos listed that need nothing */
  idle: number;
}

export function planQuantiplyStop(ledger: QLedgerRow[], algos: QAlgo[]): QuantiplyStopPlan {
  const owned = ownedIds(ledger);
  const out: QuantiplyStopPlan = { sqOff: [], disable: [], byHand: [], notMine: [], idle: 0 };
  for (const a of algos) {
    if (!owned.has(a.id)) {
      if (a.enabled || a.status === Q_ACTIVE) out.notMine.push(a);
      continue;
    }
    if (a.status === Q_ACTIVE) out.sqOff.push(a);
    else if (a.enabled && (FINISHED.has(a.status) || a.status === Q_READY)) out.disable.push(a);
    else if (a.enabled) out.byHand.push(a);
    else out.idle += 1;
  }
  return out;
}

/**
 * After the calls: the tool's algos still open or still enabled, each with what to do by hand.
 * `sent`: algos whose square-off went out; one of them still open is the caller's "still closing,
 * do NOT exit at the broker" line, never "by hand".
 */
export function quantiplyLeft(
  ledger: QLedgerRow[],
  after: QAlgo[],
  sent: Set<string> = new Set(),
): string[] {
  const owned = ownedIds(ledger);
  const out: string[] = [];
  for (const a of after) {
    if (!owned.has(a.id)) continue;
    if (a.status === Q_ACTIVE && sent.has(a.id)) {
      if (a.enabled)
        out.push(`${a.name} (${a.day}) still ENABLED: switch it off once it has closed`);
    } else if (a.status === Q_ACTIVE)
      out.push(`${a.name} (${a.day}) still TRADE_ACTIVE: square off by hand`);
    else if (a.enabled)
      out.push(`${a.name} (${a.day}) still ENABLED (${a.status}): switch off by hand`);
    else if (a.status === Q_READY)
      out.push(`${a.name} (${a.day}) switched off but still READY: check it does not enter`);
  }
  return out;
}

/**
 * The sessions a switched-off algo belongs to, for its deploy-ledger rows: today and the next date
 * of its weekday (an algo enabled for a later session, by the tool or by hand, must not be
 * switched back on by that session's 09:21 enable).
 */
export function stopSessions(today: string, weekday: string): string[] {
  const out = [today];
  const want = (WEEKDAYS as readonly string[]).indexOf(weekday);
  if (want < 0) return out;
  const base = Date.parse(`${today}T00:00:00Z`);
  for (let n = 0; n < 7; n += 1) {
    const d = new Date(base + n * 86_400_000);
    if (d.getUTCDay() === want) {
      const day = d.toISOString().slice(0, 10);
      if (day !== today) out.push(day);
      break;
    }
  }
  return out;
}

/** One AlgoTest deploy, as `GET /execution/v2/executions?environment=live` lists it. */
export interface Execution {
  id: string;
  name: string;
  status: string;
  activeOnServer: boolean;
  /** the saved strategy's `_id`, when the list carries one (the field is not yet seen live) */
  strategyId: string | null;
  /** the IST day it was deployed, from `creation_ts`, when readable */
  createdDay: string | null;
}

export const A_LIVE = 'StrategyStatus.Live';
export const A_ERROR = 'StrategyStatus.Error';
export const A_SQUARED_OFF = 'StrategyStatus.SquaredOff';
export const A_STOPPED = 'StrategyStatus.Stopped';

const HEX24 = /^[0-9a-f]{24}$/i;

function strategyIdOf(e: Record<string, unknown>): string | null {
  for (const v of [e.strategy_id, e.strategyId, e.strategy]) {
    if (typeof v === 'string' && HEX24.test(v)) return v;
    if (v && typeof v === 'object') {
      const id = (v as { _id?: unknown })._id;
      if (typeof id === 'string' && HEX24.test(id)) return id;
    }
  }
  return null;
}

function istDayOf(ts: unknown): string | null {
  let ms: number;
  if (typeof ts === 'number' && Number.isFinite(ts)) ms = ts < 1e12 ? ts * 1000 : ts;
  else if (typeof ts === 'string' && ts.trim()) ms = Date.parse(ts);
  else return null;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms + 330 * 60_000).toISOString().slice(0, 10);
}

export function parseExecutions(json: unknown): Execution[] {
  const list = Array.isArray(json) ? json : (json as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new Error('executions list: not an array');
  return (list as Record<string, unknown>[]).map((e) => {
    if (typeof e._id !== 'string') throw new Error('executions list: an execution without _id');
    return {
      id: e._id,
      name: typeof e.name === 'string' ? e.name : '',
      status: typeof e.status === 'string' ? e.status : 'UNKNOWN',
      activeOnServer: e.active_on_server === true,
      strategyId: strategyIdOf(e),
      createdDay: istDayOf(e.creation_ts),
    };
  });
}

/** The web app's own rule (its `canSquareOff`). */
export function canSquareOff(e: Execution): boolean {
  return (e.status === A_LIVE || e.status === A_ERROR) && e.activeOnServer;
}

/**
 * AlgoTest is squaring it off already (`pending_square_off`, the state the web app sets after the
 * call; matched loosely, as the exact server string is unconfirmed). Never "by hand": an exit at
 * the broker while AlgoTest's own exit orders go out would open a reverse position.
 */
export function squaringOff(status: string): boolean {
  return /pending[_ ]?square[_ ]?off/i.test(status);
}

export function isToolName(name: string): boolean {
  return NAME_PREFIXES.some((p) => name.startsWith(p));
}

/**
 * Which deploys are the tool's: the saved strategy's id is one the uploader recorded (when the
 * list carries it), or the name is one the uploader ever saved, or it has a tool prefix. Over-
 * matching (an owner's copy named like the tool's) is the safe direction for a stop; a rename
 * only ever adds names.
 */
export function toolMatcher(ledger: LedgerRow[]): (e: Execution) => boolean {
  const ids = new Set<string>();
  const saved = new Set<string>();
  for (const r of ledger) {
    if (!r.ok || r.action !== 'upload') continue;
    saved.add(r.name);
    if (r.id) ids.add(r.id);
  }
  return (e) =>
    (e.strategyId !== null && ids.has(e.strategyId)) || saved.has(e.name) || isToolName(e.name);
}

export interface AlgoTestStopPlan {
  squareOff: Execution[];
  /** the tool's, AlgoTest already squaring it off: wait, never by hand */
  squaring: Execution[];
  /** the tool's, not done, but no square-off the platform offers now */
  byHand: Execution[];
  /** the tool's, switched to manual today (or undated): its legs may be open */
  check: Execution[];
  /** the owner's own deploys still live: left alone */
  notMine: Execution[];
  /** the tool's, squared off, or stopped on an earlier day */
  done: number;
}

export function planAlgoTestStop(
  execs: Execution[],
  isTool: (e: Execution) => boolean,
  today: string,
): AlgoTestStopPlan {
  const out: AlgoTestStopPlan = {
    squareOff: [],
    squaring: [],
    byHand: [],
    check: [],
    notMine: [],
    done: 0,
  };
  for (const e of execs) {
    if (!isTool(e)) {
      if (e.status !== A_SQUARED_OFF && e.status !== A_STOPPED) out.notMine.push(e);
      continue;
    }
    if (canSquareOff(e)) out.squareOff.push(e);
    else if (squaringOff(e.status)) out.squaring.push(e);
    else if (e.status === A_SQUARED_OFF) out.done += 1;
    else if (e.status === A_STOPPED) {
      if (e.createdDay === null || e.createdDay >= today) out.check.push(e);
      else out.done += 1;
    } else out.byHand.push(e);
  }
  return out;
}

export interface AlgoTestAfter {
  confirmed: string[];
  /** still squaring off, or still live, when the wait ended */
  pending: string[];
  /** switched to manual or gone from the list: legs may be open */
  check: string[];
  /** squared off (or squaring) but now in another state: look at /live, never exit blind */
  byHand: string[];
}

/** What each target shows now. `confirmed` only when squared off. */
export function algotestAfter(targets: Execution[], after: Execution[]): AlgoTestAfter {
  const now = new Map(after.map((e) => [e.id, e]));
  const out: AlgoTestAfter = { confirmed: [], pending: [], check: [], byHand: [] };
  for (const t of targets) {
    const e = now.get(t.id);
    if (!e) out.check.push(`${t.name}: no longer listed: check /live`);
    else if (e.status === A_SQUARED_OFF) out.confirmed.push(t.name);
    else if (squaringOff(e.status) || canSquareOff(e)) out.pending.push(`${t.name} (${e.status})`);
    else if (e.status === A_STOPPED)
      out.check.push(`${t.name}: switched to manual: its legs may be open, check at the broker`);
    else
      out.byHand.push(
        `${t.name}: square-off sent, AlgoTest now shows ${e.status}: open /live first; do NOT exit it at the broker while AlgoTest may still be exiting`,
      );
  }
  return out;
}

export const names = (xs: Array<{ name: string }>): string => xs.map((x) => x.name).join(', ');

/** Names for a report line, at most `max` of them: a long list must not sink the message. */
export function capped(xs: Array<{ name: string } | string>, max = 8): string {
  const all = xs.map((x) => (typeof x === 'string' ? x : x.name));
  if (all.length <= max) return all.join(', ');
  return `${all.slice(0, max).join(', ')} and ${all.length - max} more`;
}
