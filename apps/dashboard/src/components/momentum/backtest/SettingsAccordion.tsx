'use client';

import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../../lib/cn';

/**
 * The settings panel's accordion: the look of `ui/Accordion`, but controlled, so the open state
 * lives with the panel's parent. That lets it survive the panel being collapsed and reopened,
 * and lets a summary chip open the accordion it describes. `id` is the scroll target.
 */
export function SettingsAccordion({
  id,
  title,
  description,
  badge,
  modified = false,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  /** A setting inside differs from the dataset's defaults. */
  modified?: boolean;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      className="scroll-mt-24 overflow-hidden rounded-xl border border-border bg-surface xl:scroll-mt-2"
    >
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        aria-controls={`${id}-body`}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          {modified ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-info"
              title="Changed from this dataset's defaults"
            >
              <span className="sr-only">Changed from the defaults</span>
            </span>
          ) : null}
          {badge}
        </div>
        <div className="flex min-w-0 items-center gap-3">
          {description ? (
            <span className="hidden truncate text-xs text-muted sm:inline">{description}</span>
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
        <div
          id={`${id}-body`}
          className="animate-fade-in space-y-4 border-t border-border px-4 py-4"
        >
          {description ? <p className="-mt-1 text-xs text-muted sm:hidden">{description}</p> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}
