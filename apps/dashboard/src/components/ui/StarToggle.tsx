'use client';

import { Star } from 'lucide-react';

import { cn } from '../../lib/cn';

/**
 * A star that marks something as a favourite (BL-102). A toggle button: `aria-pressed` says
 * whether it is starred, and the label names what it stars so a screen reader hears
 * "Star Steady" / "Remove the star from Steady".
 */
export function StarToggle({
  on,
  label,
  onClick,
  className,
  size = 'sm',
  disabled = false,
}: {
  on: boolean;
  /** What is being starred: a list or strategy name. */
  label: string;
  onClick: () => void;
  className?: string;
  size?: 'sm' | 'md';
  /** True until the stars have loaded: a click would have nothing to change. */
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      aria-label={`${on ? 'Remove the star from' : 'Star'} ${label}`}
      title={on ? 'Starred: used as a default in pickers' : 'Star: use as a default in pickers'}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'rounded p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
        on ? 'text-warning' : 'text-faint hover:text-muted',
        className,
      )}
    >
      <Star
        className={cn(size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5', on && 'fill-current')}
        aria-hidden="true"
      />
    </button>
  );
}
