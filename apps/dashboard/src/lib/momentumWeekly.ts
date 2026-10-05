/**
 * Pure rules for the Momentum › Weekly signal view: which run / send combinations are
 * allowed, what the Run button says, how a signal's action words and a strategy block's
 * severity map to tones, and the readiness facts shown in the strip at the top.
 */

import type {
  MomentumSavedRun,
  MomentumWeeklyRunResult,
  MomentumWeeklyStatus,
} from '../types/momentum';
import { signalActionTone } from './momentumResult';

export type WeeklyRunKind = 'preview' | 'final';

/** A preview uses live prices and may change before the close, so only a final run can be sent. */
export function canSend(run: WeeklyRunKind): boolean {
  return run === 'final';
}

/** Why the Send option is unavailable for this run kind, or null when it is available. */
export function sendDisabledReason(run: WeeklyRunKind): string | null {
  return canSend(run)
    ? null
    : 'A preview uses live prices and can change before the close, so it is never sent from here. Switch to Final to send.';
}

/** The send flag that may actually be submitted: always false for a run that cannot be sent. */
export function effectiveSend(run: WeeklyRunKind, send: boolean): boolean {
  return send && canSend(run);
}

export function runButtonLabel(run: WeeklyRunKind, send: boolean): string {
  if (run === 'preview') return 'Run preview';
  return effectiveSend(run, send) ? 'Run final and send to Telegram' : 'Run final without sending';
}

/** What the confirmation row says will go to Telegram. `known` is false until favourites load. */
export function sendConfirmationText(activeName: string | null, known: boolean): string {
  if (!known) {
    return "Sends the active strategy's final signal to Telegram.";
  }
  if (activeName === null) {
    return 'No favourite is marked Telegram-active, so Telegram will receive a "no active favourite selected" warning instead of a signal.';
  }
  return `Sends the active strategy's final signal (${activeName}) to Telegram. If that strategy is blocked this week, Telegram receives the blocked warning instead.`;
}

// ---------------------------------------------------------------------------
// Signal rows

export type ActionTone = 'positive' | 'negative' | 'neutral' | 'warning';

/**
 * Tone for a signal action word. The engine emits BUY / ADD / SELL / TRIM (sometimes with a
 * suffix, "TRIM 20%") / HOLD / AT CAP / WAIT.
 */
export function actionTone(action: string): ActionTone {
  // One tone map for signal actions across Backtest, Weekly and Rebalance.
  return signalActionTone(action);
}

/** True for an action that changes the portfolio (not HOLD / AT CAP / WAIT). */
export function isTradeAction(action: string): boolean {
  const tone = actionTone(action);
  return tone === 'positive' || tone === 'negative';
}

export interface WeeklySignalRow {
  asset: string;
  action: string;
  rank: number | null;
}

/** The rows of a signal that carry an action, read defensively from the untyped payload. */
export function signalActionRows(signal: Record<string, unknown> | null): WeeklySignalRow[] {
  const raw = signal?.rows;
  if (!Array.isArray(raw)) return [];
  const rows: WeeklySignalRow[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const { asset, action, rank } = item as Record<string, unknown>;
    if (typeof asset !== 'string' || typeof action !== 'string' || !action.trim()) continue;
    rows.push({
      asset,
      action: action.trim(),
      rank: typeof rank === 'number' && Number.isFinite(rank) ? rank : null,
    });
  }
  return rows;
}

const TONE_ORDER: Record<ActionTone, number> = { negative: 0, positive: 1, warning: 2, neutral: 3 };

/** Sells first, then buys, then waiting, then holds: the order the Telegram message uses. */
export function sortSignalRows(rows: readonly WeeklySignalRow[]): WeeklySignalRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        TONE_ORDER[actionTone(a.row.action)] - TONE_ORDER[actionTone(b.row.action)] ||
        a.index - b.index,
    )
    .map((item) => item.row);
}

export type BlockSeverity = 'info' | 'warning' | 'blocked';

