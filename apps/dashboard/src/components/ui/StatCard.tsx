import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';
import { InfoTooltip } from './InfoTooltip';
import { Skeleton } from './Skeleton';

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
  /** Explains the metric, behind an (i) next to the label. */
  hint?: string;
  /** A change against a reference ("+1.2 pp vs previous"); coloured by `deltaTone`. */
  delta?: ReactNode;
  deltaTone?: ValueTone;
  /** Shows a placeholder where the value will be. */
  loading?: boolean;
  className?: string;
}

/**
 * Metric tile. Generalised from PnlView's local StatCard; used for the hero /
 * summary metric grids across views.
 */
export function StatCard({
  label,
  value,
  note,
  tone = 'default',
  icon,
  hint,
  delta,
  deltaTone = 'muted',
  loading = false,
  className,
}: StatCardProps) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface-2/60 px-4 py-3.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wider text-faint">
          {label}
          {hint ? (
            <InfoTooltip
              text={hint}
              label={typeof label === 'string' ? `About ${label}` : undefined}
            />
          ) : null}
        </span>
        {icon ? <span className="text-faint">{icon}</span> : null}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-7 w-24" />
      ) : (
        <div
          className={cn('metric mt-1.5 text-2xl font-semibold tracking-tight', VALUE_TONE[tone])}
        >
          {value}
        </div>
      )}
      {delta && !loading ? (
        <div className={cn('metric mt-1 text-xs font-medium', VALUE_TONE[deltaTone])}>{delta}</div>
      ) : null}
      {note ? <div className="mt-1 text-xs text-muted">{note}</div> : null}
    </div>
  );
}
