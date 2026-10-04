'use client';

import { type KeyboardEvent, type ReactNode, useRef } from 'react';

import { cn } from '../../lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  /** Names the group for assistive tech ("Dataset", "Theme"). */
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
}

/** The enabled option `step` places from `from`, wrapping round. Exported for tests. */
export function nextEnabled<T extends string>(
  options: ReadonlyArray<SegmentedOption<T>>,
  from: number,
  step: 1 | -1,
): number {
  for (let i = 1; i <= options.length; i++) {
    const index = (from + step * i + options.length * i) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return from;
}

/**
 * A single choice among a few short options, shown side by side. A radiogroup: one tab stop,
 * arrow keys move and select, Home / End jump to the ends.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
  className,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.findIndex((option) => option.value === value);

  function select(index: number): void {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    refs.current[index]?.focus();
  }

  function onKeyDown(event: KeyboardEvent, index: number): void {
    const last = options.length - 1;
    let target: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      target = nextEnabled(options, index, 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      target = nextEnabled(options, index, -1);
    } else if (event.key === 'Home') target = nextEnabled(options, last, 1);
    else if (event.key === 'End') target = nextEnabled(options, 0, -1);
    if (target === null) return;
    event.preventDefault();
    select(target);
  }

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-surface-2/60 p-1',
        className,
      )}
    >
      {options.map((option, index) => {
        const checked = index === selected;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: a button radiogroup — native radios cannot be styled as segments
            role="radio"
            aria-checked={checked}
            disabled={option.disabled}
            tabIndex={checked || (selected === -1 && index === 0) ? 0 : -1}
            onClick={() => select(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
              size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
              checked
                ? 'bg-surface text-foreground shadow-card'
                : 'text-muted hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
