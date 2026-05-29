import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

type ValueTone = 'default' | 'positive' | 'negative' | 'muted';

const VALUE_TONE: Record<ValueTone, string> = {
  default: 'text-foreground',
  positive: 'text-positive',
  negative: 'text-negative',
  muted: 'text-muted',
};

interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  /** Small caption under the value. */
  note?: ReactNode;
  tone?: ValueTone;
  icon?: ReactNode;
  className?: string;
}

/**
 * Metric tile. Generalised from PnlView's local StatCard; used for the hero /
 * summary metric grids across views.
 */
export function StatCard({ label, value, note, tone = 'default', icon, className }: StatCardProps) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface-2/60 px-4 py-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-faint">{label}</span>
        {icon ? <span className="text-faint">{icon}</span> : null}
      </div>
      <div className={cn('metric mt-1.5 text-2xl font-semibold tracking-tight', VALUE_TONE[tone])}>
        {value}
      </div>
      {note ? <div className="mt-1 text-xs text-muted">{note}</div> : null}
    </div>
  );
}
