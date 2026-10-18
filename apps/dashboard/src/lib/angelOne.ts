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

export type AngelSource = 'manual' | 'scheduled' | 'collector';

export interface AngelCheck {
  /** When the attempt started (IST, ISO 8601). */
  checked_at: string;
  source: AngelSource;
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
  /** The guard's lock is held: a test or a collection is logged in right now. */
  running: boolean;
  running_source: AngelSource | null;
  cooldown_s: number;
  retry_after_s: number;
  /** When another login may be sent (absolute, so a cached response counts down correctly). */
  cooldown_until: string | null;
  /** A refused login is not repeated with the same settings until `until`. */
  hold: { until: string; message: string } | null;
  warning: string | null;
}

export interface AngelTestStarted {
  status: 'started';
  started_at: string;
}

export const REASON_LABEL: Record<AngelCheckReason, string> = {
  ok: 'Logged in',
  not_configured: 'Not configured',
  rejected: 'Login refused',
  network: 'Could not reach Angel One',
  unavailable: 'Angel One unavailable',
  error: 'Login error',
};

export const SOURCE_LABEL: Record<AngelSource, string> = {
  manual: 'Test connection',
  scheduled: '08:00 check',
  collector: 'Evening collection',
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

/** The check a test started at `startedAt` produced, once the status carries it. */
export function resultOf(status: AngelStatus | null, startedAt: string): AngelCheck | null {
  const check = status?.last_check;
  if (!status || status.running || !check) return null;
  return Date.parse(check.checked_at) >= Date.parse(startedAt) ? check : null;
}

export type TestButtonKind =
  | 'ready'
  | 'not_configured'
  | 'testing'
  | 'collecting'
  | 'cooldown'
  | 'held';

/** The Test connection button: disabled while a login is in use, through the cool-down and a
 * hold after a refused login. `secondsLeft` is the cool-down's, for the label. */
export function testButton(opts: {
  status: AngelStatus;
  testing: boolean;
  nowMs: number;
}): { kind: TestButtonKind; disabled: boolean; secondsLeft: number } {
  const { status, testing, nowMs } = opts;
  const until = status.cooldown_until ? Date.parse(status.cooldown_until) : Number.NaN;
  const cooldown = Number.isNaN(until) ? 0 : until - nowMs;
  const secondsLeft = Math.min(status.cooldown_s, Math.max(0, Math.ceil(cooldown / 1000)));
  const holdUntil = status.hold ? Date.parse(status.hold.until) : Number.NaN;
  const kind: TestButtonKind = !status.configured
    ? 'not_configured'
    : testing || (status.running && status.running_source !== 'collector')
      ? 'testing'
      : status.running
        ? 'collecting'
        : secondsLeft > 0
          ? 'cooldown'
          : !Number.isNaN(holdUntil) && holdUntil > nowMs
            ? 'held'
            : 'ready';
  return { kind, disabled: kind !== 'ready', secondsLeft };
}
