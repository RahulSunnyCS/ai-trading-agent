'use client';

import { cn } from '../../lib/cn';

export interface RadioCardOption {
  value: string;
  label: string;
  description: string;
}

/**
 * A choice where the options need explaining, not just naming — each option
 * shows its one-line meaning right next to it, so there's no dropdown to open
 * and no need to already know what "Buffer" or "Make room" means.
 */
export function RadioCards({
  name,
  value,
  options,
  onChange,
  columns = 1,
}: {
  name: string;
  value: string;
  options: RadioCardOption[];
  onChange: (value: string) => void;
  columns?: 1 | 2 | 3;
}) {
  return (
    <div
      role="radiogroup"
      className={cn(
        'grid gap-2',
        columns === 2 && 'sm:grid-cols-2',
        columns === 3 && 'sm:grid-cols-3',
      )}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors',
              checked
                ? 'border-primary bg-primary/10 ring-1 ring-inset ring-primary/30'
                : 'border-border bg-surface-2/30 hover:border-border-strong hover:bg-surface-2/60',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              onChange={() => onChange(option.value)}
              className="mt-0.5 accent-[hsl(var(--primary))]"
            />
            <span className="text-xs leading-relaxed text-muted">
              <span className={cn('font-semibold', checked ? 'text-primary' : 'text-foreground')}>
                {option.label}
              </span>{' '}
              — {option.description}
            </span>
          </label>
        );
      })}
    </div>
  );
}
