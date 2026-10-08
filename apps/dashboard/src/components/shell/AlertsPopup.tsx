'use client';

import { X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useMomentumAlerts } from '../../hooks/useMomentumAlerts';
import { navigateToLink } from '../../hooks/useQueryState';
import { cn } from '../../lib/cn';
import { istToday } from '../../lib/format';
import { ALERT_TONE, dueToday } from '../../lib/momentumAlerts';
import { useMomentumAlertsStore } from '../../store/momentumAlerts';
import { Button } from '../ui/Button';
import { StatusDot } from '../ui/StatusDot';

const BAR_TONE = {
  error: 'border-l-negative',
  warning: 'border-l-warning',
  info: 'border-l-info',
} as const;

/**
 * The alert pop-up (BL-051 Phase 5), mounted once in the app shell so it shows on whatever page is
 * open: the most severe alert that has not popped up today, with "Review ›" (opens where it is
 * acted on) and "Remind me tomorrow". Showing an alert records the day in this browser, so it
 * pops up at most once a day however the card is closed, and the next due alert follows. The
 * card leaves by itself when the check behind it clears.
 */
export function AlertsPopup() {
  const { data } = useMomentumAlerts();
  const shown = useMomentumAlertsStore((state) => state.shown);
  const hydrated = useMomentumAlertsStore((state) => state.hydrated);
  const markShown = useMomentumAlertsStore((state) => state.markShown);
  const prune = useMomentumAlertsStore((state) => state.prune);
  const [currentId, setCurrentId] = useState<string | null>(null);

  const open = useMemo(() => data?.alerts ?? [], [data]);
  const current = open.find((alert) => alert.id === currentId) ?? null;

  useEffect(() => {
    // Nothing until the stored memory is read, and no new card while one is showing.
    if (!hydrated || !data || current) return;
    const today = istToday();
    const [next] = dueToday(open, shown, today);
    if (!next) return;
    markShown(next.id, today);
    setCurrentId(next.id);
  }, [hydrated, data, current, open, shown, markShown]);

  useEffect(() => {
    if (hydrated && data) prune(open, istToday());
  }, [hydrated, data, open, prune]);

  if (!current) return null;
  const tone = ALERT_TONE[current.severity];

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[4.5rem] z-[55] flex justify-end px-4 sm:px-6">
      <section
        role={current.severity === 'error' ? 'alert' : 'status'}
        aria-label="Alert"
        className={cn(
          'pointer-events-auto w-full max-w-sm animate-fade-in rounded-lg border border-l-4 border-border bg-surface p-3.5 shadow-elevated',
          BAR_TONE[current.severity],
        )}
      >
        <div className="flex items-start gap-2.5">
          <StatusDot tone={tone} className="mt-1.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold leading-snug text-foreground">{current.title}</h2>
            <p className="mt-1 text-xs leading-snug text-muted">{current.detail}</p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setCurrentId(null)}
            className="rounded text-faint hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setCurrentId(null)}>
            Remind me tomorrow
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setCurrentId(null);
              navigateToLink(current.link);
            }}
          >
            Review ›
          </Button>
        </div>
      </section>
    </div>
  );
}
