'use client';

import {
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  forwardRef,
  useEffect,
  useState,
} from 'react';

import { cn } from '../../lib/cn';

/** The one field style. Use <Input> / <Select> / <NumberField>; reach for this only for a <textarea>. */
export const inputClass =
  'w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground transition-colors placeholder:text-faint hover:border-border-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-negative';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(inputClass, className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(inputClass, className)} {...rest}>
        {children}
      </select>
    );
  },
);

/**
 * What a typed draft means: a number to commit, or null while it is empty, partial ("-", "1.")
 * or outside [min, max]. Exported for tests.
 */
export function parseDraft(draft: string, min?: number, max?: number): number | null {
  const text = draft.trim();
  if (text === '' || text === '-' || text === '.' || text === '-.') return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (min !== undefined && value < min) return null;
  if (max !== undefined && value > max) return null;
  return value;
}

/** Where an abandoned draft settles on blur: the nearest allowed value, or the last good one. */
export function settleDraft(draft: string, fallback: number, min?: number, max?: number): number {
  const value = Number(draft.trim());
  if (draft.trim() === '' || !Number.isFinite(value)) return fallback;
  if (min !== undefined && value < min) return min;
  if (max !== undefined && value > max) return max;
  return value;
}

interface NumberFieldProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'type' | 'min' | 'max'
  > {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}

/**
 * A number input that can be cleared and retyped. It keeps what you type as a string draft and
 * commits only a valid, in-range number, so clearing the field no longer snaps it to 0. On blur
 * an empty or out-of-range draft settles to the nearest allowed value.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  className,
  onBlur,
  ...rest
}: NumberFieldProps) {
  const [draft, setDraft] = useState(() => (Number.isFinite(value) ? String(value) : ''));

  // Follow the value when it changes from outside (a preset, a reset), not while it matches the draft.
  useEffect(() => {
    setDraft((current) =>
      parseDraft(current, min, max) === value
        ? current
        : Number.isFinite(value)
          ? String(value)
          : '',
    );
  }, [value, min, max]);

  const invalid = parseDraft(draft, min, max) === null;

  return (
    <input
      type="number"
      inputMode="decimal"
      className={cn(inputClass, className)}
      value={draft}
      min={min}
      max={max}
      aria-invalid={invalid}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = parseDraft(event.target.value, min, max);
        if (parsed !== null && parsed !== value) onChange(parsed);
      }}
      onBlur={(event) => {
        const settled = settleDraft(draft, value, min, max);
        setDraft(String(settled));
        if (settled !== value) onChange(settled);
        onBlur?.(event);
      }}
      {...rest}
    />
  );
}
