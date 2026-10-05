/**
 * EditPersonalityDialog — edit a personality's minimum probability and stop-loss.
 *
 * Validation and the comparison-integrity rule live in lib/personalities.ts. The integrity
 * rule is only a warning here: the server checks it again on save and is the authority.
 * Save sends PUT /api/personalities/:id with the personality's params, edited keys replaced,
 * so no other parameter is dropped. A field left empty for a parameter the personality never
 * had is not written.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';

import { apiPut } from '../lib/api';
import { formatPct, formatPp } from '../lib/format';
import {
  FROZEN_EDIT_REASON,
  INTEGRITY_MAX_SPREAD_PP,
  checkComparisonIntegrity,
  draftFromParam,
  editChangesParams,
  editedParams,
  serverErrorMessage,
  stopLossKey,
  validateEdit,
} from '../lib/personalities';
import type { Personality } from '../types/trading';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { toast } from './ui/Toast';

interface EditPersonalityDialogProps {
  personality: Personality;
  /** Every personality, for the client-side comparison-integrity warning. */
  personalities: readonly Personality[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a successful save so the parent can refresh its list. */
  onSaved: () => void;
}

function Field({
  id,
  label,
  hint,
  error,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  error: string | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-muted">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error !== undefined}
          aria-describedby={`${id}-hint`}
          className="metric w-28"
        />
        <span className="text-sm text-muted">%</span>
      </div>
      <p
        id={`${id}-hint`}
        className={error ? 'mt-1 text-xs text-negative' : 'mt-1 text-xs text-faint'}
      >
        {error ?? hint}
      </p>
    </div>
  );
}

export function EditPersonalityDialog({
  personality,
  personalities,
  open,
  onOpenChange,
  onSaved,
}: EditPersonalityDialogProps) {
  const idBase = useId();
  const params = personality.params;
  const slKey = stopLossKey(params);
  const required = {
    minProbability: typeof params.min_probability === 'number',
    stopLoss: typeof params[slKey] === 'number',
  };

  const [minProbabilityPct, setMinProbabilityPct] = useState(() =>
    draftFromParam(params.min_probability, true),
  );
  const [stopLossPct, setStopLossPct] = useState(() => draftFromParam(params[slKey], false));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validation = validateEdit({ minProbabilityPct, stopLossPct }, required);
  const changed = validation.valid && editChangesParams(params, validation.values);
  const integrity = validation.valid
    ? checkComparisonIntegrity(personalities, personality.id, validation.values.minProbability)
    : null;
  const canSave = validation.valid && changed && !personality.is_frozen;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setError(null);
    setSubmitting(true);
    const res = await apiPut<{ data: Personality }>(`/api/personalities/${personality.id}`, {
      params: editedParams(params, validation.values),
    });
    setSubmitting(false);
    if (!res.ok) {
      const message = serverErrorMessage(res.error);
      setError(message);
      toast(`Couldn't save ${personality.display_name}: ${message}`, 'error');
      return;
    }
    toast(`Saved ${personality.display_name}`);
    onSaved();
    onOpenChange(false);
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-6 shadow-elevated">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-base font-semibold tracking-tight text-foreground">
                Edit {personality.display_name}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-muted">
                Change when it takes a signal and when it cuts a losing trade. Other settings stay
                as they are.
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

          {personality.is_frozen ? (
            <p className="text-sm text-muted">{FROZEN_EDIT_REASON}</p>
          ) : (
            <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4" noValidate>
              <Field
                id={`${idBase}-min-prob`}
                label="Minimum probability"
                hint={
                  required.minProbability
                    ? 'Signals scoring below this are skipped. 0 to 100%.'
                    : 'Not set for this personality. Leave empty to keep it unset.'
                }
                error={validation.errors.minProbability}
                value={minProbabilityPct}
                onChange={setMinProbabilityPct}
              />
              <Field
                id={`${idBase}-stop-loss`}
                label="Stop-loss (% of the straddle at entry)"
                hint={
                  required.stopLoss
                    ? 'Exit when the straddle rises this far above its entry value. Above 0, up to 100%.'
                    : 'Not set for this personality. Leave empty to keep it unset.'
                }
                error={validation.errors.stopLoss}
                value={stopLossPct}
                onChange={setStopLossPct}
              />

              {integrity !== null &&
                (integrity.ok ? (
                  <p className="text-xs text-faint">
                    Within the {INTEGRITY_MAX_SPREAD_PP} pp band that keeps{' '}
                    {integrity.members.map((m) => m.name).join(', ')} comparable (spread{' '}
                    {formatPp(integrity.spreadPp, 1, { unit: 'percent', sign: false })}).
                  </p>
                ) : (
                  <div
                    role="alert"
                    className="flex gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <p>
                      {integrity.members
                        .map((m) => `${m.name} ${formatPct(m.minProbability, 0)}`)
                        .join(' · ')}
                      : {formatPp(integrity.spreadPp, 1, { unit: 'percent', sign: false })} apart.
                      They must stay within {INTEGRITY_MAX_SPREAD_PP} pp of each other for their
                      results to stay comparable, so the server is expected to refuse this save.
                    </p>
                  </div>
                ))}

              {error !== null && (
                <div
                  role="alert"
                  className="rounded-lg border border-negative/30 bg-negative/10 px-3 py-2 text-xs text-negative"
                >
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Dialog.Close asChild>
                  <Button type="button" variant="ghost" size="sm">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  loading={submitting}
                  disabled={!canSave}
                  title={
                    !validation.valid
                      ? 'Fix the highlighted fields first'
                      : !changed
                        ? 'Nothing has changed yet'
                        : undefined
                  }
                >
                  Save
                </Button>
              </div>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
