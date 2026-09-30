'use client';

import { ChevronDown } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { cn } from '../../lib/cn';

/**
 * Collapsible settings group — the grouped, labelled sections the legacy
 * Python momentum UI used ("1 · Universe & period", "2 · Selection &
 * portfolio", ...) instead of one long flat grid of unlabelled fields.
 */
export function Accordion({
  title,
  description,
  defaultOpen = true,
  badge,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cn('overflow-hidden rounded-xl border border-border bg-surface', className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {badge}
        </div>
        <div className="flex items-center gap-3">
          {description ? (
            <span className="hidden text-xs text-muted sm:inline">{description}</span>
          ) : null}
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-faint transition-transform duration-150',
              open && 'rotate-180',
            )}
          />
        </div>
      </button>
      {open ? (
        <div className="space-y-4 border-t border-border px-4 py-4 animate-fade-in">
          {description ? <p className="-mt-1 text-xs text-muted sm:hidden">{description}</p> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
