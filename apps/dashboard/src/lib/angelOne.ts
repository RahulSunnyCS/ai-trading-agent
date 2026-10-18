/**
 * The Angel One card on Broker logins: response shapes of `/api/backtest/legwise/angel/*`
 * (packages/option-backtesting `angelone/check.py`) and the pure helpers the card renders from.
 * Nothing here ever holds a credential value: the API returns names, a yes/no and a masked
 * client code only.
 */

import { STATUS_TONE, type Tone } from '../components/ui/Badge';

export const ANGEL_STATUS_URL = '/api/backtest/legwise/angel/status';
export const ANGEL_TEST_URL = '/api/backtest/legwise/angel/test';

export type AngelCheckReason =
  | 'ok'
  | 'not_configured'
  | 'rejected'
  | 'network'
  | 'unavailable'
  | 'error';

export interface AngelCheck {
  checked_at: string;
  source: 'manual' | 'scheduled';
  ok: boolean;
  reason: AngelCheckReason;
  /** Scrubbed upstream: never a token, PIN, TOTP code or key. */
  message: string;
  /** Masked client code ("R1•••56"). */
  client: string | null;
  duration_ms: number;
  /** A login request was sent (it started the cool-down). */
  attempted: boolean;
}

export interface AngelCredential {
  name: string;
  set: boolean;
  required: boolean;
}

export interface AngelCollection {
  trading_day: string | null;
  started_at: string | null;
  status: string;
}

export interface AngelStatus {
  configured: boolean;
  credentials: AngelCredential[];
  client: string | null;
  last_check: AngelCheck | null;
  last_collection: AngelCollection | null;
  running: boolean;
  cooldown_s: number;
  /** Seconds until another login may be sent, as of the response. */
  retry_after_s: number;
  warning: string | null;
}

export interface AngelTestResponse {
  result: AngelCheck;
}

export const REASON_LABEL: Record<AngelCheckReason, string> = {
  ok: 'Logged in',
  not_configured: 'Not configured',
  rejected: 'Login refused',
  network: 'Could not reach Angel One',
  unavailable: 'Angel One unavailable',
  error: 'Login error',
};

export const SOURCE_LABEL: Record<AngelCheck['source'], string> = {
  manual: 'Test connection',
  scheduled: '08:00 check',
};

export type AngelCardState = 'unknown' | 'not_configured' | 'untested' | 'working' | 'failed';

/** Where the connection stands, from the status and the newest check. */
export function angelCardState(
  status: AngelStatus | null,
  check: AngelCheck | null,
): AngelCardState {
  if (!status) return 'unknown';
  if (!status.configured) return 'not_configured';
  if (!check) return 'untested';
  return check.ok ? 'working' : 'failed';
}

export const STATE_BADGE: Record<AngelCardState, { label: string; tone: Tone }> = {
  unknown: { label: 'Unknown', tone: 'neutral' },
  not_configured: { label: 'Not configured', tone: 'neutral' },
  untested: { label: 'Not tested yet', tone: 'neutral' },
  working: { label: 'Login works', tone: STATUS_TONE.connected },
  failed: { label: 'Last check failed', tone: STATUS_TONE.failed },
};

export const STATE_DOT: Record<AngelCardState, Tone> = {
  unknown: 'neutral',
  not_configured: 'neutral',
  untested: 'neutral',
  working: 'primary',
  failed: 'negative',
};

/** The newer of two checks (a test just run here, and the one the status last reported). */
export function newestCheck(a: AngelCheck | null, b: AngelCheck | null): AngelCheck | null {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a.checked_at) >= Date.parse(b.checked_at) ? a : b;
}

/** When the cool-down ends, in epoch ms, from a status received at `receivedAtMs`. */
export function cooldownEndsAt(status: AngelStatus | null, receivedAtMs: number): number {
  return receivedAtMs + Math.max(0, status?.retry_after_s ?? 0) * 1000;
}

/** The Test connection button: disabled while a test runs and through the cool-down. */
export function testButton(opts: {
  configured: boolean;
  testing: boolean;
  running: boolean;
  endsAtMs: number;
  nowMs: number;
}): { disabled: boolean; label: string; secondsLeft: number } {
  const secondsLeft = Math.max(0, Math.ceil((opts.endsAtMs - opts.nowMs) / 1000));
  if (opts.testing || opts.running) {
    return { disabled: true, label: 'Testing…', secondsLeft };
  }
  if (!opts.configured) return { disabled: true, label: 'Test connection', secondsLeft };
  if (secondsLeft > 0) return { disabled: true, label: `Wait ${secondsLeft} s`, secondsLeft };
  return { disabled: false, label: 'Test connection', secondsLeft: 0 };
}
