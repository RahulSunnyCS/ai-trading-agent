import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/** Monospace inline/block code surface (used by ReplayView's run instructions). */
export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cn(
        'block overflow-x-auto rounded-lg border border-border bg-surface-2/70 px-3 py-2 font-mono text-xs text-foreground',
        className,
      )}
    >
      {children}
    </code>
  );
}
