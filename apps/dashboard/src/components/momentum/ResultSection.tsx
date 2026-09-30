import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/** A titled block inside the results tab widget — a section, not another nested card. */
export function ResultSection({
  title,
  description,
  actions,
  children,
  padded = true,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** False when the section sits in a grid cell rather than directly in the tab's divided list. */
  padded?: boolean;
}) {
  return (
    <section className={cn('space-y-3', padded && 'py-5 first:pt-0 last:pb-0')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
