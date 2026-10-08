'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Bell } from 'lucide-react';
import type { MouseEvent } from 'react';

import { useMomentumAlerts } from '../../hooks/useMomentumAlerts';
import { navigateToLink } from '../../hooks/useQueryState';
import { cn } from '../../lib/cn';
import { formatRelative } from '../../lib/format';
import { ALERT_TONE, bellCount, sortAlerts, topSeverity } from '../../lib/momentumAlerts';
import type { MomentumAlert } from '../../types/momentum';
import { StatusDot } from '../ui/StatusDot';

/** A plain left click, which the app handles itself; modified clicks behave as normal links. */
function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Open an alert's link in the app (no page load), unless the click wants a new tab. */
export function followAlertLink(event: MouseEvent, link: string): void {
  if (!isPlainClick(event)) return;
  event.preventDefault();
  navigateToLink(link);
}

const BADGE_TONE = {
  error: 'bg-negative text-primary-foreground',
  warning: 'bg-warning text-primary-foreground',
  info: 'bg-info text-primary-foreground',
} as const;

/**
 * The bell in the top bar (BL-051 Phase 5): every open alert, most severe first, each a link to
 * where it is acted on. The count is on the bell, coloured by the worst severity. An alert leaves
 * the list when the check behind it clears; the ones that just cleared are listed dimmed below.
 */
export function AlertsBell() {
  const { data, error } = useMomentumAlerts();
  const open = data ? sortAlerts(data.alerts) : [];
  const worst = topSeverity(open);
  const recent = data?.resolved.slice(0, 3) ?? [];
  const label = open.length
    ? `Alerts: ${open.length} need${open.length === 1 ? 's' : ''} you`
    : 'Alerts: nothing needs you';

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {worst ? (
            <span
              data-testid="alerts-count"
              className={cn(
                'absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none',
                BADGE_TONE[worst],
              )}
            >
              {bellCount(open)}
            </span>
          ) : null}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          aria-label="Alerts"
          className="z-50 w-[min(24rem,calc(100vw-2rem))] rounded-lg border border-border-strong bg-surface p-1 shadow-elevated"
        >
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
            Needs you
          </DropdownMenu.Label>
          {open.length === 0 ? (
            <p className="px-2.5 py-2 text-sm text-muted">
              {data
                ? 'Nothing needs you right now.'
                : error
                  ? 'Alerts could not be loaded.'
                  : 'Loading…'}
            </p>
          ) : (
            open.map((alert) => <AlertRow key={alert.id} alert={alert} />)
          )}
          {data && data.unchecked.length > 0 ? (
            <p className="border-t border-border px-2.5 pb-1.5 pt-2 text-[11px] leading-snug text-faint">
              Could not check {data.unchecked.join(', ')} just now; earlier alerts for them are
              kept.
            </p>
          ) : null}
          {recent.length > 0 ? (
            <>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-faint">
                Cleared recently
              </DropdownMenu.Label>
              {recent.map((alert) => (
                <p key={alert.id} className="truncate px-2.5 py-1 text-xs text-faint">
                  {alert.title}
                  <span className="ml-1.5">{formatRelative(alert.resolved_at)}</span>
                </p>
              ))}
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function AlertRow({ alert }: { alert: MomentumAlert }) {
  return (
    <DropdownMenu.Item asChild>
      <a
        href={alert.link}
        onClick={(event) => followAlertLink(event, alert.link)}
        className="flex cursor-pointer select-none items-start gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface-2"
      >
        <StatusDot tone={ALERT_TONE[alert.severity]} className="mt-1.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium leading-snug text-foreground">{alert.title}</span>
          <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-muted">
            {alert.detail}
          </span>
          {alert.opened_at ? (
            <span className="mt-0.5 block text-[11px] text-faint">
              Open {formatRelative(alert.opened_at)}
            </span>
          ) : null}
        </span>
      </a>
    </DropdownMenu.Item>
  );
}
