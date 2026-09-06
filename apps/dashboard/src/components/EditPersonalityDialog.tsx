/**
 * EditPersonalityDialog — modal form for editing a personality's tunable params.
 *
 * v1 scope: the two parameters operators tune most frequently:
 *   - min_probability (0.0–1.0)  — signal-acceptance threshold
 *   - sl_pct                     — stop-loss percent
 *
 * On Save: PUT /api/personalities/:id with the merged params object. Errors
 * from the backend (403 FROZEN_VIOLATION, 409 COMPARISON_INTEGRITY_VIOLATION)
 * are surfaced inline so the operator sees exactly which guard fired.
 *
 * Other params on the personality are passed through unchanged so the PUT
 * never accidentally drops an existing field the engine relies on.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import { apiPut } from '../lib/api.js';
import type { Personality } from '../types/trading.js';
import { Button } from './ui/Button';

interface EditPersonalityDialogProps {
  personality: Personality;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save so the parent can refresh its list. */
  onSaved: () => void;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function EditPersonalityDialog({
  personality,
  open,
  onOpenChange,
  onSaved,
}: EditPersonalityDialogProps) {
  const startMinProb = numberOr(personality.params.min_probability, 0.5);
  const startSlPct = numberOr(personality.params.sl_pct, 25);

  const [minProb, setMinProb] = useState<number>(startMinProb);
  const [slPct, setSlPct] = useState<number>(startSlPct);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset state when the dialog opens for a different personality.
  // (Cheap: just reset on each open transition; avoids stale values from a
  // previous personality bleeding into this dialog instance.)
  function handleOpenChange(next: boolean) {
    if (next) {
      setMinProb(startMinProb);
      setSlPct(startSlPct);
      setError(null);
    }
    onOpenChange(next);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    // Merge so we don't drop other params the engine relies on (e.g.
    // entry_window_start, rolling-window sizes, etc.).
    const nextParams = {
      ...personality.params,
      min_probability: minProb,
      sl_pct: slPct,
    };

    const res = await apiPut<{ data: Personality }>(`/api/personalities/${personality.id}`, {
      params: nextParams,
    });

    setSubmitting(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
                Edit {personality.display_name}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-muted">
                Tune signal-acceptance threshold and stop-loss. Backend enforces
                the frozen-Clockwork guard and the ±8pp integrity cap.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            {/* min_probability slider */}
            <div>
              <label
                htmlFor={`min-prob-${personality.id}`}
                className="mb-1 flex items-baseline justify-between text-xs font-medium"
              >
                <span className="text-muted">Minimum probability</span>
                <span className="tabular-nums text-foreground">
                  {(minProb * 100).toFixed(0)}%
                </span>
              </label>
              <input
                id={`min-prob-${personality.id}`}
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={minProb}
                onChange={(e) => setMinProb(Number.parseFloat(e.target.value))}
                className="w-full accent-primary"
              />
              <div className="mt-1 flex justify-between text-[10px] tabular-nums text-faint">
                <span>0%</span>
                <span>50%</span>
                <span>100%</span>
              </div>
            </div>

            {/* sl_pct number input */}
            <div>
              <label
                htmlFor={`sl-pct-${personality.id}`}
                className="mb-1 block text-xs font-medium text-muted"
              >
                Stop-loss (% of straddle)
              </label>
              <input
                id={`sl-pct-${personality.id}`}
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={slPct}
                onChange={(e) => setSlPct(Number.parseFloat(e.target.value))}
                className="h-9 w-full rounded-lg border border-border bg-surface-2 px-3 text-sm tabular-nums text-foreground focus:border-primary focus:outline-none"
              />
            </div>

            {error !== null && (
              <div className="rounded-md border border-negative/40 bg-negative/10 px-3 py-2 text-xs text-negative">
                {error}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="sm">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" size="sm" disabled={submitting}>
                {submitting ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
