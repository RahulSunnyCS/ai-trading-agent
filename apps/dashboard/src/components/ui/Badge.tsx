import type { ReactNode } from 'react';

import { cn } from '../../lib/cn';

/**
 * Tone-keyed pill. Consolidates the ~30 status / management / regime / frozen
 * badges that were previously redefined in every table view. Tones map to the
 * semantic color tokens so they read correctly in light and dark.
 */
export type Tone = 'positive' | 'negative' | 'warning' | 'info' | 'accent' | 'neutral' | 'primary';

const TONES: Record<Tone, string> = {
  positive: 'bg-positive/10 text-positive ring-positive/25',
  negative: 'bg-negative/10 text-negative ring-negative/25',
  warning: 'bg-warning/15 text-warning ring-warning/25',
  info: 'bg-info/10 text-info ring-info/25',
  accent: 'bg-accent/15 text-accent ring-accent/25',
  primary: 'bg-primary/10 text-primary ring-primary/25',
  neutral: 'bg-surface-2 text-muted ring-border',
};

/**
 * What a state means, mapped to a tone in one place — so "Open", "Connected", "Completed" and
 * a profit do not all end up the same green. Use `<Badge status="open">` rather than picking a
 * tone by hand for these.
 */
export type Status =
  | 'profit'
  | 'loss'
  | 'open'
  | 'closed'
  | 'connected'
  | 'disconnected'
  | 'completed'
  | 'running'
  | 'queued'
  | 'failed'
  | 'attention';

export const STATUS_TONE: Record<Status, Tone> = {
  profit: 'positive',
  loss: 'negative',
  open: 'info',
  closed: 'neutral',
  connected: 'primary',
  disconnected: 'negative',
  completed: 'neutral',
  running: 'info',
  queued: 'neutral',
  failed: 'negative',
  attention: 'warning',
};

interface BadgeProps {
  tone?: Tone;
  /** A semantic state; sets the tone from STATUS_TONE (an explicit `tone` wins). */
  status?: Status;
  children: ReactNode;
  className?: string;
  /** Show a leading dot (useful for active/status pills). */
  dot?: boolean;
}

export function Badge({ tone, status, children, className, dot = false }: BadgeProps) {
  const resolved = tone ?? (status ? STATUS_TONE[status] : 'neutral');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONES[resolved],
        className,
      )}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
