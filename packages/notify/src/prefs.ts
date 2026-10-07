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
  'momentum.preview': 'Momentum weekly preview (Fri 14:40)',
  'momentum.final': 'Momentum weekly final signal / rebalance (Fri 16:45)',
  'momentum.journal': 'Momentum forward-journal entries and weekly check',
  'momentum.problem': 'Momentum: no signal, stale data, blocked favourite or failed job',
  'momentum.live_rules':
    'Momentum live-money rules: the weekly status (a rule that is hit is always sent)',
  'options.daily': 'Options evening collection and leg-wise P&L summary',
  'options.problem': 'Options evening collection could not run',
  'scheduler.morning': 'Scheduler morning summary (09:00 on trading days)',
  'scheduler.digest': 'Scheduler Saturday health digest',
  'scheduler.backup': 'Monthly backup fell back to ~/Downloads (SSD not plugged in)',
} as const;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

/**
 * One small JSON file, `{"disabled": ["momentum.preview", ...]}`, written by
 * the scheduler and read by every sender in every language — so Python and
 * the Node jobs need no database to honour it. Override with NOTIFY_PREFS_FILE.
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

/** True when a message of this type should go to Telegram. */
export function isEnabled(type: string | undefined, path?: string): boolean {
  return type === undefined || !disabledTypes(path).has(type);
}
