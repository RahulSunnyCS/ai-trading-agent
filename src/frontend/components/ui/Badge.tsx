import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/**
 * Tone-keyed pill. Consolidates the ~30 status / management / regime / frozen
 * badges that were previously redefined in every table view. Tones map to the
 * semantic color tokens so they read correctly in light and dark.
 */
export type Tone = 'positive' | 'negative' | 'warning' | 'info' | 'accent' | 'neutral' | 'primary';

const TONES: Record<Tone, string> = {
  positive: 'bg-positive/12 text-positive ring-positive/25',
  negative: 'bg-negative/12 text-negative ring-negative/25',
  warning: 'bg-warning/14 text-warning ring-warning/25',
  info: 'bg-info/12 text-info ring-info/25',
  accent: 'bg-accent/14 text-accent ring-accent/25',
  primary: 'bg-primary/12 text-primary ring-primary/25',
  neutral: 'bg-surface-2 text-muted ring-border',
};

interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  /** Show a leading dot (useful for active/status pills). */
  dot?: boolean;
}

export function Badge({ tone = 'neutral', children, className, dot = false }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
