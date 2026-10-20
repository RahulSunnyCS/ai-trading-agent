import { FINISHED, type QAlgo, type QLedgerRow, ownedIds } from './quantiply-plan.js';
import { NAME_PREFIXES } from './strategy-plan.js';

/**
 * BL-143 Phase 4, the stop button: what a confirmed stop does on each platform, decided without a
 * network (`stop-button.ts` makes the calls). The owner's answer (2026-10-20): switch off AND
 * square off, only after a second confirm tap.
 *
 * Quantiply (each account; only the tool's algos: ids in that account's uploader ledger):
 * - `TRADE_ACTIVE` (the only status the web app offers its square-off for): square off all
 *   positions and terminate the algo, Quantiply's own `PUT /algos/:id/action/SQ_OFF_TERMINATE`.
 * - enabled and `READY`, `NOT_RUNNING` or `TRADE_CLOSED`: switched off (`PUT /algos/:id/disable`),
 *   whatever its weekday and whether today's session is over (the emergency stop).
 * - enabled in any other status: nothing the tool knows to send; "check by hand".
 * - squared off ones are switched off as well once Quantiply shows them finished.
 *
 * AlgoTest (/live; only deploys named like the tool's strategies, `T1 · ` / `Core · `, whoever
 * deployed them):
 * - `StrategyStatus.Live` or `StrategyStatus.Error` and `active_on_server` (the web app's
 *   `canSquareOff`): `PUT /execution/v2/square-off/<execution id>`, AlgoTest's own square-off.
 * - Live or Error but not active on its server (the app offers only "Restart"), or paused: no
 *   square-off the platform offers; "square off by hand".
 * - anything else (squared off, stopped): nothing to do.
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

/** After the calls: the tool's algos still open or still enabled, each with what to do by hand. */
export function quantiplyLeft(ledger: QLedgerRow[], after: QAlgo[]): string[] {
  const owned = ownedIds(ledger);
  const out: string[] = [];
  for (const a of after) {
    if (!owned.has(a.id)) continue;
    if (a.status === Q_ACTIVE)
      out.push(`${a.name} (${a.day}) still TRADE_ACTIVE: square off by hand`);
    else if (a.enabled)
      out.push(`${a.name} (${a.day}) still ENABLED (${a.status}): switch off by hand`);
    else if (a.status === Q_READY)
      out.push(`${a.name} (${a.day}) switched off but still READY: check it does not enter`);
  }
  return out;
}

/** One AlgoTest deploy, as `GET /execution/v2/executions?environment=live` lists it. */
export interface Execution {
  id: string;
  name: string;
  status: string;
  activeOnServer: boolean;
}

export const A_LIVE = 'StrategyStatus.Live';
export const A_ERROR = 'StrategyStatus.Error';
export const A_SQUARED_OFF = 'StrategyStatus.SquaredOff';
export const A_STOPPED = 'StrategyStatus.Stopped';

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
    };
  });
}

/** The web app's own rule (its `canSquareOff`). */
export function canSquareOff(e: Execution): boolean {
  return (e.status === A_LIVE || e.status === A_ERROR) && e.activeOnServer;
}

export function isToolName(name: string): boolean {
  return NAME_PREFIXES.some((p) => name.startsWith(p));
}

export interface AlgoTestStopPlan {
  squareOff: Execution[];
  /** the tool's, not done, but no square-off the platform offers */
  byHand: Execution[];
  /** the owner's own deploys still live: left alone */
  notMine: Execution[];
  /** the tool's, already squared off or stopped */
  done: number;
}

const OVER = new Set([A_SQUARED_OFF, A_STOPPED]);

export function planAlgoTestStop(execs: Execution[]): AlgoTestStopPlan {
  const out: AlgoTestStopPlan = { squareOff: [], byHand: [], notMine: [], done: 0 };
  for (const e of execs) {
    if (!isToolName(e.name)) {
      if (!OVER.has(e.status)) out.notMine.push(e);
      continue;
    }
    if (canSquareOff(e)) out.squareOff.push(e);
    else if (OVER.has(e.status)) out.done += 1;
    else out.byHand.push(e);
  }
  return out;
}

/** After the square-offs: what each target shows now. `confirmed` only when squared off. */
export function algotestAfter(
  targets: Execution[],
  after: Execution[],
): { confirmed: string[]; pending: string[]; byHand: string[] } {
  const now = new Map(after.map((e) => [e.id, e]));
  const out = { confirmed: [] as string[], pending: [] as string[], byHand: [] as string[] };
  for (const t of targets) {
    const e = now.get(t.id);
    if (!e) out.byHand.push(`${t.name}: no longer listed, check /live`);
    else if (e.status === A_SQUARED_OFF) out.confirmed.push(t.name);
    else if (e.status === A_STOPPED)
      out.byHand.push(
        `${t.name}: STOPPED (switched to manual), positions may be open: square off by hand`,
      );
    else if (canSquareOff(e)) out.pending.push(`${t.name} (${e.status})`);
    else out.byHand.push(`${t.name}: ${e.status}: square off by hand`);
  }
  return out;
}

export const names = (xs: Array<{ name: string }>): string => xs.map((x) => x.name).join(', ');
