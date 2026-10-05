import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/** A row of filters and actions above a table or chart. Wraps on narrow screens. */
export function Toolbar({
  children,
  ariaLabel,
  className,
}: { children: ReactNode; ariaLabel: string; className?: string }) {
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      className={cn('flex flex-wrap items-center gap-2', className)}
    >
      {children}
    </div>
  );
}

/** Pushes whatever follows it to the far end of a Toolbar. */
export function ToolbarSpacer() {
  return <span className="flex-1" />;
}
