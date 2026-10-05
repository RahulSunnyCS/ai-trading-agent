'use client';

import { Check, Pencil, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '../../ui/Button';
import { Input } from '../../ui/Input';

export interface RenameState {
  id: string;
  draft: string;
  status: 'editing' | 'saving' | 'failed';
  /** The trimmed name sent to the server while `saving`. */
  submitted: string | null;
  /** The parent's rename call has returned (its refreshed list, if any, has arrived). */
  settled: boolean;
  error: string | null;
}

/**
 * A saved run's name with inline rename. Nothing is saved by leaving the field: Enter or the
 * tick commits, Escape or moving away cancels.
 */
export function SavedRunName({
  name,
  n,
  rename,
  onStart,
  onDraft,
  onCommit,
  onCancel,
}: {
  name: string;
  n: number;
  /** Set while this run is being renamed. */
  rename: RenameState | null;
  onStart: () => void;
  onDraft: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const editing = rename !== null;
  const status = rename?.status;
  // Focus on entering edit mode, and again after a failure so the kept text can be corrected.
  useEffect(() => {
    if (editing && status !== 'saving') inputRef.current?.focus();
  }, [editing, status]);

  if (!rename) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate font-medium text-foreground" title={name}>
          {name || `Run ${n}`}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6"
          aria-label={`Rename ${name || `run ${n}`}`}
          onClick={onStart}
        >
          <Pencil className="h-3 w-3" aria-hidden />
        </Button>
      </span>
    );
  }

  const saving = rename.status === 'saving';
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1">
        <Input
          ref={inputRef}
          aria-label={`Name for run ${n}`}
          aria-invalid={rename.error ? true : undefined}
          value={rename.draft}
          maxLength={64}
          readOnly={saving}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          onBlur={() => {
            // The tick and the cross keep focus in the field (see onMouseDown), so a blur here
            // means the user moved away: discard, never save silently.
            if (!saving) onCancel();
          }}
          className="w-48 py-1"
        />
        <Button
          size="icon"
          variant="primary"
          className="h-7 w-7"
          aria-label="Save name"
          loading={saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCommit}
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          aria-label="Cancel rename"
          disabled={saving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </span>
      {rename.error ? (
        <span role="alert" className="whitespace-normal text-xs text-negative">
          {rename.error}
        </span>
      ) : (
        <span className="text-xs text-faint">Enter to save · Esc to cancel</span>
      )}
    </span>
  );
}