/**
 * Severity of one strategy's block. Blocked wins. The run-level `severity` describes the
 * active strategy's notification only, so it applies to the active block; any other block is
 * a warning when it indicates trades and info otherwise.
 */
export function blockSeverity(
  strategy: { blocked: string | null; active: boolean; signal: Record<string, unknown> | null },
  runSeverity: string,
): BlockSeverity {
  if (strategy.blocked) return 'blocked';
  if (strategy.active && runSeverity !== 'info') return 'warning';
  return signalActionRows(strategy.signal).some((row) => isTradeAction(row.action))
    ? 'warning'
    : 'info';
}

type ResultStrategy = NonNullable<MomentumWeeklyRunResult['strategies']>[number];

/** The per-strategy blocks of a run; an old single-strategy payload becomes one block. */
export function resultStrategies(result: MomentumWeeklyRunResult): ResultStrategy[] {
  return (
    result.strategies ?? [
      {
        id: null,
        name: 'Default live strategy',
        dataset: 'etf',
        active: true,
        blocked: null,
        title: result.title,
        body: result.body,
        signal: result.signal,
      },
    ]
  );
}

const DATASET_LABELS: Record<ResultStrategy['dataset'], string> = {
  etf: 'ETF Rotation',
  stock: 'Nifty 50 Stocks',
  custom_index: 'Custom Index',
  broad: 'Broad Momentum',
};

export function datasetLabel(dataset: string): string {
  return (DATASET_LABELS as Record<string, string>)[dataset] ?? dataset;
}

// ---------------------------------------------------------------------------
// Readiness

const WEEK_MS = 7 * 86_400_000;

export function weeksBehind(through: string, target: string): number {
  return Math.round((Date.parse(target) - Date.parse(through)) / WEEK_MS);
}

/** Which ingested dataset a favourite depends on: ETF prices, or bhavcopy for everything else. */
export function dataKeyFor(dataset: unknown): 'etf' | 'stock' {
  return dataset === 'etf' ? 'etf' : 'stock';
}

export interface WeeklyReadiness {
  /** null while the favourites have not loaded. */
  activeName: string | null;
  activeKnown: boolean;
  latestFinal: MomentumWeeklyStatus['signals'][number] | null;
  /** Whether the active strategy's data is in for the target week; null when unknown. */
  activeReady: boolean | null;
  /** One line per thing that would stop a final signal this week. */
  blockedReasons: string[];
}

export function weeklyReadiness(
  status: MomentumWeeklyStatus | null,
  favorites: readonly MomentumSavedRun[] | null,
): WeeklyReadiness {
  const active = favorites?.find((run) => run.active) ?? null;
  const activeData =
    active && status
      ? (status.datasets.find((item) => item.key === dataKeyFor(active.config.dataset)) ?? null)
      : null;
  const blockedReasons: string[] = [];
  if (favorites && !active && favorites.length > 0) {
    blockedReasons.push('No favourite is marked Telegram-active, so no signal would be sent.');
  }
  for (const item of status?.datasets ?? []) {
    if (item.ready && !item.error) continue;
    const affected = (favorites ?? []).filter(
      (run) => dataKeyFor(run.config.dataset) === item.key,
    ).length;
    if (favorites && affected === 0) continue;
    const why =
      item.error?.replace(/\.$/, '') ??
      (item.through
        ? `${weeksBehind(item.through, status?.target_week ?? item.through)} week(s) behind the target week`
        : 'not ingested yet');
    blockedReasons.push(
      `${item.label}: ${why}${
        active && activeData?.key === item.key
          ? ` (blocks the active strategy, ${active.name})`
          : ''
      }.`,
    );
  }
  return {
    activeName: active?.name ?? null,
    activeKnown: favorites !== null,
    latestFinal: status?.signals.find((signal) => signal.run === 'final') ?? null,
    activeReady: activeData ? activeData.ready && !activeData.error : null,
    blockedReasons,
  };
}
