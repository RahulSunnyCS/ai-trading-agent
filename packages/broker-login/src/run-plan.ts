import type { BrokerResult } from './brokers/types.js';

/**
 * The browser-free decisions main.ts makes: when Quantiply runs relative to the AlgoTest logins,
 * and what the process exit code is. Kept here so they are unit-tested (main.ts runs on import).
 */

/** AlgoTest rejects broker logins outside 08:15-15:40 IST. */
export const WINDOW_OPENS_MINUTES = 8 * 60 + 16;
export const WINDOW_CLOSES_MINUTES = 15 * 60 + 40;

export function istMinutesNow(at: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

/**
 * - `now`: no AlgoTest login in the settings (ONLY=none, BL-140): nothing to wait for, so Quantiply
 *   logs in at once.
 * - `first`: well before AlgoTest's 08:16 window opens, while the guard would only sleep -
 *   Quantiply uses those minutes and costs AlgoTest nothing.
 * - `last`: the window is already open (a late or manual run) or the guard is skipped - the
 *   real-money AlgoTest logins go first and are never delayed by Quantiply.
 * - `off`: QUANTIPLY_LOGIN is off, or its config is broken (then it is only a FAIL line).
 */
export type QuantiplyOrder = 'now' | 'first' | 'last' | 'off';

/** Quantiply's hard time limit (quantiply.ts QUANTIPLY_TIME_LIMIT_MS), in whole minutes. */
export const QUANTIPLY_LIMIT_MINUTES = 5;

/**
 * `first` only while even a Quantiply login that runs to its time limit ends before the window
 * opens (the 08:00 dispatch: 08:05 < 08:16); a start closer to the window goes `last`.
 */
export function quantiplyOrder(
  runQuantiply: boolean,
  skipWindowGuard: boolean,
  nowMinutes: number,
  algotest = true,
): QuantiplyOrder {
  if (!runQuantiply) return 'off';
  if (!algotest) return 'now';
  const endsInTime = nowMinutes + QUANTIPLY_LIMIT_MINUTES <= WINDOW_OPENS_MINUTES;
  return !skipWindowGuard && endsInTime ? 'first' : 'last';
}

/**
 * Exit code of the run. Every failure counts (so a local run says so), except that in Actions -
 * `splitQuantiply`, when the workflow gives us $GITHUB_OUTPUT - a Quantiply failure is handed to
 * the workflow as an output instead: its own step then fails the job. The "Log in brokers" step's
 * conclusion so stays AlgoTest's alone, which the cron backstop and the morning summary read.
 */
export function exitCode(
  results: BrokerResult[],
  quantiply: BrokerResult | null,
  fatal: string | null,
  splitQuantiply: boolean,
): number {
  if (fatal !== null || results.some((r) => r.status === 'FAIL')) return 1;
  if (!splitQuantiply && quantiply?.status === 'FAIL') return 1;
  return 0;
}
