/**
 * Alerts (BL-051 Phase 5): which open alert pops up now, and how that is remembered. Pure helpers,
 * tested in `__tests__/momentumAlerts.test.ts`; the bell and the pop-up are
 * `components/shell/AlertsBell.tsx` and `AlertsPopup.tsx`, the memory is `store/momentumAlerts.ts`.
 *
 * The rule: an alert pops up on whatever page is open **at most once a day**. Showing it records
 * the day; "Remind me tomorrow" (and closing it) leave that record, so it comes back the next
 * day if it is still open. An alert that was resolved and later opens again under the same id
 * is the same alert, so it does not pop up twice in a day.
 */
import type { Tone } from '../components/ui/Badge';
import type { MomentumAlert, MomentumAlertSeverity } from '../types/momentum';

/** The day each alert (by id) last popped up in this browser, as an IST 'YYYY-MM-DD'. */
export type AlertMemory = Readonly<Record<string, string>>;

/** The tone each severity is drawn in (dot, bar, badge). */
export const ALERT_TONE: Record<MomentumAlertSeverity, Tone> = {
  error: 'negative',
  warning: 'warning',
  info: 'info',
};

const SEVERITY_RANK: Record<MomentumAlertSeverity, number> = { error: 0, warning: 1, info: 2 };

/** Most severe first, then the one open longest; the server's order, kept when it is lost. */
export function sortAlerts(alerts: readonly MomentumAlert[]): MomentumAlert[] {
  return [...alerts].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (a.opened_at ?? '').localeCompare(b.opened_at ?? '') ||
      a.id.localeCompare(b.id),
  );
}

/** The alerts that have not popped up yet on `today`, most severe first. */
export function dueToday(
  alerts: readonly MomentumAlert[],
  memory: AlertMemory,
  today: string,
): MomentumAlert[] {
  return sortAlerts(alerts.filter((alert) => memory[alert.id] !== today));
}

/** `memory` with `id` recorded as shown on `today` (showing it, or "Remind me tomorrow"). */
export function markShown(memory: AlertMemory, id: string, today: string): AlertMemory {
  return memory[id] === today ? memory : { ...memory, [id]: today };
}

/** The day after an IST 'YYYY-MM-DD' (calendar arithmetic, no time zone involved). */
export function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Forget alerts that are neither open now nor shown today, so the memory does not grow for ever.
 * An alert that cleared and opens again within the day keeps today's record.
 */
export function pruneMemory(
  memory: AlertMemory,
  open: readonly MomentumAlert[],
  today: string,
): AlertMemory {
  const ids = new Set(open.map((alert) => alert.id));
  const kept = Object.entries(memory).filter(([id, day]) => ids.has(id) || day === today);
  return kept.length === Object.keys(memory).length ? memory : Object.fromEntries(kept);
}

/** The most severe open severity, for the bell's colour; null when nothing is open. */
export function topSeverity(alerts: readonly MomentumAlert[]): MomentumAlertSeverity | null {
  const first = sortAlerts(alerts)[0];
  return first ? first.severity : null;
}

/** "3" on the bell; "9+" past nine. */
export function bellCount(alerts: readonly MomentumAlert[]): string {
  return alerts.length > 9 ? '9+' : String(alerts.length);
}
