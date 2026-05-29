import { AlertTriangle, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

type Variant = 'empty' | 'error';

interface StateMessageProps {
  variant: Variant;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/**
 * One consistent treatment for empty + error states, replacing the five
 * duplicated EmptyState / ErrorState pairs. Errors are reassuring, not alarming
 * (the polling hooks keep retrying and stale data is preserved upstream).
 */
export function StateMessage({ variant, title, description, icon, className }: StateMessageProps) {
  if (variant === 'error') {
    return (
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3.5',
          className,
        )}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div>
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center',
        className,
      )}
    >
      <span className="text-faint">{icon ?? <Inbox className="h-7 w-7" />}</span>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{description}</p>
        ) : null}
      </div>
    </div>
  );
}
