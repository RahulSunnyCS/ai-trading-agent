import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Every notification type a sender may tag a message with. The dashboard's
 * Notifications page lists these so the owner can switch each one off for
 * Telegram (BL-012). The Python senders use the same strings — keep them in
 * step with packages/{momentum,option}-backtesting/.../notify.py callers.
 *
 * A message with no type is always sent: untagged means "not optional".
 */
export const NOTIFICATION_TYPES = {
  'broker.algotest': 'AlgoTest broker login report and failures',
  'broker.fyers': 'Fyers login failures',
  'broker.kite': 'Kite: the Friday 13:30 login reminder (BL-142)',
  'broker.quantiply': 'Quantiply: the Core picks created or deleted, and failures (BL-139)',
  'momentum.preview': 'Momentum weekly preview (Fri 14:40)',
  'momentum.final': 'Momentum weekly final signal / rebalance (Fri 16:45)',
  'momentum.orders': 'Momentum: your orders for the headline favourite (Fri 14:15)',
  'momentum.journal': 'Momentum forward-journal entries and weekly check',
  'momentum.problem': 'Momentum: no signal, stale data, blocked favourite or failed job',
  'momentum.live_rules':
    'Momentum live-money rules: the weekly status (a rule that is hit is always sent)',
  'monitor.margin': 'Trade monitor: the 09:05 margin check per broker account (BL-143)',
  'monitor.deploy': 'Trade monitor: the 09:25 deploy check of AlgoTest and Quantiply (BL-143)',
  'monitor.loss':
    'Trade monitor: the -₹5,000 loss warning (the -₹8,000 alert and "cannot read" are always sent)',
  'options.daily': 'Options evening collection and leg-wise P&L summary',
  'options.problem': 'Options evening collection could not run',
  'scheduler.morning': 'Scheduler morning summary (09:00 on trading days)',
  'scheduler.digest': 'Scheduler Saturday health digest',
  'scheduler.backup': 'Monthly backup fell back to ~/Downloads (SSD not plugged in)',
  'scheduler.recovered': 'Scheduler: a job that failed ran fine again',
  'scheduler.missed': 'Scheduler: jobs missed while the laptop slept (one message per wake-up)',
  'scheduler.failure': 'Scheduler: a job failed (its alert)',
  'options.pick': 'Options rotation: the 09:16 picks (Adaptive and T1)',
  'options.result': "Options rotation: the 16:00 result and tomorrow's strategies",
  'quantiply.switch_off': "Quantiply: the 15:40 switch-off of the tool's algos",
} as const;

/** How much of a type goes to Telegram: everything, only its failures, or nothing. */
export type Level = 'all' | 'failures' | 'off';

/**
 * BL-173 (owner, 2026-10-28): the level a type has when the preferences file says nothing about
 * it. Every other type is `all`. The Python notify.py copies carry the same table.
 */
export const DEFAULT_LEVELS: Readonly<Record<string, Level>> = {
  'momentum.preview': 'off',
  'momentum.journal': 'failures',
  'momentum.live_rules': 'failures',
  'options.daily': 'failures',
  'scheduler.recovered': 'off',
  'quantiply.switch_off': 'failures',
};

/**
 * A message's failure, read from its first characters: the warning icons every sender puts first
 * on a problem (⚠️ ❌ 🚨 💥 🔴 ⛔). A structured message says it with its severity instead.
 */
export function looksLikeFailure(text: string): boolean {
  return /^\s*(⚠️|⚠|❌|🚨|💥|🔴|⛔)/u.test(text);
}

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

/**
 * One small JSON file, `{"disabled": ["momentum.preview", ...], "levels": {"options.daily":
 * "failures"}}`, written by the scheduler and read by every sender in every language — so Python
 * and the Node jobs need no database to honour it. Override with NOTIFY_PREFS_FILE. `disabled`
 * (the older form) still means off; `levels` wins where both name a type.
 */
export function prefsPath(): string {
  return (
    process.env.NOTIFY_PREFS_FILE?.trim() ||
    join(homedir(), '.config', 'ai-trading-agent', 'notifications.json')
  );
}

/**
 * The switched-off types. Fails open: a missing or unreadable file means
 * everything is on, because a broken preferences file must never be what
 * silences a failure alert.
 */
export function disabledTypes(path: string = prefsPath()): Set<string> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(text);
    const list = (parsed as { disabled?: unknown })?.disabled;
    return new Set(Array.isArray(list) ? list.filter((t) => typeof t === 'string') : []);
  } catch {
    console.error(`  notification preferences at ${path} are not valid JSON; sending everything`);
    return new Set();
  }
}

/** The levels the file sets (`levels`, then `disabled` as off). Fails open like `disabledTypes`. */
export function fileLevels(path: string = prefsPath()): Record<string, Level> {
  const out: Record<string, Level> = {};
  for (const t of disabledTypes(path)) out[t] = 'off';
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { levels?: unknown };
    const levels = parsed?.levels;
    if (levels && typeof levels === 'object') {
      for (const [t, v] of Object.entries(levels as Record<string, unknown>)) {
        if (v === 'all' || v === 'failures' || v === 'off') out[t] = v;
      }
    }
  } catch {
    // missing or broken: the file's `disabled` (already read) or nothing
  }
  return out;
}

/** The type's level: the file's, else BL-173's default, else `all`. */
export function levelOf(type: string, path?: string): Level {
  return fileLevels(path)[type] ?? DEFAULT_LEVELS[type] ?? 'all';
}

/**
 * True when a message of this type should go to Telegram. An untagged message always goes; a
 * `failures` type sends only a failure (`failure`, else read from the text's first icon).
 */
export function isEnabled(
  type: string | undefined,
  path?: string,
  failure?: boolean,
  text?: string,
): boolean {
  if (type === undefined) return true;
  const level = levelOf(type, path);
  if (level === 'off') return false;
  if (level === 'failures') return failure ?? looksLikeFailure(text ?? '');
  return true;
}
