'use client';

import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { cn } from '../../../lib/cn';
import { OFF } from '../../../lib/legwiseGrid';

/**
 * A value that reads as text and is edited in place (BL-102 Phase 1c): click or press Enter on
 * it to type, Enter or leaving it to keep, Esc to give the change up. `onCommit` takes the typed
 * text and answers with a message when it cannot be used; the cell then stays open and says why,
 * so a bad value is never silently dropped or half-applied.
 */
export function EditableCell({
  display,
  seed,
  ariaLabel,
  onCommit,
  errors,
  align = 'left',
  mono = false,
  placeholder,
  className,
}: {
  /** What is shown when not editing. */
  display: string;
  /** What the editor opens with; defaults to the display, with the off dash as empty. */
  seed?: string;
  /** Names the cell for assistive tech: "Stop for leg ce". */
  ariaLabel: string;
  /** Apply the typed text. Return a message to refuse it, or null once it is applied. */
  onCommit: (text: string) => string | null;
  /** What the validator said about this value. */
  errors?: readonly string[] | undefined;
  align?: 'left' | 'right';
  mono?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  /** Set by Enter and Esc so the blur that follows the input unmounting does not act again. */
  const done = useRef(false);

  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  function open() {
    done.current = false;
    setDraft(seed ?? (display === OFF ? '' : display));
    setProblem(null);
    setEditing(true);
  }

  /** Close the editor. `refocus` only after Enter or Esc: a blur is the browser already moving focus. */
  function close(refocus: boolean) {
    done.current = true;
    setEditing(false);
    setProblem(null);
    if (refocus) {
      // Give focus back so keyboard users carry on from the same cell.
      queueMicrotask(() => opener.current?.focus());
    }
  }

  function commit(refocus: boolean) {
    if (done.current) return;
    const message = onCommit(draft);
    if (message === null) close(refocus);
    else setProblem(message);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    }
  }

  const invalid = problem !== null || (errors?.length ?? 0) > 0;
  const message = problem ?? errors?.[0];

  if (editing) {
    return (
      <span className="block">
        <input
          ref={input}
          value={draft}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          placeholder={placeholder}
          onChange={(event) => {
            setDraft(event.target.value);
            setProblem(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Leaving the cell keeps a valid value; an invalid one is left open and explained.
            commit(false);
          }}
          className={cn(
            'h-7 w-full min-w-14 rounded border bg-surface px-1.5 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30',
            invalid ? 'border-negative' : 'border-primary',
            mono && 'font-mono',
            align === 'right' && 'text-right',
          )}
        />
        {problem ? (
          <span role="alert" className="mt-0.5 block text-[11px] text-negative">
            {problem}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      ref={opener}
      type="button"
      aria-label={`${ariaLabel}: ${display === OFF ? 'off' : display}`}
      aria-invalid={invalid || undefined}
      title={message ?? 'Click to edit'}
      onClick={open}
      className={cn(
        'h-7 w-full min-w-14 truncate rounded px-1.5 text-xs transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        display === OFF ? 'text-faint' : 'text-foreground',
        mono && 'font-mono',
        align === 'right' ? 'text-right' : 'text-left',
        invalid && 'text-negative ring-1 ring-negative/60',
        className,
      )}
    >
      {display}
      {message ? <span className="sr-only"> ({message})</span> : null}
    </button>
  );
}

/**
 * A choice that reads as text: a native select with the chrome taken off until it is hovered or
 * focused, so a row of them does not look like a form.
 */
export function ChoiceCell<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  errors,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel: string;
  errors?: readonly string[] | undefined;
}) {
  const invalid = (errors?.length ?? 0) > 0;
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      title={errors?.[0]}
      onChange={(event) => onChange(event.target.value as T)}
      className={cn(
        'h-7 w-full min-w-16 cursor-pointer rounded border border-transparent bg-transparent px-1 text-xs text-foreground hover:border-border focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30',
        invalid && 'border-negative text-negative',
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
