'use client';

/**
 * The inputs dialog: the two columns the owner's sheet asked for by hand, for one day — the algo
 * trades taken (the sheet's algo fee follows from it) and the capital (one total, or per broker;
 * the 15:50 reading fills Angel One's). Saving PUTs only what changed (a cleared field is removed)
 * and the page refetches.
 */

import { useEffect, useState } from 'react';

import { apiPut } from '../../lib/api';
import { formatDay, formatInr, formatIstDateTimeShort } from '../../lib/format';
import {
  type InputsDraft,
  TRADE_BOOK_API,
  algoFee,
  inputsBody,
  inputsDraft,
} from '../../lib/tradeBookView';
import type { TradeBookManual } from '../../types/tradeBook';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { toast } from '../ui/Toast';

function Field({
  id,
  label,
  value,
  onChange,
  error,
  note,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | undefined;
  note?: string | null;
  placeholder?: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-x-3 gap-y-1">
      <label htmlFor={id} className="text-sm text-foreground">
        {label}
      </label>
      <Input
        id={id}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder ?? 'not typed'}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || note ? `${id}-note` : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="metric text-right"
      />
      {error || note ? (
        <p
          id={`${id}-note`}
          className={error ? 'col-span-2 text-xs text-negative' : 'col-span-2 text-xs text-faint'}
        >
          {error ?? note}
        </p>
      ) : null}
    </div>
  );
}

function readAt(manual: TradeBookManual | null, broker: string): string | null {
  const read = manual?.capital_read_at?.[broker];
  return read ? `read ${formatIstDateTimeShort(read.at)} (${read.source})` : null;
}

export function TradeBookInputsDialog({
  day,
  manual,
  open,
  onOpenChange,
  onSaved,
}: {
  day: string;
  manual: TradeBookManual | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<InputsDraft>(() => inputsDraft(manual));
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh draft each time the dialog opens (or the day's stored inputs change under it).
  useEffect(() => {
    if (open) {
      setDraft(inputsDraft(manual));
      setFailure(null);
    }
  }, [open, manual]);

  const check = inputsBody(manual, draft);
  const invalid = Object.keys(check.errors).length > 0;
  const algos = Number(draft.algos.replace(/[,\s]/g, ''));
  const set = (key: keyof InputsDraft) => (v: string) => setDraft((d) => ({ ...d, [key]: v }));
  const fromSheet = new Set(
    manual?.from_sheet ?? (manual?.source === 'sheet' ? ['algos', 'capital_total'] : []),
  );

  async function save() {
    if (!check.changed || invalid) return;
    setSaving(true);
    setFailure(null);
    const result = await apiPut<{ ok: boolean }>(`${TRADE_BOOK_API}/inputs/${day}`, check.body);
    setSaving(false);
    if (!result.ok) {
      setFailure(result.error);
      return;
    }
    toast(`Inputs saved for ${formatDay(day)}`);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Inputs for ${formatDay(day, { weekday: true })}`}
      description="The two columns your sheet asked you to type. A field left empty is not counted; clearing one removes it."
      footer={
        <>
          <span className="text-xs text-negative">{failure ? `Not saved: ${failure}` : ''}</span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={save}
              loading={saving}
              disabled={!check.changed || invalid || saving}
            >
              Save
            </Button>
          </span>
        </>
      }
    >
      <Field
        id="tb-algos"
        label="Algo trades taken"
        value={draft.algos}
        onChange={set('algos')}
        error={check.errors.algos}
        note={`algo fee ${formatInr(Number.isFinite(algos) ? algoFee(algos) : 0)} by the sheet's formula${fromSheet.has('algos') ? ' · from the sheet' : ''}`}
      />
      <p className="pt-1 text-xs text-faint">
        Capital, the margin usable that morning. One total, or each broker's; a total wins over the
        two.
      </p>
      <Field
        id="tb-capital-total"
        label="Total (all accounts)"
        value={draft.capitalTotal}
        onChange={set('capitalTotal')}
        error={check.errors.capitalTotal}
        note={fromSheet.has('capital_total') ? 'from the sheet' : null}
      />
      <Field
        id="tb-capital-finvasia"
        label="Finvasia"
        value={draft.finvasia}
        onChange={set('finvasia')}
        error={check.errors.finvasia}
        note={readAt(manual, 'finvasia') ?? 'type it: Finvasia is not read at 15:50'}
      />
      <Field
        id="tb-capital-angelone"
        label="Angel One"
        value={draft.angelone}
        onChange={set('angelone')}
        error={check.errors.angelone}
        note={readAt(manual, 'angelone')}
      />
    </Modal>
  );
}
