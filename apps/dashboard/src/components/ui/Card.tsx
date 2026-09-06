import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/**
 * Surface container — the single source of truth for the "card" look across
 * the app. Replaces the ~14 hand-rolled `rounded-lg bg-gray-900 p-4` panels.
 */
interface CardProps {
  children: ReactNode;
  className?: string;
  /** Drop the default padding when the card hosts its own table/chart. */
  flush?: boolean;
}

export function Card({ children, className, flush = false }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-surface shadow-card',
        flush ? '' : 'p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: ReactNode;
  /** Optional small caption shown under the title. */
  description?: ReactNode;
  /** Right-aligned actions (e.g. a Refresh button). */
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function CardHeader({ title, description, actions, icon, className }: CardHeaderProps) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="flex items-start gap-2.5">
        {icon ? <span className="mt-0.5 text-muted">{icon}</span> : null}
        <div>
          <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
